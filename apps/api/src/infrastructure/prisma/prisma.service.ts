import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { buildDatabaseUrl, PrismaClient } from '@health/database';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * The application's PrismaClient.
 *
 * Slow queries are surfaced on a dedicated log channel so a regression shows up
 * as a metric rather than as a support ticket. Query text is logged only when
 * LOG_LEVEL is debug or lower and never in production, because parameters can
 * contain customer data.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly SLOW_QUERY_MS = 500;

  constructor(
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    const verbose = !config.isProduction && ['debug', 'trace'].includes(config.env.LOG_LEVEL);
    super({
      datasources: {
        db: {
          url: buildDatabaseUrl(
            config.env.DATABASE_URL,
            config.env.DATABASE_POOL_SIZE,
            config.env.DATABASE_STATEMENT_TIMEOUT_MS,
          ),
        },
      },
      log: [
        ...(verbose ? ([{ emit: 'event', level: 'query' }] as const) : []),
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    this.logger.setContext(PrismaService.name);

    // `as never` narrows the union Prisma's overloads produce for $on when the
    // log configuration is built conditionally; the handlers below are typed.
    this.$on('warn' as never, (event: { message: string }) => {
      this.logger.warn({ message: event.message }, 'prisma warning');
    });
    this.$on('error' as never, (event: { message: string }) => {
      this.logger.error({ message: event.message }, 'prisma error');
    });
    if (verbose) {
      this.$on('query' as never, (event: { query: string; duration: number }) => {
        if (event.duration >= PrismaService.SLOW_QUERY_MS) {
          this.logger.warn({ durationMs: event.duration, query: event.query }, 'slow query');
        }
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap liveness probe for the readiness endpoint. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
