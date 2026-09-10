import type { AuditActorType, AuditOutcome } from '@health/database';

/**
 * Canonical audit action names.
 *
 * Actions are `<domain>.<verb>` and past tense where the action has completed.
 * Keeping them in one place means the admin log viewer can offer a filter list
 * that is guaranteed to match what is actually written.
 */
export const AUDIT_ACTIONS = {
  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGIN_BLOCKED: 'auth.login.blocked',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_LOGOUT_ALL: 'auth.logout_all',
  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',
  AUTH_TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  AUTH_REGISTERED: 'auth.registered',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',
  AUTH_PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  AUTH_PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  AUTH_EMAIL_VERIFIED: 'auth.email.verified',
  MFA_ENROLLMENT_STARTED: 'mfa.enrollment.started',
  MFA_ENROLLED: 'mfa.enrolled',
  MFA_DISABLED: 'mfa.disabled',
  MFA_CHALLENGE_SUCCEEDED: 'mfa.challenge.succeeded',
  MFA_CHALLENGE_FAILED: 'mfa.challenge.failed',
  MFA_RECOVERY_CODE_USED: 'mfa.recovery_code.used',
  MFA_RECOVERY_CODES_REGENERATED: 'mfa.recovery_codes.regenerated',
  USER_INVITED: 'user.invited',
  USER_INVITE_ACCEPTED: 'user.invite.accepted',
  USER_UPDATED: 'user.updated',
  USER_STATUS_CHANGED: 'user.status.changed',
  USER_ROLES_CHANGED: 'user.roles.changed',
  USER_SESSIONS_REVOKED: 'user.sessions.revoked',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  CUSTOMER_PROFILE_UPDATED: 'customer.profile.updated',
  CUSTOMER_ADDRESS_CREATED: 'customer.address.created',
  CUSTOMER_ADDRESS_UPDATED: 'customer.address.updated',
  CUSTOMER_ADDRESS_DELETED: 'customer.address.deleted',
  CUSTOMER_CONSENT_RECORDED: 'customer.consent.recorded',
  SETTING_UPDATED: 'system.setting.updated',
  FEATURE_FLAG_UPDATED: 'system.feature_flag.updated',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditWrite {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  actorType?: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  outcome?: AuditOutcome;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}
