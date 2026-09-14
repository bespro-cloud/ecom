import type { MaintenanceDeps } from './commerce.js';

/**
 * Compliance housekeeping.
 *
 * Shared with the API for the same reason the commerce sweeps are: the
 * scheduled code should be the code the integration tests cover, not a second
 * copy of it that is free to drift.
 *
 * Both sweeps only ever withdraw permission — to display a claim, or to sell a
 * lot. Neither can grant anything, which is why running them twice, or on
 * several workers at once, is safe: each unit re-reads its row inside the
 * transaction and does nothing if another run got there first.
 */

/**
 * Expires claim approvals whose review interval has elapsed.
 *
 * The claim stops being publishable immediately and disappears from the live
 * listing; the product stays up. Pulling a whole page down over one lapsed
 * sentence is a far bigger customer impact than the lapse represents, and the
 * publishing gate separately refuses to re-publish a listing carrying one.
 */
export async function expireLapsedClaims(deps: MaintenanceDeps, limit = 500): Promise<number> {
  const { prisma, now, onError } = deps;
  const at = now();

  const lapsed = await prisma.productClaim.findMany({
    where: { status: 'APPROVED', reviewDueAt: { lte: at } },
    select: { id: true, productId: true, reviewDueAt: true },
    take: limit,
  });
  if (lapsed.length === 0) return 0;

  let expired = 0;
  for (const claim of lapsed) {
    try {
      await prisma.$transaction(async (tx) => {
        // A reviewer may have re-approved it between the query and now.
        const current = await tx.productClaim.findUnique({
          where: { id: claim.id },
          select: { status: true, reviewDueAt: true },
        });
        if (current?.status !== 'APPROVED') return;
        if (current.reviewDueAt && current.reviewDueAt > at) return;

        await tx.productClaim.update({ where: { id: claim.id }, data: { status: 'EXPIRED' } });

        await tx.auditLog.create({
          data: {
            action: 'claim.expired',
            actorType: 'SYSTEM',
            actorLabel: 'system',
            entityType: 'claim',
            entityId: claim.id,
            outcome: 'SUCCESS',
            reason: 'The claim review interval elapsed.',
            afterState: {
              productId: claim.productId,
              reviewDueAt: claim.reviewDueAt?.toISOString() ?? null,
            },
          },
        });

        expired += 1;
      });
    } catch (error) {
      onError?.(error, { claimId: claim.id });
    }
  }

  return expired;
}

/**
 * Withdraws lots that have passed their stated expiry date from sale.
 *
 * Units already reserved against open orders are left reserved. The goods were
 * allocated while they were in date, and whether a parcel close to its date
 * still ships is a judgement for a person with the order in front of them — not
 * something a sweep should decide at three in the morning.
 */
export async function expireLapsedLots(deps: MaintenanceDeps, limit = 500): Promise<number> {
  const { prisma, now, onError } = deps;
  const at = now();

  const lapsed = await prisma.inventoryBatch.findMany({
    where: { status: 'AVAILABLE', expiresAt: { lte: at } },
    select: { id: true, lotCode: true, quantityOnHand: true },
    take: limit,
  });
  if (lapsed.length === 0) return 0;

  let expired = 0;
  for (const batch of lapsed) {
    try {
      await prisma.$transaction(async (tx) => {
        const current = await tx.inventoryBatch.findUnique({
          where: { id: batch.id },
          select: { status: true, expiresAt: true },
        });
        if (current?.status !== 'AVAILABLE') return;
        if (!current.expiresAt || current.expiresAt > at) return;

        await tx.inventoryBatch.update({ where: { id: batch.id }, data: { status: 'EXPIRED' } });

        await tx.batchEvent.create({
          data: {
            batchId: batch.id,
            type: 'EXPIRED',
            fromStatus: 'AVAILABLE',
            toStatus: 'EXPIRED',
            reason: `The stated expiry date (${current.expiresAt.toISOString().slice(0, 10)}) has passed.`,
            isSystem: true,
            actorLabel: 'system',
          },
        });

        await tx.auditLog.create({
          data: {
            action: 'batch.expired',
            actorType: 'SYSTEM',
            actorLabel: 'system',
            entityType: 'batch',
            entityId: batch.id,
            outcome: 'SUCCESS',
            reason: 'The stated expiry date has passed.',
            afterState: { lotCode: batch.lotCode, quantityOnHand: batch.quantityOnHand },
          },
        });

        expired += 1;
      });
    } catch (error) {
      onError?.(error, { batchId: batch.id });
    }
  }

  return expired;
}
