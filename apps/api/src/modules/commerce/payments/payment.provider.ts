import { Provider } from '@nestjs/common';
import {
  DevelopmentPaymentProvider,
  StripePaymentProvider,
  type PaymentProvider,
} from '@health/payments';
import { AppConfigService } from '../../../infrastructure/config/app-config.service.js';

/** Injection token for the configured payment provider. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * Selects the payment provider from configuration.
 *
 * The development adapter is reachable only because the environment says so,
 * and `packages/config` refuses that value in production — with
 * `scripts/verify-production-guards.mjs` asserting the refusal. There is no
 * path by which a production deployment silently runs a stand-in.
 */
export const paymentProviderFactory: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [AppConfigService],
  useFactory: (configService: AppConfigService): PaymentProvider => {
    const config = configService.env;

    if (config.PAYMENT_PROVIDER === 'stripe') {
      if (!config.PAYMENT_SECRET_KEY || !config.PAYMENT_WEBHOOK_SECRET) {
        throw new Error(
          'PAYMENT_PROVIDER=stripe requires PAYMENT_SECRET_KEY and PAYMENT_WEBHOOK_SECRET.',
        );
      }
      return new StripePaymentProvider({
        secretKey: config.PAYMENT_SECRET_KEY,
        webhookSecret: config.PAYMENT_WEBHOOK_SECRET,
      });
    }

    return new DevelopmentPaymentProvider({
      // Falls back to a fixed string only outside production, where the
      // configuration guard has already refused this provider anyway.
      webhookSecret: config.PAYMENT_WEBHOOK_SECRET ?? 'development-webhook-secret',
    });
  },
};
