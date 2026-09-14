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
  orderCancelledEmail,
  orderPlacedEmail,
  paymentFailedEmail,
  refundIssuedEmail,
  staffRolesChangedEmail,
  subscriptionRenewalFailedEmail,
  subscriptionUnpaidEmail,
  supportRepliedEmail,
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

  /**
   * Turns an event into a message, or into nothing.
   *
   * Split by aggregate because the recipient is found differently: an account
   * event addresses the user row it names, while an order event addresses the
   * email captured on the order — which may be a guest who has no account at
   * all. Looking up a user for an order event would drop every guest's
   * confirmation.
   */
  private async render(job: OutboxJob): Promise<EmailMessage | null> {
    if (job.aggregateType === 'order') return this.renderOrderEmail(job);
    if (job.aggregateType === 'subscription') return this.renderSubscriptionEmail(job);
    if (job.aggregateType === 'support_thread') return this.renderSupportEmail(job);
    return this.renderAccountEmail(job);
  }

  private async renderAccountEmail(job: OutboxJob): Promise<EmailMessage | null> {
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

  /**
   * Order mail.
   *
   * Reads the order rather than trusting the event payload for anything a
   * customer will see: the payload is a snapshot from when the event was
   * written, and a confirmation quoting a total that has since been corrected
   * is worse than one that is a second late.
   */
  private async renderOrderEmail(job: OutboxJob): Promise<EmailMessage | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: job.aggregateId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) {
      this.logger.warn({ orderId: job.aggregateId }, 'skipping email for missing order');
      return null;
    }

    const context = this.templateContext;
    const firstName = (order.shippingAddress as { firstName?: string } | null)?.firstName ?? null;

    switch (job.eventType) {
      case DOMAIN_EVENTS.ORDER_PLACED:
        return orderPlacedEmail(context, {
          to: order.email,
          firstName,
          reference: order.reference,
          currency: order.currency,
          lines: order.items.map((item) => ({
            productName: item.productName,
            variantName: item.variantName,
            quantity: item.quantity,
            lineTotalCents: item.lineTotalCents,
          })),
          subtotalCents: order.subtotalCents,
          discountCents: order.discountCents,
          shippingCents: order.shippingCents,
          taxCents: order.taxCents,
          totalCents: order.totalCents,
          orderUrl: `${context.storefrontUrl}/orders/${order.id}`,
        });

      case DOMAIN_EVENTS.ORDER_CANCELLED:
        return orderCancelledEmail(context, {
          to: order.email,
          firstName,
          reference: order.reference,
          refunded: order.amountRefundedCents > 0,
        });

      case DOMAIN_EVENTS.PAYMENT_FAILED:
        return paymentFailedEmail(context, {
          to: order.email,
          firstName,
          reference: order.reference,
          checkoutUrl: `${context.storefrontUrl}/checkout`,
        });

      case DOMAIN_EVENTS.REFUND_ISSUED:
        return refundIssuedEmail(context, {
          to: order.email,
          firstName,
          reference: order.reference,
          currency: order.currency,
          amountCents: Number(job.payload.amountCents ?? 0),
        });

      default:
        return null;
    }
  }

  private async renderSubscriptionEmail(job: OutboxJob): Promise<EmailMessage | null> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: job.aggregateId },
      include: { customer: { include: { user: { select: { email: true, firstName: true } } } } },
    });
    if (!subscription) {
      this.logger.warn(
        { subscriptionId: job.aggregateId },
        'skipping email for missing subscription',
      );
      return null;
    }

    const context = this.templateContext;
    const manageUrl = `${context.storefrontUrl}/account/subscriptions`;
    const to = subscription.customer.user.email;
    const firstName = subscription.customer.user.firstName;

    switch (job.eventType) {
      case DOMAIN_EVENTS.SUBSCRIPTION_RENEWAL_FAILED:
        return subscriptionRenewalFailedEmail(context, {
          to,
          firstName,
          reference: subscription.reference,
          nextAttemptAt: subscription.nextBillingAt,
          manageUrl,
        });
      case DOMAIN_EVENTS.SUBSCRIPTION_UNPAID:
        return subscriptionUnpaidEmail(context, {
          to,
          firstName,
          reference: subscription.reference,
          manageUrl,
        });
      default:
        return null;
    }
  }

  /**
   * Support mail carries a link and no message body.
   *
   * A support reply can contain anything an agent typed. Email is the least
   * controlled channel in the system, so the customer comes back to the site
   * to read it rather than receiving a copy in their inbox.
   */
  private async renderSupportEmail(job: OutboxJob): Promise<EmailMessage | null> {
    const thread = await this.prisma.supportThread.findUnique({
      where: { id: job.aggregateId },
      include: { customer: { include: { user: { select: { email: true, firstName: true } } } } },
    });
    if (!thread) {
      this.logger.warn({ threadId: job.aggregateId }, 'skipping email for missing conversation');
      return null;
    }

    if (job.eventType !== DOMAIN_EVENTS.SUPPORT_REPLIED) return null;

    const context = this.templateContext;
    return supportRepliedEmail(context, {
      to: thread.customer.user.email,
      firstName: thread.customer.user.firstName,
      reference: thread.reference,
      threadUrl: `${context.storefrontUrl}/account/support/${thread.id}`,
    });
  }
}
