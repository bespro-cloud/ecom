import { Controller, Get, Header } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { QueueService } from '../queues/queue.service.js';
import { WorkerMetricsService } from '../metrics.service.js';

/**
 * The worker exposes health endpoints so it can be supervised in exactly the
 * same way as the API — a worker that has silently stopped consuming is worse
 * than one that has crashed, because nothing alerts.
 */
@Controller('health')
export class WorkerHealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly metrics: WorkerMetricsService,
  ) {}

  @Get('live')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; queues: Record<string, Record<string, number>> }> {
    await this.prisma.ping();
    return { status: 'ok', queues: await this.queues.counts() };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metricsScrape(): Promise<string> {
    return this.metrics.scrape();
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async health(): Promise<{
    status: string;
    service: 'worker';
    uptimeSeconds: number;
    queues: Record<string, Record<string, number>>;
  }> {
    return {
      status: 'ok',
      service: 'worker',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      queues: await this.queues.counts(),
    };
  }
}
