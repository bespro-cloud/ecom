import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { expireStaleCheckouts, releaseExpiredReservations } from '@health/database';
import { PrismaService } from '../prisma.service.js';
import { CLOCK } from '../clock.module.js';

/**
 * Commerce housekeeping.
 *
 * Both sweeps undo holds that were never converted. A customer who starts a
 * checkout and closes the tab leaves stock reserved against a basket nobody is
 * buying; without a sweep, availability drifts steadily below what is on the
 * shelf and the shop stops selling things it actually has.
 *
 * Reservations are released first and checkouts expired after, in that order.
 * A reservation whose hold has run out is dead whether or not its checkout is
 * stale, so releasing first returns stock at the earliest safe moment; expiring
 * the checkout afterwards then finds little left to do.
 *
 * The implementations live in `@health/database` and are shared with the API,
 * so the scheduled sweep runs exactly the code the API's integration tests
 * cover. Both are safe to run on several worker instances at once: each unit of
 * work takes a row lock and re-checks state inside its transaction, so a
 * concurrent run is a no-op rather than a double release.
 */
@Injectable()
export class CommerceMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(CommerceMaintenanceService.name);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'release-expired-reservations' })
  async releaseExpiredReservations(): Promise<void> {
    const released = await releaseExpiredReservations({
      prisma: this.prisma,
      now: () => this.clock.now(),
      onError: (error, context) =>
        this.logger.warn({ err: error, ...context }, 'failed to release an expired reservation'),
    });

    if (released > 0) {
      this.logger.info({ released }, 'released expired stock reservations');
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'expire-stale-checkouts' })
  async expireStaleCheckouts(): Promise<void> {
    const expired = await expireStaleCheckouts({
      prisma: this.prisma,
      now: () => this.clock.now(),
      onError: (error, context) =>
        this.logger.warn({ err: error, ...context }, 'failed to expire a checkout'),
    });

    if (expired > 0) {
      this.logger.info({ expired }, 'expired stale checkouts');
    }
  }
}
