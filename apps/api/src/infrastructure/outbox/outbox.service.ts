import { Injectable } from '@nestjs/common';
import type { DbClient } from '@health/database';
import type { DomainEventName } from '@health/types';

export interface OutboxWrite {
  aggregateType: string;
  aggregateId: string;
  eventType: DomainEventName;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  /** Delay before the worker may pick the message up. */
  availableAt?: Date;
}

/**
 * Transactional outbox.
 *
 * Domain events are written in the *same transaction* as the state change that
 * produced them. Either both land or neither does, so a customer can never be
 * created without its welcome email being scheduled — and an email is never
 * sent for a registration that rolled back.
 *
 * The worker polls `outbox_messages` and dispatches to BullMQ.
 */
@Injectable()
export class OutboxService {
  async publish(tx: DbClient, message: OutboxWrite): Promise<void> {
    await tx.outboxMessage.create({
      data: {
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload as never,
        correlationId: message.correlationId ?? null,
        ...(message.availableAt ? { availableAt: message.availableAt } : {}),
      },
    });
  }

  async publishMany(tx: DbClient, messages: OutboxWrite[]): Promise<void> {
    if (messages.length === 0) return;
    await tx.outboxMessage.createMany({
      data: messages.map((message) => ({
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload as never,
        correlationId: message.correlationId ?? null,
        ...(message.availableAt ? { availableAt: message.availableAt } : {}),
      })),
    });
  }
}
