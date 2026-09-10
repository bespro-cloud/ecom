import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, truncateIp, type Clock } from '@health/config';
import {
  AccessTokenService,
  burnPasswordComparison,
  evaluatePassword,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  needsRehash,
  PASSWORD_ALGORITHM_ID,
  verifyPassword,
} from '@health/auth';
import { DOMAIN_EVENTS, ERROR_CODES, type LoginResult, type PublicUser } from '@health/types';
import { normalizeEmail, type LoginInput, type RegisterInput } from '@health/validation';
import { isUniqueConstraintError, type DbClient, type User } from '@health/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { OutboxService } from '../../infrastructure/outbox/outbox.service.js';
import { MetricsService } from '../../infrastructure/metrics/metrics.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';
import { SettingsService } from '../settings/settings.service.js';
import { SessionService, type SessionContext } from './session.service.js';
import { PrincipalService, type UserAuthorizationProfile } from './principal.service.js';
import { MfaService } from './mfa.service.js';

export interface AuthRequestContext extends SessionContext {
  correlationId: string;
}

export interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  user: PublicUser;
}

export type LoginOutcome =
  | { status: 'AUTHENTICATED'; session: AuthenticatedSession }
  | {
      status: 'MFA_REQUIRED';
      challengeToken: string;
      expiresAt: Date;
      methods: Array<'TOTP' | 'RECOVERY_CODE'>;
    };

const CUSTOMER_ROLE_KEY = 'CUSTOMER';

/**
 * Authentication.
 *
 * Design commitments worth stating explicitly:
 *
 *  - Login never reveals whether an address is registered. A miss still spends
 *    a password-hash's worth of time, and every failure returns the same code.
 *  - Failed attempts are counted per account *and* per source, so neither an
 *    account nor an IP can be used to brute force the other.
 *  - MFA is a second, independent step: the password step yields only a
 *    single-use challenge token that carries no session authority.
 *  - Anything that changes a credential revokes existing sessions.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly sessions: SessionService,
    private readonly principals: PrincipalService,
    private readonly mfa: MfaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly metrics: MetricsService,
    private readonly tokens: AccessTokenService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(AuthService.name);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  async register(input: RegisterInput, context: AuthRequestContext): Promise<AuthenticatedSession> {
    const policy = evaluatePassword(input.password, {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
    });
    if (!policy.ok) {
      throw AppException.validation(
        policy.problems.map((message) => ({ path: 'password', message })),
      );
    }

    const emailNormalized = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const now = this.clock.now();

    const customerRole = await this.prisma.role.findUnique({ where: { key: CUSTOMER_ROLE_KEY } });
    if (!customerRole) {
      throw AppException.internal('CUSTOMER role missing; RBAC sync has not been run');
    }

    let created: { user: User; refreshToken: string; sessionId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email.trim(),
            emailNormalized,
            passwordHash,
            passwordAlgorithm: PASSWORD_ALGORITHM_ID,
            passwordUpdatedAt: now,
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone ?? null,
            type: 'CUSTOMER',
            status: 'ACTIVE',
          },
        });

        await tx.userRole.create({ data: { userId: user.id, roleId: customerRole.id } });

        const customer = await tx.customer.create({
          data: {
            userId: user.id,
            reference: await this.nextCustomerReference(tx),
            acceptsMarketingEmail: input.acceptsMarketingEmail,
          },
        });

        // Consent is an append-only ledger entry, recorded with the same
        // request metadata we would need to evidence it later.
        await tx.customerConsent.createMany({
          data: [
            {
              customerId: customer.id,
              type: 'TERMS_OF_SERVICE',
              granted: true,
              source: 'registration',
              ipAddress: truncateIp(context.ipAddress),
              userAgent: context.userAgent?.slice(0, 512) ?? null,
            },
            {
              customerId: customer.id,
              type: 'MARKETING_EMAIL',
              granted: input.acceptsMarketingEmail,
              source: 'registration',
              ipAddress: truncateIp(context.ipAddress),
              userAgent: context.userAgent?.slice(0, 512) ?? null,
            },
          ],
        });

        const verificationToken = generateOpaqueToken();
        await tx.userToken.create({
          data: {
            userId: user.id,
            type: 'EMAIL_VERIFICATION',
            tokenHash: hashToken(verificationToken),
            expiresAt: addSeconds(now, this.config.env.EMAIL_VERIFICATION_TTL_SECONDS),
          },
        });

        await this.outbox.publish(tx, {
          aggregateType: 'user',
          aggregateId: user.id,
          eventType: DOMAIN_EVENTS.USER_REGISTERED,
          payload: { userId: user.id, customerId: customer.id, verificationToken },
          correlationId: context.correlationId,
        });

        await this.audit.recordIn(tx, {
          action: AUDIT_ACTIONS.AUTH_REGISTERED,
          entityType: 'user',
          entityId: user.id,
          actorId: user.id,
          actorLabel: user.email,
          ipAddress: truncateIp(context.ipAddress),
          userAgent: context.userAgent,
          correlationId: context.correlationId,
        });

        const issued = await this.sessions.issue(tx, user.id, {
          ...context,
          mfaSatisfied: false,
        });

        return { user, refreshToken: issued.token, sessionId: issued.session.id };
      });
    } catch (error) {
      if (isUniqueConstraintError(error, 'email')) {
        // Do not confirm that the address is taken: that turns registration
        // into an account-enumeration oracle. The worker sends a "someone tried
        // to register with your address" email instead.
        throw AppException.conflict(
          'We could not complete registration with those details. If you already have an account, try signing in or resetting your password.',
          ERROR_CODES.ALREADY_EXISTS,
          { internalDetail: `duplicate registration for ${emailNormalized}` },
        );
      }
      throw error;
    }

    this.metrics.authEvents.inc({ event: 'register', outcome: 'success' });
    return this.buildSession(created.user.id, created.sessionId, created.refreshToken, false);
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(input: LoginInput, context: AuthRequestContext): Promise<LoginOutcome> {
    const emailNormalized = normalizeEmail(input.email);
    await this.assertSourceNotThrottled(context.ipAddress);

    const user = await this.prisma.user.findFirst({
      where: { emailNormalized, deletedAt: null },
    });

    if (!user || !user.passwordHash) {
      // Spend comparable time so a missing account is not detectable by timing.
      await burnPasswordComparison(input.password);
      await this.recordFailedAttempt(null, emailNormalized, context, 'no such account');
      throw this.invalidCredentials();
    }

    const now = this.clock.now();
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      await this.audit.record({
        action: AUDIT_ACTIONS.AUTH_LOGIN_BLOCKED,
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        actorLabel: user.email,
        outcome: 'FAILURE',
        reason: 'account temporarily locked',
        ipAddress: truncateIp(context.ipAddress),
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
      this.metrics.authEvents.inc({ event: 'login', outcome: 'locked' });
      throw new AppException(
        ERROR_CODES.ACCOUNT_LOCKED,
        403,
        'This account is temporarily locked after too many failed sign-in attempts. Try again later or reset your password.',
      );
    }

    const passwordValid = await verifyPassword(user.passwordHash, input.password);
    if (!passwordValid) {
      await this.recordFailedAttempt(user, emailNormalized, context, 'wrong password');
      throw this.invalidCredentials();
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        action: AUDIT_ACTIONS.AUTH_LOGIN_BLOCKED,
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        actorLabel: user.email,
        outcome: 'FAILURE',
        reason: `account status ${user.status}`,
        ipAddress: truncateIp(context.ipAddress),
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
      this.metrics.authEvents.inc({ event: 'login', outcome: 'inactive' });
      throw AppException.forbidden(
        ERROR_CODES.ACCOUNT_SUSPENDED,
        'This account is not currently able to sign in. Please contact support.',
      );
    }

    const profile = await this.principals.loadProfile(user.id);
    if (!profile) throw AppException.internal('authorization profile missing for existing user');

    // Opportunistic rehash: the user just proved the password, so we can
    // upgrade a hash produced under weaker parameters at zero extra cost.
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(input.password);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: upgraded, passwordAlgorithm: PASSWORD_ALGORITHM_ID },
      });
    }

    await this.clearFailedAttempts(user, context);

    if (profile.mfaEnabled) {
      return this.issueMfaChallenge(user, ['TOTP', 'RECOVERY_CODE'], context);
    }

    if (profile.requiresMfa) {
      // A privileged role with no factor enrolled. The session is allowed, but
      // the authorisation guard confines it to the enrolment endpoints, and
      // the grace period below bounds how long that state may last.
      await this.assertWithinMfaGracePeriod(user, profile.roles);
      this.logger.warn(
        { userId: user.id, roles: profile.roles },
        'privileged account signed in without MFA enrolled; enrolment required',
      );
    }

    const session = await this.startSession(user.id, context, false);
    await this.recordSuccessfulLogin(user, context);
    this.metrics.authEvents.inc({ event: 'login', outcome: 'success' });
    return { status: 'AUTHENTICATED', session };
  }

  /**
   * Completes the second factor and upgrades the pending login into a real
   * session.
   */
  async verifyMfa(
    input: { challengeToken: string; code?: string; recoveryCode?: string },
    context: AuthRequestContext,
  ): Promise<AuthenticatedSession> {
    const now = this.clock.now();
    let claims: { sub: string; jti: string };
    try {
      claims = await this.tokens.verifyMfaChallenge(input.challengeToken, now);
    } catch {
      throw AppException.unauthorized(
        ERROR_CODES.MFA_INVALID,
        'This verification step has expired. Please sign in again.',
      );
    }

    // The challenge is single-use: claiming the nonce is atomic in Redis, so a
    // captured token cannot be replayed even within its validity window.
    const claimed = await this.redis.claimOnce(
      'mfa:challenge',
      claims.jti,
      this.config.env.MFA_CHALLENGE_TTL_SECONDS,
    );
    if (!claimed) {
      throw AppException.unauthorized(
        ERROR_CODES.MFA_INVALID,
        'This verification step has already been used. Please sign in again.',
      );
    }

    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, deletedAt: null, status: 'ACTIVE' },
    });
    if (!user) throw this.invalidCredentials();

    const verified = input.recoveryCode
      ? await this.mfa.consumeRecoveryCode(user.id, input.recoveryCode)
      : await this.mfa.verifyTotpCode(user.id, input.code ?? '');

    if (!verified.ok) {
      await this.audit.record({
        action: AUDIT_ACTIONS.MFA_CHALLENGE_FAILED,
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        actorLabel: user.email,
        outcome: 'FAILURE',
        reason: verified.reason,
        ipAddress: truncateIp(context.ipAddress),
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
      this.metrics.authEvents.inc({ event: 'mfa', outcome: 'failure' });
      throw AppException.unauthorized(
        ERROR_CODES.MFA_INVALID,
        'That code was not accepted. Check your authenticator app and try again.',
      );
    }

    await this.audit.record({
      action: input.recoveryCode
        ? AUDIT_ACTIONS.MFA_RECOVERY_CODE_USED
        : AUDIT_ACTIONS.MFA_CHALLENGE_SUCCEEDED,
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorLabel: user.email,
      ipAddress: truncateIp(context.ipAddress),
      userAgent: context.userAgent,
      correlationId: context.correlationId,
    });

    const session = await this.startSession(user.id, context, true);
    await this.recordSuccessfulLogin(user, context);
    this.metrics.authEvents.inc({ event: 'mfa', outcome: 'success' });
    return session;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string, context: AuthRequestContext): Promise<AuthenticatedSession> {
    const outcome = await this.sessions.rotate(refreshToken, context);

    switch (outcome.status) {
      case 'ROTATED': {
        const profile = await this.principals.loadProfile(outcome.previous.userId);
        if (!profile || profile.status !== 'ACTIVE') {
          // The account changed since the token was issued; do not extend it.
          await this.sessions.revoke(outcome.issued.session.id, 'ADMIN_REVOKED');
          throw AppException.unauthorized(
            ERROR_CODES.SESSION_REVOKED,
            'Your session is no longer valid. Please sign in again.',
          );
        }
        return this.buildSession(
          outcome.previous.userId,
          outcome.issued.session.id,
          outcome.issued.token,
          outcome.issued.session.mfaSatisfied,
        );
      }
      case 'REUSE_DETECTED': {
        await this.audit.record({
          action: AUDIT_ACTIONS.AUTH_TOKEN_REUSE_DETECTED,
          entityType: 'user_session',
          entityId: outcome.session.id,
          actorId: outcome.session.userId,
          outcome: 'FAILURE',
          reason: 'refresh token replay; session family revoked',
          ipAddress: truncateIp(context.ipAddress),
          userAgent: context.userAgent,
          correlationId: context.correlationId,
        });
        this.metrics.authEvents.inc({ event: 'refresh', outcome: 'reuse_detected' });
        throw AppException.unauthorized(
          ERROR_CODES.SESSION_REVOKED,
          'Your session was ended for security reasons. Please sign in again.',
        );
      }
      case 'EXPIRED':
        this.metrics.authEvents.inc({ event: 'refresh', outcome: 'expired' });
        throw AppException.unauthorized(
          ERROR_CODES.SESSION_EXPIRED,
          'Your session has expired. Please sign in again.',
        );
      case 'REVOKED':
        this.metrics.authEvents.inc({ event: 'refresh', outcome: 'revoked' });
        throw AppException.unauthorized(
          ERROR_CODES.SESSION_REVOKED,
          'Your session is no longer valid. Please sign in again.',
        );
      case 'NOT_FOUND':
      default:
        this.metrics.authEvents.inc({ event: 'refresh', outcome: 'not_found' });
        throw AppException.unauthorized(
          ERROR_CODES.SESSION_EXPIRED,
          'Your session has expired. Please sign in again.',
        );
    }
  }

  async logout(sessionId: string, context: AuthRequestContext, userId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'LOGOUT');
    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGOUT,
      entityType: 'user_session',
      entityId: sessionId,
      actorId: userId,
      ipAddress: truncateIp(context.ipAddress),
      userAgent: context.userAgent,
      correlationId: context.correlationId,
    });
  }

  async logoutAll(userId: string, context: AuthRequestContext): Promise<number> {
    const revoked = await this.sessions.revokeAllForUser(this.prisma, userId, 'LOGOUT_ALL');
    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGOUT_ALL,
      entityType: 'user',
      entityId: userId,
      actorId: userId,
      after: { revokedSessions: revoked },
      ipAddress: truncateIp(context.ipAddress),
      userAgent: context.userAgent,
      correlationId: context.correlationId,
    });
    return revoked;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async startSession(
    userId: string,
    context: AuthRequestContext,
    mfaSatisfied: boolean,
  ): Promise<AuthenticatedSession> {
    const issued = await this.prisma.$transaction((tx) =>
      this.sessions.issue(tx, userId, { ...context, mfaSatisfied }),
    );
    return this.buildSession(userId, issued.session.id, issued.token, mfaSatisfied);
  }

  private async buildSession(
    userId: string,
    sessionId: string,
    refreshToken: string,
    mfaSatisfied: boolean,
  ): Promise<AuthenticatedSession> {
    const profile = await this.principals.loadProfile(userId);
    if (!profile) throw AppException.internal('authorization profile missing after authentication');

    const now = this.clock.now();
    const accessToken = await this.tokens.signAccessToken(
      {
        sub: profile.userId,
        sid: sessionId,
        email: profile.email,
        type: profile.type,
        roles: profile.roles,
        permissions: profile.permissions,
        mfa: mfaSatisfied,
      },
      { issuedAt: now, ttlSeconds: this.config.env.ACCESS_TOKEN_TTL_SECONDS },
    );

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: addSeconds(now, this.config.env.ACCESS_TOKEN_TTL_SECONDS),
      refreshTokenExpiresAt: addSeconds(now, this.config.env.REFRESH_TOKEN_TTL_SECONDS),
      user: await this.toPublicUser(profile),
    };
  }

  async toPublicUser(profile: UserAuthorizationProfile): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: profile.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        type: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      type: user.type,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      mfaEnabled: profile.mfaEnabled,
      roles: profile.roles,
      permissions: profile.permissions,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private async issueMfaChallenge(
    user: User,
    methods: Array<'TOTP' | 'RECOVERY_CODE'>,
    context: AuthRequestContext,
  ): Promise<LoginOutcome> {
    const now = this.clock.now();
    const jti = randomUUID();
    const challengeToken = await this.tokens.signMfaChallenge(
      { sub: user.id, jti, methods },
      { issuedAt: now, ttlSeconds: this.config.env.MFA_CHALLENGE_TTL_SECONDS },
    );
    this.metrics.authEvents.inc({ event: 'login', outcome: 'mfa_required' });
    this.logger.info(
      { userId: user.id, correlationId: context.correlationId },
      'mfa challenge issued',
    );
    return {
      status: 'MFA_REQUIRED',
      challengeToken,
      expiresAt: addSeconds(now, this.config.env.MFA_CHALLENGE_TTL_SECONDS),
      methods,
    };
  }

  /**
   * Bounds how long a privileged account may operate before enrolling a second
   * factor. Measured from when the account last set a password — that is when
   * the person first had access — rather than from row creation, so an invited
   * account is not penalised for a slow acceptance.
   *
   * Fails closed: once the window has passed, sign-in is refused entirely and
   * an administrator must intervene.
   */
  private async assertWithinMfaGracePeriod(user: User, roles: string[]): Promise<void> {
    const graceDays =
      (await this.settings.get<number>('security.staff_mfa_grace_period_days')) ?? 7;
    const since = user.passwordUpdatedAt ?? user.createdAt;
    const deadline = addSeconds(since, graceDays * 24 * 60 * 60);

    if (this.clock.timestamp() <= deadline.getTime()) return;

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGIN_BLOCKED,
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorLabel: user.email,
      outcome: 'FAILURE',
      reason: `MFA enrolment grace period of ${graceDays} day(s) expired`,
      after: { roles },
    });
    this.metrics.authEvents.inc({ event: 'login', outcome: 'mfa_enrollment_overdue' });

    throw AppException.forbidden(
      ERROR_CODES.MFA_ENROLLMENT_REQUIRED,
      'Multi-factor authentication is required for your role and the enrolment window has closed. Ask an administrator to reset your access.',
    );
  }

  private invalidCredentials(): AppException {
    // One message for "no such user" and "wrong password" alike.
    return AppException.unauthorized(
      ERROR_CODES.INVALID_CREDENTIALS,
      'Email address or password is incorrect.',
    );
  }

  private async assertSourceNotThrottled(ipAddress?: string | null): Promise<void> {
    const source = truncateIp(ipAddress);
    if (!source) return;
    const attempts = await this.redis.incrementWindow('login:source', source, 60);
    if (attempts > this.config.env.RATE_LIMIT_AUTH_PER_MINUTE * 5) {
      this.metrics.authEvents.inc({ event: 'login', outcome: 'source_throttled' });
      throw AppException.rateLimited(
        'Too many sign-in attempts from this network. Please wait a minute and try again.',
      );
    }
  }

  private async recordFailedAttempt(
    user: User | null,
    emailNormalized: string,
    context: AuthRequestContext,
    reason: string,
  ): Promise<void> {
    this.metrics.authEvents.inc({ event: 'login', outcome: 'failure' });

    if (user) {
      const attempts = user.failedLoginCount + 1;
      const shouldLock = attempts >= this.config.env.LOGIN_MAX_FAILED_ATTEMPTS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: attempts,
          lockedUntil: shouldLock
            ? addSeconds(this.clock.now(), this.config.env.LOGIN_LOCKOUT_SECONDS)
            : user.lockedUntil,
        },
      });

      if (shouldLock) {
        await this.prisma.$transaction(async (tx) => {
          await this.outbox.publish(tx, {
            aggregateType: 'user',
            aggregateId: user.id,
            eventType: DOMAIN_EVENTS.USER_LOCKED_OUT,
            payload: { userId: user.id, attempts },
            correlationId: context.correlationId,
          });
        });
      }
    }

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      entityType: 'user',
      entityId: user?.id ?? null,
      actorType: user ? 'USER' : 'SYSTEM',
      actorId: user?.id ?? null,
      // The address is masked by the audit redactor before it is stored.
      actorLabel: user?.email ?? emailNormalized,
      outcome: 'FAILURE',
      reason,
      ipAddress: truncateIp(context.ipAddress),
      userAgent: context.userAgent,
      correlationId: context.correlationId,
    });
  }

  private async clearFailedAttempts(user: User, context: AuthRequestContext): Promise<void> {
    if (user.failedLoginCount === 0 && user.lockedUntil === null) return;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    this.logger.debug(
      { userId: user.id, correlationId: context.correlationId },
      'failed login counter reset',
    );
  }

  private async recordSuccessfulLogin(user: User, context: AuthRequestContext): Promise<void> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: this.clock.now(),
        lastLoginIp: truncateIp(context.ipAddress),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorLabel: user.email,
      ipAddress: truncateIp(context.ipAddress),
      userAgent: context.userAgent,
      correlationId: context.correlationId,
    });
  }

  /**
   * Human-readable customer reference (`HC-000001`). Derived from a sequence
   * rather than a random value so support can read it over the phone.
   */
  private async nextCustomerReference(tx: DbClient): Promise<string> {
    const [row] = await tx.$queryRaw<Array<{ next: bigint }>>`
      SELECT nextval('customer_reference_seq') AS next
    `;
    const value = row ? Number(row.next) : 1;
    return `HC-${String(value).padStart(6, '0')}`;
  }
}

export type { LoginResult };
