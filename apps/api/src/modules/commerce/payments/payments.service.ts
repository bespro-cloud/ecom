import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { canTransitionPayment, type PaymentStatus } from '@health/types';
import {
  PaymentProviderError,
  WebhookSignatureError,
  type PaymentEvent,
  type PaymentProvider,
} from '@health/payments';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import { PAYMENT_PROVIDER } from './payment.provider.js';
import type { ActorContext } from '../../rbac/roles.service.js';

/**
 * Payments.
 *
 * **The provider is the only authority on whether money moved.** Nothing here
 * marks a payment captured because a browser said so. A payment settles when
 * the provider says it did, through one of two paths that deliberately
 * converge on the same idempotent handler: the API response to our own confirm
 * call, and a signature-verified webhook.
 *
 * **Webhooks are verified, then deduplicated, then applied.** In that order.
 * Verification decides whether the request is from the provider at all —
 * without it, the endpoint is a way for anyone on the internet to mark orders
 * as paid. Deduplication is by the provider's own event id, recorded in
 * `webhook_events`, because providers retry and will happily deliver the same
 * event several times.
 *
 * **No card data is stored.** The brand and last four digits exist so a
 * customer can recognise which card they used, and that is the entire extent
 * of it. There is no code path in this service that could persist a PAN.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(PaymentsService.name);
  }

  get providerName(): string {
    return this.provider.name;
  }

  /** False for the development adapter. Surfaced so the admin can label orders. */
  get isRealMoney(): boolean {
    return this.provider.isRealMoney;
  }

  /**
   * Creates (or re-uses) a payment intent for a checkout.
   *
   * The idempotency key is derived from the checkout, so retrying this step
   * returns the provider's existing intent rather than creating a second one
   * that could also be paid.
   */
  async createIntentForCheckout(input: {
    checkoutId: string;
    amountCents: number;
    currency: string;
    email: string;
    idempotencyKey: string;
    actor: ActorContext;
  }): Promise<{ provider: string; clientSecret: string | null }> {
    const existing = await this.prisma.payment.findFirst({
      where: {
        checkoutId: input.checkoutId,
        status: { in: ['REQUIRES_PAYMENT', 'PROCESSING', 'AUTHORIZED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    // An existing intent for a different amount is stale — the basket changed
    // after it was created — so it is cancelled rather than paid.
    if (existing && existing.amountCents !== input.amountCents) {
      await this.safeCancel(existing.providerPaymentId, `stale-${existing.id}`);
      await this.prisma.payment.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED' },
      });
    } else if (existing) {
      const refreshed = await this.provider.retrieveIntent(existing.providerPaymentId);
      return { provider: this.provider.name, clientSecret: refreshed.clientSecret };
    }

    let intent;
    try {
      intent = await this.provider.createIntent({
        amountCents: input.amountCents,
        currency: input.currency,
        reference: input.checkoutId,
        email: input.email,
        idempotencyKey: input.idempotencyKey,
        metadata: { checkoutId: input.checkoutId },
      });
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        throw error.retryable
          ? AppException.dependencyUnavailable('payment provider')
          : AppException.preconditionFailed(error.message);
      }
      throw error;
    }

    await this.prisma.payment.upsert({
      where: {
        provider_providerPaymentId: {
          provider: this.provider.name,
          providerPaymentId: intent.providerPaymentId,
        },
      },
      update: { amountCents: intent.amountCents, checkoutId: input.checkoutId },
      create: {
        checkoutId: input.checkoutId,
        provider: this.provider.name,
        providerPaymentId: intent.providerPaymentId,
        status: intent.status,
        currency: intent.currency,
        amountCents: intent.amountCents,
      },
    });

    await this.audit.record({
      action: COMMERCE_AUDIT_ACTIONS.PAYMENT_INTENT_CREATED,
      entityType: 'checkout',
      entityId: input.checkoutId,
      actorId: input.actor.actorId,
      actorLabel: input.actor.actorLabel,
      // The amount and provider, never the client secret: that is a credential
      // and the audit log is read by people who do not need it.
      after: {
        provider: this.provider.name,
        amountCents: intent.amountCents,
        isRealMoney: this.provider.isRealMoney,
      },
      ipAddress: input.actor.ipAddress ?? null,
      userAgent: input.actor.userAgent ?? null,
      correlationId: input.actor.correlationId,
    });

    return { provider: this.provider.name, clientSecret: intent.clientSecret };
  }

  /**
   * Asks the provider directly whether a checkout's payment has settled.
   *
   * Called when the customer returns from the payment step. Going to the
   * provider rather than trusting the redirect is the point: a return URL is
   * something anyone can navigate to.
   */
  async settledPaymentForCheckout(checkoutId: string): Promise<{ id: string } | null> {
    const payments = await this.prisma.payment.findMany({
      where: { checkoutId },
      orderBy: { createdAt: 'desc' },
    });

    for (const payment of payments) {
      if (payment.status === 'CAPTURED') return { id: payment.id };

      // Not settled in our records — ask the provider, because the webhook may
      // not have arrived yet.
      try {
        const intent = await this.provider.retrieveIntent(payment.providerPaymentId);
        if (intent.status === 'CAPTURED') {
          await this.applyIntentState(payment.id, {
            status: 'CAPTURED',
            amountCapturedCents: intent.amountCents,
            cardBrand: intent.cardBrand ?? null,
            cardLast4: intent.cardLast4 ?? null,
          });
          return { id: payment.id };
        }
      } catch (error) {
        this.logger.warn(
          { err: error, paymentId: payment.id },
          'could not confirm payment state with the provider',
        );
      }
    }

    return null;
  }

  /**
   * Handles an inbound webhook.
   *
   * Takes the **raw body**, because signatures are computed over exact bytes
   * and re-serialising JSON changes them.
   *
   * Returns whether the event was newly applied, so the controller can answer
   * 200 either way — a provider that gets an error for a duplicate will retry
   * forever.
   */
  async handleWebhook(
    rawBody: string,
    signature: string,
  ): Promise<{ received: true; duplicate: boolean; type: string }> {
    let event: PaymentEvent;
    try {
      event = this.provider.verifyAndParseWebhook(rawBody, signature);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        // Recorded as an audit event, not just a log line: repeated failures
        // here mean someone is probing the endpoint.
        await this.audit.record({
          action: COMMERCE_AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
          actorType: 'SYSTEM',
          entityType: 'payment_webhook',
          outcome: 'FAILURE',
          reason: error.message,
          after: { provider: this.provider.name },
        });
        throw AppException.forbidden('FORBIDDEN', 'The webhook signature did not verify.');
      }
      throw error;
    }

    // Deduplicate on the provider's own event id, through the unique
    // constraint rather than a read-then-write. Providers retry aggressively
    // and often in parallel; a "check if seen, then insert" has a window
    // between the two statements in which both copies pass the check, and a
    // capture applied twice is a double-counted payment.
    const record = await this.prisma.webhookEvent.upsert({
      where: {
        provider_externalId: { provider: this.provider.name, externalId: event.id },
      },
      update: { attempts: { increment: 1 } },
      create: {
        provider: this.provider.name,
        externalId: event.id,
        eventType: event.rawType,
        status: 'PROCESSING',
        attempts: 1,
        // The verified payload, so a failed application can be replayed
        // without asking the provider to resend.
        payload: JSON.parse(rawBody) as never,
      },
    });

    if (record.status === 'PROCESSED') {
      return { received: true, duplicate: true, type: event.rawType };
    }

    try {
      await this.applyEvent(event);
      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: { status: 'PROCESSED', processedAt: this.clock.now() },
      });
    } catch (error) {
      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: {
          status: 'FAILED',
          lastError: error instanceof Error ? error.message : 'unknown error',
        },
      });
      throw error;
    }

    return { received: true, duplicate: false, type: event.rawType };
  }

  /** Refunds through the provider, returning its result. */
  async refund(input: {
    providerPaymentId: string;
    amountCents: number;
    reason: string;
    idempotencyKey: string;
  }) {
    return this.provider.refund(input);
  }

  // -------------------------------------------------------------------------

  private async applyEvent(event: PaymentEvent): Promise<void> {
    if (!event.providerPaymentId) {
      // Nothing to attach it to. Recorded as processed rather than failed: an
      // event we do not act on is not an error.
      this.logger.info({ type: event.rawType }, 'webhook carried no payment reference');
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: {
        provider_providerPaymentId: {
          provider: this.provider.name,
          providerPaymentId: event.providerPaymentId,
        },
      },
    });

    if (!payment) {
      // An event for a payment we have no record of. Worth noticing, not worth
      // failing: it may belong to another environment sharing a provider
      // account.
      this.logger.warn(
        { providerPaymentId: event.providerPaymentId, type: event.rawType },
        'webhook referenced an unknown payment',
      );
      return;
    }

    switch (event.type) {
      case 'payment.captured':
        await this.applyIntentState(payment.id, {
          status: 'CAPTURED',
          amountCapturedCents: event.amountCents ?? payment.amountCents,
          cardBrand: event.cardBrand,
          cardLast4: event.cardLast4,
        });
        break;

      case 'payment.authorized':
        await this.applyIntentState(payment.id, { status: 'AUTHORIZED' });
        break;

      case 'payment.failed':
        await this.applyIntentState(payment.id, {
          status: 'FAILED',
          failureCode: event.failureCode,
          failureMessage: event.failureMessage,
        });
        await this.audit.record({
          action: COMMERCE_AUDIT_ACTIONS.PAYMENT_FAILED,
          actorType: 'SYSTEM',
          entityType: 'payment',
          entityId: payment.id,
          outcome: 'FAILURE',
          reason: event.failureCode ?? 'unknown',
          after: { provider: this.provider.name },
        });
        break;

      case 'payment.cancelled':
        await this.applyIntentState(payment.id, { status: 'CANCELLED' });
        break;

      case 'refund.succeeded':
      case 'refund.failed':
        // Refund state is owned by the refunds service, which reconciles
        // against the provider. Recorded here so the timeline is complete.
        this.logger.info({ paymentId: payment.id, type: event.rawType }, 'refund webhook received');
        break;

      default:
        this.logger.debug({ type: event.rawType }, 'ignoring unmapped webhook event');
    }
  }

  /**
   * Applies a provider-reported state to a payment, and to its order.
   *
   * Guarded by the payment state machine, so an out-of-order webhook — which
   * providers do deliver — cannot walk a captured payment backwards.
   */
  private async applyIntentState(
    paymentId: string,
    update: {
      status: PaymentStatus;
      amountCapturedCents?: number;
      cardBrand?: string | null;
      cardLast4?: string | null;
      failureCode?: string | null;
      failureMessage?: string | null;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const from = payment.status as PaymentStatus;

      if (from === update.status) return;

      if (!canTransitionPayment(from, update.status)) {
        this.logger.warn(
          { paymentId, from, to: update.status },
          'ignoring an out-of-order payment transition',
        );
        return;
      }

      const now = this.clock.now();
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: update.status,
          ...(update.amountCapturedCents !== undefined
            ? { amountCapturedCents: update.amountCapturedCents }
            : {}),
          ...(update.cardBrand !== undefined ? { cardBrand: update.cardBrand } : {}),
          ...(update.cardLast4 !== undefined ? { cardLast4: update.cardLast4 } : {}),
          ...(update.failureCode !== undefined ? { failureCode: update.failureCode } : {}),
          ...(update.failureMessage !== undefined ? { failureMessage: update.failureMessage } : {}),
          ...(update.status === 'AUTHORIZED' ? { authorizedAt: now } : {}),
          ...(update.status === 'CAPTURED' ? { capturedAt: now } : {}),
          ...(update.status === 'FAILED' ? { failedAt: now } : {}),
        },
      });

      if (payment.orderId && update.status === 'CAPTURED') {
        const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
        await tx.order.update({
          where: { id: payment.orderId },
          data: {
            paymentStatus: 'CAPTURED',
            amountPaidCents: update.amountCapturedCents ?? payment.amountCents,
            ...(order.status === 'PENDING_PAYMENT' ? { status: 'PAID', paidAt: now } : {}),
          },
        });

        await tx.orderEvent.create({
          data: {
            orderId: payment.orderId,
            type: 'payment.captured',
            message: `Payment captured via ${this.provider.name}.`,
            data: { amountCents: update.amountCapturedCents ?? payment.amountCents },
            isSystem: true,
          },
        });
      }
    });
  }

  private async safeCancel(providerPaymentId: string, idempotencyKey: string): Promise<void> {
    try {
      await this.provider.cancel(providerPaymentId, idempotencyKey);
    } catch (error) {
      // A stale intent that cannot be cancelled is untidy, not dangerous: it
      // was never paid and will expire at the provider.
      this.logger.warn({ err: error, providerPaymentId }, 'could not cancel a stale intent');
    }
  }
}
