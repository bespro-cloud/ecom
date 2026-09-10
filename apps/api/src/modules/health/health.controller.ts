import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';
import { Public } from '../../common/decorators/public.decorator.js';
import { SkipRateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { AppException } from '../../common/errors/app-exception.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { MetricsService } from '../../infrastructure/metrics/metrics.service.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';

interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs?: number;
  error?: string;
}

/**
 * Health endpoints, split by what the caller actually needs to know:
 *
 *  - `/health/live`  — is the process running? Never touches a dependency, so a
 *    database outage does not cause the orchestrator to kill healthy pods.
 *  - `/health/ready` — can this instance serve traffic? Checks dependencies and
 *    returns 503 when one is down, which removes it from the load balancer.
 *  - `/health`       — a human-readable summary for operators.
 */
@ApiTags('Health')
// Version-neutral and outside the /api prefix: orchestrators, load balancers
// and the metrics scraper must not have to track an API version.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
@SkipRateLimit()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'The process is running.' })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  @Get('ready')
  @Public()
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Returns 503 when a required dependency is unavailable.',
  })
  async ready(): Promise<{ status: 'ok'; dependencies: Record<string, DependencyStatus> }> {
    const dependencies = await this.checkDependencies();
    const failed = Object.entries(dependencies).filter(([, value]) => value.status === 'down');

    if (failed.length > 0) {
      this.logger.error({ failed: failed.map(([name]) => name) }, 'readiness check failed');
      throw AppException.dependencyUnavailable(failed.map(([name]) => name).join(', '));
    }
    return { status: 'ok', dependencies };
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Health summary' })
  async health(): Promise<{
    status: 'ok' | 'degraded';
    service: string;
    environment: string;
    uptimeSeconds: number;
    dependencies: Record<string, DependencyStatus>;
  }> {
    const dependencies = await this.checkDependencies();
    const degraded = Object.values(dependencies).some((d) => d.status === 'down');
    return {
      status: degraded ? 'degraded' : 'ok',
      service: 'api',
      environment: this.config.env.NODE_ENV,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      dependencies,
    };
  }

  @Get('metrics')
  @Public()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiExcludeEndpoint()
  async metricsScrape(): Promise<string> {
    return this.metrics.scrape();
  }

  private async checkDependencies(): Promise<Record<string, DependencyStatus>> {
    const [database, redis] = await Promise.all([
      timed(() => this.prisma.ping()),
      timed(() => this.redis.ping()),
    ]);
    return { database, redis };
  }
}

async function timed(check: () => Promise<unknown>): Promise<DependencyStatus> {
  const start = process.hrtime.bigint();
  try {
    await check();
    return { status: 'up', latencyMs: Number(process.hrtime.bigint() - start) / 1e6 };
  } catch (error) {
    return {
      status: 'down',
      // Kept short and generic: readiness output is often publicly reachable.
      error: error instanceof Error ? error.name : 'unknown error',
    };
  }
}
