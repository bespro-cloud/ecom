import type { CookieOptions, Request, Response } from 'express';
import type { AppConfigService } from '../../../infrastructure/config/app-config.service.js';

/**
 * The guest-cart cookie.
 *
 * A guest cart is reachable only by this token — there is no route that takes a
 * cart id — so the cookie is treated like a session credential: httpOnly, so
 * XSS cannot read it, and SameSite=Lax, so another site cannot make requests
 * that carry it.
 *
 * It deliberately outlives a browser session. Someone who fills a basket and
 * comes back tomorrow should find it there.
 */
export const CART_COOKIE = 'hc_cart';

const CART_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function options(config: AppConfigService): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: CART_COOKIE_MAX_AGE_MS,
    ...(config.env.COOKIE_DOMAIN ? { domain: config.env.COOKIE_DOMAIN } : {}),
  };
}

export function readCartToken(request: Request): string | null {
  const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
  const value = cookies?.[CART_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function setCartCookie(response: Response, config: AppConfigService, token: string): void {
  response.cookie(CART_COOKIE, token, options(config));
}

export function clearCartCookie(response: Response, config: AppConfigService): void {
  const { maxAge: _maxAge, ...rest } = options(config);
  response.clearCookie(CART_COOKIE, rest);
}
