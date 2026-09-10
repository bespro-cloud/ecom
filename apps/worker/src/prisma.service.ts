import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { buildDatabaseUrl, PrismaClient } from '@health/database';
import { parseServerEnv } from '@health/config';

/** The worker's database client. Same schema, separate pool from the API. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const env = parseServerEnv();
    super({
      datasources: {
        db: {
          url: buildDatabaseUrl(
            env.DATABASE_URL,
            env.DATABASE_POOL_SIZE,
            env.DATABASE_STATEMENT_TIMEOUT_MS,
          ),
        },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
