import { randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard.js';
import { AppException } from '../errors/app-exception.js';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();
  const token = randomBytes(32).toString('base64url');

  it('allows safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard.canActivate(contextFor({ method, headers: {}, cookies: {} }))).toBe(true);
    }
  });

  it('allows bearer-authenticated writes, which a cross-site form cannot forge', () => {
    const context = contextFor({
      method: 'POST',
      headers: { authorization: 'Bearer abc' },
      cookies: { hc_csrf: token },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows requests with no auth cookie at all', () => {
    expect(guard.canActivate(contextFor({ method: 'POST', headers: {}, cookies: {} }))).toBe(true);
  });

  it('requires a matching header when a CSRF cookie is present', () => {
    const missing = contextFor({ method: 'POST', headers: {}, cookies: { hc_csrf: token } });
    expect(() => guard.canActivate(missing)).toThrow(AppException);

    const wrong = contextFor({
      method: 'POST',
      headers: { 'x-csrf-token': randomBytes(32).toString('base64url') },
      cookies: { hc_csrf: token },
    });
    expect(() => guard.canActivate(wrong)).toThrow(AppException);

    const correct = contextFor({
      method: 'POST',
      headers: { 'x-csrf-token': token },
      cookies: { hc_csrf: token },
    });
    expect(guard.canActivate(correct)).toBe(true);
  });

  it('rejects a header that merely shares a prefix with the cookie', () => {
    const context = contextFor({
      method: 'POST',
      headers: { 'x-csrf-token': token.slice(0, 8) },
      cookies: { hc_csrf: token },
    });
    expect(() => guard.canActivate(context)).toThrow(AppException);
  });

  it('reports a specific error code so the client can retry sensibly', () => {
    const context = contextFor({ method: 'DELETE', headers: {}, cookies: { hc_csrf: token } });
    try {
      guard.canActivate(context);
      throw new Error('expected the guard to reject');
    } catch (error) {
      expect((error as AppException).code).toBe('CSRF_TOKEN_INVALID');
      expect((error as AppException).getStatus()).toBe(403);
    }
  });
});
