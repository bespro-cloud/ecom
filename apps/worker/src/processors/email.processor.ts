import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { parseServerEnv, type ServerEnv } from '@health/config';
import { DOMAIN_EVENTS } from '@health/types';
import {
  createEmailProvider,
  NotificationDeliveryError,
  accountLockedEmail,
  emailVerificationEmail,
  mfaDisabledEmail,
  mfaEnrolledEmail,
  passwordChangedEmail,
  passwordResetEmail,
  staffInviteEmail,
  staffRolesChangedEmail,
  welcomeEmail,
  type EmailMessage,
  type EmailProvider,
  type TemplateContext,
} from '@health/notifications';
import { PrismaService } from '../prisma.service.js';
import { QueueService } from '../queues/queue.service.js';
import { computeBackoff, queuePrefix } from '../queues/queue.constants.js';
import { WorkerMetricsService } from '../metrics.service.js';

interface OutboxJob {
  outboxId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
}

/**
 * Sends transactional email.
 *
 * A job that fails for a retryable reason is retried with backoff; one that
 * fails permanently (a rejected recipient, an event we cannot render) is
 * dead-lettered on the first attempt rather than burning five retries on
 * something that will never succeed.
 */
@Injectable()
export class EmailProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly env: ServerEnv;
  private readonly provider: EmailProvider;
  private connection!: Redis;
  private worker!: Worker<OutboxJob>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly metrics: WorkerMetricsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmailProcessor.name);
    this.env = parseServerEnv();
    this.provider = createEmailProvider(this.env);
  }

  onModuleInit(): void {
    this.connection = new IORedis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.worker = new Worker<OutboxJob>('email', (job) => this.handle(job), {
      connection: this.connection,
      prefix: queuePrefix(this.env.REDIS_KEY_PREFIX),
      concurrency: 5,
      settings: { backoffStrategy: (attemptsMade: number) => computeBackoff(attemptsMade) },
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        { jobId: job?.id, attempts: job?.attemptsMade, err: error },
        'email job failed',
      );
    });

    this.worker.on('error', (error) => {
      this.logger.error({ err: error }, 'email worker error');
    });

    this.logger.info({ provider: this.provider.name }, 'email processor started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.connection?.disconnect();
  }

  async handle(job: Job<OutboxJob>): Promise<void> {
    const stopTimer = this.metrics.jobDuration.startTimer({ queue: 'email' });
    try {
      await this.deliver(job);
      this.metrics.jobsProcessed.inc({ queue: 'email', outcome: 'success' });
    } catch (error) {
      this.metrics.jobsProcessed.inc({ queue: 'email', outcome: 'failure' });
      throw error;
    } finally {
      stopTimer();
    }
  }

  private async deliver(job: Job<OutboxJob>): Promise<void> {
    const message = await this.render(job.data);

    if (!message) {
      // Nothing to send for this event — acknowledge rather than retry.
      this.logger.debug({ eventType: job.data.eventType }, 'no email template for event');
      return;
    }

    try {
      const result = await this.provider.send({
        ...message,
        // Ties the send to the outbox row, so a provider that supports
        // deduplication will not send twice if we retry after a timeout.
        idempotencyKey: `outbox:${job.data.outboxId}`,
      });
      this.logger.info(
        {
          eventType: job.data.eventType,
          provider: result.provider,
          correlationId: job.data.correlationId,
        },
        'transactional email accepted',
      );
    } catch (error) {
      const permanent = error instanceof NotificationDeliveryError && !error.retryable;
      const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (permanent || exhausted) {
        await this.queues.deadLetter('email', job.name, job.data, {
          jobId: String(job.id),
          attempts: job.attemptsMade + 1,
          error: error instanceof Error ? error.message : 'unknown error',
        });
        // Swallowed on purpose: the job is recorded in the DLQ, and rethrowing
        // would leave a duplicate in the failed set.
        return;
      }
      throw error;
    }
  }

  private get templateContext(): TemplateContext {
    return {
      storeName: 'Health Commerce',
      supportEmail: this.env.EMAIL_FROM,
      storefrontUrl: this.env.STOREFRONT_PUBLIC_URL,
      adminUrl: this.env.ADMIN_PUBLIC_URL,
    };
  }

  private async render(job: OutboxJob): Promise<EmailMessage | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: job.aggregateId },
      select: { email: true, firstName: true },
    });
    if (!user) {
      // The account was removed between the event and its delivery. Not an
      // error worth retrying.
      this.logger.warn({ userId: job.aggregateId }, 'skipping email for missing user');
      return null;
    }

    const context = this.templateContext;
    const payload = job.payload;

    switch (job.eventType) {
      case DOMAIN_EVENTS.USER_REGISTERED:
        return welcomeEmail(context, {
          to: user.email,
          firstName: user.firstName,
          verificationToken: String(payload.verificationToken ?? ''),
        });
      case DOMAIN_EVENTS.USER_EMAIL_VERIFICATION_REQUESTED:
        return emailVerificationEmail(context, {
          to: user.email,
          verificationToken: String(payload.token ?? ''),
        });
      case DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED:
        return passwordResetEmail(context, { to: user.email, token: String(payload.token ?? '') });
      case DOMAIN_EVENTS.USER_PASSWORD_CHANGED:
        return passwordChangedEmail(context, { to: user.email });
      case DOMAIN_EVENTS.USER_LOCKED_OUT:
        return accountLockedEmail(context, {
          to: user.email,
          attempts: Number(payload.attempts ?? 0),
        });
      case DOMAIN_EVENTS.USER_MFA_ENROLLED:
        return mfaEnrolledEmail(context, { to: user.email });
      case DOMAIN_EVENTS.USER_MFA_DISABLED:
        return mfaDisabledEmail(context, { to: user.email });
      case DOMAIN_EVENTS.STAFF_INVITED:
        return staffInviteEmail(context, {
          to: user.email,
          token: String(payload.token ?? ''),
          roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
        });
      case DOMAIN_EVENTS.STAFF_ROLES_CHANGED:
        return staffRolesChangedEmail(context, {
          to: user.email,
          roles: Array.isArray(payload.after) ? (payload.after as string[]) : [],
        });
      default:
        return null;
    }
  }
}
