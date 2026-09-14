import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { expireLapsedClaims, expireLapsedLots } from '@health/database';
import { PrismaService } from '../prisma.service.js';
import { CLOCK } from '../clock.module.js';

/**
 * Compliance housekeeping.
 *
 * Two sweeps, both of which exist because "somebody notices" is not a control.
 *
 * **Lapsed claim approvals.** An approval is valid for a configured interval
 * precisely so that a claim approved years ago against since-superseded
 * evidence does not stay live by default. Without a sweep the interval is a
 * date in a column that nothing ever reads.
 *
 * **Expired lots.** A lot stays allocatable until its status changes, so a lot
 * that passed its date yesterday is still sellable this morning unless
 * something marks it. Both sweeps fail safe: they only ever *remove*
 * permission to sell or to display, never grant it.
 *
 * Hourly rather than by the minute. Both conditions are dated in days, and a
 * sweep that runs sixty times more often than the data changes is load, not
 * safety.
 */
@Injectable()
export class ComplianceMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(ComplianceMaintenanceService.name);
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-lapsed-claims' })
  async expireClaims(): Promise<void> {
    const expired = await expireLapsedClaims({
      prisma: this.prisma,
      now: () => this.clock.now(),
      onError: (error, context) =>
        this.logger.warn({ err: error, ...context }, 'failed to expire a claim approval'),
    });

    if (expired > 0) {
      // Worth a warning rather than an info line: an expired claim has just
      // disappeared from a live listing, and somebody should re-review it.
      this.logger.warn({ expired }, 'claim approvals lapsed and were expired');
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'expire-lapsed-lots' })
  async expireLots(): Promise<void> {
    const expired = await expireLapsedLots({
      prisma: this.prisma,
      now: () => this.clock.now(),
      onError: (error, context) =>
        this.logger.warn({ err: error, ...context }, 'failed to expire a lot'),
    });

    if (expired > 0) {
      this.logger.warn({ expired }, 'lots passed their expiry date and were withdrawn from sale');
    }
  }
}
