import { z } from 'zod';
import {
  INVENTORY_ADJUSTMENT_REASONS,
  ORDER_STATUSES,
  REFUND_REASONS,
  SHIPMENT_STATUSES,
} from '@health/types';
import { paginationSchema, uuidSchema } from './primitives.js';
// Money has one definition in this codebase, and it lives with the catalogue
// schemas that introduced it.
import { moneyCentsSchema } from './catalogue.js';

/**
 * Commerce request validation.
 *
 * One rule shapes all of it: **no request may name a price.** Quantities,
 * identifiers and choices come from the client; every monetary value comes from
 * the catalogue or from configuration. There is deliberately no field on any
 * schema here that a caller could use to say what something costs.
 */

/** Bounded so one request cannot become a denial-of-service by arithmetic. */
export const quantitySchema = z
  .number()
  .int('Enter a whole number.')
  .min(1, 'Enter at least one.')
  .max(999, 'That is more than we can sell in a single order. Contact us for bulk orders.');

/**
 * Idempotency keys.
 *
 * Supplied by the client and unique per attempt. This is what makes a double
 * submit, a retried request or a flaky network produce one order rather than
 * two, so the format is checked rather than trusted: an unbounded key is a
 * storage problem and a colliding one is a correctness problem.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16, 'An idempotency key must be at least 16 characters.')
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores.');

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * A shipping or billing address.
 *
 * Copied onto the order rather than referenced, so an order keeps the address
 * it was shipped to even after the customer edits their address book.
 */
export const orderAddressSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter a first name.').max(100),
  lastName: z.string().trim().min(1, 'Enter a last name.').max(100),
  company: z.string().trim().max(120).optional(),
  line1: z.string().trim().min(1, 'Enter a street address.').max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1, 'Enter a city.').max(100),
  region: z
    .string()
    .trim()
    .toUpperCase()
    .length(2, 'Use the two-letter state code.')
    .regex(/^[A-Z]{2}$/),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, 'Enter a five-digit ZIP code.'),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .length(2)
    .default('US')
    // Serviceability is a business rule read from settings, but a country this
    // platform has never shipped to is refused at the edge rather than deep in
    // a fulfilment call.
    .refine((value) => value === 'US', 'We currently ship within the United States only.'),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[\d\s()+-]*$/, 'Enter a phone number.')
    .optional(),
});
export type OrderAddressInput = z.infer<typeof orderAddressSchema>;

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export const addCartItemSchema = z.object({
  variantId: uuidSchema,
  quantity: quantitySchema.default(1),
});
export type AddCartItemInput = z.infer<typeof addCartItemSchema>;

export const updateCartItemSchema = z.object({
  /** Zero removes the line. Anything else is a quantity. */
  quantity: z.number().int().min(0).max(999),
});
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;

export const cartNoteSchema = z.object({
  note: z.string().trim().max(1000).nullable(),
});
export type CartNoteInput = z.infer<typeof cartNoteSchema>;

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export const startCheckoutSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(320),
});
export type StartCheckoutInput = z.infer<typeof startCheckoutSchema>;

export const updateCheckoutSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  shippingAddress: orderAddressSchema.optional(),
  billingAddress: orderAddressSchema.nullish(),
  shippingMethodCode: z.string().trim().max(60).optional(),
});
export type UpdateCheckoutInput = z.infer<typeof updateCheckoutSchema>;

/**
 * Confirming a checkout.
 *
 * `pricingFingerprint` is the customer's agreement to a specific set of totals.
 * The server re-prices and refuses if it no longer matches, which is what stops
 * a repriced catalogue or an edited cart being charged at a stale total.
 *
 * Note what is absent: no amount, no currency, no line prices. The client
 * confirms *which quote* it is accepting, never *what* it costs.
 */
export const confirmCheckoutSchema = z.object({
  pricingFingerprint: z.string().trim().min(8).max(64),
  /** The provider's client-side token, where the provider issues one. */
  paymentMethodToken: z.string().trim().max(500).optional(),
});
export type ConfirmCheckoutInput = z.infer<typeof confirmCheckoutSchema>;

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const orderQuerySchema = paginationSchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  email: z.string().trim().toLowerCase().max(320).optional(),
  reference: z.string().trim().max(40).optional(),
  customerId: uuidSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type OrderQuery = z.infer<typeof orderQuerySchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(5, 'Record why this order is being cancelled.').max(500),
  /** Refund any captured payment as part of the cancellation. */
  refund: z.boolean().default(true),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const orderNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
  /** Internal notes are never shown to the customer. */
  isInternal: z.boolean().default(true),
});
export type OrderNoteInput = z.infer<typeof orderNoteSchema>;

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Issuing a refund.
 *
 * `amountCents` is the one place a caller names money, and it is deliberate: a
 * partial refund is a human decision about how much to give back. It is
 * validated server-side against what was actually captured and not already
 * refunded, so the number is a request rather than an instruction.
 */
export const issueRefundSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    amountCents: moneyCentsSchema.positive('A refund must be for more than zero.').optional(),
    /** Refund specific lines instead of naming an amount. */
    lines: z
      .array(z.object({ orderItemId: uuidSchema, quantity: quantitySchema }))
      .max(200)
      .optional(),
    reason: z.enum(REFUND_REASONS),
    notes: z.string().trim().min(10, 'Record why this refund is being issued.').max(2000),
    /** Return the refunded units to sellable stock. */
    restock: z.boolean().default(false),
  })
  .refine((value) => value.amountCents !== undefined || (value.lines?.length ?? 0) > 0, {
    message: 'Give an amount, or the lines being refunded.',
    path: ['amountCents'],
  });
export type IssueRefundInput = z.infer<typeof issueRefundSchema>;

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export const createWarehouseSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(20)
    .regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores.'),
  name: z.string().trim().min(2).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().toUpperCase().length(2),
  postalCode: z.string().trim().min(3).max(20),
  country: z.string().trim().toUpperCase().length(2).default('US'),
  priority: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = createWarehouseSchema.partial().omit({ code: true });
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export const upsertInventorySchema = z.object({
  variantId: uuidSchema,
  warehouseId: uuidSchema,
  reorderPoint: z.number().int().min(0).max(1_000_000).optional(),
  trackInventory: z.boolean().optional(),
  allowBackorder: z.boolean().optional(),
});
export type UpsertInventoryInput = z.infer<typeof upsertInventorySchema>;

/**
 * A stock adjustment.
 *
 * The delta is signed and the reason is required, because the adjustment ledger
 * is the only answer to "we are eleven units short". An adjustment with no
 * reason is a number nobody can act on later.
 */
export const adjustInventorySchema = z.object({
  variantId: uuidSchema,
  warehouseId: uuidSchema,
  quantityDelta: z
    .number()
    .int('Enter a whole number of units.')
    .refine((value) => value !== 0, 'An adjustment of zero changes nothing.')
    .refine((value) => Math.abs(value) <= 1_000_000, 'That is larger than any real adjustment.'),
  reason: z.enum(INVENTORY_ADJUSTMENT_REASONS),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;

export const inventoryQuerySchema = paginationSchema.extend({
  warehouseId: uuidSchema.optional(),
  search: z.string().trim().max(200).optional(),
  /** Only rows at or below their reorder point. */
  lowStockOnly: z.coerce.boolean().optional(),
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

// ---------------------------------------------------------------------------
// Shipping and fulfilment
// ---------------------------------------------------------------------------

export const createShippingRateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, numbers, hyphens and underscores.'),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).optional(),
    countries: z.array(z.string().trim().toUpperCase().length(2)).min(1).max(50).default(['US']),
    regions: z.array(z.string().trim().toUpperCase().length(2)).max(60).default([]),
    priceCents: moneyCentsSchema,
    freeAboveSubtotalCents: moneyCentsSchema.nullish(),
    minWeightGrams: z.number().int().min(0).max(1_000_000).nullish(),
    maxWeightGrams: z.number().int().min(0).max(1_000_000).nullish(),
    minSubtotalCents: moneyCentsSchema.nullish(),
    maxSubtotalCents: moneyCentsSchema.nullish(),
    estimatedDaysMin: z.number().int().min(0).max(365).nullish(),
    estimatedDaysMax: z.number().int().min(0).max(365).nullish(),
    position: z.number().int().min(0).max(1000).default(0),
    isActive: z.boolean().default(true),
  })
  .refine(
    (value) =>
      value.minWeightGrams == null ||
      value.maxWeightGrams == null ||
      value.minWeightGrams <= value.maxWeightGrams,
    { message: 'The minimum weight must not exceed the maximum.', path: ['minWeightGrams'] },
  )
  .refine(
    (value) =>
      value.minSubtotalCents == null ||
      value.maxSubtotalCents == null ||
      value.minSubtotalCents <= value.maxSubtotalCents,
    { message: 'The minimum subtotal must not exceed the maximum.', path: ['minSubtotalCents'] },
  )
  .refine(
    (value) =>
      value.estimatedDaysMin == null ||
      value.estimatedDaysMax == null ||
      value.estimatedDaysMin <= value.estimatedDaysMax,
    {
      message: 'The earliest estimate must not be later than the latest.',
      path: ['estimatedDaysMin'],
    },
  );
export type CreateShippingRateInput = z.infer<typeof createShippingRateSchema>;

export const createShipmentSchema = z.object({
  warehouseId: uuidSchema.optional(),
  carrier: z.string().trim().max(60).optional(),
  service: z.string().trim().max(60).optional(),
  trackingNumber: z.string().trim().max(120).optional(),
  trackingUrl: z.string().trim().url().max(500).optional(),
  lines: z
    .array(z.object({ orderItemId: uuidSchema, quantity: quantitySchema }))
    .min(1, 'A shipment needs at least one line.')
    .max(200),
});
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

export const updateShipmentSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  trackingNumber: z.string().trim().max(120).optional(),
  trackingUrl: z.string().trim().url().max(500).optional(),
});
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;
