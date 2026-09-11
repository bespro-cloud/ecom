import 'server-only';
import { apiRequestOrSignIn } from './guards';

/**
 * Admin-side commerce types.
 *
 * Mirrors the HTTP contract rather than importing the API's own interfaces, for
 * the same reason as the catalogue types: the console is a client, and sharing
 * internal types would let a service change compile cleanly here while
 * silently breaking a screen.
 *
 * Note what is **not** modelled. No card number, no expiry, no CVV, because
 * none of those ever reach the API, let alone this app. `cardBrand` and
 * `cardLast4` are display strings the provider returns so a human can match a
 * payment to a customer's statement; they cannot be used to charge anything.
 */

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'PARTIALLY_FULFILLED'
  | 'FULFILLED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'CANCELLED';

export interface AdminOrderSummary {
  id: string;
  reference: string;
  email: string;
  status: OrderStatus;
  paymentStatus: string;
  fulfilmentStatus: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  amountRefundedCents: number;
  placedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  _count: { items: number };
}

export interface AdminOrderAddress {
  firstName: string;
  lastName: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone?: string | null;
}

export interface AdminOrderItem {
  id: string;
  sku: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
  discountCents: number;
  taxCents: number;
  lineTotalCents: number;
  quantityFulfilled: number;
  quantityRefunded: number;
}

export interface AdminOrderEvent {
  id: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  actorLabel: string | null;
  isSystem: boolean;
  createdAt: string;
}

export interface AdminPayment {
  id: string;
  provider: string;
  providerPaymentId: string;
  status: string;
  currency: string;
  amountCents: number;
  amountCapturedCents: number;
  amountRefundedCents: number;
  cardBrand: string | null;
  cardLast4: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  createdAt: string;
}

export interface AdminRefund {
  id: string;
  provider: string;
  providerRefundId: string | null;
  status: string;
  amountCents: number;
  currency: string;
  reason: string;
  notes: string;
  actorLabel: string;
  failureCode: string | null;
  failureMessage: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface AdminShipment {
  id: string;
  status: string;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  items: Array<{ id: string; orderItemId: string; quantity: number }>;
}

export interface AdminOrder extends Omit<AdminOrderSummary, '_count'> {
  customerId: string | null;
  checkoutId: string | null;
  shippingAddress: AdminOrderAddress;
  billingAddress: AdminOrderAddress | null;
  shippingMethodCode: string | null;
  shippingMethodName: string | null;
  customerNote: string | null;
  internalNote: string | null;
  items: AdminOrderItem[];
  events: AdminOrderEvent[];
  payments: AdminPayment[];
  refunds: AdminRefund[];
  shipments: AdminShipment[];
  /**
   * False when the order was paid through the development adapter. Surfaced so
   * nobody mistakes a stand-in for a real settlement while reading the order.
   */
  paymentIsRealMoney: boolean;
}

export interface AdminStockRow {
  id: string;
  variantId: string;
  sku: string;
  variantName: string;
  productName: string;
  productStatus: string;
  warehouse: { id: string; code: string; name: string };
  onHandQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  reorderPoint: number;
  trackInventory: boolean;
  allowBackorder: boolean;
  isLow: boolean;
}

export interface AdminAdjustment {
  id: string;
  quantityDelta: number;
  resultingOnHand: number;
  reason: string;
  reference: string | null;
  notes: string | null;
  actorLabel: string | null;
  createdAt: string;
}

export interface AdminWarehouse {
  id: string;
  code: string;
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  priority: number;
  isActive: boolean;
}

export interface AdminShippingRate {
  id: string;
  code: string;
  name: string;
  description: string | null;
  countries: string[];
  regions: string[];
  priceCents: number;
  freeAboveSubtotalCents: number | null;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  minSubtotalCents: number | null;
  maxSubtotalCents: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  position: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------

export async function listOrders(query: string): Promise<{
  data: AdminOrderSummary[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`/api/v1/admin/commerce/orders${query ? `?${query}` : ''}`);
}

export async function getOrder(id: string): Promise<AdminOrder> {
  return apiRequestOrSignIn(`/api/v1/admin/commerce/orders/${id}`);
}

export async function listRefunds(orderId: string): Promise<AdminRefund[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminRefund[] }>(
    `/api/v1/admin/commerce/orders/${orderId}/refunds`,
  );
  return data;
}

export async function listStock(query: string): Promise<{
  data: AdminStockRow[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`/api/v1/admin/commerce/inventory${query ? `?${query}` : ''}`);
}

export async function listAdjustments(inventoryItemId: string): Promise<AdminAdjustment[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminAdjustment[] }>(
    `/api/v1/admin/commerce/inventory/${inventoryItemId}/adjustments`,
  );
  return data;
}

export async function listWarehouses(includeInactive = true): Promise<AdminWarehouse[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminWarehouse[] }>(
    `/api/v1/admin/commerce/warehouses?includeInactive=${includeInactive ? 'true' : 'false'}`,
  );
  return data;
}

export async function listShippingRates(): Promise<AdminShippingRate[]> {
  const { data } = await apiRequestOrSignIn<{ data: AdminShippingRate[] }>(
    '/api/v1/admin/commerce/shipping-rates',
  );
  return data;
}

// ---------------------------------------------------------------------------

const ORDER_STATUS_TONE: Record<OrderStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  PENDING_PAYMENT: 'warning',
  PAID: 'success',
  PROCESSING: 'neutral',
  PARTIALLY_FULFILLED: 'neutral',
  FULFILLED: 'success',
  PARTIALLY_REFUNDED: 'warning',
  REFUNDED: 'warning',
  CANCELLED: 'danger',
};

export function orderStatusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  return ORDER_STATUS_TONE[status as OrderStatus] ?? 'neutral';
}

export function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}
