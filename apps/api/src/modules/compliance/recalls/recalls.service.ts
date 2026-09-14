import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { isUniqueConstraintError } from '@health/database';
import { canTransitionRecall, recallNotificationApproved, type RecallStatus } from '@health/types';
import type {
  ApproveRecallNotificationInput,
  CancelRecallInput,
  CloseRecallInput,
  CreateRecallInput,
  RecallLotsInput,
  RecallNoteInput,
  RecallQuery,
  RecallRegulatorInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { COMPLIANCE_AUDIT_ACTIONS } from '../compliance.audit.js';

/**
 * Recalls.
 *
 * The single most consequential service in the platform, and the design is
 * shaped by one sentence: **this system never contacts anyone.**
 *
 * Opening a recall blocks the affected lots immediately — that part is
 * automatic, because stock that may be unsafe should stop being allocatable the
 * moment somebody says so, and waiting for an approval to do it would be
 * backwards. Everything downstream of that is deliberately manual:
 *
 * - **Impact is derived, not acted on.** Given the lots, the service can say
 *   which orders received units and therefore which customers are affected. It
 *   computes that on request and records that it was computed. It does not send
 *   an email, queue a job, or write to an outbox.
 *
 * - **The contact list does not exist until a named person approves it.**
 *   `assessImpact` returns counts to anyone with `RECALL_READ`; the customer
 *   identities are withheld until the recall reaches `NOTIFICATION_APPROVED`.
 *   That is not UI politeness — a list of names and addresses of people who
 *   consumed a possibly-unsafe product is exactly the artefact that should not
 *   be casually reachable, and having it require an approval means nobody
 *   arrives at it by clicking through screens.
 *
 * - **Approval is its own permission, its own route, its own second factor, and
 *   a typed acknowledgement.** `RECALL_NOTIFY` is separate from
 *   `RECALL_MANAGE`: blocking stock is an operational act, telling customers
 *   their purchase is being recalled has legal consequences, and they should
 *   not be the same authority.
 *
 * The database enforces the important half of this independently: a recall row
 * cannot sit in `NOTIFICATION_APPROVED` without a named approver and a
 * timestamp, and every action on a recall is append-only.
 */
@Injectable()
export class RecallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(RecallsService.name);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(query: RecallQuery) {
    const rows = await this.prisma.recall.findMany({
      where: query.status ? { status: query.status as RecallStatus } : {},
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      include: { _count: { select: { lots: true } } },
    });

    return {
      data: rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        reference: row.reference,
        status: row.status,
        classification: row.classification,
        title: row.title,
        openedAt: row.openedAt,
        notificationApprovedAt: row.notificationApprovedAt,
        closedAt: row.closedAt,
        lotCount: row._count.lots,
        createdAt: row.createdAt,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async findById(recallId: string) {
    const recall = await this.prisma.recall.findUnique({
      where: { id: recallId },
      include: {
        lots: {
          include: {
            batch: {
              include: {
                inventoryItem: {
                  select: {
                    warehouse: { select: { code: true, name: true } },
                    variant: {
                      select: {
                        sku: true,
                        name: true,
                        product: { select: { id: true, name: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        actions: { orderBy: { createdAt: 'desc' }, take: 500 },
      },
    });
    if (!recall) throw AppException.notFound('Recall');

    return {
      id: recall.id,
      reference: recall.reference,
      status: recall.status,
      classification: recall.classification,
      title: recall.title,
      reason: recall.reason,
      hazard: recall.hazard,
      openedByLabel: recall.openedByLabel,
      openedAt: recall.openedAt,
      notificationApprovedByLabel: recall.notificationApprovedByLabel,
      notificationApprovedAt: recall.notificationApprovedAt,
      /** Whether customer identities may be disclosed at all. */
      notificationApproved: recallNotificationApproved(recall.status as RecallStatus),
      regulatorNotifiedAt: recall.regulatorNotifiedAt,
      regulatorReference: recall.regulatorReference,
      closedAt: recall.closedAt,
      createdAt: recall.createdAt,
      lots: recall.lots.map((lot) => ({
        id: lot.id,
        batchId: lot.batchId,
        lotCode: lot.batch.lotCode,
        status: lot.batch.status,
        previousStatus: lot.previousStatus,
        quantityAtRecall: lot.quantityAtRecall,
        quantityOnHand: lot.batch.quantityOnHand,
        expiresAt: lot.batch.expiresAt,
        warehouse: lot.batch.inventoryItem.warehouse,
        sku: lot.batch.inventoryItem.variant.sku,
        productId: lot.batch.inventoryItem.variant.product.id,
        productName: lot.batch.inventoryItem.variant.product.name,
      })),
      actions: recall.actions,
    };
  }

  /**
   * Who received goods from the recalled lots.
   *
   * Two shapes, and which one you get depends entirely on whether a named
   * person has approved contacting customers:
   *
   * - Before approval: **counts only**. How many orders, how many distinct
   *   customers, how many units, broken down by product. Enough to assess scale
   *   and brief a regulator; not enough to contact anybody.
   * - After approval: the same counts plus the affected orders and the contact
   *   details needed to reach them.
   *
   * The withholding is done here, in the service, rather than in a controller
   * or a template — so there is no route, no admin screen and no export that
   * can reach the identities by asking differently.
   */
  async assessImpact(recallId: string, rawActor: ActorContext) {
    const recall = await this.prisma.recall.findUnique({
      where: { id: recallId },
      include: { lots: { select: { batchId: true } } },
    });
    if (!recall) throw AppException.notFound('Recall');

    const batchIds = recall.lots.map((lot) => lot.batchId);
    if (batchIds.length === 0) {
      return {
        notificationApproved: recallNotificationApproved(recall.status as RecallStatus),
        orderCount: 0,
        customerCount: 0,
        unitsShipped: 0,
        byProduct: [],
        orders: null,
        disclosureNote: NO_LOTS_NOTE,
      };
    }

    // Every reservation that drew from a recalled lot and belongs to an order.
    // This is the join lot tracking exists to make possible.
    const reservations = await this.prisma.inventoryReservation.findMany({
      where: { batchId: { in: batchIds }, orderId: { not: null } },
      select: {
        quantity: true,
        status: true,
        batchId: true,
        order: {
          select: {
            id: true,
            reference: true,
            email: true,
            customerId: true,
            status: true,
            placedAt: true,
            shippingAddress: true,
          },
        },
        inventoryItem: {
          select: {
            variant: { select: { sku: true, product: { select: { id: true, name: true } } } },
          },
        },
      },
    });

    const orders = new Map<string, AffectedOrder>();
    const byProduct = new Map<string, { productId: string; productName: string; units: number }>();
    let unitsShipped = 0;

    for (const reservation of reservations) {
      if (!reservation.order) continue;

      const product = reservation.inventoryItem.variant.product;
      unitsShipped += reservation.quantity;

      const productEntry = byProduct.get(product.id) ?? {
        productId: product.id,
        productName: product.name,
        units: 0,
      };
      productEntry.units += reservation.quantity;
      byProduct.set(product.id, productEntry);

      const existing = orders.get(reservation.order.id);
      if (existing) {
        existing.units += reservation.quantity;
        continue;
      }
      orders.set(reservation.order.id, {
        orderId: reservation.order.id,
        reference: reservation.order.reference,
        email: reservation.order.email,
        customerId: reservation.order.customerId,
        orderStatus: reservation.order.status,
        placedAt: reservation.order.placedAt,
        shippingAddress: reservation.order.shippingAddress,
        units: reservation.quantity,
      });
    }

    const customerKeys = new Set(
      [...orders.values()].map((order) => order.customerId ?? `guest:${order.email}`),
    );

    const approved = recallNotificationApproved(recall.status as RecallStatus);

    // Recorded whether or not identities were disclosed. Someone asking "who
    // looked at the affected customer list, and when?" gets an answer either
    // way.
    await this.recordAction(recallId, {
      type: 'IMPACT_ASSESSED',
      message: `Impact assessed: ${orders.size} order(s), ${customerKeys.size} customer(s), ${unitsShipped} unit(s).`,
      data: {
        orderCount: orders.size,
        customerCount: customerKeys.size,
        unitsShipped,
        identitiesDisclosed: approved,
      },
      actor: rawActor,
    });

    return {
      notificationApproved: approved,
      orderCount: orders.size,
      customerCount: customerKeys.size,
      unitsShipped,
      byProduct: [...byProduct.values()],
      // The whole mechanism, in one expression.
      orders: approved ? [...orders.values()] : null,
      disclosureNote: approved ? DISCLOSED_NOTE : WITHHELD_NOTE,
    };
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(input: CreateRecallInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const recall = await this.prisma.$transaction(async (tx) => {
      const created = await tx.recall.create({
        data: {
          reference: await this.allocateReference(),
          status: 'DRAFT',
          classification: input.classification ?? 'UNCLASSIFIED',
          title: input.title,
          reason: input.reason,
          hazard: input.hazard ?? null,
        },
      });

      await tx.recallAction.create({
        data: {
          recallId: created.id,
          type: 'NOTE',
          message: 'Recall drafted.',
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.RECALL_CREATED,
        entityType: 'recall',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        after: { reference: created.reference, title: input.title },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    if (input.batchIds?.length) {
      await this.addLots(
        recall.id,
        { batchIds: input.batchIds, reason: 'Lots named when the recall was drafted.' },
        rawActor,
      );
    }

    return this.findById(recall.id);
  }

  /**
   * Adds lots to a recall's scope.
   *
   * While the recall is open this blocks the stock as it goes, so a lot added
   * an hour into a recall stops being allocatable at that moment rather than
   * when someone remembers to quarantine it.
   */
  async addLots(recallId: string, input: RecallLotsInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const recall = await this.prisma.recall.findUnique({ where: { id: recallId } });
    if (!recall) throw AppException.notFound('Recall');
    if (recall.status === 'CLOSED' || recall.status === 'CANCELLED') {
      throw AppException.conflict(`A ${recall.status.toLowerCase()} recall cannot be changed.`);
    }

    const batches = await this.prisma.inventoryBatch.findMany({
      where: { id: { in: input.batchIds } },
      select: { id: true, lotCode: true, status: true, quantityOnHand: true },
    });
    if (batches.length !== input.batchIds.length) {
      throw AppException.notFound('Lot');
    }

    const blocking = recall.status === 'OPEN' || recall.status === 'NOTIFICATION_APPROVED';

    await this.prisma.$transaction(async (tx) => {
      for (const batch of batches) {
        try {
          await tx.recallLot.create({
            data: {
              recallId,
              batchId: batch.id,
              // Kept so cancelling a recall opened in error restores what was
              // actually there rather than assuming AVAILABLE.
              previousStatus: batch.status,
              quantityAtRecall: batch.quantityOnHand,
            },
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) continue;
          throw error;
        }

        if (blocking && batch.status !== 'RECALLED') {
          await tx.inventoryBatch.update({
            where: { id: batch.id },
            data: { status: 'RECALLED' },
          });
          await tx.batchEvent.create({
            data: {
              batchId: batch.id,
              type: 'RECALLED',
              fromStatus: batch.status,
              toStatus: 'RECALLED',
              reason: `Recall ${recall.reference}: ${input.reason}`,
              actorId: actor.actorId,
              actorLabel: actor.actorLabel,
            },
          });
        }

        await tx.recallAction.create({
          data: {
            recallId,
            type: 'LOT_ADDED',
            message: `Lot ${batch.lotCode} added to the recall (${batch.quantityOnHand} unit(s) on hand).`,
            data: { batchId: batch.id, lotCode: batch.lotCode, blocked: blocking },
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
          },
        });
      }

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.RECALL_LOTS_ADDED,
        entityType: 'recall',
        entityId: recallId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        after: { lotCodes: batches.map((batch) => batch.lotCode), blocked: blocking },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(recallId);
  }

  /**
   * Opens the recall: every lot in scope stops being allocatable, now.
   *
   * Deliberately automatic. Stock that may be unsafe should stop being sold the
   * moment someone with the authority says so — requiring a second approval to
   * *stop* selling would get the risk exactly the wrong way round. It is
   * contacting customers that needs the extra approval, not withdrawing stock.
   */
  async open(recallId: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const recall = await this.prisma.recall.findUnique({
      where: { id: recallId },
      include: {
        lots: { include: { batch: { select: { id: true, lotCode: true, status: true } } } },
      },
    });
    if (!recall) throw AppException.notFound('Recall');
    this.assertTransition(recall.status as RecallStatus, 'OPEN');

    if (recall.lots.length === 0) {
      throw AppException.preconditionFailed(
        'A recall needs at least one lot in scope before it can be opened.',
      );
    }

    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.recall.update({
        where: { id: recallId },
        data: {
          status: 'OPEN',
          openedAt: now,
          openedById: actor.actorId,
          openedByLabel: actor.actorLabel,
        },
      });

      for (const lot of recall.lots) {
        if (lot.batch.status === 'RECALLED') continue;
        await tx.inventoryBatch.update({
          where: { id: lot.batch.id },
          data: { status: 'RECALLED' },
        });
        await tx.batchEvent.create({
          data: {
            batchId: lot.batch.id,
            type: 'RECALLED',
            fromStatus: lot.batch.status,
            toStatus: 'RECALLED',
            reason: `Recall ${recall.reference} opened: ${recall.reason}`,
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
          },
        });
      }

      await tx.recallAction.create({
        data: {
          recallId,
          type: 'OPENED',
          message: `Recall opened. ${recall.lots.length} lot(s) withdrawn from sale.`,
          data: { lotCount: recall.lots.length },
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await tx.recallAction.create({
        data: {
          recallId,
          type: 'STOCK_QUARANTINED',
          message:
            'Affected stock is no longer allocatable. No customer has been contacted; that requires a separate approval.',
          isSystem: true,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.RECALL_OPENED,
        entityType: 'recall',
        entityId: recallId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: recall.reason,
        before: { status: recall.status },
        after: {
          status: 'OPEN',
          reference: recall.reference,
          lotCount: recall.lots.length,
          customersContacted: false,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.logger.warn(
      { recallId, reference: recall.reference, lots: recall.lots.length },
      'recall opened; affected stock withdrawn from sale',
    );

    return this.findById(recallId);
  }

  /**
   * Approves contacting affected customers.
   *
   * The one decision in this system with legal consequences for people outside
   * the business, and everything about the route says so: its own permission,
   * a second factor, a typed acknowledgement rather than a checkbox, and a
   * required written basis.
   *
   * Approving still sends nothing. It unlocks the affected-customer list for
   * someone to act on, and records who unlocked it and why. The platform does
   * have transactional email, and recall notification is deliberately not wired
   * to it: dispatch is a further explicit act, not a consequence of this one.
   */
  async approveNotification(
    recallId: string,
    input: ApproveRecallNotificationInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);

    const recall = await this.prisma.recall.findUnique({ where: { id: recallId } });
    if (!recall) throw AppException.notFound('Recall');
    this.assertTransition(recall.status as RecallStatus, 'NOTIFICATION_APPROVED');

    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.recall.update({
        where: { id: recallId },
        data: {
          status: 'NOTIFICATION_APPROVED',
          notificationApprovedAt: now,
          notificationApprovedById: actor.actorId,
          notificationApprovedByLabel: actor.actorLabel,
        },
      });

      await tx.recallAction.create({
        data: {
          recallId,
          type: 'NOTIFICATION_APPROVED',
          message: `${actor.actorLabel} approved contacting affected customers.`,
          data: { basis: input.notes },
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await tx.recallAction.create({
        data: {
          recallId,
          type: 'NOTE',
          message:
            'The affected customer list is now available. This system does not send anything; contacting customers remains a manual act.',
          isSystem: true,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.RECALL_NOTIFICATION_APPROVED,
        entityType: 'recall',
        entityId: recallId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        before: { status: recall.status },
        after: {
          status: 'NOTIFICATION_APPROVED',
          reference: recall.reference,
          approvedBy: actor.actorLabel,
          // Stated explicitly in the audit record, because this is the entry
          // someone will read years later trying to establish what happened.
          messagesSentByThisSystem: 0,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.logger.warn(
      { recallId, reference: recall.reference, approverId: actor.actorId },
      'customer notification approved for recall',
    );

    return this.findById(recallId);
  }

  /** Records that a regulator was told, by the person who told them. */
  async recordRegulatorNotification(
    recallId: string,
    input: RecallRegulatorInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);

    const recall = await this.prisma.recall.findUnique({ where: { id: recallId } });
    if (!recall) throw AppException.notFound('Recall');

    await this.prisma.$transaction(async (tx) => {
      await tx.recall.update({
        where: { id: recallId },
        data: {
          regulatorNotifiedAt: this.clock.now(),
          regulatorReference: input.regulatorReference,
        },
      });
      await tx.recallAction.create({
        data: {
          recallId,
          type: 'REGULATOR_NOTIFIED',
          message: `Regulator notified. Reference ${input.regulatorReference}.`,
          data: { notes: input.notes },
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.RECALL_REGULATOR_NOTIFIED,
        entityType: 'recall',
        entityId: recallId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        after: { regulatorReference: input.regulatorReference },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(recallId);
  }

  async addNote(recallId: string, input: RecallNoteInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    const recall = await this.prisma.recall.findUnique({ where: { id: recallId } });
    if (!recall) throw AppException.notFound('Recall');

    await this.recordAction(recallId, { type: 'NOTE', message: input.note, actor: rawActor });
    void actor;
    return this.findById(recallId);
  }

  /**
   * Closes a recall.
   *
   * Recalled stock stays recalled. Closing records that the response is
   * finished, not that the goods turned out to be fine — those are different
   * statements, and conflating them would put withdrawn units back on the
   * shelf.
   */
  async close(recallId: string, input: CloseRecallInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const recall = await this.prisma.recall.findUnique({ where: { id: recallId } });
    if (!recall) throw AppException.notFound('Recall');
    this.assertTransition(recall.status as RecallStatus, 'CLOSED');

    await this.prisma.$transaction(async (tx) => {
      await tx.recall.update({
        where: { id: recallId },
        data: { status: 'CLOSED', closedAt: this.clock.now() },
      });
      await tx.recallAction.create({
        data: {
          recallId,
          type: 'CLOSED',
          message: input.reason,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.RECALL_CLOSED,
        entityType: 'recall',
        entityId: recallId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        before: { status: recall.status },
        after: { status: 'CLOSED', stockRemainsWithdrawn: true },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(recallId);
  }

  /**
   * Cancels a recall opened in error, restoring each lot to what it was before.
   *
   * Unavailable once customer contact has been approved: at that point the
   * recall is a matter of record and is closed rather than undone. Restoring
   * the *previous* status rather than `AVAILABLE` matters — a lot that was
   * already quarantined for an unrelated reason must not become sellable
   * because a different recall was withdrawn.
   */
  async cancel(recallId: string, input: CancelRecallInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const recall = await this.prisma.recall.findUnique({
      where: { id: recallId },
      include: {
        lots: { include: { batch: { select: { id: true, lotCode: true, status: true } } } },
      },
    });
    if (!recall) throw AppException.notFound('Recall');
    this.assertTransition(recall.status as RecallStatus, 'CANCELLED');

    await this.prisma.$transaction(async (tx) => {
      await tx.recall.update({ where: { id: recallId }, data: { status: 'CANCELLED' } });

      for (const lot of recall.lots) {
        if (lot.batch.status !== 'RECALLED') continue;

        await tx.inventoryBatch.update({
          where: { id: lot.batch.id },
          data: { status: lot.previousStatus },
        });
        await tx.batchEvent.create({
          data: {
            batchId: lot.batch.id,
            type: 'RECALL_CANCELLED',
            fromStatus: 'RECALLED',
            toStatus: lot.previousStatus,
            reason: `Recall ${recall.reference} cancelled: ${input.reason}`,
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
          },
        });
      }

      await tx.recallAction.create({
        data: {
          recallId,
          type: 'CANCELLED',
          message: input.reason,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.RECALL_CANCELLED,
        entityType: 'recall',
        entityId: recallId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        before: { status: recall.status },
        after: { status: 'CANCELLED', lotsRestored: recall.lots.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(recallId);
  }

  // -------------------------------------------------------------------------

  private async recordAction(
    recallId: string,
    entry: { type: string; message: string; data?: unknown; actor: ActorContext },
  ): Promise<void> {
    await this.prisma.recallAction.create({
      data: {
        recallId,
        type: entry.type,
        message: entry.message,
        data: (entry.data ?? null) as never,
        actorId: entry.actor.actorId,
        actorLabel: entry.actor.actorLabel,
      },
    });
  }

  private assertTransition(from: RecallStatus, to: RecallStatus): void {
    if (!canTransitionRecall(from, to)) {
      throw AppException.conflict(
        `A recall cannot move from ${from.toLowerCase().replace(/_/g, ' ')} to ${to
          .toLowerCase()
          .replace(/_/g, ' ')}.`,
      );
    }
  }

  /**
   * A recall reference.
   *
   * Random rather than sequential, for the same reason order references are: a
   * sequential one tells anyone who sees a recall notice how many recalls the
   * business has had.
   */
  private async allocateReference(): Promise<string> {
    const year = this.clock.now().getUTCFullYear();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = randomBytes(4).toString('hex').toUpperCase();
      const reference = `RC-${year}-${suffix}`;
      const clash = await this.prisma.recall.findUnique({
        where: { reference },
        select: { id: true },
      });
      if (!clash) return reference;
    }
    throw AppException.conflict('Could not allocate a recall reference. Try again.');
  }
}

interface AffectedOrder {
  orderId: string;
  reference: string;
  email: string;
  customerId: string | null;
  orderStatus: string;
  placedAt: Date;
  shippingAddress: unknown;
  units: number;
}

const WITHHELD_NOTE =
  'Customer identities are withheld until a named person with RECALL_NOTIFY approves contacting them. Counts are shown so the scale can be assessed and a regulator briefed.';

const DISCLOSED_NOTE =
  'Customer contact was approved by a named person. This system sends nothing: contacting these customers remains a manual act.';

const NO_LOTS_NOTE = 'No lots are in scope for this recall yet, so nobody is affected by it.';
