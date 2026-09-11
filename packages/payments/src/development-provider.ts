import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  PaymentProviderError,
  WebhookSignatureError,
  type CapturePaymentInput,
  type CreatePaymentIntent,
  type PaymentEvent,
  type PaymentIntentResult,
  type PaymentProvider,
  type RefundPaymentInput,
  type RefundResult,
} from './provider.js';

/**
 * A development payment provider.
 *
 * **This does not move money.** It exists so the checkout, order and refund
 * flows can be built and tested without a live merchant account. It is not a
 * payment provider, it is a stand-in, and `isRealMoney` is false so nothing
 * downstream can mistake one for the other:
 *
 *  - the production configuration guard refuses to start with it selected
 *    (`scripts/verify-production-guards.mjs` asserts this);
 *  - the admin console labels any order paid through it;
 *  - the order timeline records the provider name on every payment event.
 *
 * What it *does* faithfully reproduce is the shape of the real thing: real
 * idempotency (the same key returns the same intent rather than creating a
 * second), real HMAC webhook signatures with the same timestamp-tolerance
 * rules, and deterministic failure cases keyed off the amount so declines,
 * provider outages and late webhooks can all be exercised.
 *
 * State is in memory. Restarting loses it, which is correct: there is nothing
 * here worth persisting.
 */

/** Amounts that trigger a specific outcome, so failure paths are testable. */
export const DEV_DECLINE_CENTS = 1_00;
export const DEV_PROVIDER_ERROR_CENTS = 2_00;
export const DEV_REQUIRES_ACTION_CENTS = 3_00;
/**
 * A refund whose idempotency key contains this marker fails once, then succeeds.
 *
 * Models the case that matters most for retry behaviour: a provider that is
 * briefly unreachable. A refund that only ever fails permanently, or only ever
 * succeeds, never exercises the path where an operator retries.
 *
 * Keyed off the idempotency key rather than the amount, deliberately. Every
 * small amount is one a real refund could plausibly be for, so an amount-keyed
 * trigger eventually fires on a test — or a demo — that meant nothing by it.
 */
export const DEV_REFUND_FAIL_ONCE_MARKER = 'dev-fail-once';

interface DevIntent {
  id: string;
  status: PaymentIntentResult['status'];
  amountCents: number;
  currency: string;
  capturedCents: number;
  refundedCents: number;
  reference: string;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface DevelopmentProviderOptions {
  /** Signs simulated webhooks, so signature verification is exercised too. */
  webhookSecret: string;
  webhookToleranceSeconds?: number;
  now?: () => Date;
}

export class DevelopmentPaymentProvider implements PaymentProvider {
  readonly name = 'development';
  readonly isRealMoney = false;

  private readonly intents = new Map<string, DevIntent>();
  /** Maps an idempotency key to the intent it created. */
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly refunds = new Map<string, RefundResult>();
  /** Idempotency keys that have already burned their one simulated outage. */
  private readonly refundsFailedOnce = new Set<string>();
  private readonly now: () => Date;
  private readonly toleranceSeconds: number;

  constructor(private readonly options: DevelopmentProviderOptions) {
    if (!options.webhookSecret) {
      throw new Error('DevelopmentPaymentProvider requires a webhook secret.');
    }
    this.now = options.now ?? (() => new Date());
    this.toleranceSeconds = options.webhookToleranceSeconds ?? 300;
  }

  async createIntent(input: CreatePaymentIntent): Promise<PaymentIntentResult> {
    // Real idempotency: the same key must not create a second intent, because
    // that is precisely the bug this key exists to prevent.
    const existingId = this.byIdempotencyKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.intents.get(existingId)!;
      if (existing.amountCents !== input.amountCents) {
        // Stripe behaves this way too: reusing a key with different parameters
        // is a programming error, not a retry.
        throw new PaymentProviderError(
          'That idempotency key was already used for a different amount.',
          'IDEMPOTENCY_KEY_REUSED',
          false,
        );
      }
      return this.toResult(existing);
    }

    if (input.amountCents === DEV_PROVIDER_ERROR_CENTS) {
      throw new PaymentProviderError(
        'The development provider was asked to simulate an outage.',
        'PROVIDER_UNREACHABLE',
        true,
      );
    }

    const intent: DevIntent = {
      id: `dev_pi_${randomUUID().replace(/-/g, '')}`,
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      capturedCents: 0,
      refundedCents: 0,
      reference: input.reference,
      // Always starts unpaid. A provider that returned "captured" from its own
      // create call would be modelling a flow that does not exist.
      status: 'REQUIRES_PAYMENT',
      failureCode: null,
      failureMessage: null,
    };

    this.intents.set(intent.id, intent);
    this.byIdempotencyKey.set(input.idempotencyKey, intent.id);
    return this.toResult(intent);
  }

  async retrieveIntent(providerPaymentId: string): Promise<PaymentIntentResult> {
    return this.toResult(this.require(providerPaymentId));
  }

  /**
   * Completes a payment, standing in for what the customer's browser does with
   * a real provider. Only a development adapter has such a method — the real
   * one cannot, because only the provider can decide a payment succeeded.
   */
  async simulateCustomerPayment(providerPaymentId: string): Promise<PaymentIntentResult> {
    const intent = this.require(providerPaymentId);

    if (intent.amountCents === DEV_DECLINE_CENTS) {
      intent.status = 'FAILED';
      intent.failureCode = 'card_declined';
      intent.failureMessage = 'Your card was declined.';
      return this.toResult(intent);
    }

    intent.status = 'CAPTURED';
    intent.capturedCents = intent.amountCents;
    return this.toResult(intent);
  }

  async capture(input: CapturePaymentInput): Promise<PaymentIntentResult> {
    const intent = this.require(input.providerPaymentId);
    const amount = input.amountCents ?? intent.amountCents;

    if (amount > intent.amountCents) {
      throw new PaymentProviderError(
        'Cannot capture more than was authorised.',
        'CAPTURE_EXCEEDS_AUTHORIZATION',
        false,
      );
    }

    intent.status = 'CAPTURED';
    intent.capturedCents = amount;
    return this.toResult(intent);
  }

  async cancel(providerPaymentId: string): Promise<PaymentIntentResult> {
    const intent = this.require(providerPaymentId);
    if (intent.status === 'CAPTURED') {
      throw new PaymentProviderError(
        'A captured payment cannot be cancelled; refund it instead.',
        'ALREADY_CAPTURED',
        false,
      );
    }
    intent.status = 'CANCELLED';
    return this.toResult(intent);
  }

  async refund(input: RefundPaymentInput): Promise<RefundResult> {
    const existing = this.refunds.get(input.idempotencyKey);
    if (existing) return existing;

    const intent = this.require(input.providerPaymentId);

    if (
      input.idempotencyKey.includes(DEV_REFUND_FAIL_ONCE_MARKER) &&
      !this.refundsFailedOnce.has(input.idempotencyKey)
    ) {
      this.refundsFailedOnce.add(input.idempotencyKey);
      throw new PaymentProviderError(
        'The payment provider is temporarily unreachable.',
        'PROVIDER_UNREACHABLE',
        true,
      );
    }

    const refundable = intent.capturedCents - intent.refundedCents;

    if (input.amountCents > refundable) {
      throw new PaymentProviderError(
        'Cannot refund more than remains captured on this payment.',
        'REFUND_EXCEEDS_CAPTURED',
        false,
      );
    }

    intent.refundedCents += input.amountCents;
    const result: RefundResult = {
      providerRefundId: `dev_re_${randomUUID().replace(/-/g, '')}`,
      status: 'SUCCEEDED',
      amountCents: input.amountCents,
    };
    this.refunds.set(input.idempotencyKey, result);
    return result;
  }

  /**
   * Signs a payload the way the provider would.
   *
   * Test-only, and the reason the development path exercises the *same*
   * verification code as production rather than a bypass. A webhook handler
   * that skips verification in development is a handler whose verification is
   * never tested.
   */
  signWebhook(rawBody: string, at = this.now()): string {
    const timestamp = Math.floor(at.getTime() / 1000);
    const signature = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  verifyAndParseWebhook(rawBody: string, signatureHeader: string): PaymentEvent {
    if (!signatureHeader) {
      throw new WebhookSignatureError('The webhook had no signature header.');
    }

    const parts = new Map<string, string>();
    for (const segment of signatureHeader.split(',')) {
      const index = segment.indexOf('=');
      if (index > 0) parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
    }

    const timestamp = parts.get('t');
    const provided = parts.get('v1');
    if (!timestamp || !provided) {
      throw new WebhookSignatureError('The webhook signature header was malformed.');
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      throw new WebhookSignatureError('The webhook signature timestamp was not a number.');
    }
    if (Math.abs(this.now().getTime() / 1000 - timestampSeconds) > this.toleranceSeconds) {
      throw new WebhookSignatureError(
        'The webhook signature is outside the accepted time window, so it may be a replay.',
      );
    }

    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');

    const left = Buffer.from(provided, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new WebhookSignatureError('The webhook signature did not verify.');
    }

    const parsed = JSON.parse(rawBody) as {
      id?: string;
      type?: string;
      created?: number;
      data?: Record<string, unknown>;
    };

    const data = (parsed.data ?? {}) as {
      providerPaymentId?: string;
      providerRefundId?: string;
      amountCents?: number;
      currency?: string;
      failureCode?: string;
      failureMessage?: string;
    };

    return {
      id: parsed.id ?? randomUUID(),
      type: (parsed.type as PaymentEvent['type']) ?? 'unknown',
      providerPaymentId: data.providerPaymentId ?? null,
      providerRefundId: data.providerRefundId ?? null,
      amountCents: data.amountCents ?? null,
      currency: data.currency ?? null,
      cardBrand: 'devcard',
      cardLast4: '0000',
      failureCode: data.failureCode ?? null,
      failureMessage: data.failureMessage ?? null,
      occurredAt: new Date((parsed.created ?? Math.floor(Date.now() / 1000)) * 1000),
      rawType: parsed.type ?? 'unknown',
    };
  }

  private require(id: string): DevIntent {
    const intent = this.intents.get(id);
    if (!intent) {
      throw new PaymentProviderError('No such payment intent.', 'NOT_FOUND', false);
    }
    return intent;
  }

  private toResult(intent: DevIntent): PaymentIntentResult {
    return {
      providerPaymentId: intent.id,
      status: intent.status,
      amountCents: intent.amountCents,
      currency: intent.currency,
      // Obviously fake, on purpose: a real client secret is a credential, and
      // anything here that looked like one would invite being treated as one.
      clientSecret: `${intent.id}_secret_development_only`,
      cardBrand: intent.status === 'CAPTURED' ? 'devcard' : null,
      cardLast4: intent.status === 'CAPTURED' ? '0000' : null,
      failureCode: intent.failureCode,
      failureMessage: intent.failureMessage,
    };
  }
}
