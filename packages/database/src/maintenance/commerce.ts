import { Prisma, type PrismaClient } from '../../generated/client/index.js';

/**
 * Commerce housekeeping.
 *
 * These two sweeps undo holds that were never converted: a checkout the
 * customer walked away from, and the stock it was holding. Without them,
 * abandoned baskets slowly consume the warehouse — availability falls while the
 * shelves stay full, and the shop stops selling things it has.
 *
 * They live here, rather than in either app, because both need them. The API
 * exposes them so an operator can run a sweep on demand and so they are
 * testable against a real database; the worker runs them on a schedule. One
 * implementation means the scheduled sweep cannot quietly drift from the tested
 * one.
 *
 * Both are safe to run concurrently on several instances. Each unit of work
 * takes a row lock, re-reads the state it is about to act on inside the
 * transaction, and does nothing if another instance got there first. A
 * duplicate run is a no-op, never a double release.
 */

type Tx = Prisma.TransactionClient;

export interface MaintenanceDeps {
  prisma: PrismaClient;
  now: () => Date;
  /** Called per failure. A failure in one unit must not stop the sweep. */
  onError?: (error: unknown, context: Record<string, string>) => void;
}

/**
 * Locks an inventory row for update.
 *
 * Raw SQL because Prisma has no `FOR UPDATE`. Serialising writers on the row is
 * the whole mechanism preventing two transactions from reading the same
 * reserved quantity and both decrementing it.
 */
async function lockInventoryRow(tx: Tx, inventoryItemId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM inventory_items WHERE id = ${inventoryItemId}::uuid FOR UPDATE`,
  );
}

/**
 * Releases stock held by reservations whose hold has run out.
 *
 * Returns how many were released. Bounded by `limit` so one sweep cannot hold a
 * connection for an unbounded time; the next run picks up the rest.
 */
export async function releaseExpiredReservations(
  deps: MaintenanceDeps,
  limit = 500,
): Promise<number> {
  const { prisma, now, onError } = deps;
  const at = now();

  const expired = await prisma.inventoryReservation.findMany({
    where: { status: 'HELD', expiresAt: { lte: at } },
    select: { id: true, inventoryItemId: true, quantity: true },
    take: limit,
  });
  if (expired.length === 0) return 0;

  let released = 0;
  for (const reservation of expired) {
    // One transaction each: a single failure must not strand the rest of the
    // sweep, and each release is independent of the others.
    try {
      await prisma.$transaction(async (tx) => {
        // Lock the stock row first, then re-read the reservation. Taking the
        // lock before the check is what makes the check meaningful: another
        // instance committing this reservation cannot slip in between.
        await lockInventoryRow(tx, reservation.inventoryItemId);

        const current = await tx.inventoryReservation.findUnique({
          where: { id: reservation.id },
          select: { status: true },
        });
        // It may have been committed to an order since the query above.
        if (current?.status !== 'HELD') return;

        await tx.inventoryItem.update({
          where: { id: reservation.inventoryItemId },
          data: { reservedQuantity: { decrement: reservation.quantity } },
        });
        await tx.inventoryReservation.update({
          where: { id: reservation.id },
          data: { status: 'EXPIRED', releasedAt: at },
        });
        released += 1;
      });
    } catch (error) {
      onError?.(error, { reservationId: reservation.id });
    }
  }

  return released;
}

/**
 * Expires checkouts that were started and abandoned, releasing their stock.
 *
 * A checkout that produced an order is never expired, however stale it looks:
 * the order is the fact, and marking its checkout expired would release stock
 * that someone has already paid for.
 */
export async function expireStaleCheckouts(deps: MaintenanceDeps, limit = 200): Promise<number> {
  const { prisma, now, onError } = deps;
  const at = now();

  const stale = await prisma.checkout.findMany({
    where: { status: { in: ['OPEN', 'AWAITING_PAYMENT'] }, expiresAt: { lte: at } },
    select: { id: true, cartId: true },
    take: limit,
  });

  let expired = 0;
  for (const checkout of stale) {
    try {
      const released = await prisma.$transaction(async (tx) => {
        // An order may have been placed since the query above. Re-read inside
        // the transaction, and never expire a checkout that produced one.
        const order = await tx.order.findFirst({
          where: { checkoutId: checkout.id },
          select: { id: true },
        });
        if (order) return false;

        const updated = await tx.checkout.updateMany({
          where: { id: checkout.id, status: { in: ['OPEN', 'AWAITING_PAYMENT'] } },
          data: { status: 'EXPIRED' },
        });
        // Another instance expired it first; it also released the stock.
        if (updated.count === 0) return false;

        const held = await tx.inventoryReservation.findMany({
          where: { cartId: checkout.cartId, status: 'HELD' },
          select: { id: true, inventoryItemId: true, quantity: true },
        });

        // Sorted, so concurrent releases of overlapping baskets always take
        // their locks in the same order and cannot deadlock against each other.
        for (const reservation of [...held].sort((a, b) =>
          a.inventoryItemId.localeCompare(b.inventoryItemId),
        )) {
          await lockInventoryRow(tx, reservation.inventoryItemId);
          await tx.inventoryItem.update({
            where: { id: reservation.inventoryItemId },
            data: { reservedQuantity: { decrement: reservation.quantity } },
          });
          await tx.inventoryReservation.update({
            where: { id: reservation.id },
            data: { status: 'RELEASED', releasedAt: at },
          });
        }

        return true;
      });

      if (released) expired += 1;
    } catch (error) {
      onError?.(error, { checkoutId: checkout.id });
    }
  }

  return expired;
}
