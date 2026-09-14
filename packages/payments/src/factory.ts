import type { ServerEnv } from '@health/config';
import { DevelopmentPaymentProvider } from './development-provider.js';
import { StripePaymentProvider } from './stripe-provider.js';
import type { PaymentProvider } from './provider.js';

/**
 * Selects the payment provider from configuration.
 *
 * One factory, used by both the API and the worker, so the process that charges
 * a renewal on a schedule cannot end up on a different adapter from the one
 * that charges a checkout.
 *
 * The development adapter is reachable only because the environment says so,
 * and `packages/config` refuses that value in production — with
 * `scripts/verify-production-guards.mjs` asserting the refusal. There is no
 * path by which a production deployment silently runs a stand-in.
 */
export function createPaymentProvider(env: ServerEnv): PaymentProvider {
  switch (env.PAYMENT_PROVIDER) {
    case 'stripe':
      if (!env.PAYMENT_SECRET_KEY || !env.PAYMENT_WEBHOOK_SECRET) {
        throw new Error(
          'PAYMENT_PROVIDER=stripe requires PAYMENT_SECRET_KEY and PAYMENT_WEBHOOK_SECRET.',
        );
      }
      return new StripePaymentProvider({
        secretKey: env.PAYMENT_SECRET_KEY,
        webhookSecret: env.PAYMENT_WEBHOOK_SECRET,
      });
    case 'mock':
      return new DevelopmentPaymentProvider({
        // Falls back to a fixed string only outside production, where the
        // configuration guard has already refused this provider anyway.
        webhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? 'development-webhook-secret',
      });
    default:
      // Not a silent fallback to the stand-in. A provider named in
      // configuration but not implemented must stop the process, or a
      // deployment could take real orders through an adapter nobody wrote.
      throw new Error(
        `PAYMENT_PROVIDER="${String(env.PAYMENT_PROVIDER)}" is declared in configuration but no adapter is implemented. ` +
          'Implement it in @health/payments before enabling it.',
      );
  }
}
