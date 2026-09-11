import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PaymentProviderError, WebhookSignatureError } from './provider.js';
import { StripePaymentProvider } from './stripe-provider.js';

/**
 * Webhook verification is the security boundary of the whole payment flow: it
 * is the thing that decides whether an HTTP request from the internet may mark
 * an order as paid. These tests are mostly about the ways that check can be
 * wrong.
 */

const SECRET = 'whsec_test_secret';
const NOW = new Date('2026-09-11T12:00:00.000Z');

function build(options: Partial<ConstructorParameters<typeof StripePaymentProvider>[0]> = {}) {
  return new StripePaymentProvider({
    secretKey: 'sk_test_key',
    webhookSecret: SECRET,
    now: () => NOW,
    ...options,
  });
}

function sign(body: string, at = NOW, secret = SECRET): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

const CAPTURED_EVENT = JSON.stringify({
  id: 'evt_123',
  type: 'payment_intent.succeeded',
  created: Math.floor(NOW.getTime() / 1000),
  data: {
    object: {
      id: 'pi_123',
      amount: 2400,
      amount_received: 2400,
      currency: 'usd',
      payment_method_details: { card: { brand: 'visa', last4: '4242' } },
    },
  },
});

describe('construction', () => {
  it('refuses to exist without a webhook secret', () => {
    // A provider that cannot verify webhooks must never be running, so this is
    // caught at construction rather than at the first webhook.
    expect(() => new StripePaymentProvider({ secretKey: 'sk', webhookSecret: '' })).toThrow(
      /webhook signing secret/,
    );
  });

  it('refuses to exist without a secret key', () => {
    expect(() => new StripePaymentProvider({ secretKey: '', webhookSecret: 'whsec' })).toThrow(
      /secret key/,
    );
  });

  it('declares that it moves real money', () => {
    expect(build().isRealMoney).toBe(true);
  });
});

describe('verifyAndParseWebhook', () => {
  it('accepts a correctly signed payload', () => {
    const event = build().verifyAndParseWebhook(CAPTURED_EVENT, sign(CAPTURED_EVENT));

    expect(event.id).toBe('evt_123');
    expect(event.type).toBe('payment.captured');
    expect(event.providerPaymentId).toBe('pi_123');
    expect(event.amountCents).toBe(2400);
    expect(event.currency).toBe('USD');
    expect(event.cardLast4).toBe('4242');
  });

  it('rejects a payload with no signature header', () => {
    expect(() => build().verifyAndParseWebhook(CAPTURED_EVENT, '')).toThrow(WebhookSignatureError);
  });

  it('rejects a signature computed with the wrong secret', () => {
    // This is the case that matters: anyone can POST to the webhook URL, and
    // only the signature distinguishes the provider from everyone else.
    const forged = sign(CAPTURED_EVENT, NOW, 'whsec_attacker_guess');
    expect(() => build().verifyAndParseWebhook(CAPTURED_EVENT, forged)).toThrow(/did not verify/);
  });

  it('rejects a valid signature over a different body', () => {
    // Capturing one signed payload must not let an attacker substitute another.
    const tampered = CAPTURED_EVENT.replace('2400', '1');
    expect(() => build().verifyAndParseWebhook(tampered, sign(CAPTURED_EVENT))).toThrow(
      /did not verify/,
    );
  });

  it('rejects a replay from outside the time window', () => {
    // Without a tolerance, a signature seen once is valid forever.
    const old = new Date(NOW.getTime() - 10 * 60 * 1000);
    expect(() => build().verifyAndParseWebhook(CAPTURED_EVENT, sign(CAPTURED_EVENT, old))).toThrow(
      /time window/,
    );
  });

  it('rejects a timestamp from the future beyond tolerance', () => {
    const ahead = new Date(NOW.getTime() + 10 * 60 * 1000);
    expect(() =>
      build().verifyAndParseWebhook(CAPTURED_EVENT, sign(CAPTURED_EVENT, ahead)),
    ).toThrow(/time window/);
  });

  it('accepts a timestamp inside the tolerance', () => {
    const recent = new Date(NOW.getTime() - 60 * 1000);
    expect(() =>
      build().verifyAndParseWebhook(CAPTURED_EVENT, sign(CAPTURED_EVENT, recent)),
    ).not.toThrow();
  });

  it('accepts any of several signatures, so secret rotation works', () => {
    // Stripe sends one v1 per active secret during a rotation. Matching only
    // the first would break every rotation.
    const valid = sign(CAPTURED_EVENT);
    const header = `${valid},v1=${'0'.repeat(64)}`;
    expect(() => build().verifyAndParseWebhook(CAPTURED_EVENT, header)).not.toThrow();
  });

  it('rejects a malformed header', () => {
    for (const header of ['garbage', 't=', 'v1=abc', 't=notanumber,v1=abc']) {
      expect(() => build().verifyAndParseWebhook(CAPTURED_EVENT, header)).toThrow(
        WebhookSignatureError,
      );
    }
  });

  it('rejects a signature of the wrong length without leaking via a throw', () => {
    const header = `t=${Math.floor(NOW.getTime() / 1000)},v1=tooshort`;
    expect(() => build().verifyAndParseWebhook(CAPTURED_EVENT, header)).toThrow(/did not verify/);
  });

  it('rejects a body that is not JSON even when correctly signed', () => {
    const body = 'not json';
    expect(() => build().verifyAndParseWebhook(body, sign(body))).toThrow(/valid JSON/);
  });

  it('maps a failure event and carries the decline reason', () => {
    const body = JSON.stringify({
      id: 'evt_fail',
      type: 'payment_intent.payment_failed',
      created: Math.floor(NOW.getTime() / 1000),
      data: {
        object: {
          id: 'pi_fail',
          amount: 2400,
          currency: 'usd',
          last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
        },
      },
    });

    const event = build().verifyAndParseWebhook(body, sign(body));
    expect(event.type).toBe('payment.failed');
    expect(event.failureCode).toBe('card_declined');
  });

  it('maps a refund event to the intent it belongs to', () => {
    const body = JSON.stringify({
      id: 'evt_refund',
      type: 'charge.refunded',
      created: Math.floor(NOW.getTime() / 1000),
      data: { object: { id: 'ch_1', payment_intent: 'pi_123', amount: 500, currency: 'usd' } },
    });

    const event = build().verifyAndParseWebhook(body, sign(body));
    expect(event.type).toBe('refund.succeeded');
    expect(event.providerPaymentId).toBe('pi_123');
  });

  it('reports an unrecognised event type as unknown rather than guessing', () => {
    const body = JSON.stringify({
      id: 'evt_x',
      type: 'customer.subscription.created',
      created: Math.floor(NOW.getTime() / 1000),
      data: { object: { id: 'sub_1' } },
    });

    const event = build().verifyAndParseWebhook(body, sign(body));
    expect(event.type).toBe('unknown');
    expect(event.rawType).toBe('customer.subscription.created');
  });
});

describe('API calls', () => {
  function fetchReturning(status: number, payload: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  }

  it('sends the amount in minor units and an idempotency key', async () => {
    const fetchImpl = fetchReturning(200, {
      id: 'pi_1',
      status: 'succeeded',
      amount: 2400,
      currency: 'usd',
      client_secret: 'pi_1_secret',
    });

    await build({ fetchImpl: fetchImpl as unknown as typeof fetch }).createIntent({
      amountCents: 2400,
      currency: 'USD',
      reference: 'HC-1001',
      idempotencyKey: 'idem-key-0123456789',
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('idem-key-0123456789');

    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get('amount')).toBe('2400');
    expect(body.get('currency')).toBe('usd');
  });

  it('maps provider statuses onto ours', async () => {
    const cases: Array<[string, string]> = [
      ['succeeded', 'CAPTURED'],
      ['requires_capture', 'AUTHORIZED'],
      ['processing', 'PROCESSING'],
      ['requires_payment_method', 'REQUIRES_PAYMENT'],
      ['requires_action', 'REQUIRES_PAYMENT'],
      ['canceled', 'CANCELLED'],
    ];

    for (const [stripeStatus, expected] of cases) {
      const fetchImpl = fetchReturning(200, {
        id: 'pi_1',
        status: stripeStatus,
        amount: 100,
        currency: 'usd',
      });
      const result = await build({
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).retrieveIntent('pi_1');
      expect(result.status).toBe(expected);
    }
  });

  it('treats an unrecognised status as not paid', async () => {
    // The safe side of the only question that matters.
    const fetchImpl = fetchReturning(200, {
      id: 'pi_1',
      status: 'some_future_status',
      amount: 100,
      currency: 'usd',
    });
    const result = await build({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).retrieveIntent('pi_1');
    expect(result.status).toBe('FAILED');
  });

  it('passes a card decline message through, because it is written for customers', async () => {
    const fetchImpl = fetchReturning(402, {
      error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' },
    });

    await expect(
      build({ fetchImpl: fetchImpl as unknown as typeof fetch }).retrieveIntent('pi_1'),
    ).rejects.toThrow('Your card was declined.');
  });

  it('does not leak provider internals for other errors', async () => {
    const fetchImpl = fetchReturning(400, {
      error: { type: 'invalid_request_error', message: 'No such token: tok_internal_detail' },
    });

    await expect(
      build({ fetchImpl: fetchImpl as unknown as typeof fetch }).retrieveIntent('pi_1'),
    ).rejects.toThrow(/could not be processed/);
  });

  /**
   * Captures the rejection, failing if the call unexpectedly succeeded.
   *
   * `.catch(assert)` would pass silently on a resolved promise, which is the
   * one outcome these tests exist to rule out.
   */
  async function rejection(promise: Promise<unknown>): Promise<PaymentProviderError> {
    try {
      await promise;
    } catch (error) {
      return error as PaymentProviderError;
    }
    throw new Error('Expected the provider call to reject, but it resolved.');
  }

  it('marks server errors and rate limits retryable, and declines not', async () => {
    // Whether a failure is retryable decides whether a customer is charged
    // twice or not at all, so it is asserted per status rather than assumed.
    for (const [status, retryable] of [
      [500, true],
      [429, true],
      [409, true],
      [402, false],
      [400, false],
    ] as const) {
      const fetchImpl = fetchReturning(status, { error: { type: 'api_error' } });
      const error = await rejection(
        build({ fetchImpl: fetchImpl as unknown as typeof fetch }).retrieveIntent('pi_1'),
      );

      expect(error).toBeInstanceOf(PaymentProviderError);
      expect({ status, retryable: error.retryable }).toEqual({ status, retryable });
    }
  });

  it('treats an unreachable provider as retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    const error = await rejection(
      build({ fetchImpl: fetchImpl as unknown as typeof fetch }).retrieveIntent('pi_1'),
    );

    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error.retryable).toBe(true);
    expect(error.code).toBe('PROVIDER_UNREACHABLE');
  });
});
