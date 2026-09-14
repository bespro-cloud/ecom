import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { DOMAIN_EVENTS, SUPPORT_MEDICAL_REDIRECT, type SupportStatus } from '@health/types';
import type {
  CreateSupportThreadInput,
  SupportQuery,
  SupportReplyInput,
  SupportStatusInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { LIFECYCLE_AUDIT_ACTIONS } from '../lifecycle.audit.js';

/**
 * Support conversations.
 *
 * The design constraint that matters here is what this inbox must *not*
 * become. A wellness retailer's support queue is the most natural place in the
 * whole platform for health information to accumulate: a customer describing
 * their symptoms to explain why they want a refund, an agent asking a clarifying
 * question, and suddenly the business is holding clinical detail it has no
 * lawful basis for and no ability to act on.
 *
 * So: there is no medical topic, no symptom field, and the storefront shows the
 * redirect before the customer types rather than after. Where the platform
 * cannot stop someone typing it anyway, it at least does not invite it, does not
 * structure it, and does not make it searchable.
 *
 * Messages are append-only. A support transcript that could be edited is not
 * evidence of what was said, and "what did we tell that customer?" is a question
 * that gets asked.
 *
 * Internal notes live in the same table as customer replies, distinguished by
 * one column. A separate notes table reads tidier and invites exactly one bug —
 * a customer-facing query that forgets to exclude it — so the filter lives in
 * this service, in one place, rather than in every caller.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(SupportService.name);
  }

  /** What the storefront shows before a customer starts typing. */
  readonly medicalRedirect = SUPPORT_MEDICAL_REDIRECT;

  // -------------------------------------------------------------------------
  // Customer
  // -------------------------------------------------------------------------

  async open(customerId: string, input: CreateSupportThreadInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    if (input.orderId) {
      // Scoped to the caller's own orders, so naming somebody else's changes
      // nothing except getting refused.
      const order = await this.prisma.order.findFirst({
        where: { id: input.orderId, customerId },
        select: { id: true },
      });
      if (!order) throw AppException.notFound('Order');
    }

    const now = this.clock.now();

    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportThread.create({
        data: {
          reference: await this.allocateReference(),
          customerId,
          orderId: input.orderId ?? null,
          topic: input.topic,
          subject: input.subject,
          status: 'OPEN',
          lastMessageAt: now,
        },
      });

      await tx.supportMessage.create({
        data: {
          threadId: created.id,
          authorType: 'CUSTOMER',
          authorId: actor.actorId,
          authorLabel: actor.actorLabel,
          body: input.body,
          isInternal: false,
        },
      });

      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.SUPPORT_THREAD_OPENED,
        entityType: 'support_thread',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        // The subject and topic, never the body. A support message is the
        // customer's own words and may contain anything; copying it into the
        // audit log would put it somewhere with a much longer retention and a
        // much wider read.
        after: { reference: created.reference, topic: input.topic, subject: input.subject },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    return this.findForCustomer(thread.id, customerId);
  }

  async listForCustomer(customerId: string) {
    const threads = await this.prisma.supportThread.findMany({
      where: { customerId },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: { order: { select: { id: true, reference: true } } },
    });

    return threads.map((thread) => ({
      id: thread.id,
      reference: thread.reference,
      topic: thread.topic,
      subject: thread.subject,
      status: thread.status,
      order: thread.order,
      lastMessageAt: thread.lastMessageAt,
      createdAt: thread.createdAt,
    }));
  }

  /**
   * One conversation, as the customer sees it.
   *
   * Internal notes are excluded in the query, not filtered afterwards: a
   * `.filter()` on a result set is one careless refactor away from leaking
   * staff commentary to the person it is about.
   */
  async findForCustomer(threadId: string, customerId: string) {
    const thread = await this.prisma.supportThread.findFirst({
      where: { id: threadId, customerId },
      include: {
        order: { select: { id: true, reference: true } },
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            authorType: true,
            authorLabel: true,
            body: true,
            createdAt: true,
          },
        },
      },
    });
    if (!thread) throw AppException.notFound('Conversation');

    return {
      id: thread.id,
      reference: thread.reference,
      topic: thread.topic,
      subject: thread.subject,
      status: thread.status,
      order: thread.order,
      lastMessageAt: thread.lastMessageAt,
      createdAt: thread.createdAt,
      messages: thread.messages.map((message) => ({
        id: message.id,
        // The staff member's email is not the customer's business. A support
        // reply is from the business, not from an individual's inbox.
        author: message.authorType === 'STAFF' ? 'Support' : 'You',
        authorType: message.authorType,
        body: message.body,
        createdAt: message.createdAt,
      })),
    };
  }

  async replyAsCustomer(
    threadId: string,
    customerId: string,
    input: SupportReplyInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);

    const thread = await this.prisma.supportThread.findFirst({
      where: { id: threadId, customerId },
      select: { id: true, status: true },
    });
    if (!thread) throw AppException.notFound('Conversation');
    if (thread.status === 'CLOSED') {
      throw AppException.conflict('This conversation is closed. Start a new one.');
    }

    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: {
          threadId,
          authorType: 'CUSTOMER',
          authorId: actor.actorId,
          authorLabel: actor.actorLabel,
          body: input.body,
          // Ignored from a customer regardless of what they sent, and a
          // database CHECK refuses it too.
          isInternal: false,
        },
      });
      await tx.supportThread.update({
        where: { id: threadId },
        data: { lastMessageAt: now, status: 'OPEN' },
      });
    });

    return this.findForCustomer(threadId, customerId);
  }

  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------

  async list(query: SupportQuery) {
    const rows = await this.prisma.supportThread.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.topic ? { topic: query.topic } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: query.limit + 1,
      include: {
        customer: { select: { id: true, reference: true } },
        order: { select: { id: true, reference: true } },
        _count: { select: { messages: true } },
      },
    });

    return {
      data: rows.slice(0, query.limit).map((thread) => ({
        id: thread.id,
        reference: thread.reference,
        topic: thread.topic,
        subject: thread.subject,
        status: thread.status,
        customerReference: thread.customer.reference,
        order: thread.order,
        assignedToLabel: thread.assignedToLabel,
        messageCount: thread._count.messages,
        lastMessageAt: thread.lastMessageAt,
        createdAt: thread.createdAt,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  /** One conversation for staff, internal notes included. */
  async findForStaff(threadId: string) {
    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      include: {
        customer: { select: { id: true, reference: true } },
        order: { select: { id: true, reference: true, status: true, totalCents: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!thread) throw AppException.notFound('Conversation');
    return thread;
  }

  async replyAsStaff(threadId: string, input: SupportReplyInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      select: { id: true, status: true },
    });
    if (!thread) throw AppException.notFound('Conversation');

    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: {
          threadId,
          authorType: 'STAFF',
          authorId: actor.actorId,
          authorLabel: actor.actorLabel,
          body: input.body,
          isInternal: input.isInternal,
        },
      });
      await tx.supportThread.update({
        where: { id: threadId },
        data: {
          lastMessageAt: now,
          // An internal note is not a reply to the customer, so it does not
          // move the conversation into "waiting on them".
          ...(input.isInternal ? {} : { status: 'AWAITING_CUSTOMER' as const }),
          ...(thread.status === 'CLOSED' ? { status: 'OPEN' as const, closedAt: null } : {}),
        },
      });

      // Only a reply the customer can see is worth an email. An internal note
      // that notified the customer would be a leak of staff commentary about
      // them, by notification rather than by content.
      if (!input.isInternal) {
        await this.outbox.publish(tx, {
          aggregateType: 'support_thread',
          aggregateId: threadId,
          eventType: DOMAIN_EVENTS.SUPPORT_REPLIED,
          payload: {},
          correlationId: actor.correlationId,
        });
      }

      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.SUPPORT_REPLIED,
        entityType: 'support_thread',
        entityId: threadId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        // Whether a reply happened and whether it was internal. Never the text.
        after: { isInternal: input.isInternal },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findForStaff(threadId);
  }

  async setStatus(threadId: string, input: SupportStatusInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      select: { id: true, status: true },
    });
    if (!thread) throw AppException.notFound('Conversation');

    const now = this.clock.now();
    const status = input.status as SupportStatus;

    await this.prisma.$transaction(async (tx) => {
      await tx.supportThread.update({
        where: { id: threadId },
        data: {
          status,
          resolvedAt: status === 'RESOLVED' ? now : null,
          closedAt: status === 'CLOSED' ? now : null,
          assignedToId: actor.actorId,
          assignedToLabel: actor.actorLabel,
        },
      });

      if (input.note) {
        await tx.supportMessage.create({
          data: {
            threadId,
            authorType: 'STAFF',
            authorId: actor.actorId,
            authorLabel: actor.actorLabel,
            body: input.note,
            isInternal: true,
          },
        });
      }

      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.SUPPORT_STATUS_CHANGED,
        entityType: 'support_thread',
        entityId: threadId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { status: thread.status },
        after: { status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findForStaff(threadId);
  }

  // -------------------------------------------------------------------------

  private async allocateReference(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = `SUP-${randomBytes(3).toString('hex').toUpperCase()}`;
      const clash = await this.prisma.supportThread.findUnique({
        where: { reference },
        select: { id: true },
      });
      if (!clash) return reference;
    }
    throw AppException.conflict('Could not allocate a conversation reference. Try again.');
  }
}
