import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  PaymentProviderError,
  WebhookSignatureError,
  type CapturePaymentInput,
  type CreatePaymentIntent,
  type PaymentEvent,
  type PaymentEventType,
  type PaymentIntentResult,
  type PaymentIntentStatus,
  type PaymentProvider,
  type RefundPaymentInput,
  type RefundResult,
} from './provider.js';

/**
 * Stripe.
 *
 * Written against Stripe's REST API directly rather than through their SDK.
 * The surface used here is small and stable, and a direct implementation makes
 * the two things that matter — idempotency headers and webhook signature
 * verification — visible in this file rather than buried in a dependency.
 *
 * **Payment Intents, not Charges.** Intents handle Strong Customer
 * Authentication and 3-D Secure by design; a Charges-based flow silently fails
 * for any customer whose bank requires a challenge.
 *
 * **Card data never passes through here.** The browser tokenises with Stripe.js
 * against the publishable key and this code only ever sees intent identifiers
 * and a client secret. There is no code path in this file that could accept a
 * card number.
 */

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2024-12-18.acacia';

export interface StripeProviderOptions {
  secretKey: string;
  webhookSecret: string;
  /** Overridable for testing against a local Stripe mock. */
  apiBaseUrl?: string;
  /** How far a webhook timestamp may drift before it is rejected. */
  webhookToleranceSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly isRealMoney = true;

  private readonly apiBaseUrl: string;
  private readonly toleranceSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: StripeProviderOptions) {
    if (!options.secretKey) {
      throw new Error('StripePaymentProvider requires a secret key.');
    }
    if (!options.webhookSecret) {
      // Refused at construction rather than at the first webhook: a provider
      // that cannot verify webhooks must never be running in the first place.
      throw new Error('StripePaymentProvider requires a webhook signing secret.');
    }

    this.apiBaseUrl = options.apiBaseUrl ?? STRIPE_API;
    this.toleranceSeconds = options.webhookToleranceSeconds ?? 300;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async createIntent(input: CreatePaymentIntent): Promise<PaymentIntentResult> {
    const body = new URLSearchParams({
      amount: String(input.amountCents),
      currency: input.currency.toLowerCase(),
      // Capture immediately. Authorise-then-capture is the right model once
      // fulfilment can be delayed; until then a held authorisation that expires
      // silently is worse for the customer than a clean charge.
      capture_method: 'automatic',
      'automatic_payment_methods[enabled]': 'true',
      description: `Order ${input.reference}`,
    });

    if (input.email) body.set('receipt_email', input.email);
    body.set('metadata[reference]', input.reference);
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      body.set(`metadata[${key}]`, value);
    }

    const intent = await this.request<StripePaymentIntent>('POST', '/payment_intents', body, {
      idempotencyKey: input.idempotencyKey,
    });

    return toIntentResult(intent);
  }

  async retrieveIntent(providerPaymentId: string): Promise<PaymentIntentResult> {
    const intent = await this.request<StripePaymentIntent>(
      'GET',
      `/payment_intents/${encodeURIComponent(providerPaymentId)}`,
    );
    return toIntentResult(intent);
  }

  async capture(input: CapturePaymentInput): Promise<PaymentIntentResult> {
    const body = new URLSearchParams();
    if (input.amountCents !== undefined) {
      body.set('amount_to_capture', String(input.amountCents));
    }

    const intent = await this.request<StripePaymentIntent>(
      'POST',
      `/payment_intents/${encodeURIComponent(input.providerPaymentId)}/capture`,
      body,
      { idempotencyKey: input.idempotencyKey },
    );
    return toIntentResult(intent);
  }

  async cancel(providerPaymentId: string, idempotencyKey: string): Promise<PaymentIntentResult> {
    const intent = await this.request<StripePaymentIntent>(
      'POST',
      `/payment_intents/${encodeURIComponent(providerPaymentId)}/cancel`,
      new URLSearchParams(),
      { idempotencyKey },
    );
    return toIntentResult(intent);
  }

  async refund(input: RefundPaymentInput): Promise<RefundResult> {
    const body = new URLSearchParams({
      payment_intent: input.providerPaymentId,
      amount: String(input.amountCents),
    });
    // Stripe accepts only a fixed vocabulary here; anything else is rejected,
    // so our richer internal reason is carried as metadata instead.
    if (input.reason && STRIPE_REFUND_REASONS.has(input.reason)) {
      body.set('reason', input.reason);
    } else if (input.reason) {
      body.set('metadata[internal_reason]', input.reason);
    }

    const refund = await this.request<StripeRefund>('POST', '/refunds', body, {
      idempotencyKey: input.idempotencyKey,
    });

    return {
      providerRefundId: refund.id,
      status:
        refund.status === 'succeeded'
          ? 'SUCCEEDED'
          : refund.status === 'failed'
            ? 'FAILED'
            : 'PENDING',
      amountCents: refund.amount,
      failureCode: refund.failure_reason ?? null,
      failureMessage: refund.failure_reason ?? null,
    };
  }

  /**
   * Verifies Stripe's `Stripe-Signature` header.
   *
   * The header looks like `t=1699999999,v1=abc...,v1=def...`. The signed
   * payload is `${timestamp}.${rawBody}`, HMAC-SHA256 with the endpoint
   * secret.
   *
   * Three things this does that a naive implementation skips, each of which is
   * the whole point:
   *
   *  - **Compares in constant time.** A `===` on an HMAC leaks the correct
   *    value one byte at a time to anyone willing to make enough requests.
   *  - **Enforces a timestamp tolerance.** Without it, a signature captured
   *    once is valid forever, and an attacker who ever sees one payload can
   *    replay it indefinitely.
   *  - **Accepts multiple `v1` values.** Stripe sends several during secret
   *    rotation; matching only the first breaks every rotation.
   */
  verifyAndParseWebhook(rawBody: string, signatureHeader: string): PaymentEvent {
    if (!signatureHeader) {
      throw new WebhookSignatureError('The webhook had no signature header.');
    }

    const parts = new Map<string, string[]>();
    for (const segment of signatureHeader.split(',')) {
      const index = segment.indexOf('=');
      if (index <= 0) continue;
      const key = segment.slice(0, index).trim();
      const value = segment.slice(index + 1).trim();
      parts.set(key, [...(parts.get(key) ?? []), value]);
    }

    const timestamp = parts.get('t')?.[0];
    const signatures = parts.get('v1') ?? [];

    if (!timestamp || signatures.length === 0) {
      throw new WebhookSignatureError('The webhook signature header was malformed.');
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      throw new WebhookSignatureError('The webhook signature timestamp was not a number.');
    }

    const ageSeconds = Math.abs(this.now().getTime() / 1000 - timestampSeconds);
    if (ageSeconds > this.toleranceSeconds) {
      throw new WebhookSignatureError(
        'The webhook signature is outside the accepted time window, so it may be a replay.',
      );
    }

    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');

    const matched = signatures.some((candidate) => constantTimeEquals(candidate, expected));
    if (!matched) {
      throw new WebhookSignatureError('The webhook signature did not verify.');
    }

    let parsed: StripeEvent;
    try {
      parsed = JSON.parse(rawBody) as StripeEvent;
    } catch (error) {
      // The parser's own message can name internals; the caller is told only
      // that the body did not parse, with the cause kept for the logs.
      throw new WebhookSignatureError('The webhook body was not valid JSON.', { cause: error });
    }

    return normaliseEvent(parsed);
  }

  // -------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: URLSearchParams,
    options: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    // Stripe collapses retries carrying the same key for 24 hours. This is the
    // header that turns "the connection dropped, try again" into one charge.
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body: body.toString() } : {}),
      });
    } catch (error) {
      // The request never reached Stripe, or the answer never came back. Either
      // way the caller may retry — the idempotency key makes that safe.
      throw new PaymentProviderError(
        'We could not reach the payment provider.',
        'PROVIDER_UNREACHABLE',
        true,
        { cause: error },
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = (payload as { error?: StripeError } | null)?.error;
      throw new PaymentProviderError(
        // Stripe's decline messages are written for customers and are safe to
        // show. Anything else gets a generic message so provider internals do
        // not leak into a checkout page.
        error?.type === 'card_error' && error.message
          ? error.message
          : 'The payment could not be processed. Please try again or use a different card.',
        error?.code ?? error?.type ?? 'PROVIDER_ERROR',
        // 409 is a concurrent-request conflict and 5xx is the provider's
        // problem; both are worth retrying. A declined card is not.
        response.status >= 500 || response.status === 409 || response.status === 429,
      );
    }

    return payload as T;
  }
}

const STRIPE_REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Comparing lengths first is safe: the expected length is not secret.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function toIntentResult(intent: StripePaymentIntent): PaymentIntentResult {
  const charge = intent.latest_charge;
  const card = typeof charge === 'object' ? charge?.payment_method_details?.card : undefined;

  return {
    providerPaymentId: intent.id,
    status: mapIntentStatus(intent.status),
    amountCents: intent.amount,
    currency: intent.currency.toUpperCase(),
    clientSecret: intent.client_secret ?? null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    failureCode: intent.last_payment_error?.code ?? null,
    failureMessage: intent.last_payment_error?.message ?? null,
  };
}

function mapIntentStatus(status: string): PaymentIntentStatus {
  switch (status) {
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
      return 'REQUIRES_PAYMENT';
    case 'processing':
      return 'PROCESSING';
    case 'requires_capture':
      return 'AUTHORIZED';
    case 'succeeded':
      return 'CAPTURED';
    case 'canceled':
      return 'CANCELLED';
    default:
      // An unrecognised status is not assumed to be success. Anything this code
      // does not understand is treated as "not paid", which is the safe side of
      // the only question that matters.
      return 'FAILED';
  }
}

const EVENT_TYPE_MAP: Record<string, PaymentEventType> = {
  'payment_intent.succeeded': 'payment.captured',
  'payment_intent.amount_capturable_updated': 'payment.authorized',
  'payment_intent.payment_failed': 'payment.failed',
  'payment_intent.canceled': 'payment.cancelled',
  'charge.refunded': 'refund.succeeded',
  'charge.refund.updated': 'refund.succeeded',
  'refund.created': 'refund.succeeded',
  'refund.failed': 'refund.failed',
};

function normaliseEvent(event: StripeEvent): PaymentEvent {
  const object = event.data?.object ?? {};
  const type = EVENT_TYPE_MAP[event.type] ?? 'unknown';

  // Refund events carry the intent on the object; payment events are the intent.
  const providerPaymentId =
    (typeof object.payment_intent === 'string' ? object.payment_intent : null) ??
    (event.type.startsWith('payment_intent.') ? (object.id ?? null) : null);

  const card =
    object.payment_method_details?.card ?? object.charges?.data?.[0]?.payment_method_details?.card;

  return {
    id: event.id,
    type,
    providerPaymentId,
    providerRefundId: event.type.includes('refund') ? (object.id ?? null) : null,
    amountCents:
      typeof object.amount_received === 'number'
        ? object.amount_received
        : typeof object.amount === 'number'
          ? object.amount
          : null,
    currency: typeof object.currency === 'string' ? object.currency.toUpperCase() : null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    failureCode: object.last_payment_error?.code ?? object.failure_reason ?? null,
    failureMessage: object.last_payment_error?.message ?? null,
    occurredAt: new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000),
    rawType: event.type,
  };
}

// Minimal shapes for the fields actually read. Deliberately not the full Stripe
// type surface: what this file depends on should be visible in this file.

interface StripeCard {
  brand?: string;
  last4?: string;
}

interface StripePaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  client_secret?: string | null;
  last_payment_error?: { code?: string; message?: string } | null;
  latest_charge?: { payment_method_details?: { card?: StripeCard } } | string | null;
}

interface StripeRefund {
  id: string;
  status: string;
  amount: number;
  failure_reason?: string | null;
}

interface StripeError {
  type?: string;
  code?: string;
  message?: string;
}

interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data?: {
    object?: {
      id?: string;
      amount?: number;
      amount_received?: number;
      currency?: string;
      payment_intent?: string;
      failure_reason?: string;
      last_payment_error?: { code?: string; message?: string } | null;
      payment_method_details?: { card?: StripeCard };
      charges?: { data?: Array<{ payment_method_details?: { card?: StripeCard } }> };
    };
  };
}
