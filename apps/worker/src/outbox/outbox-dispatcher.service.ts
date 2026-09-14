import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { DOMAIN_EVENTS, type QueueName } from '@health/types';
import { PrismaService } from '../prisma.service.js';
import { QueueService } from '../queues/queue.service.js';
import { CLOCK } from '../clock.module.js';

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  correlation_id: string | null;
  attempts: number;
}

/**
 * Drains the transactional outbox onto the queues.
 *
 * The API writes domain events in the same transaction as the state change;
 * this loop is what turns them into work. Two properties matter:
 *
 *  - **Exactly one worker claims a row.** `SELECT ... FOR UPDATE SKIP LOCKED`
 *    lets several worker instances poll the same table concurrently without
 *    either blocking each other or double-dispatching.
 *  - **Enqueue is idempotent.** The BullMQ job id is derived from the outbox
 *    row id, so a crash between "job added" and "row marked dispatched" results
 *    in the job being added again and ignored, not processed twice.
 */
@Injectable()
export class OutboxDispatcherService implements OnModuleDestroy {
  private static readonly BATCH_SIZE = 100;
  private static readonly MAX_ATTEMPTS = 10;

  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(OutboxDispatcherService.name);
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  @Interval('outbox-dispatch', 1000)
  async tick(): Promise<void> {
    // Overlapping ticks would do no harm (SKIP LOCKED protects us) but would
    // waste connections while a slow batch is in flight.
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      let dispatched = 0;
      // Keep going while there is a full batch waiting, so a backlog drains
      // quickly instead of at one batch per second.
      for (;;) {
        const count = await this.dispatchBatch();
        dispatched += count;
        if (count < OutboxDispatcherService.BATCH_SIZE) break;
      }
      if (dispatched > 0) {
        this.logger.debug({ dispatched }, 'outbox batch dispatched');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'outbox dispatch failed');
    } finally {
      this.running = false;
    }
  }

  async dispatchBatch(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, correlation_id, attempts
           FROM outbox_messages
          WHERE dispatched_at IS NULL
            AND failed_at IS NULL
            AND available_at <= now()
          ORDER BY available_at ASC, created_at ASC
          LIMIT ${OutboxDispatcherService.BATCH_SIZE}
          FOR UPDATE SKIP LOCKED`,
      );

      for (const row of rows) {
        try {
          const queue = queueForEvent(row.event_type);
          await this.queues.enqueue(
            queue,
            row.event_type,
            {
              outboxId: row.id,
              aggregateType: row.aggregate_type,
              aggregateId: row.aggregate_id,
              eventType: row.event_type,
              payload: row.payload,
              correlationId: row.correlation_id,
            },
            // Derived from the row id: re-adding after a crash is a no-op.
            { jobId: `outbox:${row.id}` },
          );

          await tx.outboxMessage.update({
            where: { id: row.id },
            data: { dispatchedAt: this.clock.now(), attempts: { increment: 1 } },
          });
        } catch (error) {
          const attempts = row.attempts + 1;
          const exhausted = attempts >= OutboxDispatcherService.MAX_ATTEMPTS;
          await tx.outboxMessage.update({
            where: { id: row.id },
            data: {
              attempts,
              lastError: error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
              // Give up eventually rather than looping forever on a message
              // that can never be routed; it stays in the table for inspection.
              ...(exhausted ? { failedAt: this.clock.now() } : {}),
              availableAt: new Date(this.clock.timestamp() + Math.min(attempts * 5000, 300_000)),
            },
          });
          this.logger.error(
            { err: error, outboxId: row.id, eventType: row.event_type, attempts, exhausted },
            'failed to dispatch outbox message',
          );
        }
      }

      return rows.length;
    });
  }
}

/**
 * Routes a domain event to a queue.
 *
 * Unknown events go to the analytics queue rather than being dropped: an event
 * nobody consumes yet is still evidence that something happened.
 *
 * The email list is account and staff events plus the transactional commerce
 * and lifecycle ones. Every entry has a renderer in `EmailProcessor`: routing
 * an event here that the processor cannot render dead-letters the job, so the
 * two have to stay in step, and a unit test asserts that they do.
 */
export function queueForEvent(eventType: string): QueueName {
  switch (eventType) {
    case DOMAIN_EVENTS.USER_REGISTERED:
    case DOMAIN_EVENTS.USER_EMAIL_VERIFICATION_REQUESTED:
    case DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED:
    case DOMAIN_EVENTS.USER_PASSWORD_CHANGED:
    case DOMAIN_EVENTS.USER_MFA_ENROLLED:
    case DOMAIN_EVENTS.USER_MFA_DISABLED:
    case DOMAIN_EVENTS.USER_LOCKED_OUT:
    case DOMAIN_EVENTS.STAFF_INVITED:
    case DOMAIN_EVENTS.STAFF_ROLES_CHANGED:
    case DOMAIN_EVENTS.ORDER_PLACED:
    case DOMAIN_EVENTS.ORDER_CANCELLED:
    case DOMAIN_EVENTS.PAYMENT_FAILED:
    case DOMAIN_EVENTS.REFUND_ISSUED:
    case DOMAIN_EVENTS.SUBSCRIPTION_RENEWAL_FAILED:
    case DOMAIN_EVENTS.SUBSCRIPTION_UNPAID:
    case DOMAIN_EVENTS.SUPPORT_REPLIED:
      return 'email';
    default:
      return 'analytics';
  }
}
