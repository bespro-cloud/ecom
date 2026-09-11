import 'server-only';
import { apiRequest } from './api-client';

/**
 * The storefront's view of commerce.
 *
 * Mirrors the HTTP contract rather than importing the API's own types: the
 * browser talks to a wire format, and sharing internal types would let a
 * service change compile cleanly here while breaking the page.
 *
 * Every call forwards cookies, because the cart and checkout are addressed by
 * them — a guest's basket lives behind an httpOnly token, not an id in a URL.
 */

export interface CartLine {
  id: string;
  variantId: string;
  productId: string;
  slug: string;
  sku: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
  currency: string;
  imageUrl: string | null;
  availableQuantity: number | null;
  priceChanged: boolean;
  quotedUnitPriceCents: number;
}

export interface Cart {
  id: string;
  currency: string;
  lines: CartLine[];
  itemCount: number;
  subtotalCents: number;
  note: string | null;
  unavailable: Array<{ variantId: string; sku: string; name: string; reason: string }>;
  updatedAt: string;
}

export interface ShippingOption {
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}

export interface CheckoutAddress {
  firstName: string;
  lastName: string;
  company?: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface Checkout {
  id: string;
  status: string;
  email: string | null;
  currency: string;
  shippingAddress: CheckoutAddress | null;
  billingAddress: CheckoutAddress | null;
  shippingMethodCode: string | null;
  shippingOptions: ShippingOption[];
  lines: Array<{
    variantId: string;
    sku: string;
    productName: string;
    variantName: string;
    quantity: number;
    unitPriceCents: number;
    lineSubtotalCents: number;
    discountCents: number;
    taxCents: number;
    lineTotalCents: number;
  }>;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  taxRateApplied: number | null;
  pricingFingerprint: string | null;
  expiresAt: string | null;
  payment: { provider: string; clientSecret: string | null; isRealMoney: boolean } | null;
}

export interface OrderSummary {
  id: string;
  reference: string;
  status: string;
  paymentStatus: string;
  fulfilmentStatus: string;
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  amountRefundedCents: number;
  placedAt: string;
  items: Array<{
    id: string;
    sku: string;
    productName: string;
    variantName: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
    quantityFulfilled: number;
    quantityRefunded: number;
  }>;
}

export interface OrderDetail extends OrderSummary {
  email: string;
  shippingAddress: CheckoutAddress;
  shippingMethodCode: string | null;
  customerNote: string | null;
  shipments: Array<{
    id: string;
    status: string;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
  }>;
  refunds: Array<{ id: string; amountCents: number; status: string; createdAt: string }>;
}

/** The basket. Never cached: it is per-visitor and changes constantly. */
export async function fetchCart(): Promise<Cart> {
  return apiRequest<Cart>('/api/v1/cart');
}

export async function fetchCheckout(id: string): Promise<Checkout> {
  return apiRequest<Checkout>(`/api/v1/checkout/${id}`);
}

export async function fetchOrders(): Promise<OrderSummary[]> {
  const { data } = await apiRequest<{ data: OrderSummary[] }>('/api/v1/orders');
  return data;
}

export async function fetchOrder(id: string): Promise<OrderDetail> {
  return apiRequest<OrderDetail>(`/api/v1/orders/${id}`);
}

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  PROCESSING: 'Being prepared',
  PARTIALLY_SHIPPED: 'Partly on its way',
  SHIPPED: 'On its way',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partly refunded',
};

/** Customer-facing wording for an order status. */
export function orderStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.toLowerCase().replace(/_/g, ' ');
}
