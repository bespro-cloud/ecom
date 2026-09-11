import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedPrincipal } from '@health/types';
import { AppException } from '../errors/app-exception.js';

export interface RequestWithPrincipal extends Request {
  principal?: AuthenticatedPrincipal;
}

/**
 * Injects the authenticated principal. Throws rather than returning undefined
 * so a handler can never silently operate without an identity.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    if (!request.principal) {
      throw AppException.unauthorized();
    }
    return request.principal;
  },
);

/**
 * Injects the principal when there is one, and `undefined` when there is not.
 *
 * For `@Public()` routes that behave differently for a signed-in customer — a
 * cart, a checkout — where being signed out is an ordinary case rather than an
 * error. `@CurrentUser()` throws on purpose and must stay that way, so this is
 * a separate decorator rather than an option on it: a handler that needs an
 * identity should never be able to get `undefined` by accident.
 */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal | undefined => {
    return ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
  },
);

/** Request metadata used for audit records. */
export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string;
}
