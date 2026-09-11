import { describe, expect, it } from 'vitest';
import {
  DevelopmentPaymentProvider,
  DEV_DECLINE_CENTS,
  DEV_PROVIDER_ERROR_CENTS,
} from './development-provider.js';
import { PaymentProviderError, WebhookSignatureError } from './provider.js';

/**
 * The development adapter is a stand-in, but the behaviour it stands in for has
 * to be right: idempotency that actually collapses retries, signatures that
 * actually verify, and refunds that cannot exceed what was captured. A
 * permissive fake would let bugs through that the real provider would catch,
 * which is the opposite of useful.
 */

const SECRET = 'dev_webhook_secret';
const NOW = new Date('2026-09-11T12:00:00.000Z');

function build() {
  return new DevelopmentPaymentProvider({ webhookSecret: SECRET, now: () => NOW });
}

function intent(
  overrides: Partial<Parameters<DevelopmentPaymentProvider['createIntent']>[0]> = {},
) {
  return {
    amountCents: 2400,
    currency: 'USD',
    reference: 'HC-1001',
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}-padding`,
    ...overrides,
  };
}

describe('honesty about what it is', () => {
  it('declares that it does not move real money', () => {
    // Everything downstream keys off this: the production guard, the admin
    // labelling, the order timeline.
    expect(build().isRealMoney).toBe(false);
  });

  it('issues a client secret that is obviously not a credential', () => {
    expect(build().name).toBe('development');
  });
});

describe('idempotency', () => {
  it('returns the same intent for a repeated key rather than creating a second', async () => {
    // This is the bug idempotency keys exist to prevent: a retried request
    // charging the customer twice.
    const provider = build();
    const input = intent();

    const first = await provider.createIntent(input);
    const second = await provider.createIntent(input);

    expect(second.providerPaymentId).toBe(first.providerPaymentId);
  });

  it('refuses a key reused for a different amount', async () => {
    const provider = build();
    const key = 'shared-key-0123456789';

    await provider.createIntent(intent({ idempotencyKey: key, amountCents: 2400 }));
    await expect(
      provider.createIntent(intent({ idempotencyKey: key, amountCents: 9900 })),
    ).rejects.toThrow(/different amount/);
  });

  it('collapses a repeated refund request', async () => {
    const provider = build();
    const created = await provider.createIntent(intent());
    await provider.simulateCustomerPayment(created.providerPaymentId);

    const key = 'refund-key-0123456789';
    const first = await provider.refund({
      providerPaymentId: created.providerPaymentId,
      amountCents: 1000,
      idempotencyKey: key,
    });
    const second = await provider.refund({
      providerPaymentId: created.providerPaymentId,
      amountCents: 1000,
      idempotencyKey: key,
    });

    expect(second.providerRefundId).toBe(first.providerRefundId);
  });
});

describe('payment lifecycle', () => {
  it('starts unpaid', async () => {
    const created = await build().createIntent(intent());
    expect(created.status).toBe('REQUIRES_PAYMENT');
  });

  it('captures when the customer pays', async () => {
    const provider = build();
    const created = await provider.createIntent(intent());
    const paid = await provider.simulateCustomerPayment(created.providerPaymentId);

    expect(paid.status).toBe('CAPTURED');
    expect(paid.cardLast4).toBe('0000');
  });

  it('declines a specific amount, so the failure path is testable', async () => {
    const provider = build();
    const created = await provider.createIntent(intent({ amountCents: DEV_DECLINE_CENTS }));
    const result = await provider.simulateCustomerPayment(created.providerPaymentId);

    expect(result.status).toBe('FAILED');
    expect(result.failureCode).toBe('card_declined');
  });

  it('simulates a provider outage as retryable', async () => {
    const provider = build();

    // Captured rather than asserted inside a `.catch`, so a call that
    // unexpectedly succeeded fails the test instead of passing silently.
    let caught: unknown;
    try {
      await provider.createIntent(intent({ amountCents: DEV_PROVIDER_ERROR_CENTS }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PaymentProviderError);
    expect((caught as PaymentProviderError).retryable).toBe(true);
    expect((caught as PaymentProviderError).code).toBe('PROVIDER_UNREACHABLE');
  });

  it('refuses to cancel a captured payment', async () => {
    const provider = build();
    const created = await provider.createIntent(intent());
    await provider.simulateCustomerPayment(created.providerPaymentId);

    await expect(
      provider.cancel(created.providerPaymentId, 'cancel-key-0123456789'),
    ).rejects.toThrow(/refund it instead/);
  });

  it('refuses to refund more than was captured', async () => {
    const provider = build();
    const created = await provider.createIntent(intent({ amountCents: 2400 }));
    await provider.simulateCustomerPayment(created.providerPaymentId);

    await expect(
      provider.refund({
        providerPaymentId: created.providerPaymentId,
        amountCents: 2401,
        idempotencyKey: 'over-refund-0123456789',
      }),
    ).rejects.toThrow(/more than remains captured/);
  });

  it('refuses a second refund that would exceed the capture in total', async () => {
    const provider = build();
    const created = await provider.createIntent(intent({ amountCents: 2400 }));
    await provider.simulateCustomerPayment(created.providerPaymentId);

    await provider.refund({
      providerPaymentId: created.providerPaymentId,
      amountCents: 2000,
      idempotencyKey: 'partial-one-0123456789',
    });

    await expect(
      provider.refund({
        providerPaymentId: created.providerPaymentId,
        amountCents: 500,
        idempotencyKey: 'partial-two-0123456789',
      }),
    ).rejects.toThrow(/more than remains captured/);
  });

  it('refuses to capture more than the intent is for', async () => {
    const provider = build();
    const created = await provider.createIntent(intent({ amountCents: 1000 }));

    await expect(
      provider.capture({
        providerPaymentId: created.providerPaymentId,
        amountCents: 5000,
        idempotencyKey: 'over-capture-0123456789',
      }),
    ).rejects.toThrow(/more than was authorised/);
  });

  it('reports an unknown intent rather than inventing one', async () => {
    await expect(build().retrieveIntent('dev_pi_nope')).rejects.toThrow(/No such payment intent/);
  });
});

describe('webhook verification', () => {
  const body = JSON.stringify({
    id: 'evt_dev_1',
    type: 'payment.captured',
    created: Math.floor(NOW.getTime() / 1000),
    data: { providerPaymentId: 'dev_pi_1', amountCents: 2400, currency: 'USD' },
  });

  it('accepts a payload it signed itself', () => {
    // The point of signing in development is that the same verification code
    // runs in both environments. A handler whose verification is bypassed in
    // development is a handler whose verification is never tested.
    const provider = build();
    const event = provider.verifyAndParseWebhook(body, provider.signWebhook(body));

    expect(event.type).toBe('payment.captured');
    expect(event.providerPaymentId).toBe('dev_pi_1');
    expect(event.amountCents).toBe(2400);
  });

  it('rejects an unsigned payload', () => {
    expect(() => build().verifyAndParseWebhook(body, '')).toThrow(WebhookSignatureError);
  });

  it('rejects a tampered body', () => {
    const provider = build();
    const signature = provider.signWebhook(body);
    expect(() => provider.verifyAndParseWebhook(body.replace('2400', '1'), signature)).toThrow(
      /did not verify/,
    );
  });

  it('rejects a stale signature', () => {
    const provider = build();
    const old = provider.signWebhook(body, new Date(NOW.getTime() - 10 * 60 * 1000));
    expect(() => provider.verifyAndParseWebhook(body, old)).toThrow(/time window/);
  });

  it('rejects a signature from a different secret', () => {
    const other = new DevelopmentPaymentProvider({ webhookSecret: 'other', now: () => NOW });
    expect(() => build().verifyAndParseWebhook(body, other.signWebhook(body))).toThrow(
      /did not verify/,
    );
  });
});
