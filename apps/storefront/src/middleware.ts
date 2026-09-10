import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge-level gate for the account area.
 *
 * This runs before any rendering, so an unauthenticated visitor gets a clean
 * 307 to the sign-in page instead of a partially-rendered layout racing a
 * server-side redirect.
 *
 * It checks only whether a session cookie is *present* — it cannot verify the
 * token, and it deliberately does not try. Authorisation is the API's job; this
 * is a fast path that avoids a pointless round trip for visitors who obviously
 * have no session. A forged cookie gets past it and is then rejected by the API
 * exactly as it would have been.
 */
const PROTECTED_PREFIXES = ['/account'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const needsSession = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!needsSession) return NextResponse.next();

  const hasSession = request.cookies.has('hc_access') || request.cookies.has('hc_refresh');
  if (hasSession) return NextResponse.next();

  const signIn = new URL('/login', request.url);
  signIn.searchParams.set('next', pathname);
  return NextResponse.redirect(signIn, 307);
}

export const config = {
  matcher: ['/account/:path*', '/account'],
};
