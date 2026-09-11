import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import {
  canTransitionOrder,
  isCustomerCancellable,
  ORDER_EVENT_TYPES,
  type OrderStatus,
} from '@health/types';
import type { CancelOrderInput, OrderAddressInput, OrderQuery } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { ActorContext } from '../../rbac/roles.service.js';

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * Orders.
 *
 * **An order is the financial record.** Product names, SKUs and prices are
 * copied onto its lines rather than joined at read time, because a listing can
 * be renamed, repriced or withdrawn and the invoice must still say what was
 * bought and what it cost. The stored totals are equally deliberate: an invoice
 * says what was charged, not what today's prices and tax rules would produce.
 *
 * **Status changes go through the state machine.** An impossible transition is
 * refused rather than written, so an order cannot walk backwards into
 * `PENDING_PAYMENT` after money has been taken.
 *
 * **Everything that happens is recorded on an append-only timeline.** It is
 * the first place anyone looks when a customer disputes a charge, and a
 * timeline that could be rewritten afterwards is not evidence of anything.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(OrdersService.name);
  }

  /**
   * Writes the order from a paid checkout.
   *
   * Everything happens in one transaction: the order, its lines, the
   * reservation hand-over from cart to order, the cart conversion and the
   * timeline. A partial write here would be an order with no stock held, or
   * stock held for an order that does not exist.
   */
  async placeFromCheckout(
    checkoutId: string,
    paymentId: string,
    actor: ActorContext,
  ): Promise<{ id: string; reference: string }> {
    const checkout = await this.prisma.checkout.findUnique({
      where: { id: checkoutId },
      include: {
        cart: {
          include: {
            items: {
              include: {
                variant: {
                  include: { product: { select: { id: true, name: true, priceCents: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!checkout) throw AppException.notFound('Checkout');

    const shippingAddress = checkout.shippingAddress as OrderAddressInput | null;
    if (!shippingAddress) {
      throw AppException.preconditionFailed('The checkout has no delivery address.');
    }
    if (checkout.cart.items.length === 0) {
      throw AppException.preconditionFailed('The basket is empty.');
    }

    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    // Priced once more from the *checkout's* stored totals, which were locked
    // when the customer confirmed. Re-pricing from the catalogue here would
    // risk charging a different number than the one they agreed to.
    const lines = checkout.cart.items.map((item) => {
      const unitPriceCents = item.variant.priceCents ?? item.variant.product.priceCents;
      return {
        productId: item.variant.product.id,
        variantId: item.variantId,
        sku: item.variant.sku,
        productName: item.variant.product.name,
        variantName: item.variant.name,
        quantity: item.quantity,
        unitPriceCents,
        lineSubtotalCents: unitPriceCents * item.quantity,
      };
    });

    const subtotalCents = lines.reduce((sum, line) => sum + line.lineSubtotalCents, 0);
    if (subtotalCents !== checkout.subtotalCents) {
      // The basket moved between confirmation and placement. Refusing is the
      // only safe answer: the customer agreed to one number and the goods now
      // add up to another.
      throw AppException.conflict(
        'The basket changed after payment was confirmed. This order has not been placed; contact support.',
      );
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          reference: await this.allocateReference(tx),
          checkoutId,
          customerId: checkout.cart.customerId,
          email: checkout.email ?? '',
          status: payment.status === 'CAPTURED' ? 'PAID' : 'PENDING_PAYMENT',
          paymentStatus: payment.status,
          currency: checkout.currency,
          subtotalCents: checkout.subtotalCents,
          discountCents: checkout.discountCents,
          shippingCents: checkout.shippingCents,
          taxCents: checkout.taxCents,
          totalCents: checkout.totalCents,
          amountPaidCents: payment.status === 'CAPTURED' ? payment.amountCapturedCents : 0,
          shippingAddress: shippingAddress as never,
          billingAddress: (checkout.billingAddress ?? null) as never,
          shippingMethodCode: checkout.shippingMethodCode,
          customerNote: checkout.cart.note,
          placedAt: this.clock.now(),
          ...(payment.status === 'CAPTURED' ? { paidAt: this.clock.now() } : {}),
        },
      });

      // Line-level discount and tax come from the checkout's own allocation, so
      // the lines sum to the order exactly — which the database also checks.
      const discountShares = allocateAcross(
        checkout.discountCents,
        lines.map((l) => l.lineSubtotalCents),
      );
      const taxShares = allocateAcross(
        checkout.taxCents,
        lines.map((l) => l.lineSubtotalCents),
      );

      await tx.orderItem.createMany({
        data: lines.map((line, index) => ({
          orderId: created.id,
          productId: line.productId,
          variantId: line.variantId,
          sku: line.sku,
          productName: line.productName,
          variantName: line.variantName,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          lineSubtotalCents: line.lineSubtotalCents,
          discountCents: discountShares[index]!,
          taxCents: taxShares[index]!,
          lineTotalCents: line.lineSubtotalCents - discountShares[index]! + taxShares[index]!,
        })),
      });

      await tx.payment.update({ where: { id: paymentId }, data: { orderId: created.id } });

      // The cart's holds become the order's. Re-reserving would open a window
      // in which someone else could take the stock.
      await this.inventory.commitToOrder(tx, checkout.cartId, created.id);

      await tx.cart.update({
        where: { id: checkout.cartId },
        // The token is kept, not cleared. `CartService.resolve` only ever
        // returns an ACTIVE cart, so this one can no longer be shopped in —
        // but the token still proves who the checkout belonged to, which is
        // what makes a repeated complete call idempotent rather than a 404.
        data: { status: 'CONVERTED', convertedAt: this.clock.now() },
      });

      await tx.checkout.update({
        where: { id: checkoutId },
        data: { status: 'COMPLETED', completedAt: this.clock.now() },
      });

      await tx.orderEvent.createMany({
        data: [
          {
            orderId: created.id,
            type: ORDER_EVENT_TYPES.PLACED,
            message: `Order ${created.reference} placed.`,
            data: { totalCents: created.totalCents, lineCount: lines.length },
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
          },
          {
            orderId: created.id,
            type: ORDER_EVENT_TYPES.STOCK_COMMITTED,
            message: 'Stock committed to this order.',
            isSystem: true,
          },
        ],
      });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.ORDER_PLACED,
        entityType: 'order',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: {
          reference: created.reference,
          totalCents: created.totalCents,
          provider: payment.provider,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    this.logger.info(
      { orderId: order.id, reference: order.reference, totalCents: order.totalCents },
      'order placed',
    );

    return { id: order.id, reference: order.reference };
  }

  /**
   * Moves an order between statuses.
   *
   * The transition is checked rather than assumed, and every change writes a
   * timeline entry, so "why is this order cancelled?" always has an answer.
   */
  async changeStatus(
    orderId: string,
    to: OrderStatus,
    actor: ActorContext,
    reason?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const from = order.status as OrderStatus;

      if (from === to) return;
      if (!canTransitionOrder(from, to)) {
        throw AppException.conflict(`An order cannot move from ${from} to ${to}.`);
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: to,
          ...(to === 'CANCELLED' ? { cancelledAt: this.clock.now() } : {}),
        },
      });

      await tx.orderEvent.create({
        data: {
          orderId,
          type: ORDER_EVENT_TYPES.STATUS_CHANGED,
          message: `Status changed from ${from.toLowerCase()} to ${to.toLowerCase()}.`,
          data: { from, to, reason: reason ?? null },
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
        entityType: 'order',
        entityId: orderId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: reason ?? null,
        before: { status: from },
        after: { status: to },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  /**
   * Cancels an order and releases its stock.
   *
   * Refunding is a separate, deliberate decision made by the caller, because
   * cancelling an unpaid order and cancelling a paid one are different acts
   * with different consequences.
   */
  async cancel(
    orderId: string,
    input: CancelOrderInput,
    actor: ActorContext,
  ): Promise<{ releasedStock: boolean }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw AppException.notFound('Order');

    const from = order.status as OrderStatus;
    if (!canTransitionOrder(from, 'CANCELLED')) {
      throw AppException.conflict(
        from === 'CANCELLED'
          ? 'This order is already cancelled.'
          : `An order that is ${from.toLowerCase().replace(/_/g, ' ')} cannot be cancelled. Refund or return it instead.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED', cancelledAt: this.clock.now() },
      });

      // Stock goes back on the shelf. Leaving it reserved for a cancelled order
      // is how a warehouse ends up unable to sell things it has.
      await this.inventory.releaseHeldIn(tx, { orderId });

      await tx.orderEvent.createMany({
        data: [
          {
            orderId,
            type: ORDER_EVENT_TYPES.CANCELLED,
            message: `Order cancelled: ${input.reason}`,
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
          },
          {
            orderId,
            type: ORDER_EVENT_TYPES.STOCK_RELEASED,
            message: 'Reserved stock released.',
            isSystem: true,
          },
        ],
      });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.ORDER_CANCELLED,
        entityType: 'order',
        entityId: orderId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        before: { status: from },
        after: { status: 'CANCELLED', refundRequested: input.refund },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return { releasedStock: true };
  }

  /** Whether the customer can cancel this themselves. */
  canCustomerCancel(status: OrderStatus): boolean {
    return isCustomerCancellable(status);
  }

  async addNote(
    orderId: string,
    note: string,
    isInternal: boolean,
    actor: ActorContext,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.orderEvent.create({
        data: {
          orderId,
          type: ORDER_EVENT_TYPES.NOTE_ADDED,
          message: note,
          data: { isInternal },
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      if (isInternal) {
        await tx.order.update({ where: { id: orderId }, data: { internalNote: note } });
      }

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.ORDER_NOTE_ADDED,
        entityType: 'order',
        entityId: orderId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { isInternal },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  async list(query: OrderQuery) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.email ? { email: query.email } : {}),
      ...(query.reference ? { reference: query.reference } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.from || query.to
        ? {
            placedAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.order.findMany({
      where,
      orderBy: { placedAt: 'desc' },
      take: query.limit + 1,
      include: { _count: { select: { items: true } } },
    });

    const hasMore = rows.length > query.limit;
    return { data: rows.slice(0, query.limit), meta: { hasMore } };
  }

  async findById(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'desc' }, take: 200 },
        payments: { orderBy: { createdAt: 'desc' } },
        refunds: { orderBy: { createdAt: 'desc' } },
        shipments: { orderBy: { createdAt: 'desc' }, include: { items: true } },
      },
    });
    if (!order) throw AppException.notFound('Order');
    return order;
  }

  /** A customer's own orders. Scoped by customer id, never by anything client-supplied. */
  async listForCustomer(customerId: string, limit = 50) {
    return this.prisma.order.findMany({
      where: { customerId },
      orderBy: { placedAt: 'desc' },
      take: limit,
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Allocates a customer-facing order reference.
   *
   * Deliberately not sequential: a sequential reference tells every customer
   * how many orders the business has taken, and lets anyone enumerate them. The
   * random suffix is checked for collision against the unique constraint, and
   * retried — over a large space, a retry is vanishingly rare and cheap.
   */
  private async allocateReference(tx: Tx): Promise<string> {
    const year = this.clock.now().getUTCFullYear();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = randomInt(0, 36 ** 6)
        .toString(36)
        .toUpperCase()
        .padStart(6, '0');
      const reference = `HC-${year}-${suffix}`;

      const clash = await tx.order.findUnique({ where: { reference }, select: { id: true } });
      if (!clash) return reference;
    }

    throw AppException.internal('could not allocate an order reference after five attempts');
  }
}

/**
 * Splits an amount across weights so the parts sum exactly to the whole.
 *
 * The same largest-remainder method the pricing engine uses. Duplicated here
 * deliberately rather than shared: the order lines must reproduce exactly what
 * the checkout quoted, and a future change to one should not silently change
 * the other.
 */
function allocateAcross(amountCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0 || amountCents === 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (amountCents * weight) / total);
  const shares = exact.map((value) => Math.floor(value));
  let remainder = amountCents - shares.reduce((sum, share) => sum + share, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let step = 0; remainder > 0; step += 1, remainder -= 1) {
    shares[order[step % order.length]!.index]! += 1;
  }

  return shares;
}
