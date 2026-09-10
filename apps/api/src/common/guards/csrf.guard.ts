import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ERROR_CODES } from '@health/types';
import type { Request } from 'express';
import { AppException } from '../errors/app-exception.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../modules/auth/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection.
 *
 * Applies only to cookie-authenticated, state-changing requests. A request
 * carrying an `Authorization: Bearer` header is exempt: a cross-site form or
 * image cannot set that header, so there is nothing to forge.
 *
 * SameSite=Lax already blocks the common cases; this is the second layer that
 * survives a browser or embedded-webview that mishandles SameSite.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    // Bearer-authenticated requests are not cookie-driven.
    if (request.headers.authorization?.startsWith('Bearer ')) return true;

    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    const cookieToken = cookies?.[CSRF_COOKIE];

    // No auth cookie at all — nothing to protect (e.g. login, register).
    if (!cookieToken) return true;

    const headerValue = request.headers[CSRF_HEADER];
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (!headerToken || !safeEqual(cookieToken, headerToken)) {
      throw AppException.forbidden(
        ERROR_CODES.CSRF_TOKEN_INVALID,
        'Your session could not be verified. Please refresh the page and try again.',
      );
    }
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
