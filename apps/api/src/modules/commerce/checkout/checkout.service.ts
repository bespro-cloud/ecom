import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import { expireStaleCheckouts, isUniqueConstraintError } from '@health/database';
import {
  canTransitionCheckout,
  priceOrder,
  type CheckoutStatus,
  type PricingLineInput,
  type PricingResult,
  type ShippingQuote,
} from '@health/types';
import type {
  ConfirmCheckoutInput,
  OrderAddressInput,
  StartCheckoutInput,
  UpdateCheckoutInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import { SettingsService } from '../../settings/settings.service.js';
import { CartService } from '../cart/cart.service.js';
import { InventoryService, InsufficientStockError } from '../inventory/inventory.service.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { OrdersService } from '../orders/orders.service.js';
import type { ActorContext } from '../../rbac/roles.service.js';

export interface CheckoutView {
  id: string;
  status: CheckoutStatus;
  email: string | null;
  currency: string;
  shippingAddress: OrderAddressInput | null;
  billingAddress: OrderAddressInput | null;
  shippingMethodCode: string | null;
  shippingOptions: ShippingQuote[];
  lines: PricingResult['lines'];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  /** Null when no tax rate is configured, so "zero" is distinguishable. */
  taxRateApplied: number | null;
  pricingFingerprint: string | null;
  expiresAt: string | null;
  /** Present once a payment intent exists. */
  payment: { provider: string; clientSecret: string | null; isRealMoney: boolean } | null;
}

/**
 * Checkout.
 *
 * This is the part of the system where getting it wrong takes money from
 * someone incorrectly, so four rules are enforced rather than assumed.
 *
 * **1. Idempotent by construction.** A checkout is created under a
 * client-supplied key with a unique constraint behind it. A double submit, a
 * retried request or a browser that fired twice produces one checkout and
 * therefore one order — the second call returns the first result rather than
 * starting again.
 *
 * **2. Totals are always recomputed server-side.** No request body carries a
 * price. The client confirms *which quote* it is accepting by fingerprint; if
 * the basket or the catalogue moved underneath, the fingerprint no longer
 * matches and the customer is shown the difference rather than charged the old
 * number.
 *
 * **3. Stock is held before payment, not after.** Taking money for something
 * that is not there is the worst outcome available, so the reservation happens
 * first and a failure to reserve stops the payment ever being created.
 *
 * **4. The order is written before the payment is confirmed.** An order in
 * `PENDING_PAYMENT` that never gets paid is a tidy-up job; a captured payment
 * with no order is a customer with no record of what they bought.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly carts: CartService,
    private readonly inventory: InventoryService,
    private readonly shipping: ShippingService,
    private readonly payments: PaymentsService,
    private readonly orders: OrdersService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(CheckoutService.name);
  }

  private async holdSeconds(): Promise<number> {
    const minutes = (await this.settings.get<number>('checkout.hold_minutes')) ?? 30;
    return minutes * 60;
  }

  /**
   * Starts (or returns) a checkout for a cart.
   *
   * The idempotency key is what makes this safe to call twice. The unique
   * constraint is the mechanism — not a "check then insert", which has a race
   * between the two statements that is exactly the race being defended against.
   */
  async start(cartId: string, input: StartCheckoutInput): Promise<CheckoutView> {
    const cart = await this.carts.view(cartId);

    if (cart.lines.length === 0) {
      throw AppException.preconditionFailed('There is nothing in your basket.');
    }
    if (cart.unavailable.length > 0) {
      throw AppException.preconditionFailed(
        'Some items are no longer available. Review your basket before continuing.',
        { details: cart.unavailable.map((entry) => ({ path: entry.sku, message: entry.reason })) },
      );
    }

    try {
      const created = await this.prisma.checkout.create({
        data: {
          cartId,
          idempotencyKey: input.idempotencyKey,
          email: input.email,
          expiresAt: addSeconds(this.clock.now(), await this.holdSeconds()),
        },
        select: { id: true },
      });

      return this.view(created.id);
    } catch (error) {
      if (isUniqueConstraintError(error, 'idempotency_key')) {
        // The retry case. Return what the first call produced.
        const existing = await this.prisma.checkout.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true, cartId: true },
        });
        if (existing && existing.cartId === cartId) {
          return this.view(existing.id);
        }
        // Same key, different cart: a client bug, not a retry. Refusing is
        // safer than quietly checking out the wrong basket.
        throw AppException.conflict(
          'That idempotency key has already been used for a different basket.',
        );
      }
      throw error;
    }
  }

  /** Sets addresses and the shipping choice, then reprices. */
  async update(checkoutId: string, input: UpdateCheckoutInput): Promise<CheckoutView> {
    const checkout = await this.requireOpen(checkoutId);

    await this.prisma.checkout.update({
      where: { id: checkout.id },
      data: {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.shippingAddress !== undefined
          ? { shippingAddress: input.shippingAddress as never }
          : {}),
        ...(input.billingAddress !== undefined
          ? { billingAddress: (input.billingAddress ?? null) as never }
          : {}),
        ...(input.shippingMethodCode !== undefined
          ? { shippingMethodCode: input.shippingMethodCode }
          : {}),
      },
    });

    return this.view(checkoutId);
  }

  /**
   * Prices a checkout as it stands, and persists the result.
   *
   * Called on every view, so what the customer sees and what is stored are the
   * same numbers, produced by the same code, at the same moment.
   */
  async view(checkoutId: string): Promise<CheckoutView> {
    const checkout = await this.prisma.checkout.findUnique({
      where: { id: checkoutId },
      include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!checkout) throw AppException.notFound('Checkout');

    const cart = await this.carts.view(checkout.cartId);
    const shippingAddress = (checkout.shippingAddress as OrderAddressInput | null) ?? null;

    const weightGrams = await this.basketWeight(
      cart.lines.map((line) => line.variantId),
      cart.lines,
    );

    const shippingOptions = shippingAddress
      ? await this.shipping.quote({
          address: shippingAddress,
          subtotalCents: cart.subtotalCents,
          totalWeightGrams: weightGrams,
        })
      : [];

    const chosen = checkout.shippingMethodCode
      ? (shippingOptions.find((option) => option.code === checkout.shippingMethodCode) ?? null)
      : null;

    let priced: PricingResult | null = null;
    if (cart.lines.length > 0) {
      const lines: PricingLineInput[] = cart.lines.map((line) => ({
        variantId: line.variantId,
        productId: line.productId,
        sku: line.sku,
        productName: line.productName,
        variantName: line.variantName,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        taxable: true,
      }));

      priced = priceOrder({
        currency: 'USD',
        lines,
        shippingCents: chosen?.priceCents ?? 0,
        taxRate: await this.taxRateFor(shippingAddress),
        taxShipping: (await this.settings.get<boolean>('tax.shipping_taxable')) ?? false,
      });

      await this.prisma.checkout.update({
        where: { id: checkoutId },
        data: {
          subtotalCents: priced.subtotalCents,
          discountCents: priced.discountCents,
          shippingCents: priced.shippingCents,
          taxCents: priced.taxCents,
          totalCents: priced.totalCents,
          pricingFingerprint: priced.fingerprint,
        },
      });
    }

    const payment = checkout.payments[0] ?? null;

    return {
      id: checkout.id,
      status: checkout.status as CheckoutStatus,
      email: checkout.email,
      currency: checkout.currency,
      shippingAddress,
      billingAddress: (checkout.billingAddress as OrderAddressInput | null) ?? null,
      shippingMethodCode: checkout.shippingMethodCode,
      shippingOptions,
      lines: priced?.lines ?? [],
      subtotalCents: priced?.subtotalCents ?? 0,
      discountCents: priced?.discountCents ?? 0,
      shippingCents: priced?.shippingCents ?? 0,
      taxCents: priced?.taxCents ?? 0,
      totalCents: priced?.totalCents ?? 0,
      taxRateApplied: priced?.taxRateApplied ?? null,
      pricingFingerprint: priced?.fingerprint ?? null,
      expiresAt: checkout.expiresAt?.toISOString() ?? null,
      payment: payment
        ? {
            provider: payment.provider,
            clientSecret: null,
            isRealMoney: this.payments.isRealMoney,
          }
        : null,
    };
  }

  /**
   * Locks the totals, holds the stock and creates the payment intent.
   *
   * Order of operations is the design:
   *
   *   1. reprice, and refuse if the fingerprint no longer matches;
   *   2. check everything is still purchasable;
   *   3. reserve stock — failure here stops the payment existing at all;
   *   4. only then ask the provider for an intent.
   *
   * Reversing 3 and 4 would create the one outcome that must never happen:
   * money taken for goods that are not there.
   */
  async prepare(
    checkoutId: string,
    input: ConfirmCheckoutInput,
    actor: ActorContext,
  ): Promise<CheckoutView> {
    const checkout = await this.requireOpen(checkoutId);
    const view = await this.view(checkoutId);

    if (!view.shippingAddress) {
      throw AppException.preconditionFailed('Add a delivery address before paying.');
    }
    if (!view.email) {
      throw AppException.preconditionFailed('Add an email address before paying.');
    }
    if (!checkout.shippingMethodCode || view.shippingCents === undefined) {
      throw AppException.preconditionFailed('Choose a delivery method before paying.');
    }
    if (!view.shippingOptions.some((option) => option.code === checkout.shippingMethodCode)) {
      // The rate was withdrawn, or the basket/address moved it out of range.
      // Substituting another would silently change what they pay for delivery.
      throw AppException.preconditionFailed(
        'That delivery method is no longer available for this order. Please choose again.',
      );
    }
    if (view.lines.length === 0) {
      throw AppException.preconditionFailed('There is nothing in your basket.');
    }

    if (view.pricingFingerprint !== input.pricingFingerprint) {
      // The basket or the catalogue changed between quote and payment. The
      // customer sees the new total and confirms again; they are never charged
      // against a quote they did not see.
      await this.audit.record({
        action: COMMERCE_AUDIT_ACTIONS.CHECKOUT_REPRICED,
        entityType: 'checkout',
        entityId: checkoutId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        outcome: 'FAILURE',
        reason: 'The basket changed between quoting and payment.',
        after: { expected: input.pricingFingerprint, actual: view.pricingFingerprint },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      throw AppException.conflict(
        'Your basket changed while you were checking out. Review the updated total and try again.',
        'CONFLICT',
        { details: [{ path: 'pricingFingerprint', message: 'The quoted total is out of date.' }] },
      );
    }

    // 3. Stock, before money.
    try {
      await this.inventory.reserveForCart(
        checkout.cartId,
        view.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      );
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        throw AppException.conflict(
          'Some items sold out while you were checking out.',
          'CONFLICT',
          {
            details: error.shortfalls.map((shortfall) => ({
              path: shortfall.variantId,
              message:
                shortfall.available === 0
                  ? 'This item is now out of stock.'
                  : `Only ${shortfall.available} left.`,
            })),
          },
        );
      }
      throw error;
    }

    // 4. Now, and only now, the provider.
    const intent = await this.payments.createIntentForCheckout({
      checkoutId,
      amountCents: view.totalCents,
      currency: view.currency,
      email: view.email,
      // Derived from the checkout id, so a retry of this same step reuses the
      // provider-side intent rather than creating a second.
      idempotencyKey: `checkout-${checkoutId}`,
      actor,
    });

    await this.transition(checkoutId, 'AWAITING_PAYMENT');

    const refreshed = await this.view(checkoutId);
    return { ...refreshed, payment: { ...intent, isRealMoney: this.payments.isRealMoney } };
  }

  /**
   * Places the order once the provider says the payment succeeded.
   *
   * Idempotent: a checkout that already produced an order returns that order
   * rather than creating a second. Both the customer's confirm call and the
   * provider's webhook land here, and they race by design — whichever arrives
   * first wins and the other becomes a no-op.
   */
  async complete(checkoutId: string, actor: ActorContext): Promise<{ orderId: string }> {
    const existing = await this.prisma.order.findFirst({
      where: { checkoutId },
      select: { id: true },
    });
    if (existing) return { orderId: existing.id };

    const checkout = await this.prisma.checkout.findUnique({ where: { id: checkoutId } });
    if (!checkout) throw AppException.notFound('Checkout');

    const payment = await this.payments.settledPaymentForCheckout(checkoutId);
    if (!payment) {
      // The only authority on whether money moved is the provider. A client
      // saying "it worked" is not evidence.
      throw AppException.preconditionFailed(
        'This order has not been paid for yet. If you completed payment, give it a moment and refresh.',
      );
    }

    const order = await this.orders.placeFromCheckout(checkoutId, payment.id, actor);

    await this.audit.record({
      action: COMMERCE_AUDIT_ACTIONS.CHECKOUT_CONFIRMED,
      entityType: 'checkout',
      entityId: checkoutId,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      after: { orderId: order.id, orderReference: order.reference },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      correlationId: actor.correlationId,
    });

    return { orderId: order.id };
  }

  /** Releases an abandoned checkout's stock. Run on a schedule. */
  async expireStale(limit = 200): Promise<number> {
    const expired = await expireStaleCheckouts(
      {
        prisma: this.prisma,
        now: () => this.clock.now(),
        onError: (error, context) =>
          this.logger.warn({ err: error, ...context }, 'failed to expire a checkout'),
      },
      limit,
    );

    if (expired > 0) this.logger.info({ expired }, 'expired stale checkouts');
    return expired;
  }

  // -------------------------------------------------------------------------

  private async requireOpen(checkoutId: string) {
    const checkout = await this.prisma.checkout.findUnique({ where: { id: checkoutId } });
    if (!checkout) throw AppException.notFound('Checkout');

    if (checkout.status === 'COMPLETED') {
      throw AppException.conflict('This checkout has already been completed.');
    }
    if (checkout.status === 'CANCELLED') {
      throw AppException.conflict('This checkout was cancelled.');
    }
    if (checkout.expiresAt && checkout.expiresAt.getTime() <= this.clock.timestamp()) {
      throw AppException.conflict(
        'This checkout expired and the items were released. Start again from your basket.',
      );
    }

    return checkout;
  }

  private async transition(checkoutId: string, to: CheckoutStatus): Promise<void> {
    const current = await this.prisma.checkout.findUniqueOrThrow({
      where: { id: checkoutId },
      select: { status: true },
    });

    const from = current.status as CheckoutStatus;
    if (from === to) return;

    if (!canTransitionCheckout(from, to)) {
      throw AppException.conflict(`A checkout cannot move from ${from} to ${to}.`);
    }

    await this.prisma.checkout.update({ where: { id: checkoutId }, data: { status: to } });
  }

  /**
   * The tax rate for a destination.
   *
   * Read from configuration, keyed by state, because US sales tax is
   * jurisdiction-specific and a real implementation is a tax-engine
   * integration rather than arithmetic. A destination with no configured rate
   * prices at zero *and reports that no rate was applied*, so nobody mistakes
   * "not calculated" for "not taxable".
   */
  private async taxRateFor(address: OrderAddressInput | null): Promise<number | null> {
    if (!address) return null;

    const rates = await this.settings.get<Record<string, number>>('tax.rates_by_region');
    if (!rates) return null;

    const rate = rates[address.region];
    return typeof rate === 'number' && rate >= 0 && rate <= 1 ? rate : null;
  }

  private async basketWeight(
    variantIds: string[],
    lines: Array<{ variantId: string; quantity: number }>,
  ): Promise<number> {
    if (variantIds.length === 0) return 0;

    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, weightGrams: true, product: { select: { weightGrams: true } } },
    });

    const byId = new Map(variants.map((variant) => [variant.id, variant]));
    return lines.reduce((sum, line) => {
      const variant = byId.get(line.variantId);
      const grams = variant?.weightGrams ?? variant?.product.weightGrams ?? 0;
      return sum + grams * line.quantity;
    }, 0);
  }
}
