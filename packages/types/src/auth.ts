import type { PermissionKey } from './permissions.js';

export type UserType = 'STAFF' | 'CUSTOMER';

export interface AuthenticatedPrincipal {
  userId: string;
  email: string;
  type: UserType;
  sessionId: string;
  roles: string[];
  permissions: PermissionKey[];
  /** True when this session has satisfied an MFA challenge. */
  mfaSatisfied: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  type: UserType;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  emailVerified: boolean;
  mfaEnabled: boolean;
  roles: string[];
  permissions: PermissionKey[];
  createdAt: string;
}

export interface LoginChallenge {
  /** Short-lived, single-purpose token proving the password step succeeded. */
  challengeToken: string;
  expiresAt: string;
  methods: Array<'TOTP' | 'RECOVERY_CODE'>;
}

export type LoginResult =
  | { status: 'AUTHENTICATED'; user: PublicUser }
  | { status: 'MFA_REQUIRED'; challenge: LoginChallenge };
