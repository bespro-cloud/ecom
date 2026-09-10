import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type PermissionKey } from '@health/types';
import { AppException } from '../errors/app-exception.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import {
  ALLOWED_USER_TYPES_KEY,
  MFA_ENROLLMENT_EXEMPT_KEY,
  PERMISSIONS_KEY,
  REQUIRE_MFA_KEY,
} from '../decorators/permissions.decorator.js';
import type { RequestWithPrincipal } from '../decorators/current-user.decorator.js';
import { PrivilegedRoleService } from '../../modules/rbac/privileged-role.service.js';

/**
 * Authorisation guard, applied globally after authentication.
 *
 * Three checks, in order:
 *   1. user type (staff vs customer),
 *   2. MFA — required when the route asks for it *or* when the principal holds
 *      any role marked `requiresMfa`, so a privileged session can never operate
 *      on a single factor,
 *   3. permissions — every listed permission must be held.
 *
 * Permissions come from the verified token, which is re-derived from roles on
 * every issue and refresh.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly privilegedRoles: PrivilegedRoleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;
    if (!principal) throw AppException.unauthorized();

    const allowedTypes = this.reflector.getAllAndOverride<Array<'STAFF' | 'CUSTOMER'>>(
      ALLOWED_USER_TYPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(principal.type)) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'This resource is not available to your account type.',
      );
    }

    const required =
      this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const routeRequiresMfa =
      this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    const roleRequiresMfa = await this.privilegedRoles.anyRequiresMfa(principal.roles);

    if ((routeRequiresMfa || roleRequiresMfa) && !principal.mfaSatisfied) {
      // Self-service credential routes stay reachable, otherwise a privileged
      // account that has not enrolled yet could never enrol.
      const enrollmentExempt =
        this.reflector.getAllAndOverride<boolean>(MFA_ENROLLMENT_EXEMPT_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) === true;

      if (!enrollmentExempt) {
        throw AppException.forbidden(
          ERROR_CODES.MFA_REQUIRED,
          'This action requires multi-factor authentication. Please enrol a second factor and sign in again.',
        );
      }
    }

    if (required.length === 0) return true;

    const held = new Set(principal.permissions);
    const missing = required.filter((permission) => !held.has(permission));
    if (missing.length > 0) {
      throw AppException.forbidden(
        ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        'You do not have permission to perform this action.',
        { internalDetail: `missing permissions: ${missing.join(', ')}` },
      );
    }

    return true;
  }
}
