import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { parseServerEnv } from '@health/config';
import { PrismaService } from './prisma.service.js';

/**
 * Worker metrics.
 *
 * These exist because the alerts in
 * infrastructure/monitoring/prometheus/rules/alerts.yml refer to them. An
 * alert on a metric nothing emits is worse than no alert: it looks like
 * coverage and provides none.
 */
@Injectable()
export class WorkerMetricsService implements OnModuleDestroy {
  readonly registry = new Registry();

  /** Undispatched rows in the outbox. Should hover near zero. */
  readonly outboxPending: Gauge<'status'>;
  readonly outboxDispatched: Counter<'event_type'>;
  readonly jobsProcessed: Counter<'queue' | 'outcome'>;
  readonly jobDuration: Histogram<'queue'>;
  readonly deadLettered: Counter<'queue' | 'reason'>;

  private readonly defaultMetricsTimer: ReturnType<typeof collectDefaultMetrics> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerMetricsService.name);
    const env = parseServerEnv();
    this.registry.setDefaultLabels({ service: 'worker', env: env.NODE_ENV });
    if (env.METRICS_ENABLED) {
      this.defaultMetricsTimer = collectDefaultMetrics({ register: this.registry });
    }

    this.outboxPending = new Gauge({
      name: 'outbox_pending_messages',
      help: 'Outbox rows waiting to be dispatched to a queue.',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.outboxDispatched = new Counter({
      name: 'outbox_dispatched_total',
      help: 'Outbox rows successfully placed on a queue.',
      labelNames: ['event_type'] as const,
      registers: [this.registry],
    });

    this.jobsProcessed = new Counter({
      name: 'queue_jobs_processed_total',
      help: 'Queue jobs processed, by queue and outcome.',
      labelNames: ['queue', 'outcome'] as const,
      registers: [this.registry],
    });

    this.jobDuration = new Histogram({
      name: 'queue_job_duration_seconds',
      help: 'Time taken to process a queue job.',
      labelNames: ['queue'] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });

    this.deadLettered = new Counter({
      name: 'queue_dead_lettered_total',
      help: 'Jobs moved to a dead-letter queue after exhausting retries or failing permanently.',
      labelNames: ['queue', 'reason'] as const,
      registers: [this.registry],
    });
  }

  /**
   * Refreshes the outbox gauges.
   *
   * A gauge is the right shape here: the question an operator asks is "how big
   * is the backlog right now?", not "how many were ever pending".
   */
  @Interval('outbox-gauge', 15_000)
  async sampleOutboxDepth(): Promise<void> {
    try {
      const [pending, failed] = await Promise.all([
        this.prisma.outboxMessage.count({ where: { dispatchedAt: null, failedAt: null } }),
        this.prisma.outboxMessage.count({ where: { failedAt: { not: null } } }),
      ]);
      this.outboxPending.set({ status: 'pending' }, pending);
      this.outboxPending.set({ status: 'failed' }, failed);
    } catch (error) {
      this.logger.warn({ err: error }, 'could not sample outbox depth');
    }
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  onModuleDestroy(): void {
    if (this.defaultMetricsTimer) clearInterval(this.defaultMetricsTimer as NodeJS.Timeout);
    this.registry.clear();
  }
}
