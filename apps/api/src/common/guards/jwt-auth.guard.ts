import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Clock } from '@health/config';
import { Inject } from '@nestjs/common';
import { AccessTokenService, TokenVerificationError } from '@health/auth';
import { ERROR_CODES } from '@health/types';
import { AppException } from '../errors/app-exception.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { extractAccessToken } from '../../modules/auth/cookies.js';
import { SessionService } from '../../modules/auth/session.service.js';
import type { RequestWithPrincipal } from '../decorators/current-user.decorator.js';

/**
 * Authentication guard, applied globally.
 *
 * Routes are authenticated unless explicitly marked `@Public()`, so a new
 * endpoint is protected by default. Beyond verifying the token signature, the
 * guard confirms the *session* is still live — that is what makes logout,
 * password change and administrative revocation take effect immediately rather
 * than at the end of the access token's lifetime.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const token = extractAccessToken(request);

    if (!token) {
      if (isPublic) return true;
      throw AppException.unauthorized();
    }

    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token, this.clock.now());
    } catch (error) {
      if (isPublic) return true;
      const expired = error instanceof TokenVerificationError && error.reason === 'EXPIRED';
      throw AppException.unauthorized(
        expired ? ERROR_CODES.SESSION_EXPIRED : ERROR_CODES.AUTH_REQUIRED,
        expired ? 'Your session has expired. Please sign in again.' : 'Authentication is required.',
      );
    }

    const session = await this.sessions.findActive(claims.sid);
    if (!session || session.userId !== claims.sub) {
      if (isPublic) return true;
      throw AppException.unauthorized(
        ERROR_CODES.SESSION_REVOKED,
        'Your session is no longer valid. Please sign in again.',
      );
    }

    request.principal = {
      userId: claims.sub,
      email: claims.email,
      type: claims.type,
      sessionId: claims.sid,
      roles: claims.roles,
      permissions: claims.permissions,
      // The session row is authoritative: a token minted before MFA was
      // completed cannot claim otherwise.
      mfaSatisfied: session.mfaSatisfied && claims.mfa,
    };
    return true;
  }
}
