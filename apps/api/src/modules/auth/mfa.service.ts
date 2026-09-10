import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import {
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  SecretBox,
  verifyPassword,
  verifyTotp,
} from '@health/auth';
import { DOMAIN_EVENTS, ERROR_CODES } from '@health/types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { OutboxService } from '../../infrastructure/outbox/outbox.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';
import { SessionService } from './session.service.js';

export interface MfaEnrollmentStart {
  factorId: string;
  /** otpauth:// URI for the QR code. Shown once, never persisted in the clear. */
  uri: string;
  /** Manual-entry fallback for users who cannot scan. */
  secret: string;
}

export interface MfaEnrollmentComplete {
  recoveryCodes: string[];
}

export interface MfaVerificationResult {
  ok: boolean;
  reason?: string;
}

export const RECOVERY_CODE_COUNT = 10;

/**
 * TOTP-based multi-factor authentication.
 *
 * The shared secret is encrypted at rest with AES-256-GCM, keyed by
 * ENCRYPTION_KEY and bound to the owning user id as additional authenticated
 * data — so a ciphertext copied to another row will not decrypt. Enrolment is
 * two-step: a factor is PENDING until the user proves they can generate a
 * code, which prevents an account being locked out by a half-finished setup.
 */
@Injectable()
export class MfaService {
  private readonly secretBox: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(MfaService.name);
    this.secretBox = new SecretBox(config.env.ENCRYPTION_KEY);
  }

  async startEnrollment(
    userId: string,
    context: { correlationId: string; ipAddress?: string | null; userAgent?: string | null },
  ): Promise<MfaEnrollmentStart> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });

    const active = await this.prisma.userMfaFactor.findFirst({
      where: { userId, status: 'ACTIVE' },
    });
    if (active) {
      throw AppException.conflict(
        'Multi-factor authentication is already enabled for this account. Disable it first to enrol a new device.',
      );
    }

    // Replace any abandoned enrolment so a stale QR code cannot be completed.
    await this.prisma.userMfaFactor.updateMany({
      where: { userId, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: this.clock.now() },
    });

    const enrollment = generateTotpSecret(
      this.config.env.APP_NAME === 'health-commerce' ? 'Health Commerce' : this.config.env.APP_NAME,
      user.email,
    );

    const factor = await this.prisma.userMfaFactor.create({
      data: {
        userId,
        type: 'TOTP',
        status: 'PENDING',
        secretCiphertext: this.secretBox.encrypt(enrollment.secret, userId),
      },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.MFA_ENROLLMENT_STARTED,
      entityType: 'user_mfa_factor',
      entityId: factor.id,
      actorId: userId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      correlationId: context.correlationId,
    });

    return { factorId: factor.id, uri: enrollment.uri, secret: enrollment.secret };
  }

  /**
   * Activates a pending factor and issues recovery codes.
   *
   * Existing sessions (other than the one performing enrolment) are revoked:
   * adding a second factor is a credential change, and any session established
   * before it was in place should not silently inherit the new trust level.
   */
  async completeEnrollment(
    userId: string,
    factorId: string,
    code: string,
    context: {
      correlationId: string;
      ipAddress?: string | null;
      userAgent?: string | null;
      currentSessionId?: string;
    },
  ): Promise<MfaEnrollmentComplete> {
    const factor = await this.prisma.userMfaFactor.findFirst({
      where: { id: factorId, userId, status: 'PENDING' },
    });
    if (!factor) {
      throw AppException.notFound('Enrolment');
    }

    const secret = this.secretBox.decrypt(factor.secretCiphertext, userId);
    const verification = verifyTotp(secret, code, { at: this.clock.now() });
    if (!verification.valid) {
      throw AppException.unauthorized(
        ERROR_CODES.MFA_INVALID,
        'That code was not accepted. Check the time on your device and try again.',
      );
    }

    const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.userMfaFactor.update({
        where: { id: factor.id },
        data: {
          status: 'ACTIVE',
          confirmedAt: now,
          lastUsedCounter: BigInt(verification.counter ?? 0),
        },
      });

      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userMfaRecoveryCode.createMany({
        data: plainCodes.map((plain) => ({ userId, codeHash: hashRecoveryCode(plain) })),
      });

      await this.sessions.revokeAllForUser(tx, userId, 'MFA_ENROLLED', {
        ...(context.currentSessionId ? { exceptSessionId: context.currentSessionId } : {}),
      });

      await this.outbox.publish(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: DOMAIN_EVENTS.USER_MFA_ENROLLED,
        payload: { userId, factorId: factor.id },
        correlationId: context.correlationId,
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.MFA_ENROLLED,
        entityType: 'user_mfa_factor',
        entityId: factor.id,
        actorId: userId,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        correlationId: context.correlationId,
      });
    });

    // Returned exactly once. There is no endpoint that can retrieve them again.
    return { recoveryCodes: plainCodes };
  }

  async verifyTotpCode(userId: string, code: string): Promise<MfaVerificationResult> {
    const factor = await this.prisma.userMfaFactor.findFirst({
      where: { userId, status: 'ACTIVE' },
    });
    if (!factor) return { ok: false, reason: 'no active factor' };

    let secret: string;
    try {
      secret = this.secretBox.decrypt(factor.secretCiphertext, userId);
    } catch (error) {
      // A factor we cannot decrypt is an operational emergency, not a bad code.
      this.logger.error({ err: error, userId }, 'unable to decrypt MFA secret');
      return { ok: false, reason: 'factor unreadable' };
    }

    const verification = verifyTotp(secret, code, {
      at: this.clock.now(),
      lastUsedCounter: factor.lastUsedCounter,
    });
    if (!verification.valid) return { ok: false, reason: 'invalid or replayed code' };

    // Persisting the counter is what makes a used code unusable again.
    await this.prisma.userMfaFactor.update({
      where: { id: factor.id },
      data: { lastUsedCounter: BigInt(verification.counter ?? 0) },
    });
    return { ok: true };
  }

  /**
   * Consumes a recovery code. Each code works once; the claim is done with a
   * conditional update so two concurrent attempts cannot both succeed.
   */
  async consumeRecoveryCode(userId: string, code: string): Promise<MfaVerificationResult> {
    const codeHash = hashRecoveryCode(code);
    const claimed = await this.prisma.userMfaRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: this.clock.now() },
    });
    if (claimed.count === 0) return { ok: false, reason: 'invalid or already-used recovery code' };

    const remaining = await this.prisma.userMfaRecoveryCode.count({
      where: { userId, usedAt: null },
    });
    if (remaining <= 2) {
      this.logger.warn({ userId, remaining }, 'user is running low on MFA recovery codes');
    }
    return { ok: true };
  }

  async regenerateRecoveryCodes(
    userId: string,
    context: { correlationId: string; ipAddress?: string | null; userAgent?: string | null },
  ): Promise<string[]> {
    const active = await this.prisma.userMfaFactor.findFirst({
      where: { userId, status: 'ACTIVE' },
    });
    if (!active) {
      throw AppException.preconditionFailed(
        'Multi-factor authentication is not enabled for this account.',
      );
    }

    const plainCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    await this.prisma.$transaction(async (tx) => {
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userMfaRecoveryCode.createMany({
        data: plainCodes.map((plain) => ({ userId, codeHash: hashRecoveryCode(plain) })),
      });
      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.MFA_RECOVERY_CODES_REGENERATED,
        entityType: 'user',
        entityId: userId,
        actorId: userId,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        correlationId: context.correlationId,
      });
    });
    return plainCodes;
  }

  /**
   * Disabling MFA requires both the current password and a current TOTP code.
   *
   * Requiring both means a stolen session alone cannot strip the second factor
   * — which is exactly the move an attacker makes to establish persistence.
   * Privileged roles cannot disable it at all.
   */
  async disable(
    userId: string,
    input: { password: string; code: string },
    context: { correlationId: string; ipAddress?: string | null; userAgent?: string | null },
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        roles: { include: { role: { select: { key: true, requiresMfa: true } } } },
      },
    });

    if (user.roles.some((assignment) => assignment.role.requiresMfa)) {
      throw AppException.forbidden(
        ERROR_CODES.FORBIDDEN,
        'Multi-factor authentication is mandatory for your role and cannot be turned off. Ask an administrator if you need to move to a new device.',
      );
    }

    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) {
      throw AppException.unauthorized(
        ERROR_CODES.INVALID_CREDENTIALS,
        'That password is incorrect.',
      );
    }

    const verified = await this.verifyTotpCode(userId, input.code);
    if (!verified.ok) {
      throw AppException.unauthorized(
        ERROR_CODES.MFA_INVALID,
        'That code was not accepted. Please try again.',
      );
    }

    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.userMfaFactor.updateMany({
        where: { userId, status: { in: ['ACTIVE', 'PENDING'] } },
        data: { status: 'REVOKED', revokedAt: now },
      });
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });

      await this.outbox.publish(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: DOMAIN_EVENTS.USER_MFA_DISABLED,
        payload: { userId },
        correlationId: context.correlationId,
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.MFA_DISABLED,
        entityType: 'user',
        entityId: userId,
        actorId: userId,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        correlationId: context.correlationId,
      });
    });
  }

  async status(userId: string): Promise<{ enabled: boolean; remainingRecoveryCodes: number }> {
    const [factor, remaining] = await Promise.all([
      this.prisma.userMfaFactor.findFirst({ where: { userId, status: 'ACTIVE' } }),
      this.prisma.userMfaRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    return { enabled: factor !== null, remainingRecoveryCodes: factor ? remaining : 0 };
  }
}
