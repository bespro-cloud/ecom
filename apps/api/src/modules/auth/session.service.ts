import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, truncateIp, type Clock } from '@health/config';
import { generateOpaqueToken, hashToken } from '@health/auth';
import type { DbClient, UserSession } from '@health/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';

export interface IssuedRefreshToken {
  /** Plaintext token. Returned to the client once, never stored. */
  token: string;
  session: UserSession;
}

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type RefreshOutcome =
  | { status: 'ROTATED'; issued: IssuedRefreshToken; previous: UserSession }
  | { status: 'NOT_FOUND' }
  | { status: 'EXPIRED'; session: UserSession }
  | { status: 'REVOKED'; session: UserSession }
  | { status: 'REUSE_DETECTED'; session: UserSession };

/**
 * Refresh-token sessions with rotation and reuse detection.
 *
 * Each refresh mints a new token and marks the old row consumed, linking the
 * two. If a *consumed* token is presented again, the only explanations are a
 * stolen token or a badly-behaved client — either way the entire family is
 * revoked immediately, which logs the attacker and the legitimate user out and
 * forces re-authentication. This is the standard OAuth 2.1 refresh-token
 * rotation defence.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(SessionService.name);
  }

  /** Starts a new session family (a fresh login). */
  async issue(
    tx: DbClient,
    userId: string,
    options: SessionContext & { mfaSatisfied: boolean; familyId?: string },
  ): Promise<IssuedRefreshToken> {
    const token = generateOpaqueToken();
    const now = this.clock.now();

    const session = await tx.userSession.create({
      data: {
        userId,
        familyId: options.familyId ?? randomUUID(),
        refreshTokenHash: hashToken(token),
        issuedAt: now,
        expiresAt: addSeconds(now, this.config.env.REFRESH_TOKEN_TTL_SECONDS),
        mfaSatisfied: options.mfaSatisfied,
        ipAddress: truncateIp(options.ipAddress),
        userAgent: options.userAgent?.slice(0, 512) ?? null,
      },
    });

    return { token, session };
  }

  /**
   * Exchanges a refresh token for a new one.
   *
   * Runs in a serialisable transaction with a row lock so two concurrent
   * refreshes from the same client (a common React double-render) cannot both
   * succeed and cannot be mistaken for token theft.
   */
  async rotate(presentedToken: string, context: SessionContext): Promise<RefreshOutcome> {
    const presentedHash = hashToken(presentedToken);

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM user_sessions WHERE refresh_token_hash = ${presentedHash} FOR UPDATE
      `;
      if (locked.length === 0) return { status: 'NOT_FOUND' as const };

      const session = await tx.userSession.findUniqueOrThrow({
        where: { refreshTokenHash: presentedHash },
      });
      const now = this.clock.now();

      if (session.rotatedToId !== null || session.revokedReason === 'ROTATED') {
        // A consumed token came back. Burn the family.
        await this.revokeFamily(tx, session.familyId, 'REUSE_DETECTED', now);
        this.logger.warn(
          { userId: session.userId, familyId: session.familyId },
          'refresh token reuse detected; session family revoked',
        );
        return { status: 'REUSE_DETECTED' as const, session };
      }

      if (session.revokedAt !== null) {
        return { status: 'REVOKED' as const, session };
      }

      if (session.expiresAt.getTime() <= now.getTime()) {
        await tx.userSession.update({
          where: { id: session.id },
          data: { revokedAt: now, revokedReason: 'EXPIRED' },
        });
        return { status: 'EXPIRED' as const, session };
      }

      const issued = await this.issue(tx, session.userId, {
        ...context,
        mfaSatisfied: session.mfaSatisfied,
        familyId: session.familyId,
      });

      await tx.userSession.update({
        where: { id: session.id },
        data: {
          revokedAt: now,
          revokedReason: 'ROTATED',
          rotatedToId: issued.session.id,
          lastUsedAt: now,
        },
      });

      return { status: 'ROTATED' as const, issued, previous: session };
    });
  }

  async findActive(sessionId: string): Promise<UserSession | null> {
    const session = await this.prisma.userSession.findUnique({ where: { id: sessionId } });
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= this.clock.timestamp()) return null;
    return session;
  }

  async revoke(
    sessionId: string,
    reason: 'LOGOUT' | 'ADMIN_REVOKED' | 'MFA_ENROLLED',
  ): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  /**
   * Revokes every live session for a user. Called on logout-all, password
   * change, MFA changes and administrative suspension.
   */
  async revokeAllForUser(
    client: DbClient,
    userId: string,
    reason: 'LOGOUT_ALL' | 'PASSWORD_CHANGED' | 'ADMIN_REVOKED' | 'MFA_ENROLLED',
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
    const result = await client.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  private async revokeFamily(
    tx: DbClient,
    familyId: string,
    reason: 'REUSE_DETECTED',
    now: Date,
  ): Promise<void> {
    await tx.userSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    // Also mark the already-rotated rows, so the whole chain reads as burned.
    await tx.userSession.updateMany({
      where: { familyId, revokedReason: 'ROTATED' },
      data: { revokedReason: reason },
    });
  }

  async listForUser(userId: string): Promise<UserSession[]> {
    return this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: this.clock.now() } },
      orderBy: { issuedAt: 'desc' },
      take: 50,
    });
  }

  /** Housekeeping: drop rows that expired long ago. Run from the worker. */
  async purgeExpired(olderThanDays = 60): Promise<number> {
    const cutoff = addSeconds(this.clock.now(), -olderThanDays * 24 * 60 * 60);
    const result = await this.prisma.userSession.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return result.count;
  }
}
