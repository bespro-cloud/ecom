/**
 * The payment provider contract.
 *
 * Two rules shape this interface, and both come from PCI scope rather than
 * from taste.
 *
 * **Card data never reaches this application.** No method here accepts a PAN,
 * an expiry or a CVV, and there is no shape in which one could be passed. The
 * browser sends card details directly to the provider, which returns a token;
 * this application only ever handles tokens and provider identifiers. That is
 * what keeps the server out of PCI DSS scope, and it is not negotiable.
 *
 * **The provider is the authority on whether money moved.** Nothing in the
 * application decides a payment succeeded because a browser said so. A payment
 * becomes settled when the provider says it did — via the API response we
 * confirm, or via a signature-verified webhook — and those two paths converge
 * on the same idempotent handler.
 */

export type PaymentIntentStatus =
  | 'REQUIRES_PAYMENT'
  | 'PROCESSING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELLED';

export interface CreatePaymentIntent {
  /** Minor units. Always an integer; the provider is told cents, not dollars. */
  amountCents: number;
  currency: string;
  /** Our checkout id, so a provider-side record points back at ours. */
  reference: string;
  /** Masked before it reaches a provider log line. */
  email?: string;
  /**
   * Caller-supplied, unique per attempt. Providers use this to collapse
   * retries, which is the difference between a flaky network and a double
   * charge.
   */
  idempotencyKey: string;
  /** Small, non-sensitive key/value context. Never customer health data. */
  metadata?: Record<string, string>;

  /**
   * A previously saved payment method, for charging without the customer
   * present — a subscription renewal.
   *
   * This is a provider token, exactly like everything else here. It is not a
   * card, cannot be turned back into one, and is useless outside the
   * provider's own account.
   */
  paymentMethodId?: string;

  /**
   * True when nobody is at the keyboard.
   *
   * Providers treat off-session charges differently: they cannot prompt for
   * 3-D Secure, and the issuer's liability rules change. Saying so explicitly
   * is what lets the provider decline cleanly rather than hanging on an
   * authentication nobody can complete — and a renewal that silently required
   * authentication would just fail, repeatedly, at 3am.
   */
  offSession?: boolean;
}

export interface PaymentIntentResult {
  providerPaymentId: string;
  status: PaymentIntentStatus;
  amountCents: number;
  currency: string;
  /**
   * Handed to the browser so it can complete the payment with the provider
   * directly. Short-lived, single-purpose, and useless without the provider's
   * publishable key.
   */
  clientSecret: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface CapturePaymentInput {
  providerPaymentId: string;
  /** Omit to capture the full authorised amount. */
  amountCents?: number;
  idempotencyKey: string;
}

export interface RefundPaymentInput {
  providerPaymentId: string;
  amountCents: number;
  reason?: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amountCents: number;
  failureCode?: string | null;
  failureMessage?: string | null;
}

/**
 * A provider event, normalised.
 *
 * Every provider describes the same handful of facts differently. Translating
 * at the boundary means the commerce domain has one vocabulary to reason about,
 * and adding a provider does not touch the order state machine.
 */
export type PaymentEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'payment.cancelled'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'unknown';

export interface PaymentEvent {
  /** The provider's own event id. The idempotency key for webhook handling. */
  id: string;
  type: PaymentEventType;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  amountCents: number | null;
  currency: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  occurredAt: Date;
  /** The provider's own event name, kept for diagnostics. */
  rawType: string;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Whether the caller should retry. A declined card is not retryable. */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PaymentProviderError';
  }
}

/** A webhook whose signature did not verify. Never processed, always logged. */
export class WebhookSignatureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WebhookSignatureError';
  }
}

/** A saved payment method, as the provider describes it. */
export interface PaymentMethodDetails {
  providerPaymentMethodId: string;
  /** Display only. Never enough to charge anything. */
  cardBrand: string | null;
  cardLast4: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
}

export interface PaymentProvider {
  readonly name: string;
  /**
   * False for adapters that do not move real money. The production
   * configuration guard refuses to start with one of these, and the admin
   * console labels any order paid through one.
   */
  readonly isRealMoney: boolean;

  createIntent(input: CreatePaymentIntent): Promise<PaymentIntentResult>;
  retrieveIntent(providerPaymentId: string): Promise<PaymentIntentResult>;
  capture(input: CapturePaymentInput): Promise<PaymentIntentResult>;
  cancel(providerPaymentId: string, idempotencyKey: string): Promise<PaymentIntentResult>;
  refund(input: RefundPaymentInput): Promise<RefundResult>;

  /**
   * Verifies a webhook came from the provider, then parses it.
   *
   * Takes the **raw request body**, not a parsed object: signatures are
   * computed over exact bytes, and re-serialising JSON changes them. An
   * unverifiable payload throws rather than returning a best guess — a webhook
   * handler that trusts an unsigned body is a way for anyone on the internet to
   * mark orders as paid.
   */
  verifyAndParseWebhook(rawBody: string, signatureHeader: string): PaymentEvent;

  /**
   * Looks up a saved payment method so its brand and last four can be shown.
   *
   * The application stores those strings for display, but asks the provider
   * for them rather than accepting them from the browser: a client that could
   * tell the server "this token is a Visa ending 4242" could label somebody
   * else's saved card however it liked.
   *
   * Returns null when the token is unknown, rather than throwing, because "the
   * customer removed this at the provider" is an ordinary state.
   */
  retrievePaymentMethod(providerPaymentMethodId: string): Promise<PaymentMethodDetails | null>;
}
