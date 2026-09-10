import 'server-only';
import { cookies, headers } from 'next/headers';
import type { ApiErrorBody, ErrorCode } from '@health/types';
import { serverEnv } from './env';

/**
 * Server-side API client.
 *
 * The browser never calls the API directly and never sees a token: it talks to
 * this app, which forwards the request with the caller's cookies attached. That
 * keeps the access and refresh tokens `httpOnly` and first-party, and removes
 * CORS from the picture entirely.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-level messages keyed by form field, ready to render next to inputs. */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      if (!result[detail.path]) result[detail.path] = detail.message;
    }
    return result;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Next.js cache directives; defaults to no caching for authenticated calls. */
  cache?: RequestCache;
  revalidate?: number;
  /** Forward the caller's cookies. Off for calls made outside a request. */
  forwardCookies?: boolean;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, forwardCookies = true } = options;
  const env = serverEnv();

  const requestHeaders: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

  if (forwardCookies) {
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    if (cookieHeader) requestHeaders.Cookie = cookieHeader;

    // Carry the correlation id through, so one request id spans the whole stack.
    const incoming = await headers();
    const correlationId = incoming.get('x-correlation-id');
    if (correlationId) requestHeaders['X-Correlation-Id'] = correlationId;

    // The API's CSRF check reads this header; the value is in the cookie the
    // browser already sent us.
    const csrf = cookieStore.get('hc_csrf')?.value;
    if (csrf && method !== 'GET') requestHeaders['X-CSRF-Token'] = csrf;
  }

  const response = await fetch(`${env.API_INTERNAL_URL}${path}`, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // Authenticated responses are per-user; caching them would be a data leak.
    cache: options.cache ?? 'no-store',
    ...(options.revalidate !== undefined ? { next: { revalidate: options.revalidate } } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'Something went wrong. Please try again.',
      error?.details,
      error?.correlationId,
    );
  }

  return payload as T;
}

/**
 * Reads the signed-in user, or null when there is no valid session.
 *
 * Any other failure is rethrown: silently treating "the API is down" as
 * "signed out" would show a stranger's-eye view of the site to a signed-in
 * customer.
 */
export async function getCurrentUser<T>(): Promise<T | null> {
  try {
    return await apiRequest<T>('/api/v1/auth/me');
  } catch (error) {
    if (error instanceof ApiError && error.isAuthError) return null;
    throw error;
  }
}
