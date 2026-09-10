import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { WorkerMetricsService } from '../metrics.service.js';
import { CLOCK } from '../clock.module.js';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { parseServerEnv, type Clock, type ServerEnv } from '@health/config';
import { QUEUE_NAMES, type QueueName } from '@health/types';
import { computeBackoff, DEFAULT_JOB_OPTIONS, dlqName, queuePrefix } from './queue.constants.js';

/**
 * Owns the BullMQ queues and the connections they share.
 *
 * Every queue gets a matching dead-letter queue. A job that exhausts its
 * retries is moved there rather than discarded, so a provider outage leaves an
 * inspectable, replayable backlog instead of a gap.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly env: ServerEnv;
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  readonly prefix: string;

  constructor(
    private readonly logger: PinoLogger,
    private readonly metrics: WorkerMetricsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(QueueService.name);
    this.env = parseServerEnv();
    this.prefix = queuePrefix(this.env.REDIS_KEY_PREFIX);
    this.connection = new IORedis(this.env.REDIS_URL, {
      // BullMQ blocks on BRPOPLPUSH; a per-request retry cap would abort those.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.connection.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'queue redis connection error');
    });
  }

  onModuleInit(): void {
    for (const name of QUEUE_NAMES) {
      this.queues.set(name, this.buildQueue(name));
      this.queues.set(dlqName(name), this.buildQueue(dlqName(name)));
    }
    this.logger.info({ queues: [...this.queues.keys()] }, 'queues ready');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.connection.disconnect();
  }

  get(name: QueueName | string): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Unknown queue: ${name}`);
    return queue;
  }

  /**
   * Enqueues a job.
   *
   * `jobId` makes the enqueue idempotent — BullMQ ignores a second job with an
   * id that already exists — which is what lets the outbox dispatcher retry
   * safely after a crash between "job added" and "message marked dispatched".
   */
  async enqueue<T extends object>(
    queue: QueueName,
    jobName: string,
    payload: T,
    options: JobsOptions & { jobId: string },
  ): Promise<void> {
    await this.get(queue).add(jobName, payload, { ...DEFAULT_JOB_OPTIONS, ...options });
  }

  /** Moves an exhausted job onto the dead-letter queue with its failure context. */
  async deadLetter(
    queue: QueueName,
    jobName: string,
    payload: unknown,
    context: { jobId: string; attempts: number; error: string },
  ): Promise<void> {
    await this.get(dlqName(queue)).add(
      jobName,
      { payload, failure: context, failedAt: this.clock.now().toISOString() },
      {
        jobId: `dlq:${context.jobId}`,
        // The DLQ is a record, not a work queue: nothing retries out of it
        // automatically. Replay is an explicit operator action.
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    this.metrics.deadLettered.inc({ queue, reason: classifyFailure(context.error) });
    this.logger.error({ queue, jobName, ...context }, 'job dead-lettered');
  }

  async counts(): Promise<Record<string, Record<string, number>>> {
    const result: Record<string, Record<string, number>> = {};
    for (const [name, queue] of this.queues) {
      result[name] = await queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
    }
    return result;
  }

  private buildQueue(name: string): Queue {
    return new Queue(name, {
      connection: this.connection,
      prefix: this.prefix,
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTIONS,
        backoff: { type: 'custom' },
      },
    });
  }

  /** Shared by every worker so backoff behaviour is identical across queues. */
  static readonly backoffStrategy = (attemptsMade: number): number => computeBackoff(attemptsMade);
}

/**
 * Buckets a failure message into a small, fixed set of labels.
 *
 * The raw message must never become a metric label — provider errors embed ids
 * and addresses, and each distinct value would create its own time series.
 */
function classifyFailure(error: string): string {
  const lowered = error.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('etimedout')) return 'timeout';
  if (lowered.includes('econnrefused') || lowered.includes('econnreset')) return 'connection';
  if (lowered.includes('recipient') || lowered.includes('rejected')) return 'rejected';
  if (lowered.includes('auth') || lowered.includes('credential')) return 'authentication';
  return 'other';
}
