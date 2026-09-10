import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, truncateIp, type Clock } from '@health/config';
import {
  evaluatePassword,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  PASSWORD_ALGORITHM_ID,
  verifyPassword,
} from '@health/auth';
import { DOMAIN_EVENTS, ERROR_CODES } from '@health/types';
import { normalizeEmail } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { OutboxService } from '../../infrastructure/outbox/outbox.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';
import { SessionService } from './session.service.js';
import type { AuthRequestContext } from './auth.service.js';

/**
 * Password reset, email verification and password change.
 *
 * Out-of-band tokens are opaque 256-bit values; only their SHA-256 digest is
 * stored, they are single-use, and issuing a new one invalidates any
 * outstanding token of the same type. Reset requests always return the same
 * response whether or not the address exists.
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly sessions: SessionService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(CredentialsService.name);
  }

  /**
   * Always resolves successfully. The caller returns a fixed message, so the
   * endpoint cannot be used to discover which addresses are registered.
   */
  async requestPasswordReset(email: string, context: AuthRequestContext): Promise<void> {
    const emailNormalized = normalizeEmail(email);

    // Rate limit per address so an attacker cannot mail-bomb one account.
    const attempts = await this.redis.incrementWindow('password-reset', emailNormalized, 900);
    if (attempts > 5) {
      this.logger.warn({ correlationId: context.correlationId }, 'password reset rate limit hit');
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { emailNormalized, deletedAt: null, status: { in: ['ACTIVE', 'INVITED'] } },
    });
    if (!user) {
      this.logger.info(
        { correlationId: context.correlationId },
        'password reset requested for unknown address',
      );
      return;
    }

    const token = generateOpaqueToken();
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      // Supersede any outstanding reset token.
      await tx.userToken.updateMany({
        where: { userId: user.id, type: 'PASSWORD_RESET', consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.userToken.create({
        data: {
          userId: user.id,
          type: 'PASSWORD_RESET',
          tokenHash: hashToken(token),
          expiresAt: addSeconds(now, this.config.env.PASSWORD_RESET_TTL_SECONDS),
        },
      });
      await this.outbox.publish(tx, {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED,
        payload: { userId: user.id, token },
        correlationId: context.correlationId,
      });
      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        actorLabel: user.email,
        ipAddress: truncateIp(context.ipAddress),
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    });
  }

  async resetPassword(
    token: string,
    newPassword: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const now = this.clock.now();
    const record = await this.prisma.userToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (
      !record ||
      record.type !== 'PASSWORD_RESET' ||
      record.consumedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw AppException.unauthorized(
        ERROR_CODES.AUTH_REQUIRED,
        'This password reset link is no longer valid. Please request a new one.',
      );
    }

    const policy = evaluatePassword(newPassword, {
      email: record.user.email,
      firstName: record.user.firstName,
      lastName: record.user.lastName,
    });
    if (!policy.ok) {
      throw AppException.validation(
        policy.problems.map((message) => ({ path: 'password', message })),
      );
    }

    const passwordHash = await hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      // Conditional update: if another request consumed the token first, this
      // matches zero rows and the whole reset is rejected.
      const consumed = await tx.userToken.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count === 0) {
        throw AppException.unauthorized(
          ERROR_CODES.AUTH_REQUIRED,
          'This password reset link has already been used. Please request a new one.',
        );
      }

      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          passwordAlgorithm: PASSWORD_ALGORITHM_ID,
          passwordUpdatedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
          // Completing a reset proves control of the mailbox.
          emailVerifiedAt: record.user.emailVerifiedAt ?? now,
        },
      });

      // A password change invalidates every existing session, everywhere.
      await this.sessions.revokeAllForUser(tx, record.userId, 'PASSWORD_CHANGED');

      await this.outbox.publish(tx, {
        aggregateType: 'user',
        aggregateId: record.userId,
        eventType: DOMAIN_EVENTS.USER_PASSWORD_CHANGED,
        payload: { userId: record.userId, via: 'reset' },
        correlationId: context.correlationId,
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_COMPLETED,
        entityType: 'user',
        entityId: record.userId,
        actorId: record.userId,
        actorLabel: record.user.email,
        ipAddress: truncateIp(context.ipAddress),
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    context: AuthRequestContext & { currentSessionId?: string },
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw AppException.unauthorized(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Your current password is incorrect.',
      );
    }

    const policy = evaluatePassword(newPassword, {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
    });
    if (!policy.ok) {
      throw AppException.validation(
        policy.problems.map((message) => ({ path: 'newPassword', message })),
      );
    }

    if (await verifyPassword(user.passwordHash, newPassword)) {
      throw AppException.validation([
        { path: 'newPassword', message: 'Choose a password you have not used here before.' },
      ]);
    }

    const passwordHash = await hashPassword(newPassword);
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordAlgorithm: PASSWORD_ALGORITHM_ID, passwordUpdatedAt: now },
      });

      // Every session except the one making the change.
      await this.sessions.revokeAllForUser(tx, userId, 'PASSWORD_CHANGED', {
        ...(context.currentSessionId ? { exceptSessionId: context.currentSessionId } : {}),
      });

      await this.outbox.publish(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: DOMAIN_EVENTS.USER_PASSWORD_CHANGED,
        payload: { userId, via: 'self-service' },
        correlationId: context.correlationId,
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED,
        entityType: 'user',
        entityId: userId,
        actorId: userId,
        actorLabel: user.email,
        ipAddress: truncateIp(context.ipAddress),
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    });
  }

  async verifyEmail(token: string, context: AuthRequestContext): Promise<void> {
    const now = this.clock.now();
    const record = await this.prisma.userToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (
      !record ||
      record.type !== 'EMAIL_VERIFICATION' ||
      record.consumedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw AppException.unauthorized(
        ERROR_CODES.AUTH_REQUIRED,
        'This verification link is no longer valid. Please request a new one.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.userToken.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count === 0) return;

      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: record.user.emailVerifiedAt ?? now },
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFIED,
        entityType: 'user',
        entityId: record.userId,
        actorId: record.userId,
        actorLabel: record.user.email,
        ipAddress: truncateIp(context.ipAddress),
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    });
  }

  async resendVerification(userId: string, context: AuthRequestContext): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return;

    const attempts = await this.redis.incrementWindow('email-verify', userId, 900);
    if (attempts > 3) {
      throw AppException.rateLimited(
        'We have already sent a verification email recently. Please check your inbox, including spam.',
      );
    }

    const token = generateOpaqueToken();
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.userToken.updateMany({
        where: { userId, type: 'EMAIL_VERIFICATION', consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.userToken.create({
        data: {
          userId,
          type: 'EMAIL_VERIFICATION',
          tokenHash: hashToken(token),
          expiresAt: addSeconds(now, this.config.env.EMAIL_VERIFICATION_TTL_SECONDS),
        },
      });
      await this.outbox.publish(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: DOMAIN_EVENTS.USER_EMAIL_VERIFICATION_REQUESTED,
        payload: { userId, token },
        correlationId: context.correlationId,
      });
    });
  }
}
