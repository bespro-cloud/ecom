'use client';

import type { ApiErrorBody, ErrorCode } from '@health/types';

/**
 * Browser-side API access.
 *
 * Always goes through this app's own `/api/proxy` route, never directly to the
 * API. Tokens stay in httpOnly cookies the browser attaches automatically —
 * there is nothing here for an XSS payload to steal.
 */

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ClientApiError';
  }

  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      if (!result[detail.path]) result[detail.path] = detail.message;
    }
    return result;
  }
}

function readCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)hc_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export async function clientRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = 'GET', body, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Double-submit token: the cookie is readable by design, the header is what
  // a cross-site request cannot forge.
  if (method !== 'GET') {
    const csrf = readCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const response = await fetch(`/api/proxy${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
    credentials: 'same-origin',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ClientApiError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? 'Something went wrong. Please try again.',
      error?.details,
      error?.correlationId,
    );
  }

  return payload as T;
}
