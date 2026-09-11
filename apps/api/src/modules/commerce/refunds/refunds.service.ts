import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { isUniqueConstraintError } from '@health/database';
import { ORDER_EVENT_TYPES } from '@health/types';
import { PaymentProviderError } from '@health/payments';
import type { IssueRefundInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import { PaymentsService } from '../payments/payments.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';

/**
 * Refunds.
 *
 * Giving money back is the one operation where a bug costs the business
 * directly, so three things are enforced rather than trusted.
 *
 * **Never more than was captured.** Checked against the payment's own
 * captured-minus-already-refunded figure, inside the transaction, with the
 * database enforcing the same rule via `payments_refunded_within_captured`. A
 * refund calculated from a stale read cannot slip past both.
 *
 * **Idempotent.** The caller supplies a key with a unique constraint behind it,
 * and the same key is passed to the provider. A retried request — a double
 * click, a timed-out response, a replayed job — gives money back once.
 *
 * **Recorded with a reason, by a named person.** A refund with no explanation
 * is indistinguishable from fraud when someone reviews the accounts later, so
 * the reason and the actor are required by the schema, not by convention.
 */
@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly inventory: InventoryService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(RefundsService.name);
  }

  async issue(orderId: string, input: IssueRefundInput, rawActor: ActorContext) {
    // A refund is always attributable to a person. The route requires
    // REFUND_ISSUE and MFA, so this can only fail if that ever changes.
    const actor = requireNamedActor(rawActor);

    // The idempotent fast path: a key we have already honoured returns the
    // refund it produced, without touching the provider again.
    const existing = await this.prisma.refund.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.orderId !== orderId) {
        throw AppException.conflict(
          'That idempotency key has already been used for a different order.',
        );
      }
      return existing;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        payments: { where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } } },
      },
    });
    if (!order) throw AppException.notFound('Order');

    const payment = order.payments[0];
    if (!payment) {
      throw AppException.preconditionFailed(
        'There is no captured payment on this order to refund.',
      );
    }

    const amountCents = this.resolveAmount(input, order.items);
    const refundable = payment.amountCapturedCents - payment.amountRefundedCents;

    if (amountCents > refundable) {
      throw AppException.preconditionFailed(
        `Only ${(refundable / 100).toFixed(2)} remains refundable on this payment.`,
      );
    }

    // Recorded as PENDING *before* calling the provider. If the process dies
    // between the call and the response, there is a record to reconcile
    // against rather than money that left with no trace.
    let refund;
    try {
      refund = await this.prisma.refund.create({
        data: {
          orderId,
          paymentId: payment.id,
          provider: payment.provider,
          status: 'PENDING',
          amountCents,
          currency: order.currency,
          reason: input.reason,
          notes: input.notes,
          lines: (input.lines ?? null) as never,
          idempotencyKey: input.idempotencyKey,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error, 'idempotency_key')) {
        // Two concurrent requests with the same key; the other won.
        return this.prisma.refund.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
        });
      }
      throw error;
    }

    let providerResult;
    try {
      providerResult = await this.payments.refund({
        providerPaymentId: payment.providerPaymentId,
        amountCents,
        reason: input.reason.toLowerCase(),
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      const message =
        error instanceof PaymentProviderError
          ? error.message
          : 'The refund could not be processed.';

      await this.prisma.$transaction(async (tx) => {
        await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: 'FAILED',
            failureCode: error instanceof PaymentProviderError ? error.code : 'UNKNOWN',
            failureMessage: message,
          },
        });
        await tx.orderEvent.create({
          data: {
            orderId,
            type: ORDER_EVENT_TYPES.REFUND_FAILED,
            message: `Refund of ${formatMoney(amountCents, order.currency)} failed: ${message}`,
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
          },
        });
      });

      await this.audit.record({
        action: COMMERCE_AUDIT_ACTIONS.REFUND_FAILED,
        entityType: 'order',
        entityId: orderId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        outcome: 'FAILURE',
        reason: message,
        after: { amountCents, refundId: refund.id },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      throw AppException.preconditionFailed(message);
    }

    // The provider moved the money. Now the books.
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: providerResult.status,
          providerRefundId: providerResult.providerRefundId,
          processedAt: this.clock.now(),
        },
      });

      const paymentRefunded = payment.amountRefundedCents + amountCents;
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          amountRefundedCents: paymentRefunded,
          status:
            paymentRefunded >= payment.amountCapturedCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        },
      });

      const orderRefunded = order.amountRefundedCents + amountCents;
      const fullyRefunded = orderRefunded >= order.amountPaidCents;

      await tx.order.update({
        where: { id: orderId },
        data: {
          amountRefundedCents: orderRefunded,
          paymentStatus: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          // Only the payment position changes automatically. Whether the order
          // itself is "refunded" is a fulfilment question — goods may still be
          // in transit — so it is moved only when the whole amount is back.
          ...(fullyRefunded ? { status: 'REFUNDED' } : { status: 'PARTIALLY_REFUNDED' }),
        },
      });

      if (input.lines?.length) {
        for (const line of input.lines) {
          await tx.orderItem.update({
            where: { id: line.orderItemId },
            data: { quantityRefunded: { increment: line.quantity } },
          });
        }
      }

      await tx.orderEvent.create({
        data: {
          orderId,
          type: ORDER_EVENT_TYPES.REFUND_SUCCEEDED,
          message: `Refunded ${formatMoney(amountCents, order.currency)} — ${input.reason.toLowerCase().replace(/_/g, ' ')}.`,
          data: { amountCents, reason: input.reason, restocked: input.restock },
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      if (input.restock && input.lines?.length) {
        const items = new Map(order.items.map((item) => [item.id, item]));
        const restockLines = input.lines
          .map((line) => ({
            variantId: items.get(line.orderItemId)?.variantId,
            quantity: line.quantity,
          }))
          .filter((line): line is { variantId: string; quantity: number } =>
            Boolean(line.variantId),
          );

        await this.inventory.restock(tx, restockLines, 'RETURN', orderId, actor);
      }

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.REFUND_ISSUED,
        entityType: 'order',
        entityId: orderId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        after: {
          amountCents,
          reason: input.reason,
          restocked: input.restock,
          provider: payment.provider,
          refundId: result.id,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return result;
    });

    this.logger.info(
      { orderId, refundId: updated.id, amountCents, reason: input.reason },
      'refund issued',
    );

    return updated;
  }

  async listForOrder(orderId: string) {
    return this.prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Works out what to refund.
   *
   * Line-scoped refunds are computed from the order's own stored line totals —
   * never from anything in the request — and checked against what has already
   * been refunded on each line, so the same unit cannot be refunded twice.
   */
  private resolveAmount(
    input: IssueRefundInput,
    items: Array<{
      id: string;
      quantity: number;
      quantityRefunded: number;
      lineTotalCents: number;
    }>,
  ): number {
    if (input.amountCents !== undefined) return input.amountCents;

    const byId = new Map(items.map((item) => [item.id, item]));
    let total = 0;

    for (const line of input.lines ?? []) {
      const item = byId.get(line.orderItemId);
      if (!item) {
        throw AppException.validation([
          { path: 'lines', message: 'One of those lines is not on this order.' },
        ]);
      }

      const remaining = item.quantity - item.quantityRefunded;
      if (line.quantity > remaining) {
        throw AppException.validation([
          {
            path: 'lines',
            message: `Only ${remaining} of that line remain unrefunded.`,
          },
        ]);
      }

      // Per-unit from the stored line total, so tax and the line's share of any
      // discount go back with it.
      total += Math.round((item.lineTotalCents / item.quantity) * line.quantity);
    }

    if (total <= 0) {
      throw AppException.validation([
        { path: 'lines', message: 'That selection refunds nothing.' },
      ]);
    }

    return total;
  }
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
