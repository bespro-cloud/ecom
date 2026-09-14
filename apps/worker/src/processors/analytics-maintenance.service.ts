import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { pruneAnalytics, rollUpRecentDays } from '@health/database';
import { PrismaService } from '../prisma.service.js';
import { CLOCK } from '../clock.module.js';

/**
 * Analytics rollups and retention.
 *
 * Two jobs, and the second one is the more important of the two.
 *
 * **Rolling up** turns raw events into daily counts. It recomputes rather than
 * increments, so a run that failed halfway is fixed by running it again — and
 * it is safe to run on several worker instances at once, because recomputing a
 * day twice produces the same day twice.
 *
 * **Pruning** deletes raw events, sessions and the daily salts that went with
 * them, past a short retention window. This is not housekeeping; it is the
 * mechanism behind a privacy guarantee. Raw events are the only rows shaped
 * finely enough to reconstruct one visit's path through the site, and the daily
 * salt is the only thing that could relate a visitor hash back to an IP
 * address. Once both are gone, the data that remains is counts.
 *
 * So the prune is not allowed to quietly stop working. It logs every run, and a
 * failure is an error rather than a warning.
 *
 * The implementations live in `@health/database` and are shared with the API,
 * so the scheduled sweep runs exactly the code the integration tests cover.
 */
@Injectable()
export class AnalyticsMaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(AnalyticsMaintenanceService.name);
  }

  /**
   * Hourly rather than nightly.
   *
   * A dashboard read at noon should not show an empty morning, and recomputing
   * two days of counts is cheap. Yesterday is rebuilt each time too, so a late
   * beacon or a run that failed overnight is corrected without anybody noticing
   * there was something to correct.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'analytics-rollup' })
  async rollUp(): Promise<void> {
    const results = await rollUpRecentDays({
      prisma: this.prisma,
      now: () => this.clock.now(),
      onError: (error, context) =>
        this.logger.error({ err: error, ...context }, 'could not roll up an analytics day'),
    });

    for (const result of results) {
      this.logger.info(
        {
          day: result.day,
          sessions: result.sessions,
          orders: result.orders,
          products: result.products,
          channels: result.channels,
        },
        'analytics day rolled up',
      );
    }
  }

  /**
   * Daily, shortly after midnight UTC.
   *
   * Deliberately not on the same schedule as the rollup: pruning a day that has
   * not been rolled up yet would lose it permanently, and an hour's gap after
   * the last rollup of the previous day makes the ordering obvious rather than
   * incidental.
   */
  @Cron('30 1 * * *', { name: 'analytics-retention' })
  async prune(): Promise<void> {
    try {
      const removed = await pruneAnalytics({
        prisma: this.prisma,
        now: () => this.clock.now(),
      });

      // Logged on every run, including the boring ones. A retention sweep that
      // silently stopped working would leave a growing store of browsing data
      // that nobody meant to keep, and the absence of a log line is the only
      // signal that would show it.
      this.logger.info(
        { events: removed.events, sessions: removed.sessions, salts: removed.salts },
        'analytics retention sweep completed',
      );
    } catch (error) {
      this.logger.error(
        { err: error },
        'analytics retention sweep FAILED — raw browsing data is being kept past its retention window',
      );
      throw error;
    }
  }
}
