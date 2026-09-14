import { Provider } from '@nestjs/common';
import { createPaymentProvider, type PaymentProvider } from '@health/payments';
import { AppConfigService } from '../../../infrastructure/config/app-config.service.js';

/** Injection token for the configured payment provider. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * Binds the configured payment provider into Nest's container.
 *
 * Which adapter that is, is decided by `createPaymentProvider` in
 * `@health/payments` — the same function the worker calls — so the process that
 * charges a subscription renewal on a schedule cannot end up on a different
 * adapter from the one that charges a checkout.
 */
export const paymentProviderFactory: Provider = {
  provide: PAYMENT_PROVIDER,
  inject: [AppConfigService],
  useFactory: (configService: AppConfigService): PaymentProvider =>
    createPaymentProvider(configService.env),
};
