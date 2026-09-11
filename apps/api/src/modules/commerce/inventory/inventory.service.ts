import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import { Prisma, releaseExpiredReservations } from '@health/database';
import type { AdjustInventoryInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import type { ActorContext } from '../../rbac/roles.service.js';
import { SettingsService } from '../../settings/settings.service.js';

export interface StockRequest {
  variantId: string;
  quantity: number;
}

export interface ReservationOutcome {
  variantId: string;
  requested: number;
  reserved: number;
  /** Null when stock is not tracked for this variant. */
  available: number | null;
  shortfall: number;
}

export class InsufficientStockError extends Error {
  constructor(readonly shortfalls: ReservationOutcome[]) {
    super('There is not enough stock to reserve.');
    this.name = 'InsufficientStockError';
  }
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * Stock, reservations and the ledger behind them.
 *
 * **The hard part is concurrency, and it is solved with row locks.** Two
 * customers buying the last unit at the same moment is not a rare edge case; it
 * is what happens every time something sells out. Every path that changes
 * `reserved_quantity` or `on_hand_quantity` takes `SELECT … FOR UPDATE` on the
 * inventory row first, so the second transaction waits for the first and then
 * sees the truth. Read-then-write without the lock is how two people buy the
 * same unit.
 *
 * The database backs this up: `inventory_on_hand_non_negative` and
 * `inventory_reserved_non_negative` make overselling a failed transaction
 * rather than a customer complaint, even if a future code path forgets to lock.
 *
 * **Reservations expire.** An abandoned checkout must not keep stock out of
 * circulation forever, so a held reservation carries an expiry and a sweep
 * releases it. Committed reservations — ones belonging to a placed order — do
 * not expire, because that stock is genuinely spoken for.
 *
 * **On-hand only changes through the ledger.** Every movement writes an
 * append-only `InventoryAdjustment` carrying the delta, the resulting balance
 * and a reason, because "we are eleven units short" needs an answer.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(InventoryService.name);
  }

  /** How long a cart may hold stock before the sweep releases it. */
  private async holdSeconds(): Promise<number> {
    const minutes = (await this.settings.get<number>('inventory.reservation_minutes')) ?? 30;
    return minutes * 60;
  }

  /**
   * Available stock for a set of variants, for display.
   *
   * Explicitly *not* what reservation decides against — by the time a customer
   * acts on this number it may be stale. It exists to show "only 3 left", not
   * to gate a sale. The gate is `reserve`, under a lock.
   */
  async availability(variantIds: string[]): Promise<Map<string, number | null>> {
    if (variantIds.length === 0) return new Map();

    const rows = await this.prisma.inventoryItem.findMany({
      where: { variantId: { in: variantIds }, warehouse: { isActive: true, deletedAt: null } },
      select: {
        variantId: true,
        onHandQuantity: true,
        reservedQuantity: true,
        trackInventory: true,
        allowBackorder: true,
      },
    });

    const result = new Map<string, number | null>();
    for (const row of rows) {
      // Untracked or back-orderable stock has no ceiling to report.
      if (!row.trackInventory || row.allowBackorder) {
        result.set(row.variantId, null);
        continue;
      }
      const available = Math.max(0, row.onHandQuantity - row.reservedQuantity);
      result.set(row.variantId, (result.get(row.variantId) ?? 0) + available);
    }
    return result;
  }

  /**
   * Reserves stock for a cart, atomically across every line.
   *
   * All or nothing: a partially reserved basket would let a customer pay for
   * things that are not there. When anything is short the whole call throws
   * with the shortfalls, so the storefront can say which line is the problem.
   */
  async reserveForCart(
    cartId: string,
    requests: StockRequest[],
    options: { replaceExisting?: boolean } = {},
  ): Promise<void> {
    if (requests.length === 0) return;

    const expiresAt = addSeconds(this.clock.now(), await this.holdSeconds());

    await this.prisma.$transaction(async (tx) => {
      if (options.replaceExisting !== false) {
        await this.releaseHeldIn(tx, { cartId });
      }

      const shortfalls: ReservationOutcome[] = [];

      // Ordered by variant id so two concurrent baskets containing the same two
      // products always take their locks in the same sequence. Without this,
      // one transaction locking A then B while another locks B then A is a
      // deadlock waiting for traffic.
      const ordered = [...requests].sort((a, b) => a.variantId.localeCompare(b.variantId));

      for (const request of ordered) {
        const outcome = await this.reserveOneIn(tx, request, { cartId, expiresAt });
        if (outcome.shortfall > 0) shortfalls.push(outcome);
      }

      if (shortfalls.length > 0) {
        // Throwing rolls the whole transaction back, including any lines that
        // did reserve. That is the point of all-or-nothing.
        throw new InsufficientStockError(shortfalls);
      }
    });
  }

  /**
   * Moves a cart's holds onto the order that was just placed.
   *
   * The reservation is not re-taken — it is re-pointed. Releasing and
   * re-reserving would open a window in which someone else could take the
   * stock between the two, which is exactly the window the hold existed to
   * close.
   */
  async commitToOrder(tx: Tx, cartId: string, orderId: string): Promise<void> {
    await tx.inventoryReservation.updateMany({
      where: { cartId, status: 'HELD' },
      data: { cartId: null, orderId, status: 'COMMITTED', expiresAt: null },
    });
  }

  /** Releases everything a cart or order is holding. */
  async release(owner: { cartId?: string; orderId?: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.releaseHeldIn(tx, owner);
    });
  }

  async releaseHeldIn(tx: Tx, owner: { cartId?: string; orderId?: string }): Promise<void> {
    const where = owner.cartId ? { cartId: owner.cartId } : { orderId: owner.orderId };
    const open = await tx.inventoryReservation.findMany({
      where: { ...where, status: { in: ['HELD', 'COMMITTED'] } },
      select: { id: true, inventoryItemId: true, quantity: true },
    });
    if (open.length === 0) return;

    for (const reservation of open) {
      await this.lockInventoryRow(tx, reservation.inventoryItemId);
      await tx.inventoryItem.update({
        where: { id: reservation.inventoryItemId },
        data: { reservedQuantity: { decrement: reservation.quantity } },
      });
    }

    await tx.inventoryReservation.updateMany({
      where: { id: { in: open.map((entry) => entry.id) } },
      data: { status: 'RELEASED', releasedAt: this.clock.now() },
    });
  }

  /**
   * Consumes reserved stock when goods actually leave the building.
   *
   * This is the only place on-hand drops for a sale: reserving does not remove
   * stock, it spoken-for-s it. Until the parcel ships, the units are still on
   * the shelf and still countable.
   */
  async consumeForFulfilment(
    tx: Tx,
    orderId: string,
    lines: Array<{ variantId: string; quantity: number }>,
    actor: ActorContext,
  ): Promise<void> {
    for (const line of [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
      const reservations = await tx.inventoryReservation.findMany({
        where: { orderId, status: 'COMMITTED', inventoryItem: { variantId: line.variantId } },
        select: { id: true, inventoryItemId: true, quantity: true },
        orderBy: { createdAt: 'asc' },
      });

      let remaining = line.quantity;
      for (const reservation of reservations) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, reservation.quantity);

        const item = await this.lockInventoryRow(tx, reservation.inventoryItemId);
        await tx.inventoryItem.update({
          where: { id: reservation.inventoryItemId },
          data: {
            onHandQuantity: { decrement: take },
            reservedQuantity: { decrement: take },
          },
        });

        await tx.inventoryAdjustment.create({
          data: {
            inventoryItemId: reservation.inventoryItemId,
            warehouseId: item.warehouseId,
            quantityDelta: -take,
            resultingOnHand: item.onHandQuantity - take,
            reason: 'FULFILMENT',
            reference: orderId,
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
          },
        });

        if (take === reservation.quantity) {
          await tx.inventoryReservation.update({
            where: { id: reservation.id },
            data: { status: 'CONSUMED' },
          });
        } else {
          await tx.inventoryReservation.update({
            where: { id: reservation.id },
            data: { quantity: reservation.quantity - take },
          });
        }

        remaining -= take;
      }

      if (remaining > 0) {
        // The reservation should have covered this. Reaching here means stock
        // was committed without a matching hold, which is a bug worth failing
        // loudly rather than quietly shipping unreserved goods.
        throw AppException.conflict(
          `Order ${orderId} is short ${remaining} reserved unit(s) of ${line.variantId}.`,
        );
      }
    }
  }

  /**
   * Returns units to sellable stock, for a restocked refund or a return.
   *
   * Goes through the ledger like every other movement, with its own reason, so
   * a stock count that does not match can be traced to the refund that caused
   * it.
   */
  async restock(
    tx: Tx,
    lines: Array<{ variantId: string; quantity: number }>,
    reason: 'RETURN' | 'CORRECTION',
    reference: string,
    actor: ActorContext,
  ): Promise<void> {
    for (const line of [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId))) {
      const item = await tx.inventoryItem.findFirst({
        where: { variantId: line.variantId, warehouse: { isActive: true, deletedAt: null } },
        orderBy: { warehouse: { priority: 'asc' } },
        select: { id: true },
      });
      // No stock record is not an error here: the product may never have been
      // tracked. Silently doing nothing is correct, and the refund still stands.
      if (!item) continue;

      const locked = await this.lockInventoryRow(tx, item.id);
      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { onHandQuantity: { increment: line.quantity } },
      });

      await tx.inventoryAdjustment.create({
        data: {
          inventoryItemId: item.id,
          warehouseId: locked.warehouseId,
          quantityDelta: line.quantity,
          resultingOnHand: locked.onHandQuantity + line.quantity,
          reason,
          reference,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });
    }
  }

  /**
   * Records a manual stock adjustment.
   *
   * The reason is required and the ledger entry is append-only, because a stock
   * correction with no explanation is indistinguishable from shrinkage.
   */
  async adjust(input: AdjustInventoryInput, actor: ActorContext): Promise<{ onHand: number }> {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({
        where: {
          variantId_warehouseId: {
            variantId: input.variantId,
            warehouseId: input.warehouseId,
          },
        },
        select: { id: true },
      });
      if (!item) throw AppException.notFound('Inventory record');

      const locked = await this.lockInventoryRow(tx, item.id);
      const resulting = locked.onHandQuantity + input.quantityDelta;

      if (resulting < 0) {
        throw AppException.conflict(
          `That would leave ${resulting} units on hand. Stock cannot go negative.`,
        );
      }
      if (resulting < locked.reservedQuantity) {
        // Removing stock that customers have already been promised is a
        // decision someone has to make deliberately, by releasing the orders
        // first — not a side effect of a cycle count.
        throw AppException.conflict(
          `${locked.reservedQuantity} unit(s) are reserved for open orders. Adjusting to ${resulting} would leave those orders unfulfillable.`,
        );
      }

      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { onHandQuantity: resulting },
      });

      await tx.inventoryAdjustment.create({
        data: {
          inventoryItemId: item.id,
          warehouseId: input.warehouseId,
          quantityDelta: input.quantityDelta,
          resultingOnHand: resulting,
          reason: input.reason,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.INVENTORY_ADJUSTED,
        entityType: 'inventory_item',
        entityId: item.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes ?? input.reason,
        before: { onHand: locked.onHandQuantity },
        after: { onHand: resulting, delta: input.quantityDelta, reason: input.reason },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return { onHand: resulting };
    });
  }

  /**
   * Releases reservations whose hold has expired.
   *
   * Run on a schedule. Only `HELD` rows are eligible — a committed reservation
   * belongs to a placed order and its stock is genuinely spoken for.
   */
  async releaseExpired(limit = 500): Promise<number> {
    const released = await releaseExpiredReservations(
      {
        prisma: this.prisma,
        now: () => this.clock.now(),
        onError: (error, context) =>
          this.logger.warn({ err: error, ...context }, 'failed to release an expired reservation'),
      },
      limit,
    );

    if (released > 0) {
      this.logger.info({ released }, 'released expired stock reservations');
    }
    return released;
  }

  // -------------------------------------------------------------------------

  private async reserveOneIn(
    tx: Tx,
    request: StockRequest,
    owner: { cartId: string; expiresAt: Date },
  ): Promise<ReservationOutcome> {
    const items = await tx.inventoryItem.findMany({
      where: { variantId: request.variantId, warehouse: { isActive: true, deletedAt: null } },
      orderBy: { warehouse: { priority: 'asc' } },
      select: { id: true },
    });

    if (items.length === 0) {
      // Nothing tracks this variant. Treated as unlimited, which is how an
      // untracked product behaves everywhere else.
      return {
        variantId: request.variantId,
        requested: request.quantity,
        reserved: request.quantity,
        available: null,
        shortfall: 0,
      };
    }

    let remaining = request.quantity;
    let availableSeen = 0;

    for (const item of items) {
      if (remaining <= 0) break;

      const locked = await this.lockInventoryRow(tx, item.id);

      if (!locked.trackInventory || locked.allowBackorder) {
        await tx.inventoryItem.update({
          where: { id: item.id },
          data: { reservedQuantity: { increment: remaining } },
        });
        await tx.inventoryReservation.create({
          data: {
            inventoryItemId: item.id,
            quantity: remaining,
            status: 'HELD',
            cartId: owner.cartId,
            expiresAt: owner.expiresAt,
          },
        });
        return {
          variantId: request.variantId,
          requested: request.quantity,
          reserved: request.quantity,
          available: null,
          shortfall: 0,
        };
      }

      const available = Math.max(0, locked.onHandQuantity - locked.reservedQuantity);
      availableSeen += available;
      const take = Math.min(remaining, available);
      if (take === 0) continue;

      await tx.inventoryItem.update({
        where: { id: item.id },
        data: { reservedQuantity: { increment: take } },
      });
      await tx.inventoryReservation.create({
        data: {
          inventoryItemId: item.id,
          quantity: take,
          status: 'HELD',
          cartId: owner.cartId,
          expiresAt: owner.expiresAt,
        },
      });

      remaining -= take;
    }

    return {
      variantId: request.variantId,
      requested: request.quantity,
      reserved: request.quantity - remaining,
      available: availableSeen,
      shortfall: remaining,
    };
  }

  /**
   * Takes a row-level lock on an inventory row and returns its current values.
   *
   * `FOR UPDATE` is the whole mechanism: the second transaction to ask for the
   * same row blocks until the first commits, and then reads what the first
   * actually left behind. Reading through Prisma's normal client instead would
   * return a snapshot that is already out of date by the time it is used.
   */
  private async lockInventoryRow(
    tx: Tx,
    inventoryItemId: string,
  ): Promise<{
    id: string;
    warehouseId: string;
    onHandQuantity: number;
    reservedQuantity: number;
    trackInventory: boolean;
    allowBackorder: boolean;
  }> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        warehouse_id: string;
        on_hand_quantity: number;
        reserved_quantity: number;
        track_inventory: boolean;
        allow_backorder: boolean;
      }>
    >(Prisma.sql`
      SELECT id, warehouse_id, on_hand_quantity, reserved_quantity, track_inventory, allow_backorder
        FROM inventory_items
       WHERE id = ${inventoryItemId}::uuid
         FOR UPDATE
    `);

    const row = rows[0];
    if (!row) throw AppException.notFound('Inventory record');

    return {
      id: row.id,
      warehouseId: row.warehouse_id,
      onHandQuantity: row.on_hand_quantity,
      reservedQuantity: row.reserved_quantity,
      trackInventory: row.track_inventory,
      allowBackorder: row.allow_backorder,
    };
  }
}
