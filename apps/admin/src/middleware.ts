import { NextResponse, type NextRequest } from 'next/server';

/**
 * The admin console has no public surface at all.
 *
 * Everything except the sign-in and invite-acceptance routes requires a session
 * cookie. As on the storefront this is a fast path, not the security boundary:
 * the API enforces roles, permissions and the MFA requirement on every single
 * request regardless of what happens here.
 */
const PUBLIC_PATHS = ['/sign-in', '/accept-invite'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const hasSession = request.cookies.has('hc_access') || request.cookies.has('hc_refresh');
  if (hasSession) return NextResponse.next();

  const signIn = new URL('/sign-in', request.url);
  if (pathname !== '/') signIn.searchParams.set('next', pathname);
  return NextResponse.redirect(signIn, 307);
}

export const config = {
  // Everything except Next's own assets and the proxy route (which forwards
  // credentials verbatim and is authorised by the API).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/proxy).*)'],
};
