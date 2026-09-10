import { errors, jwtVerify, SignJWT } from 'jose';
import { decodeKeyMaterial } from '@health/config';
import type { PermissionKey } from '@health/types';

/**
 * Stateless access tokens (HS256).
 *
 * Deliberately short-lived: revocation is enforced at the refresh boundary,
 * where the session row is consulted. Anything that must be revoked instantly
 * (a suspended account, a forced logout) is additionally checked against the
 * session store by the guard.
 */

export const ACCESS_TOKEN_AUDIENCE = 'health-commerce:api';
export const ACCESS_TOKEN_ISSUER = 'health-commerce:auth';
export const MFA_CHALLENGE_AUDIENCE = 'health-commerce:mfa-challenge';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  email: string;
  type: 'STAFF' | 'CUSTOMER';
  roles: string[];
  permissions: PermissionKey[];
  mfa: boolean;
}

export interface MfaChallengeClaims {
  sub: string;
  /** Nonce bound to the pending login so a challenge cannot be reused. */
  jti: string;
  methods: Array<'TOTP' | 'RECOVERY_CODE'>;
}

export class TokenVerificationError extends Error {
  constructor(
    message: string,
    public readonly reason: 'EXPIRED' | 'INVALID',
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

function keyFrom(secret: string): Uint8Array {
  const decoded = decodeKeyMaterial(secret);
  if (decoded === null || decoded.length < 32) {
    throw new Error('token signing secret must decode to at least 32 bytes');
  }
  return new Uint8Array(decoded);
}

export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = keyFrom(secret);
  }

  async signAccessToken(
    claims: AccessTokenClaims,
    options: { issuedAt: Date; ttlSeconds: number },
  ): Promise<string> {
    const issuedAtSeconds = Math.floor(options.issuedAt.getTime() / 1000);
    return new SignJWT({
      sid: claims.sid,
      email: claims.email,
      type: claims.type,
      roles: claims.roles,
      permissions: claims.permissions,
      mfa: claims.mfa,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setIssuedAt(issuedAtSeconds)
      .setNotBefore(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + options.ttlSeconds)
      .sign(this.key);
  }

  async verifyAccessToken(token: string, at: Date): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        algorithms: ['HS256'],
        currentDate: at,
        clockTolerance: 5,
      });
      return {
        sub: String(payload.sub),
        sid: String(payload.sid),
        email: String(payload.email),
        type: payload.type === 'STAFF' ? 'STAFF' : 'CUSTOMER',
        roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
        permissions: Array.isArray(payload.permissions)
          ? (payload.permissions as PermissionKey[])
          : [],
        mfa: payload.mfa === true,
      };
    } catch (error) {
      throw toVerificationError(error);
    }
  }

  async signMfaChallenge(
    claims: MfaChallengeClaims,
    options: { issuedAt: Date; ttlSeconds: number },
  ): Promise<string> {
    const issuedAtSeconds = Math.floor(options.issuedAt.getTime() / 1000);
    return new SignJWT({ methods: claims.methods })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setJti(claims.jti)
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setAudience(MFA_CHALLENGE_AUDIENCE)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + options.ttlSeconds)
      .sign(this.key);
  }

  async verifyMfaChallenge(token: string, at: Date): Promise<MfaChallengeClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ACCESS_TOKEN_ISSUER,
        audience: MFA_CHALLENGE_AUDIENCE,
        algorithms: ['HS256'],
        currentDate: at,
        clockTolerance: 5,
      });
      return {
        sub: String(payload.sub),
        jti: String(payload.jti),
        methods: Array.isArray(payload.methods)
          ? (payload.methods as Array<'TOTP' | 'RECOVERY_CODE'>)
          : ['TOTP'],
      };
    } catch (error) {
      throw toVerificationError(error);
    }
  }
}

function toVerificationError(error: unknown): TokenVerificationError {
  if (error instanceof errors.JWTExpired) {
    return new TokenVerificationError('token expired', 'EXPIRED');
  }
  return new TokenVerificationError('token could not be verified', 'INVALID');
}
