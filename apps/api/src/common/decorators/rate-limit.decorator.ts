import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'ratelimit:tier';
export const SKIP_RATE_LIMIT_KEY = 'ratelimit:skip';

/**
 * Rate-limit tiers.
 *
 * `default`   — ordinary API traffic.
 * `auth`      — sign-in, refresh and MFA verification.
 * `sensitive` — endpoints that send mail or mutate credentials, where abuse is
 *               expensive for someone other than the caller.
 */
export type RateLimitTier = 'default' | 'auth' | 'sensitive';

export const RateLimit = (tier: RateLimitTier): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, tier);

/** For probes and metrics scraping, which must not be throttled. */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_RATE_LIMIT_KEY, true);
