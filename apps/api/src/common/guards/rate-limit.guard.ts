import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { truncateIp } from '@health/config';
import type { Response } from 'express';
import { AppException } from '../errors/app-exception.js';
import {
  RATE_LIMIT_KEY,
  SKIP_RATE_LIMIT_KEY,
  type RateLimitTier,
} from '../decorators/rate-limit.decorator.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import type { RequestWithPrincipal } from '../decorators/current-user.decorator.js';

const WINDOW_SECONDS = 60;

/**
 * Redis-backed fixed-window rate limiting.
 *
 * Deliberately not `@nestjs/throttler`'s default storage, which is per-process:
 * behind more than one API instance an in-memory limiter multiplies the real
 * limit by the instance count, so it does not protect anything once the service
 * is scaled out.
 *
 * Requests are counted per identity where one exists and per truncated source
 * address otherwise, so a shared NAT does not lock out a whole office and an
 * authenticated abuser cannot escape their bucket by changing address.
 *
 * If Redis is unavailable the request is allowed through: a cache outage must
 * degrade throughput protection, not take the whole API down. The failure is
 * logged so it is visible.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RateLimitGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const tier =
      this.reflector.getAllAndOverride<RateLimitTier>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'default';

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithPrincipal>();
    const limit = this.limitFor(tier);
    const subject = this.subjectFor(request);
    const route = (request.route as { path?: string } | undefined)?.path ?? request.path;

    let count: number;
    try {
      count = await this.redis.incrementWindow(
        `ratelimit:${tier}:${request.method}:${route}`,
        subject,
        WINDOW_SECONDS,
      );
    } catch (error) {
      this.logger.error({ err: error, tier, route }, 'rate limiter unavailable; allowing request');
      return true;
    }

    const response = http.getResponse<Response>();
    response.setHeader('X-RateLimit-Limit', String(limit));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(limit - count, 0)));

    if (count > limit) {
      response.setHeader('Retry-After', String(WINDOW_SECONDS));
      this.logger.warn({ tier, route, count, limit }, 'rate limit exceeded');
      throw AppException.rateLimited();
    }
    return true;
  }

  private limitFor(tier: RateLimitTier): number {
    switch (tier) {
      case 'auth':
        return this.config.env.RATE_LIMIT_AUTH_PER_MINUTE;
      case 'sensitive':
        // Half the auth budget, floored so the tier is never effectively off.
        return Math.max(3, Math.floor(this.config.env.RATE_LIMIT_AUTH_PER_MINUTE / 2));
      case 'default':
      default:
        return this.config.env.RATE_LIMIT_GLOBAL_PER_MINUTE;
    }
  }

  private subjectFor(request: RequestWithPrincipal): string {
    if (request.principal?.userId) return `user:${request.principal.userId}`;
    const ip = truncateIp(request.ip ?? request.socket?.remoteAddress ?? null);
    return `ip:${ip ?? 'unknown'}`;
  }
}
