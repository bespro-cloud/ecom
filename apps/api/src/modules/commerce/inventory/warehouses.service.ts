import { Injectable } from '@nestjs/common';
import { isUniqueConstraintError } from '@health/database';
import type {
  CreateWarehouseInput,
  InventoryQuery,
  UpdateWarehouseInput,
  UpsertInventoryInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import type { ActorContext } from '../../rbac/roles.service.js';

/**
 * Warehouses and the stock records attached to them.
 *
 * Separate from `InventoryService` on purpose: this is configuration — where
 * stock lives and which variants are tracked — while that is the concurrency-
 * critical path that moves quantities around. Mixing them would put
 * administrative CRUD in the same file as the row-locking code, and the locking
 * code should be short enough to read in one sitting.
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive = false) {
    return this.prisma.warehouse.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });
  }

  async create(input: CreateWarehouseInput, actor: ActorContext) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.warehouse.create({ data: input });

        await this.audit.recordIn(tx, {
          action: COMMERCE_AUDIT_ACTIONS.WAREHOUSE_CREATED,
          entityType: 'warehouse',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { code: created.code, name: created.name },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error, 'code')) {
        throw AppException.conflict(`A warehouse with the code "${input.code}" already exists.`);
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateWarehouseInput, actor: ActorContext) {
    const existing = await this.prisma.warehouse.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Warehouse');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.warehouse.update({ where: { id }, data: input });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.WAREHOUSE_UPDATED,
        entityType: 'warehouse',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { isActive: existing.isActive, priority: existing.priority },
        after: { isActive: updated.isActive, priority: updated.priority },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return updated;
    });
  }

  /**
   * Creates or updates the stock record for a variant in a warehouse.
   *
   * Quantities are deliberately absent: stock only ever moves through an
   * adjustment, which carries a reason and lands in the append-only ledger.
   * Letting a configuration screen set a quantity directly would be a way to
   * change stock with no record of why.
   */
  async configure(input: UpsertInventoryInput, actor: ActorContext) {
    const [variant, warehouse] = await Promise.all([
      this.prisma.productVariant.findFirst({
        where: { id: input.variantId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: input.warehouseId, deletedAt: null },
        select: { id: true },
      }),
    ]);

    if (!variant) throw AppException.notFound('Product variant');
    if (!warehouse) throw AppException.notFound('Warehouse');

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.upsert({
        where: {
          variantId_warehouseId: {
            variantId: input.variantId,
            warehouseId: input.warehouseId,
          },
        },
        update: {
          ...(input.reorderPoint !== undefined ? { reorderPoint: input.reorderPoint } : {}),
          ...(input.trackInventory !== undefined ? { trackInventory: input.trackInventory } : {}),
          ...(input.allowBackorder !== undefined ? { allowBackorder: input.allowBackorder } : {}),
        },
        create: {
          variantId: input.variantId,
          warehouseId: input.warehouseId,
          reorderPoint: input.reorderPoint ?? 0,
          trackInventory: input.trackInventory ?? true,
          allowBackorder: input.allowBackorder ?? false,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.INVENTORY_CONFIGURED,
        entityType: 'inventory_item',
        entityId: item.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: {
          variantId: item.variantId,
          warehouseId: item.warehouseId,
          trackInventory: item.trackInventory,
          allowBackorder: item.allowBackorder,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return item;
    });
  }

  async listStock(query: InventoryQuery) {
    const rows = await this.prisma.inventoryItem.findMany({
      where: {
        ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
        ...(query.search
          ? {
              variant: {
                OR: [
                  { sku: { contains: query.search, mode: 'insensitive' as const } },
                  { name: { contains: query.search, mode: 'insensitive' as const } },
                  { product: { name: { contains: query.search, mode: 'insensitive' as const } } },
                ],
              },
            }
          : {}),
      },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        variant: {
          select: {
            id: true,
            sku: true,
            name: true,
            product: { select: { id: true, name: true, status: true } },
          },
        },
      },
      orderBy: [{ variant: { sku: 'asc' } }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const filtered = query.lowStockOnly
      ? page.filter((row) => row.onHandQuantity - row.reservedQuantity <= row.reorderPoint)
      : page;

    return {
      data: filtered.map((row) => ({
        id: row.id,
        variantId: row.variantId,
        sku: row.variant.sku,
        variantName: row.variant.name,
        productName: row.variant.product.name,
        productStatus: row.variant.product.status,
        warehouse: row.warehouse,
        onHandQuantity: row.onHandQuantity,
        reservedQuantity: row.reservedQuantity,
        availableQuantity: Math.max(0, row.onHandQuantity - row.reservedQuantity),
        reorderPoint: row.reorderPoint,
        trackInventory: row.trackInventory,
        allowBackorder: row.allowBackorder,
        isLow: row.onHandQuantity - row.reservedQuantity <= row.reorderPoint,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  /** The adjustment ledger for one stock record. */
  async listAdjustments(inventoryItemId: string, limit = 100) {
    return this.prisma.inventoryAdjustment.findMany({
      where: { inventoryItemId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Whether a product can actually be allocated, for the publishing checklist.
   *
   * Every sellable variant needs a stock record in an active warehouse. A
   * published product that cannot be allocated is an order the warehouse cannot
   * fill.
   */
  async isConfiguredForSale(
    productId: string,
  ): Promise<{ ok: boolean; missing: string[]; variantCount: number }> {
    const variants = await this.prisma.productVariant.findMany({
      where: { productId, deletedAt: null, isActive: true },
      select: {
        sku: true,
        inventory: {
          where: { warehouse: { isActive: true, deletedAt: null } },
          select: { id: true },
        },
      },
    });

    const missing = variants.filter((v) => v.inventory.length === 0).map((v) => v.sku);
    return {
      ok: variants.length > 0 && missing.length === 0,
      missing,
      variantCount: variants.length,
    };
  }
}
