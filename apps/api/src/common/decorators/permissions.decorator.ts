import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@health/types';

export const PERMISSIONS_KEY = 'auth:permissions';
export const REQUIRE_MFA_KEY = 'auth:requireMfa';
export const ALLOWED_USER_TYPES_KEY = 'auth:userTypes';
export const MFA_ENROLLMENT_EXEMPT_KEY = 'auth:mfaEnrollmentExempt';

/** All listed permissions must be held (AND, not OR). */
export const RequirePermissions = (
  ...permissions: PermissionKey[]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Requires the session to have satisfied an MFA challenge. Applied on top of
 * the automatic requirement that comes from a role marked `requiresMfa`.
 */
export const RequireMfa = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_MFA_KEY, true);

/** Restricts a route to staff or to customers. */
export const AllowUserTypes = (
  ...types: Array<'STAFF' | 'CUSTOMER'>
): MethodDecorator & ClassDecorator => SetMetadata(ALLOWED_USER_TYPES_KEY, types);

/**
 * Marks a route as reachable by a principal whose role demands MFA but who has
 * not yet enrolled a factor.
 *
 * Without this, privileged accounts are in a deadlock: every route requires
 * MFA, and enrolling requires a route. The exemption is limited to
 * self-service credential management — it never carries a permission — and how
 * long an account may stay in this state is bounded by the
 * `security.staff_mfa_grace_period_days` setting, enforced at login.
 */
export const MfaEnrollmentExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(MFA_ENROLLMENT_EXEMPT_KEY, true);
