import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import { Prisma, expireLapsedLots, isUniqueConstraintError } from '@health/database';
import { canTransitionBatch, type BatchStatus } from '@health/types';
import type {
  BatchDispositionInput,
  BatchQuery,
  LotTrackingInput,
  ReceiveBatchInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { COMPLIANCE_AUDIT_ACTIONS } from '../compliance.audit.js';

type Tx = Prisma.TransactionClient;

/**
 * Lots.
 *
 * A lot is the unit a regulator thinks in. "Which customers received goods from
 * lot 24B-0917?" is the question a recall turns on, and it is answerable here
 * because allocation records which lot each reservation drew from.
 *
 * Three rules:
 *
 * **Only available stock is allocatable**, and that is enforced in the SQL that
 * picks lots rather than in a filter a caller could influence. Quarantined,
 * recalled and expired units stay counted as on-hand — they are physically
 * there — but no path through allocation can reach them.
 *
 * **Every disposition change carries a reason**, in both directions. "Why was
 * this held?" and "on what basis was it released?" are the same question at
 * different times, and the second is the more dangerous one to have no answer
 * to. The reasons land in an append-only ledger.
 *
 * **Quantities only move through a recorded event.** Receiving creates a lot
 * with a receipt; fulfilment consumes from it; nothing sets a quantity
 * directly.
 */
@Injectable()
export class BatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(BatchesService.name);
  }

  async list(query: BatchQuery) {
    const now = this.clock.now();
    const rows = await this.prisma.inventoryBatch.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.variantId ? { inventoryItem: { variantId: query.variantId } } : {}),
        ...(query.warehouseId ? { inventoryItem: { warehouseId: query.warehouseId } } : {}),
        ...(query.search
          ? {
              OR: [
                { lotCode: { contains: query.search, mode: 'insensitive' as const } },
                { supplier: { contains: query.search, mode: 'insensitive' as const } },
                {
                  inventoryItem: {
                    variant: { sku: { contains: query.search, mode: 'insensitive' as const } },
                  },
                },
              ],
            }
          : {}),
        ...(query.expiringWithinDays !== undefined
          ? { expiresAt: { lte: addSeconds(now, query.expiringWithinDays * 24 * 60 * 60) } }
          : {}),
      },
      orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }],
      take: query.limit + 1,
      include: {
        inventoryItem: {
          select: {
            id: true,
            lotTracked: true,
            warehouse: { select: { id: true, code: true, name: true } },
            variant: {
              select: {
                id: true,
                sku: true,
                name: true,
                product: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    return {
      data: rows.slice(0, query.limit).map((row) => toBatchView(row, now)),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async findById(batchId: string) {
    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
      include: {
        inventoryItem: {
          select: {
            id: true,
            lotTracked: true,
            warehouse: { select: { id: true, code: true, name: true } },
            variant: {
              select: {
                id: true,
                sku: true,
                name: true,
                product: { select: { id: true, name: true } },
              },
            },
          },
        },
        events: { orderBy: { createdAt: 'desc' }, take: 200 },
        documents: {
          where: { archivedAt: null },
          select: { id: true, type: true, title: true, issuer: true, expiresAt: true },
        },
      },
    });
    if (!batch) throw AppException.notFound('Lot');

    const now = this.clock.now();
    return {
      ...toBatchView(batch, now),
      events: batch.events,
      documents: batch.documents.map((document) => ({
        id: document.id,
        type: document.type,
        title: document.title,
        issuerAsStated: document.issuer,
        expiresAt: document.expiresAt,
        expired: document.expiresAt !== null && document.expiresAt <= now,
      })),
    };
  }

  /**
   * Receives a lot into a warehouse.
   *
   * Creates the stock record if the variant has never been stocked there, so
   * receiving goods does not require a separate configuration step first. The
   * item-level on-hand goes up by the same amount, through the same adjustment
   * ledger every other movement uses.
   */
  async receive(input: ReceiveBatchInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const [variant, warehouse] = await Promise.all([
      this.prisma.productVariant.findFirst({
        where: { id: input.variantId, deletedAt: null },
        select: { id: true, sku: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: input.warehouseId, deletedAt: null },
        select: { id: true, code: true, isActive: true },
      }),
    ]);
    if (!variant) throw AppException.notFound('Variant');
    if (!warehouse) throw AppException.notFound('Warehouse');

    const now = this.clock.now();
    if (input.expiresAt && input.expiresAt <= now) {
      // Receiving stock that is already out of date is almost always a typo,
      // and accepting it silently would put unsellable units on the books.
      throw AppException.preconditionFailed(
        'That lot is already past its expiry date. Check the date before receiving it.',
      );
    }

    const batchId = await this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.upsert({
        where: {
          variantId_warehouseId: { variantId: input.variantId, warehouseId: input.warehouseId },
        },
        update: {},
        create: {
          variantId: input.variantId,
          warehouseId: input.warehouseId,
          trackInventory: true,
          // Receiving a lot is a statement that this stock is lot-managed, so
          // allocation from it should be first-expiry-first-out from here on.
          lotTracked: true,
        },
      });

      // Lock the stock row before touching quantities, in the same order every
      // other writer takes it, so a concurrent adjustment cannot interleave.
      await this.lockItem(tx, item.id);

      let batch;
      try {
        batch = await tx.inventoryBatch.create({
          data: {
            inventoryItemId: item.id,
            lotCode: input.lotCode,
            status: 'AVAILABLE',
            manufacturedAt: input.manufacturedAt ?? null,
            expiresAt: input.expiresAt ?? null,
            receivedAt: now,
            quantityOnHand: input.quantity,
            supplier: input.supplier ?? null,
            supplierReference: input.supplierReference ?? null,
            notes: input.notes ?? null,
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw AppException.conflict(
            'That lot code has already been received into this warehouse. Record an adjustment against the existing lot instead.',
          );
        }
        throw error;
      }

      const updated = await tx.inventoryItem.update({
        where: { id: item.id },
        data: {
          onHandQuantity: { increment: input.quantity },
          // An item that was not lot-tracked becomes so on its first receipt.
          lotTracked: true,
        },
      });

      await tx.inventoryAdjustment.create({
        data: {
          inventoryItemId: item.id,
          warehouseId: input.warehouseId,
          quantityDelta: input.quantity,
          resultingOnHand: updated.onHandQuantity,
          reason: 'RECEIPT',
          reference: input.lotCode,
          notes: input.supplierReference ?? null,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await tx.batchEvent.create({
        data: {
          batchId: batch.id,
          type: 'RECEIVED',
          toStatus: 'AVAILABLE',
          quantityDelta: input.quantity,
          reason: `Received ${input.quantity} unit(s) of lot ${input.lotCode}.`,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.BATCH_RECEIVED,
        entityType: 'batch',
        entityId: batch.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: {
          lotCode: input.lotCode,
          sku: variant.sku,
          warehouse: warehouse.code,
          quantity: input.quantity,
          expiresAt: input.expiresAt?.toISOString() ?? null,
          supplierAsStated: input.supplier ?? null,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return batch.id;
    });

    return this.findById(batchId);
  }

  /**
   * Changes a lot's disposition.
   *
   * Quarantining does not move any units — the stock stays where it is and
   * stays counted — it makes it unallocatable. That is the honest model: the
   * goods exist, they are just not for sale while a question is open.
   *
   * Units already reserved against an open order are deliberately left alone.
   * Cancelling someone's paid order is a decision for a person with the order
   * in front of them, not a side effect of a warehouse action.
   */
  async setDisposition(batchId: string, input: BatchDispositionInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        status: true,
        lotCode: true,
        quantityOnHand: true,
        quantityReserved: true,
      },
    });
    if (!batch) throw AppException.notFound('Lot');

    const from = batch.status as BatchStatus;
    if (from === input.status) {
      throw AppException.conflict(`That lot is already ${from.toLowerCase()}.`);
    }
    if (!canTransitionBatch(from, input.status)) {
      throw AppException.conflict(
        `A lot cannot move from ${from.toLowerCase()} to ${input.status.toLowerCase()}.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryBatch.update({ where: { id: batchId }, data: { status: input.status } });

      await tx.batchEvent.create({
        data: {
          batchId,
          type: 'DISPOSITION_CHANGED',
          fromStatus: from,
          toStatus: input.status,
          reason: input.reason,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action:
          input.status === 'QUARANTINED'
            ? COMPLIANCE_AUDIT_ACTIONS.BATCH_QUARANTINED
            : input.status === 'AVAILABLE'
              ? COMPLIANCE_AUDIT_ACTIONS.BATCH_RELEASED
              : COMPLIANCE_AUDIT_ACTIONS.BATCH_DISPOSED,
        entityType: 'batch',
        entityId: batchId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        before: { status: from, lotCode: batch.lotCode },
        after: {
          status: input.status,
          quantityOnHand: batch.quantityOnHand,
          // Surfaced because it is the number that decides whether anyone has
          // to be told: units already promised to open orders.
          quantityReservedForOpenOrders: batch.quantityReserved,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.logger.info(
      { batchId, from, to: input.status, actorId: actor.actorId },
      'lot disposition changed',
    );

    return this.findById(batchId);
  }

  /** Turns lot tracking on or off for a stock record. */
  async setLotTracking(input: LotTrackingInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const item = await this.prisma.inventoryItem.findUnique({
      where: {
        variantId_warehouseId: { variantId: input.variantId, warehouseId: input.warehouseId },
      },
      include: { _count: { select: { batches: true } } },
    });
    if (!item) throw AppException.notFound('Inventory record');

    if (!input.lotTracked && item._count.batches > 0) {
      // Turning tracking off while lots exist would make allocation ignore
      // their disposition entirely — quarantined and recalled units would
      // become sellable again through the untracked path.
      throw AppException.conflict(
        'Lot tracking cannot be turned off while lots exist for this stock. Dispose of them first.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { lotTracked: input.lotTracked },
      });
      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.LOT_TRACKING_CHANGED,
        entityType: 'inventory_item',
        entityId: item.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { lotTracked: item.lotTracked },
        after: { lotTracked: input.lotTracked },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return { lotTracked: input.lotTracked };
  }

  /**
   * Marks lots that have passed their expiry date as expired.
   *
   * Run on a schedule. Without it, a lot stays allocatable until someone
   * notices the date — and "someone notices" is not a control. Units already
   * reserved against open orders are left reserved: the goods were allocated
   * while they were in date, and whether a nearly-expired parcel still ships is
   * a decision for a person, not a sweep.
   */
  async expireLapsed(limit = 500): Promise<number> {
    const expired = await expireLapsedLots(
      {
        prisma: this.prisma,
        now: () => this.clock.now(),
        onError: (error, context) =>
          this.logger.warn({ err: error, ...context }, 'failed to expire a lot'),
      },
      limit,
    );

    if (expired > 0) this.logger.warn({ expired }, 'lots withdrawn from sale at expiry');
    return expired;
  }

  // -------------------------------------------------------------------------

  private async lockItem(tx: Tx, inventoryItemId: string): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM inventory_items WHERE id = ${inventoryItemId}::uuid FOR UPDATE`,
    );
  }
}

// ---------------------------------------------------------------------------

interface BatchRow {
  id: string;
  lotCode: string;
  status: string;
  manufacturedAt: Date | null;
  expiresAt: Date | null;
  receivedAt: Date;
  quantityOnHand: number;
  quantityReserved: number;
  supplier: string | null;
  supplierReference: string | null;
  notes: string | null;
  createdAt: Date;
  inventoryItem: {
    id: string;
    lotTracked: boolean;
    warehouse: { id: string; code: string; name: string };
    variant: { id: string; sku: string; name: string; product: { id: string; name: string } };
  };
}

function toBatchView(batch: BatchRow, now: Date) {
  const expired = batch.expiresAt !== null && batch.expiresAt <= now;
  return {
    id: batch.id,
    lotCode: batch.lotCode,
    status: batch.status,
    manufacturedAt: batch.manufacturedAt,
    expiresAt: batch.expiresAt,
    receivedAt: batch.receivedAt,
    quantityOnHand: batch.quantityOnHand,
    quantityReserved: batch.quantityReserved,
    /**
     * What could still be sold from this lot. Zero for anything not
     * `AVAILABLE`, however many units are physically present — which is the
     * distinction the whole model exists to keep.
     */
    quantityAllocatable:
      batch.status === 'AVAILABLE' ? Math.max(0, batch.quantityOnHand - batch.quantityReserved) : 0,
    /** Past its date but not yet swept. Reported so it is visible immediately. */
    pastExpiry: expired,
    supplierAsStated: batch.supplier,
    supplierReference: batch.supplierReference,
    notes: batch.notes,
    createdAt: batch.createdAt,
    inventoryItemId: batch.inventoryItem.id,
    lotTracked: batch.inventoryItem.lotTracked,
    warehouse: batch.inventoryItem.warehouse,
    variant: {
      id: batch.inventoryItem.variant.id,
      sku: batch.inventoryItem.variant.sku,
      name: batch.inventoryItem.variant.name,
      productId: batch.inventoryItem.variant.product.id,
      productName: batch.inventoryItem.variant.product.name,
    },
  };
}
