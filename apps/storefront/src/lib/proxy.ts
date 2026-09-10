import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { serverEnv } from './env';

/**
 * Transparent proxy from this app's origin to the API.
 *
 * Everything the browser sends — cookies, CSRF header, correlation id — is
 * forwarded, and every `Set-Cookie` the API returns is passed straight back, so
 * session rotation keeps working. Because the browser only ever addresses its
 * own origin, the auth cookies stay first-party and `SameSite=Lax` does its job
 * even when the API is served from a different hostname.
 */

/** Headers we refuse to forward in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export async function proxyToApi(request: NextRequest, path: string[]): Promise<Response> {
  const env = serverEnv();
  // The caller supplies the full API path (`/api/v1/...`); this route is a
  // transport and does not decide which version or namespace to talk to.
  const target = new URL(`/${path.join('/')}`, env.API_INTERNAL_URL);
  target.search = request.nextUrl.search;

  const outgoing = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outgoing.set(key, value);
  });
  // The API is behind this proxy; tell it who the real caller is so rate
  // limiting and audit records attribute to the right client.
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) outgoing.set('x-forwarded-for', forwardedFor);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: outgoing,
      ...(hasBody ? { body: await request.text() } : {}),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    // The API is unreachable. Return the same error shape the API would, so
    // clients have one thing to handle.
    return NextResponse.json(
      {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'We could not reach the service. Please try again shortly.',
          correlationId: request.headers.get('x-correlation-id') ?? 'unknown',
        },
      },
      { status: 503 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    // set-cookie must be appended, not set: the API sends several.
    if (key.toLowerCase() === 'set-cookie') return;
    responseHeaders.set(key, value);
  });

  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }
  responseHeaders.set('Cache-Control', 'no-store');

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
