import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Redis connection used for rate limiting, short-lived security state (MFA
 * challenge nonces, login throttling) and — from Phase 3 — BullMQ.
 *
 * Nothing durable lives here. Redis is treated as a cache and a coordination
 * primitive; losing it degrades throughput, never correctness.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  private readonly prefix: string;

  constructor(
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisService.name);
    this.prefix = config.env.REDIS_KEY_PREFIX;
    this.client = new Redis(config.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });

    this.client.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'redis connection error');
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    // A graceful QUIT can hang if the connection is already unhealthy, which
    // would stall a rolling deploy (and a test run). Give it a moment, then
    // drop the socket.
    try {
      await Promise.race([
        this.client.quit(),
        new Promise((resolve) => setTimeout(resolve, 2000).unref()),
      ]);
    } catch {
      // Ignored: we are shutting down either way.
    } finally {
      this.client.disconnect();
    }
  }

  key(...parts: Array<string | number>): string {
    return [this.prefix, ...parts].join(':');
  }

  async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error(`unexpected redis ping reply: ${reply}`);
  }

  /**
   * Atomically claims a single-use token.
   *
   * Returns true only for the first caller. Used to make MFA challenges
   * one-shot so a captured challenge token cannot be replayed even inside its
   * validity window.
   */
  async claimOnce(namespace: string, token: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(this.key(namespace, token), '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async isClaimed(namespace: string, token: string): Promise<boolean> {
    return (await this.client.exists(this.key(namespace, token))) === 1;
  }

  /**
   * Fixed-window counter. Returns the count after incrementing.
   * The TTL is only set on the first increment so the window does not slide
   * forward on every attempt.
   */
  async incrementWindow(
    namespace: string,
    subject: string,
    windowSeconds: number,
  ): Promise<number> {
    const key = this.key(namespace, subject);
    const results = await this.client.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    const count = results?.[0]?.[1];
    return typeof count === 'number' ? count : 0;
  }

  async resetWindow(namespace: string, subject: string): Promise<void> {
    await this.client.del(this.key(namespace, subject));
  }
}
