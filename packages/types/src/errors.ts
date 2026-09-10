/**
 * Stable, machine-readable error codes.
 *
 * The API returns these to clients alongside a safe public message. Internal
 * detail (stack traces, SQL, provider payloads) never crosses the boundary.
 */
export const ERROR_CODES = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',

  // 401
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',

  // 404 / 409 / 422
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  STATE_TRANSITION_INVALID: 'STATE_TRANSITION_INVALID',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',

  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorBody {
  error: {
    /** Stable machine-readable code. Safe to branch on in clients. */
    code: ErrorCode;
    /** Safe, human-readable message. Never contains internal detail. */
    message: string;
    /** Correlation id, echoed in logs and Sentry. Quote it in support tickets. */
    correlationId: string;
    /** Field-level validation problems, when `code` is VALIDATION_FAILED. */
    details?: Array<{ path: string; message: string }>;
  };
}
