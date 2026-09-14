import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import {
  billSubscriptionPeriod,
  isUniqueConstraintError,
  listDueSubscriptions,
  type BillingDeps,
} from '@health/database';
import type { PaymentProvider } from '@health/payments';
import { canTransitionSubscription, nextPeriodStart, type SubscriptionStatus } from '@health/types';
import type {
  AttachPaymentMethodInput,
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  PauseSubscriptionInput,
  SubscriptionQuery,
  UpdateSubscriptionInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { PAYMENT_PROVIDER } from '../../commerce/payments/payment.provider.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { LIFECYCLE_AUDIT_ACTIONS } from '../lifecycle.audit.js';

/**
 * Subscriptions.
 *
 * A renewal is a charge, so everything Phase 3 established about taking money
 * applies here — plus two things that are specific to recurring billing and
 * both easy to get wrong.
 *
 * **Prices are the ones the customer agreed to.** They live on the subscription
 * items and are not re-read from the catalogue at renewal. A subscription is a
 * standing agreement about an amount; charging more because a catalogue price
 * moved is changing the terms without asking, which US auto-renewal statutes
 * take a dim view of and which nobody should want to build. Changing what a
 * subscriber pays needs their agreement, and that flow is not in this phase —
 * so for now a price change simply does not reach existing subscriptions.
 *
 * **A failed renewal stops fulfilment immediately.** The subscription moves to
 * `PAST_DUE`: collection is retried on a bounded schedule, dispatch stops the
 * same moment. Shipping goods against a payment that did not settle is the
 * subscription equivalent of taking money for stock that is not there.
 *
 * Billing is idempotent per period through a unique constraint on
 * `(subscription, period start)`, not through a check. An overlapping worker, a
 * retried run, or a crash between charging and recording cannot produce a
 * second charge for the same month, because the second insert loses.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(SubscriptionsService.name);
  }

  // -------------------------------------------------------------------------
  // Payment methods
  // -------------------------------------------------------------------------

  /**
   * Saves a payment method the customer added at the provider.
   *
   * The browser sent the card to the provider and got a token back; this stores
   * the token. The brand and last four are read from the provider rather than
   * accepted from the request — a client that could label its own token could
   * label somebody else's saved card however it liked.
   */
  async attachPaymentMethod(
    customerId: string,
    input: AttachPaymentMethodInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);

    const details = await this.payments.retrievePaymentMethod(input.providerPaymentMethodId);
    if (!details) {
      throw AppException.preconditionFailed(
        'That payment method is not recognised by the payment provider.',
      );
    }

    try {
      const method = await this.prisma.$transaction(async (tx) => {
        if (input.makeDefault) {
          await tx.customerPaymentMethod.updateMany({
            where: { customerId, detachedAt: null },
            data: { isDefault: false },
          });
        }

        const created = await tx.customerPaymentMethod.create({
          data: {
            customerId,
            provider: this.payments.name,
            providerPaymentMethodId: details.providerPaymentMethodId,
            cardBrand: details.cardBrand,
            cardLast4: details.cardLast4,
            expiryMonth: details.expiryMonth,
            expiryYear: details.expiryYear,
            isDefault: input.makeDefault,
          },
        });

        await this.audit.recordIn(tx, {
          action: LIFECYCLE_AUDIT_ACTIONS.PAYMENT_METHOD_ATTACHED,
          entityType: 'payment_method',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          // Brand and last four only. There is nothing else to record, because
          // there is nothing else this system ever saw.
          after: {
            provider: this.payments.name,
            cardBrand: details.cardBrand,
            cardLast4: details.cardLast4,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return this.toPaymentMethodView(method);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppException.conflict('That payment method is already saved.');
      }
      throw error;
    }
  }

  async listPaymentMethods(customerId: string) {
    const methods = await this.prisma.customerPaymentMethod.findMany({
      where: { customerId, detachedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return methods.map((method) => this.toPaymentMethodView(method));
  }

  /**
   * Removes a saved method.
   *
   * Refused while an active subscription depends on it: silently detaching it
   * would turn the next renewal into a failure the customer did not cause and
   * cannot diagnose. They are told to switch the subscription first.
   */
  async detachPaymentMethod(customerId: string, methodId: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const method = await this.prisma.customerPaymentMethod.findFirst({
      where: { id: methodId, customerId, detachedAt: null },
    });
    if (!method) throw AppException.notFound('Payment method');

    const inUse = await this.prisma.subscription.count({
      where: {
        paymentMethodId: methodId,
        status: { in: ['PENDING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] },
      },
    });
    if (inUse > 0) {
      throw AppException.conflict(
        `${inUse} subscription(s) still bill to this card. Change them to another card first.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.customerPaymentMethod.update({
        where: { id: methodId },
        data: { detachedAt: this.clock.now(), isDefault: false },
      });
      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.PAYMENT_METHOD_DETACHED,
        entityType: 'payment_method',
        entityId: methodId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { cardBrand: method.cardBrand, cardLast4: method.cardLast4 },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Subscribing
  // -------------------------------------------------------------------------

  /**
   * Starts a subscription.
   *
   * Prices come from the catalogue *here*, once, and are then the agreed price.
   * The first charge is taken immediately: a subscription that shipped before
   * anything settled would be goods given away on the promise of a card nobody
   * had tried.
   */
  async create(customerId: string, input: CreateSubscriptionInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const [method, address] = await Promise.all([
      this.prisma.customerPaymentMethod.findFirst({
        where: { id: input.paymentMethodId, customerId, detachedAt: null },
      }),
      this.prisma.customerAddress.findFirst({
        where: { id: input.shippingAddressId, customerId, deletedAt: null },
      }),
    ]);
    if (!method) throw AppException.notFound('Payment method');
    if (!address) throw AppException.notFound('Address');

    const variants = await this.prisma.productVariant.findMany({
      where: {
        id: { in: input.items.map((item) => item.variantId) },
        isActive: true,
        deletedAt: null,
        product: { status: 'PUBLISHED', deletedAt: null },
      },
      include: {
        product: {
          select: { id: true, name: true, priceCents: true, subscriptionEligible: true },
        },
      },
    });

    if (variants.length !== input.items.length) {
      throw AppException.preconditionFailed(
        'One or more of those products is not available to subscribe to.',
      );
    }

    const notEligible = variants.filter((variant) => !variant.product.subscriptionEligible);
    if (notEligible.length > 0) {
      throw AppException.preconditionFailed(
        `${notEligible.map((variant) => variant.product.name).join(', ')} cannot be subscribed to.`,
      );
    }

    const now = this.clock.now();
    const periodEnd = nextPeriodStart(now, input.interval, input.intervalCount);

    const subscription = await this.prisma.$transaction(async (tx) => {
      const created = await tx.subscription.create({
        data: {
          reference: await this.allocateReference(),
          customerId,
          status: 'PENDING',
          interval: input.interval,
          intervalCount: input.intervalCount,
          anchorDayOfMonth: input.interval === 'MONTH' ? now.getUTCDate() : null,
          shippingAddress: {
            firstName: address.firstName,
            lastName: address.lastName,
            line1: address.line1,
            line2: address.line2,
            city: address.city,
            region: address.region,
            postalCode: address.postalCode,
            country: address.country,
          } as never,
          shippingMethodCode: input.shippingMethodCode ?? null,
          paymentMethodId: method.id,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          // Set once the first charge settles. A pending subscription is not
          // due anything.
          nextBillingAt: null,
        },
      });

      for (const item of input.items) {
        const variant = variants.find((candidate) => candidate.id === item.variantId)!;
        await tx.subscriptionItem.create({
          data: {
            subscriptionId: created.id,
            variantId: item.variantId,
            quantity: item.quantity,
            // The agreed price, captured now and not re-read at renewal.
            unitPriceCents: variant.priceCents ?? variant.product.priceCents,
          },
        });
      }

      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: created.id,
          type: 'CREATED',
          message: `Subscription created, renewing every ${input.intervalCount} ${input.interval.toLowerCase()}(s).`,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
        entityType: 'subscription',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: {
          reference: created.reference,
          interval: input.interval,
          intervalCount: input.intervalCount,
          itemCount: input.items.length,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    // The first charge, taken now. If it fails the subscription stays PENDING
    // and nothing ships — which is the correct outcome, not an error to hide.
    await this.bill(subscription.id);

    return this.findById(subscription.id);
  }

  // -------------------------------------------------------------------------
  // Billing
  // -------------------------------------------------------------------------

  /**
   * Charges one period of one subscription.
   *
   * Delegates to `billSubscriptionPeriod` in `@health/database`, which is the
   * only code in this repository that takes a recurring payment. The worker's
   * hourly run calls the same function, so a renewal charged by the scheduler
   * and one charged here cannot diverge in price, idempotency or dunning — and
   * the integration tests in this suite cover both.
   */
  async bill(subscriptionId: string): Promise<{ charged: boolean; reason?: string }> {
    const exists = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true },
    });
    if (!exists) throw AppException.notFound('Subscription');

    const outcome = await billSubscriptionPeriod(this.billingDeps(), { subscriptionId });
    return { charged: outcome.charged, reason: outcome.reason };
  }

  /**
   * The subscriptions a billing run should attempt.
   *
   * Only `ACTIVE` and `PAST_DUE`, and only those whose next charge is due. A
   * paused or cancelled subscription has no `nextBillingAt` at all — a database
   * constraint refuses to let a cancelled one keep a date, so a billing run
   * cannot charge somebody who cancelled even if this query were wrong.
   */
  async listDue(limit = 200): Promise<string[]> {
    return listDueSubscriptions(this.prisma, this.clock.now(), limit);
  }

  private billingDeps(): BillingDeps {
    return {
      prisma: this.prisma,
      payments: this.payments,
      now: () => this.clock.now(),
      onEvent: (event) => {
        if (event.type === 'renewed') return;
        this.logger.warn(
          {
            subscriptionId: event.subscriptionId,
            attempts: event.attempts,
            code: event.code,
            exhausted: event.type === 'unpaid',
          },
          'subscription renewal failed',
        );
      },
      onError: (error, context) => {
        this.logger.error({ err: error, ...context }, 'subscription renewal raised');
      },
    };
  }

  // -------------------------------------------------------------------------
  // Customer actions
  // -------------------------------------------------------------------------

  async pause(
    subscriptionId: string,
    customerId: string,
    input: PauseSubscriptionInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);
    const subscription = await this.requireOwned(subscriptionId, customerId);
    this.assertTransition(subscription.status as SubscriptionStatus, 'PAUSED');

    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: 'PAUSED',
          pausedAt: this.clock.now(),
          // Clearing the date is what actually stops the billing run. Leaving
          // it set and relying on the status filter would be one bug away from
          // charging a paused subscription.
          nextBillingAt: null,
        },
      });
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId,
          type: 'PAUSED',
          message: input.reason ? `Paused: ${input.reason}` : 'Paused by the customer.',
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_PAUSED,
        entityType: 'subscription',
        entityId: subscriptionId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason ?? null,
        before: { status: subscription.status },
        after: { status: 'PAUSED' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(subscriptionId);
  }

  async resume(subscriptionId: string, customerId: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    const subscription = await this.requireOwned(subscriptionId, customerId);
    this.assertTransition(subscription.status as SubscriptionStatus, 'ACTIVE');

    const now = this.clock.now();
    // Resumes into a fresh period starting now, rather than back-charging for
    // the time the subscription was paused. Billing someone for months they
    // deliberately paused is not a defensible reading of the agreement.
    const periodEnd = nextPeriodStart(
      now,
      subscription.interval,
      subscription.intervalCount,
      subscription.anchorDayOfMonth ?? undefined,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: 'ACTIVE',
          pausedAt: null,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          nextBillingAt: periodEnd,
        },
      });
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId,
          type: 'RESUMED',
          message: 'Resumed by the customer.',
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_RESUMED,
        entityType: 'subscription',
        entityId: subscriptionId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { status: 'ACTIVE', nextBillingAt: periodEnd.toISOString() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(subscriptionId);
  }

  /**
   * Cancels.
   *
   * Takes effect immediately and needs no reason. Cancelling must not be harder
   * than subscribing was: there is no retention flow, no required explanation
   * and no waiting period, because each of those is a dark pattern the FTC has
   * been explicit about.
   */
  async cancel(
    subscriptionId: string,
    customerId: string,
    input: CancelSubscriptionInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);
    const subscription = await this.requireOwned(subscriptionId, customerId);
    this.assertTransition(subscription.status as SubscriptionStatus, 'CANCELLED');

    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: 'CANCELLED',
          cancelledAt: this.clock.now(),
          cancelReason: input.reason ?? null,
          nextBillingAt: null,
        },
      });
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId,
          type: 'CANCELLED',
          message: input.reason ? `Cancelled: ${input.reason}` : 'Cancelled by the customer.',
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
        entityType: 'subscription',
        entityId: subscriptionId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason ?? null,
        before: { status: subscription.status },
        after: { status: 'CANCELLED' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(subscriptionId);
  }

  async update(
    subscriptionId: string,
    customerId: string,
    input: UpdateSubscriptionInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);
    await this.requireOwned(subscriptionId, customerId);

    const data: Record<string, unknown> = {};

    if (input.paymentMethodId) {
      const method = await this.prisma.customerPaymentMethod.findFirst({
        where: { id: input.paymentMethodId, customerId, detachedAt: null },
      });
      if (!method) throw AppException.notFound('Payment method');
      data.paymentMethodId = method.id;
    }

    if (input.shippingAddressId) {
      const address = await this.prisma.customerAddress.findFirst({
        where: { id: input.shippingAddressId, customerId, deletedAt: null },
      });
      if (!address) throw AppException.notFound('Address');
      data.shippingAddress = {
        firstName: address.firstName,
        lastName: address.lastName,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        region: address.region,
        postalCode: address.postalCode,
        country: address.country,
      };
    }

    if (input.shippingMethodCode !== undefined) {
      data.shippingMethodCode = input.shippingMethodCode;
    }

    if (Object.keys(data).length === 0) return this.findById(subscriptionId);

    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: subscriptionId }, data: data as never });
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId,
          type: 'UPDATED',
          message: `Changed: ${Object.keys(data).join(', ')}.`,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
    });

    return this.findById(subscriptionId);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async listForCustomer(customerId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: { variant: { include: { product: { select: { name: true, slug: true } } } } },
        },
        paymentMethod: true,
      },
    });
    return subscriptions.map((subscription) => this.toView(subscription));
  }

  async list(query: SubscriptionQuery) {
    const rows = await this.prisma.subscription.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      include: {
        items: {
          include: { variant: { include: { product: { select: { name: true, slug: true } } } } },
        },
        paymentMethod: true,
        customer: { select: { id: true, reference: true } },
      },
    });

    return {
      data: rows.slice(0, query.limit).map((subscription) => ({
        ...this.toView(subscription),
        customerReference: subscription.customer.reference,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async findById(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        items: {
          include: { variant: { include: { product: { select: { name: true, slug: true } } } } },
        },
        paymentMethod: true,
        events: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    if (!subscription) throw AppException.notFound('Subscription');
    return { ...this.toView(subscription), events: subscription.events };
  }

  // -------------------------------------------------------------------------

  private async requireOwned(subscriptionId: string, customerId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, customerId },
    });
    // Not found rather than forbidden: confirming that somebody else's
    // subscription exists is itself information.
    if (!subscription) throw AppException.notFound('Subscription');
    return subscription;
  }

  private assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
    if (!canTransitionSubscription(from, to)) {
      throw AppException.conflict(
        `A ${from.toLowerCase().replace(/_/g, ' ')} subscription cannot be ${to
          .toLowerCase()
          .replace(/_/g, ' ')}.`,
      );
    }
  }

  private async allocateReference(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = `SUB-${randomBytes(4).toString('hex').toUpperCase()}`;
      const clash = await this.prisma.subscription.findUnique({
        where: { reference },
        select: { id: true },
      });
      if (!clash) return reference;
    }
    throw AppException.conflict('Could not allocate a subscription reference. Try again.');
  }

  private toPaymentMethodView(method: {
    id: string;
    provider: string;
    cardBrand: string | null;
    cardLast4: string | null;
    expiryMonth: number | null;
    expiryYear: number | null;
    isDefault: boolean;
    createdAt: Date;
  }) {
    return {
      id: method.id,
      provider: method.provider,
      // Brand and last four. There is nothing else to show, because there is
      // nothing else this application ever received.
      cardBrand: method.cardBrand,
      cardLast4: method.cardLast4,
      expiryMonth: method.expiryMonth,
      expiryYear: method.expiryYear,
      isDefault: method.isDefault,
      createdAt: method.createdAt,
    };
  }

  private toView(subscription: {
    id: string;
    reference: string;
    status: string;
    interval: string;
    intervalCount: number;
    currency: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    nextBillingAt: Date | null;
    failedAttempts: number;
    lastFailureCode: string | null;
    shippingAddress: unknown;
    shippingMethodCode: string | null;
    pausedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    items: Array<{
      id: string;
      variantId: string;
      quantity: number;
      unitPriceCents: number;
      variant: { sku: string; name: string; product: { name: string; slug: string } };
    }>;
    paymentMethod: {
      id: string;
      cardBrand: string | null;
      cardLast4: string | null;
      detachedAt: Date | null;
    } | null;
  }) {
    const subtotalCents = subscription.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );

    return {
      id: subscription.id,
      reference: subscription.reference,
      status: subscription.status,
      interval: subscription.interval,
      intervalCount: subscription.intervalCount,
      currency: subscription.currency,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      nextBillingAt: subscription.nextBillingAt,
      failedAttempts: subscription.failedAttempts,
      lastFailureCode: subscription.lastFailureCode,
      shippingAddress: subscription.shippingAddress,
      shippingMethodCode: subscription.shippingMethodCode,
      pausedAt: subscription.pausedAt,
      cancelledAt: subscription.cancelledAt,
      createdAt: subscription.createdAt,
      items: subscription.items.map((item) => ({
        id: item.id,
        variantId: item.variantId,
        sku: item.variant.sku,
        productName: item.variant.product.name,
        productSlug: item.variant.product.slug,
        variantName: item.variant.name,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
      /** Goods only. Shipping and tax are computed at each renewal. */
      subtotalCents,
      paymentMethod: subscription.paymentMethod
        ? {
            id: subscription.paymentMethod.id,
            cardBrand: subscription.paymentMethod.cardBrand,
            cardLast4: subscription.paymentMethod.cardLast4,
            detached: subscription.paymentMethod.detachedAt !== null,
          }
        : null,
    };
  }
}
