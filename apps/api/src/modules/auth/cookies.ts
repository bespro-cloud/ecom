import type { CookieOptions, Response, Request } from 'express';
import type { AppConfigService } from '../../infrastructure/config/app-config.service.js';

/**
 * Cookie strategy.
 *
 * Tokens live in cookies rather than in `localStorage` so that XSS cannot read
 * them. The trade-off is CSRF exposure, which is closed by SameSite=Lax plus an
 * explicit double-submit token on every state-changing request (see
 * CsrfGuard).
 *
 * The refresh cookie is additionally path-scoped to the refresh endpoint, so it
 * is not attached to ordinary API calls at all.
 */
export const ACCESS_TOKEN_COOKIE = 'hc_access';
export const REFRESH_TOKEN_COOKIE = 'hc_refresh';
export const CSRF_COOKIE = 'hc_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(config: AppConfigService): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    // Lax, not Strict: Strict would drop the cookie on a return from an email
    // link or a payment provider redirect, logging the user out mid-flow.
    sameSite: 'lax',
    ...(config.env.COOKIE_DOMAIN ? { domain: config.env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(
  res: Response,
  config: AppConfigService,
  tokens: { accessToken: string; refreshToken: string; csrfToken: string },
): void {
  const base = baseOptions(config);

  res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...base,
    path: '/',
    maxAge: config.env.ACCESS_TOKEN_TTL_SECONDS * 1000,
  });

  res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: config.env.REFRESH_TOKEN_TTL_SECONDS * 1000,
  });

  // Readable by JavaScript on purpose: the browser must echo it in a header.
  // Its value is useless to an attacker who cannot read the response.
  res.cookie(CSRF_COOKIE, tokens.csrfToken, {
    ...base,
    httpOnly: false,
    path: '/',
    maxAge: config.env.REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
}

export function clearAuthCookies(res: Response, config: AppConfigService): void {
  const base = baseOptions(config);
  res.clearCookie(ACCESS_TOKEN_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, path: '/' });
}

/**
 * Reads the bearer token from the Authorization header, falling back to the
 * cookie. Header first so server-to-server and mobile clients work without
 * cookies at all.
 */
export function extractAccessToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const value = header.slice(7).trim();
    if (value.length > 0) return value;
  }
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[ACCESS_TOKEN_COOKIE] ?? null;
}

export function extractRefreshToken(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const fromCookie = cookies?.[REFRESH_TOKEN_COOKIE];
  if (fromCookie) return fromCookie;
  const body = req.body as { refreshToken?: unknown } | undefined;
  return typeof body?.refreshToken === 'string' ? body.refreshToken : null;
}
