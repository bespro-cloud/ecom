import type { NextRequest } from 'next/server';
import { proxyToApi } from '@/lib/proxy';

/**
 * Single entry point for browser-initiated API calls.
 *
 * Client components call `/api/proxy/...` on this origin; the request is
 * forwarded to the API with cookies intact. Nothing here inspects or rewrites
 * the payload — it is a transport, and the API remains the only authority on
 * authentication and authorisation.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxyToApi(request, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
