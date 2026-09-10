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

/** Request metadata used for audit records. */
export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string;
}
