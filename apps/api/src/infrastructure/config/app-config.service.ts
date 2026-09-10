import { Injectable } from '@nestjs/common';
import { parseServerEnv, type ServerEnv } from '@health/config';

/**
 * Typed access to validated configuration.
 *
 * The environment is parsed exactly once, at construction. If it does not
 * satisfy the contract the process fails to start rather than running with a
 * partially-configured security posture.
 */
@Injectable()
export class AppConfigService {
  readonly env: ServerEnv;

  constructor(source: NodeJS.ProcessEnv = process.env) {
    this.env = parseServerEnv(source);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  /** Secure cookies default to on everywhere except explicit local dev. */
  get cookieSecure(): boolean {
    return this.env.COOKIE_SECURE ?? this.isProduction;
  }

  get corsOrigins(): string[] {
    if (this.env.CORS_ALLOWED_ORIGINS.length > 0) return this.env.CORS_ALLOWED_ORIGINS;
    // Development convenience only; production validation rejects an empty list.
    return [this.env.STOREFRONT_PUBLIC_URL, this.env.ADMIN_PUBLIC_URL];
  }
}
