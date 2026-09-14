import {
  DOMAIN_EVENTS,
  DUNNING_SCHEDULE_DAYS,
  LIFECYCLE_AUDIT_ACTIONS,
  nextPeriodStart,
  priceOrder,
  quoteShippingRates,
  type Currency,
  type PricingLineInput,
  type PricingResult,
  type SubscriptionInterval,
} from '@health/types';
import type { PrismaClient } from '../../generated/client/index.js';

/**
 * Subscription billing.
 *
 * Shared between the API and the worker for the same reason the commerce and
 * compliance sweeps are: the scheduled code should be the code the integration
 * tests cover, not a second implementation of taking money that is free to
 * drift from the first. There is exactly one function in this codebase that
 * charges a renewal, and it is `billSubscriptionPeriod`.
 *
 * The payment provider is passed in rather than imported, so this module — and
 * `@health/database` with it — stays free of a dependency on the payments
 * package, and so a caller can only charge with a provider it already holds.
 *
 * Two properties are the point of the whole file:
 *
 * **Idempotent per period.** The invoice row is written *before* the provider
 * is called, under a unique constraint on `(subscription, period start)`. A
 * second run for the same period loses the insert and returns without
 * charging; a crash between charging and recording leaves an invoice to
 * reconcile against rather than money that left with no trace.
 *
 * **A failed renewal stops fulfilment immediately.** `PAST_DUE` is billable but
 * not shippable, and the retries are bounded.
 */

/** The part of the payment provider this needs. Deliberately the smallest one. */
export interface BillingPaymentProvider {
  createIntent(input: {
    amountCents: number;
    currency: string;
    reference: string;
    idempotencyKey: string;
    paymentMethodId?: string;
    offSession?: boolean;
    metadata?: Record<string, string>;
  }): Promise<{
    providerPaymentId: string;
    status: string;
    failureCode?: string | null;
    failureMessage?: string | null;
  }>;
}

export interface BillingDeps {
  prisma: PrismaClient;
  payments: BillingPaymentProvider;
  now: () => Date;
  /**
   * Called after each write so a caller with metrics or structured logging can
   * record it. Never used for control flow.
   */
  onEvent?: (event: BillingEvent) => void;
  onError?: (error: unknown, context: Record<string, string>) => void;
}

export interface BillingEvent {
  type: 'renewed' | 'renewal_failed' | 'unpaid';
  subscriptionId: string;
  attempts?: number;
  code?: string;
  totalCents?: number;
}

export interface BillingOutcome {
  charged: boolean;
  reason?: string;
  totalCents?: number;
}

/**
 * Prices a renewal from the prices the customer agreed to.
 *
 * Runs through the same pricing engine a checkout does — including the same
 * shipping-rate rule — so tax allocation and the line/total arithmetic are
 * identical. There is no second implementation of money in this codebase.
 *
 * Item prices come from the subscription's own rows, never from today's
 * catalogue. A subscription is a standing agreement about an amount; charging
 * more because a catalogue price moved changes the terms without asking, which
 * US auto-renewal statutes take a dim view of.
 */
export async function priceSubscriptionPeriod(
  prisma: PrismaClient,
  subscriptionId: string,
): Promise<PricingResult> {
  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
    include: { items: true },
  });

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: subscription.items.map((item) => item.variantId) } },
    include: { product: { select: { id: true, name: true } } },
  });

  const lines: PricingLineInput[] = subscription.items.map((item) => {
    const variant = variants.find((candidate) => candidate.id === item.variantId);
    return {
      variantId: item.variantId,
      productId: variant?.product.id ?? item.variantId,
      sku: variant?.sku ?? 'unknown',
      productName: variant?.product.name ?? 'Subscription item',
      variantName: variant?.name ?? '',
      quantity: item.quantity,
      // The agreed price, not today's catalogue price.
      unitPriceCents: item.unitPriceCents,
      taxable: true,
    };
  });

  const subtotalCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);

  const address = subscription.shippingAddress as {
    country?: string;
    region?: string;
  } | null;

  let shippingCents = 0;
  if (subscription.shippingMethodCode && address?.country) {
    const rates = await prisma.shippingRate.findMany({
      where: { isActive: true, countries: { has: address.country } },
      orderBy: [{ position: 'asc' }, { priceCents: 'asc' }],
    });
    const quote = quoteShippingRates(rates, {
      country: address.country,
      region: address.region ?? '',
      subtotalCents,
      totalWeightGrams: 0,
    }).find((candidate) => candidate.code === subscription.shippingMethodCode);

    // A withdrawn method prices delivery at zero rather than substituting a
    // pricier one. Charging a subscriber for a service nobody quoted them is
    // the worse failure; an operator who retires a rate can see the shortfall
    // in the invoices.
    shippingCents = quote?.priceCents ?? 0;
  }

  const [taxRate, taxShipping] = await Promise.all([
    readSetting<number>(prisma, 'tax.default_rate'),
    readSetting<boolean>(prisma, 'tax.shipping_taxable'),
  ]);

  return priceOrder({
    currency: subscription.currency as Currency,
    lines,
    shippingCents,
    taxRate: taxRate ?? null,
    taxShipping: taxShipping ?? false,
  });
}

/**
 * Charges one period of one subscription.
 *
 * Returns rather than throws for every business refusal — not due, cancelled,
 * no card, declined — because the caller is usually a loop over hundreds of
 * subscriptions and one customer's expired card must not stop the run.
 */
export async function billSubscriptionPeriod(
  deps: BillingDeps,
  input: { subscriptionId: string },
): Promise<BillingOutcome> {
  const { prisma, payments, now } = deps;
  const at = now();

  const subscription = await prisma.subscription.findUnique({
    where: { id: input.subscriptionId },
    include: { paymentMethod: true },
  });
  if (!subscription) return { charged: false, reason: 'No such subscription.' };

  const billable = subscription.status === 'ACTIVE' || subscription.status === 'PAST_DUE';
  if (subscription.status !== 'PENDING' && !billable) {
    return {
      charged: false,
      reason: `A ${subscription.status.toLowerCase()} subscription is not billed.`,
    };
  }

  // Only charge what is actually due. Without this, two calls in a row charge
  // twice: a success rolls the period forward, so the second call sees a
  // different period start and the unique constraint never fires. The
  // constraint protects against two runs racing on one period; this protects
  // against a run that is simply early, which is the likelier mistake.
  if (
    subscription.status !== 'PENDING' &&
    (subscription.nextBillingAt === null || subscription.nextBillingAt > at)
  ) {
    return { charged: false, reason: 'This subscription is not due yet.' };
  }

  if (!subscription.paymentMethod || subscription.paymentMethod.detachedAt) {
    await recordFailure(
      deps,
      input.subscriptionId,
      'NO_PAYMENT_METHOD',
      'No usable payment method.',
    );
    return { charged: false, reason: 'No usable payment method.' };
  }

  const priced = await priceSubscriptionPeriod(prisma, input.subscriptionId);
  const periodStart = subscription.currentPeriodStart;
  const periodEnd = subscription.currentPeriodEnd;

  const invoice = await prisma.subscriptionInvoice
    .create({
      data: {
        subscriptionId: input.subscriptionId,
        periodStart,
        periodEnd,
        status: 'PENDING',
        currency: subscription.currency,
        totalCents: priced.totalCents,
        attempt: subscription.failedAttempts + 1,
      },
    })
    .catch(async (error: unknown) => {
      if (!isUniqueConstraint(error)) throw error;
      return prisma.subscriptionInvoice.findUnique({
        where: {
          subscriptionId_periodStart: { subscriptionId: input.subscriptionId, periodStart },
        },
      });
    });

  if (!invoice) return { charged: false, reason: 'Could not record an invoice.' };
  if (invoice.status === 'PAID') {
    // Already collected for this period. This is the branch that guarantees a
    // retried run does not charge again.
    return { charged: false, reason: 'This period has already been billed.' };
  }

  const idempotencyKey = `sub-${input.subscriptionId}-${periodStart.toISOString()}-${invoice.attempt}`;

  try {
    const result = await payments.createIntent({
      amountCents: priced.totalCents,
      currency: subscription.currency,
      reference: subscription.reference,
      idempotencyKey,
      paymentMethodId: subscription.paymentMethod.providerPaymentMethodId,
      // Nobody is at the keyboard. Said explicitly so the provider declines
      // cleanly instead of waiting on an authentication no one can complete.
      offSession: true,
      metadata: { subscriptionId: input.subscriptionId, periodStart: periodStart.toISOString() },
    });

    if (result.status !== 'CAPTURED' && result.status !== 'AUTHORIZED') {
      await recordFailure(
        deps,
        input.subscriptionId,
        result.failureCode ?? 'NOT_SETTLED',
        result.failureMessage ?? 'The renewal did not settle.',
        invoice.id,
      );
      return { charged: false, reason: result.failureMessage ?? 'The renewal did not settle.' };
    }

    await recordSuccess(deps, input.subscriptionId, invoice.id, priced.totalCents);
    return { charged: true, totalCents: priced.totalCents };
  } catch (error) {
    const message = messageOf(error);
    const code = codeOf(error);
    deps.onError?.(error, { subscriptionId: input.subscriptionId });
    await recordFailure(deps, input.subscriptionId, code, message, invoice.id);
    return { charged: false, reason: message };
  }
}

/**
 * The subscriptions a billing run should attempt.
 *
 * Only `ACTIVE` and `PAST_DUE`, and only those whose next charge is due. A
 * paused or cancelled subscription has no `nextBillingAt` at all — a database
 * CHECK refuses to let a cancelled one keep a date — so a run cannot charge
 * somebody who cancelled even if this query were wrong.
 */
export async function listDueSubscriptions(
  prisma: PrismaClient,
  at: Date,
  limit = 200,
): Promise<string[]> {
  const due = await prisma.subscription.findMany({
    where: {
      status: { in: ['ACTIVE', 'PAST_DUE'] },
      nextBillingAt: { lte: at },
    },
    orderBy: { nextBillingAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  return due.map((row) => row.id);
}

async function recordSuccess(
  deps: BillingDeps,
  subscriptionId: string,
  invoiceId: string,
  totalCents: number,
): Promise<void> {
  const { prisma, now } = deps;
  const at = now();

  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });
  const periodStart = subscription.currentPeriodEnd;
  const periodEnd = nextPeriodStart(
    periodStart,
    subscription.interval as SubscriptionInterval,
    subscription.intervalCount,
    subscription.anchorDayOfMonth ?? undefined,
  );

  await prisma.$transaction(async (tx) => {
    await tx.subscriptionInvoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID', settledAt: at, failureCode: null, failureMessage: null },
    });
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'ACTIVE',
        // Reset, not decremented. One success clears the dunning history; a
        // decrement would leave a subscription permanently one failure from
        // being cut off.
        failedAttempts: 0,
        lastFailureCode: null,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextBillingAt: periodEnd,
      },
    });
    await tx.subscriptionEvent.create({
      data: {
        subscriptionId,
        type: 'RENEWED',
        message: `Charged ${(totalCents / 100).toFixed(2)} for the period to ${periodEnd
          .toISOString()
          .slice(0, 10)}.`,
        isSystem: true,
      },
    });
    await tx.auditLog.create({
      data: {
        action: LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_RENEWED,
        actorType: 'SYSTEM',
        actorLabel: 'system',
        entityType: 'subscription',
        entityId: subscriptionId,
        outcome: 'SUCCESS',
        afterState: { totalCents, nextBillingAt: periodEnd.toISOString() },
      },
    });
  });

  deps.onEvent?.({ type: 'renewed', subscriptionId, totalCents });
}

/**
 * Records a failed renewal and decides whether to keep trying.
 *
 * Dispatch stops the moment this runs — `PAST_DUE` is not shippable — and the
 * retries are bounded. When the schedule is exhausted the subscription is left
 * `UNPAID` rather than retried forever: a card that has declined four times is
 * not going to work on the fifth, and a business that keeps asking gets treated
 * as a problem by the issuer.
 *
 * The retry schedule is read from settings so an operator can change it without
 * a deploy, and falls back to the domain default rather than to "retry
 * forever".
 */
async function recordFailure(
  deps: BillingDeps,
  subscriptionId: string,
  code: string,
  message: string,
  invoiceId?: string,
): Promise<void> {
  const { prisma, now } = deps;
  const at = now();

  const configured = await readSetting<number[]>(prisma, 'subscriptions.dunning_days');
  const schedule =
    Array.isArray(configured) && configured.every((day) => Number.isFinite(day))
      ? configured
      : DUNNING_SCHEDULE_DAYS;

  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: subscriptionId },
  });
  const attempts = subscription.failedAttempts + 1;
  const wait = schedule[attempts - 1];
  const exhausted = wait === undefined;
  const nextAttempt = exhausted ? null : new Date(at.getTime() + wait * 24 * 60 * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    if (invoiceId) {
      await tx.subscriptionInvoice.update({
        where: { id: invoiceId },
        data: { status: 'FAILED', failureCode: code, failureMessage: message, attempt: attempts },
      });
    }

    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        // PENDING stays PENDING: a first charge that never settled did not
        // start a subscription, and calling it past-due would imply it had.
        status: subscription.status === 'PENDING' ? 'PENDING' : exhausted ? 'UNPAID' : 'PAST_DUE',
        failedAttempts: attempts,
        lastFailureAt: at,
        lastFailureCode: code,
        nextBillingAt: nextAttempt,
      },
    });

    await tx.subscriptionEvent.create({
      data: {
        subscriptionId,
        type: exhausted ? 'UNPAID' : 'RENEWAL_FAILED',
        message: exhausted
          ? `Renewal failed ${attempts} time(s); no further attempts will be made. ${message}`
          : `Renewal attempt ${attempts} failed: ${message}`,
        data: { code, nextAttemptAt: nextAttempt?.toISOString() ?? null },
        isSystem: true,
      },
    });

    // Told in the same transaction that records the failure. The important
    // sentence in that email is "nothing will ship" — a customer who thinks
    // their delivery is on its way will not act, and it will not arrive.
    await tx.outboxMessage.create({
      data: {
        aggregateType: 'subscription',
        aggregateId: subscriptionId,
        eventType: exhausted
          ? DOMAIN_EVENTS.SUBSCRIPTION_UNPAID
          : DOMAIN_EVENTS.SUBSCRIPTION_RENEWAL_FAILED,
        payload: { attempts, nextAttemptAt: nextAttempt?.toISOString() ?? null },
      },
    });

    await tx.auditLog.create({
      data: {
        action: exhausted
          ? LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_UNPAID
          : LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_RENEWAL_FAILED,
        actorType: 'SYSTEM',
        actorLabel: 'system',
        entityType: 'subscription',
        entityId: subscriptionId,
        outcome: 'FAILURE',
        reason: message,
        afterState: { attempts, code, nextAttemptAt: nextAttempt?.toISOString() ?? null },
      },
    });
  });

  deps.onEvent?.({
    type: exhausted ? 'unpaid' : 'renewal_failed',
    subscriptionId,
    attempts,
    code,
  });
}

async function readSetting<T>(prisma: PrismaClient, key: string): Promise<T | null> {
  const setting = await prisma.systemSetting.findUnique({ where: { key } });
  return setting ? (setting.value as T) : null;
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The renewal could not be processed.';
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'UNKNOWN';
}
