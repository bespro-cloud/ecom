/**
 * Commerce state machines and money rules.
 *
 * Three ideas run through this file.
 *
 * **Money is an integer number of minor units.** There is no decimal type and
 * no float. A cent lost to binary rounding is a cent someone has to reconcile
 * by hand, and "someone" is an accountant at quarter end.
 *
 * **Status transitions are declared, not implied.** An order moves between
 * states by a rule written here, so an impossible transition is a refusal
 * rather than a corrupt record — and so the set of reachable states is
 * something you can read rather than infer from the call sites.
 *
 * **Payment status is the provider's fact, order status is ours.** They are
 * deliberately separate: a captured payment does not make an order shipped, and
 * a cancelled order does not un-take someone's money.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** ISO 4217 codes this platform supports. */
export const SUPPORTED_CURRENCIES = ['USD'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Minor units per major unit. Not every currency is 100 — this is not decorative. */
export const CURRENCY_MINOR_UNITS: Record<Currency, number> = { USD: 100 };

/**
 * Splits an amount across n shares without losing or inventing a cent.
 *
 * Used to spread an order-level discount or a shipping charge across lines.
 * The naive approach — round each share independently — either loses cents or
 * creates them, and both show up as an order whose lines do not sum to its
 * total. Here the remainder is distributed one cent at a time to the largest
 * weights, so the shares always sum exactly to the amount.
 */
export function allocateCents(amountCents: number, weights: number[]): number[] {
  if (!Number.isInteger(amountCents)) {
    throw new Error('allocateCents requires an integer amount of minor units');
  }
  if (weights.length === 0) return [];
  if (weights.some((weight) => weight < 0)) {
    throw new Error('allocateCents requires non-negative weights');
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight === 0) {
    // Nothing to weight by: spread evenly, remainder to the earliest shares.
    const base = Math.trunc(amountCents / weights.length);
    const shares = weights.map(() => base);
    let remainder = amountCents - base * weights.length;
    for (let index = 0; remainder !== 0; index = (index + 1) % shares.length) {
      shares[index]! += remainder > 0 ? 1 : -1;
      remainder += remainder > 0 ? -1 : 1;
    }
    return shares;
  }

  const exact = weights.map((weight) => (amountCents * weight) / totalWeight);
  const shares = exact.map((value) => Math.floor(value));
  let remainder = amountCents - shares.reduce((sum, share) => sum + share, 0);

  // Largest fractional part first: the standard largest-remainder method, so
  // the rounding is deterministic rather than dependent on input order.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let step = 0; remainder > 0; step += 1, remainder -= 1) {
    shares[order[step % order.length]!.index]! += 1;
  }

  return shares;
}

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Which order statuses can follow which.
 *
 * Notable absences, each deliberate:
 *
 *  - Nothing returns to `PENDING_PAYMENT`. Money has been taken; pretending
 *    otherwise would let a second capture look legitimate.
 *  - `CANCELLED` is terminal. An order that needs to come back is a new order,
 *    because the stock, the pricing and the payment are all different facts by
 *    then.
 *  - `DELIVERED` can still be refunded. Returns happen after delivery, which is
 *    exactly when they happen.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'],
  PAID: ['PROCESSING', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  PROCESSING: ['PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_SHIPPED: ['SHIPPED', 'DELIVERED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  SHIPPED: ['DELIVERED', 'REFUNDED', 'PARTIALLY_REFUNDED'],
  DELIVERED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED', 'SHIPPED', 'DELIVERED'],
  REFUNDED: [],
  CANCELLED: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses after which stock has been committed and must be released on cancel. */
export const ORDER_STATUSES_HOLDING_STOCK: readonly OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'PARTIALLY_SHIPPED',
];

/** An order a customer can still cancel themselves. */
export function isCustomerCancellable(status: OrderStatus): boolean {
  // Once anything has shipped it is a return, not a cancellation, and returns
  // go through a person.
  return status === 'PENDING_PAYMENT' || status === 'PAID';
}

// ---------------------------------------------------------------------------
// Payment status
// ---------------------------------------------------------------------------

export const PAYMENT_STATUSES = [
  'REQUIRES_PAYMENT',
  'PROCESSING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Payment transitions.
 *
 * `FAILED` is not terminal, because a provider can report a late success after
 * an initial failure — a 3-D Secure challenge completed in another tab, for
 * instance. Treating failure as final is how a paid order ends up looking
 * unpaid.
 */
export const PAYMENT_STATUS_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  REQUIRES_PAYMENT: ['PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED'],
  PROCESSING: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED'],
  AUTHORIZED: ['CAPTURED', 'FAILED', 'CANCELLED'],
  CAPTURED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  FAILED: ['PROCESSING', 'AUTHORIZED', 'CAPTURED', 'CANCELLED'],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_STATUS_TRANSITIONS[from].includes(to);
}

/** Whether money has actually been taken. */
export function isPaymentSettled(status: PaymentStatus): boolean {
  return status === 'CAPTURED' || status === 'PARTIALLY_REFUNDED' || status === 'REFUNDED';
}

// ---------------------------------------------------------------------------
// Fulfilment, checkout, cart
// ---------------------------------------------------------------------------

export const FULFILMENT_STATUSES = [
  'UNFULFILLED',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
  'CANCELLED',
] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

export const CHECKOUT_STATUSES = [
  'OPEN',
  'AWAITING_PAYMENT',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const CHECKOUT_STATUS_TRANSITIONS: Record<CheckoutStatus, readonly CheckoutStatus[]> = {
  OPEN: ['AWAITING_PAYMENT', 'CANCELLED', 'EXPIRED'],
  // A checkout can come back from AWAITING_PAYMENT: a customer who abandons the
  // payment step and edits their address has not done anything wrong.
  AWAITING_PAYMENT: ['OPEN', 'COMPLETED', 'CANCELLED', 'EXPIRED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: ['OPEN'],
};

export function canTransitionCheckout(from: CheckoutStatus, to: CheckoutStatus): boolean {
  return CHECKOUT_STATUS_TRANSITIONS[from].includes(to);
}

export const CART_STATUSES = ['ACTIVE', 'CONVERTED', 'ABANDONED'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

export const REFUND_REASONS = [
  'REQUESTED_BY_CUSTOMER',
  'DAMAGED',
  'NOT_AS_DESCRIBED',
  'NOT_DELIVERED',
  'RECALL',
  'DUPLICATE',
  'FRAUDULENT',
  'GOODWILL',
  'OTHER',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const INVENTORY_ADJUSTMENT_REASONS = [
  'RECEIPT',
  'CYCLE_COUNT',
  'DAMAGE',
  'EXPIRY',
  'THEFT',
  'RETURN',
  'CORRECTION',
  'FULFILMENT',
] as const;
export type InventoryAdjustmentReason = (typeof INVENTORY_ADJUSTMENT_REASONS)[number];

export const SHIPMENT_STATUSES = [
  'PENDING',
  'LABEL_PURCHASED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
  'EXCEPTION',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Order events
// ---------------------------------------------------------------------------

/**
 * The vocabulary of the order timeline.
 *
 * Declared rather than free-form so the timeline can be filtered, translated
 * and reasoned about — and so a new event type is a deliberate addition.
 */
export const ORDER_EVENT_TYPES = {
  PLACED: 'order.placed',
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_WEBHOOK_RECEIVED: 'payment.webhook.received',
  STATUS_CHANGED: 'order.status.changed',
  CANCELLED: 'order.cancelled',
  REFUND_REQUESTED: 'refund.requested',
  REFUND_SUCCEEDED: 'refund.succeeded',
  REFUND_FAILED: 'refund.failed',
  STOCK_RESERVED: 'inventory.reserved',
  STOCK_RELEASED: 'inventory.released',
  STOCK_COMMITTED: 'inventory.committed',
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_DISPATCHED: 'shipment.dispatched',
  SHIPMENT_DELIVERED: 'shipment.delivered',
  NOTE_ADDED: 'order.note.added',
} as const;

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[keyof typeof ORDER_EVENT_TYPES];

// ---------------------------------------------------------------------------
// Pricing shapes
// ---------------------------------------------------------------------------

export interface PricedLine {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
  discountCents: number;
  taxCents: number;
  lineTotalCents: number;
}

export interface PricedOrder {
  currency: Currency;
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  /**
   * Identifies exactly what was priced. If the cart changes between quoting and
   * paying, this changes, and the customer is shown the difference rather than
   * being charged a stale total.
   */
  fingerprint: string;
}

export interface ShippingQuote {
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}
