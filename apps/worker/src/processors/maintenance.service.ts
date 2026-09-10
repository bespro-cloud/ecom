import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { PrismaService } from '../prisma.service.js';
import { CLOCK } from '../clock.module.js';

/**
 * Scheduled housekeeping.
 *
 * Everything here is idempotent and safe to run on several worker instances at
 * once — each job either deletes rows that are already irrelevant or performs a
 * conditional update, so a duplicate run is a no-op rather than a conflict.
 *
 * Note what is *not* here: audit records and consent history are never pruned
 * by the application. Their retention is a deliberate, privileged operation
 * documented in docs/operations/RETENTION.md.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(MaintenanceService.name);
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-sessions' })
  async expireSessions(): Promise<void> {
    const now = this.clock.now();
    const marked = await this.prisma.userSession.updateMany({
      where: { revokedAt: null, expiresAt: { lt: now } },
      data: { revokedAt: now, revokedReason: 'EXPIRED' },
    });

    // Rows are kept for a while after expiry so "where was I signed in?" and
    // incident review still work, then removed.
    const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const purged = await this.prisma.userSession.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });

    if (marked.count > 0 || purged.count > 0) {
      this.logger.info({ marked: marked.count, purged: purged.count }, 'session housekeeping');
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-tokens' })
  async expireTokens(): Promise<void> {
    const now = this.clock.now();
    // A consumed or expired single-use token has no further purpose; keeping it
    // is a small liability and no benefit.
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const removed = await this.prisma.userToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }],
      },
    });
    if (removed.count > 0) {
      this.logger.info({ removed: removed.count }, 'expired tokens purged');
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'unlock-accounts' })
  async releaseExpiredLockouts(): Promise<void> {
    const released = await this.prisma.user.updateMany({
      where: { lockedUntil: { lt: this.clock.now() } },
      data: { lockedUntil: null, failedLoginCount: 0 },
    });
    if (released.count > 0) {
      this.logger.info({ released: released.count }, 'login lockouts released');
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES, { name: 'abandoned-mfa-enrolments' })
  async revokeAbandonedEnrolments(): Promise<void> {
    // A PENDING factor that was never confirmed is a half-finished setup; it
    // should not sit around indefinitely holding an encrypted secret.
    const cutoff = new Date(this.clock.timestamp() - 24 * 60 * 60 * 1000);
    const revoked = await this.prisma.userMfaFactor.updateMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      data: { status: 'REVOKED', revokedAt: this.clock.now() },
    });
    if (revoked.count > 0) {
      this.logger.info({ revoked: revoked.count }, 'abandoned MFA enrolments revoked');
    }
  }
}
