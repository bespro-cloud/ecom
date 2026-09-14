import type { PrismaClient } from '../client.js';
import { SEED_MARKER } from './catalogue.js';

/**
 * Development commerce fixtures: a warehouse, stock for every seeded variant,
 * and shipping rates.
 *
 * Without these, nothing in the catalogue can be bought — a variant with no
 * stock record in an active warehouse cannot be allocated, and a checkout with
 * no shipping rate covering the destination cannot be completed. Seeding them
 * is what makes a fresh development database exercise the real purchase path
 * rather than fail at the first honest guard.
 *
 * Three things it deliberately does not do:
 *
 *  - **It creates no orders, payments or refunds.** Those are financial
 *    records. Inventing them would put fabricated money in the books and in
 *    every report reading from them, and there is no version of that which is
 *    useful.
 *  - **It creates no claims, evidence or documents.** Those are regulatory
 *    records. A seeded health claim would be a claim nobody reviewed, seeded
 *    evidence would be a study nobody read, and a seeded certificate would
 *    assert a certification that does not exist. Stock and lots are operational
 *    facts and are safe to fabricate for a development database; substantiation
 *    is not.
 *  - **It sets stock through the adjustment ledger**, with a stated reason,
 *    exactly as a warehouse operator would. Writing `onHandQuantity` directly
 *    would produce stock with no provenance — the one thing the ledger exists
 *    to prevent.
 *  - **It does not publish anything.** Stock satisfies one publishing check;
 *    the rest of the gate, including compliance review, still applies.
 *
 * Shipping prices here are placeholders for development. Real rates are a
 * commercial decision and are configured through the admin console.
 */

const WAREHOUSE = {
  code: 'DEV-SLC',
  name: `${SEED_MARKER} Salt Lake City`,
  line1: '1 Depot Road',
  city: 'Salt Lake City',
  region: 'UT',
  postalCode: '84101',
  country: 'US',
  priority: 0,
} as const;

const SHIPPING_RATES = [
  {
    code: 'dev-standard',
    name: 'Standard delivery',
    description: 'Development rate. Not a real carrier quote.',
    priceCents: 599,
    freeAboveSubtotalCents: 7500,
    estimatedDaysMin: 3,
    estimatedDaysMax: 5,
    position: 0,
  },
  {
    code: 'dev-express',
    name: 'Express delivery',
    description: 'Development rate. Not a real carrier quote.',
    priceCents: 1499,
    freeAboveSubtotalCents: null,
    estimatedDaysMin: 1,
    estimatedDaysMax: 2,
    position: 1,
  },
] as const;

/** Units placed in the seeded warehouse, so the purchase path can be walked. */
const SEED_ON_HAND = 100;

export async function seedCommerce(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed commerce fixtures: NODE_ENV is production.');
  }

  const warehouse = await prisma.warehouse.upsert({
    where: { code: WAREHOUSE.code },
    update: { name: WAREHOUSE.name, isActive: true, deletedAt: null },
    create: { ...WAREHOUSE, isActive: true },
  });

  for (const rate of SHIPPING_RATES) {
    await prisma.shippingRate.upsert({
      where: { code: rate.code },
      update: {
        name: rate.name,
        description: rate.description,
        priceCents: rate.priceCents,
        freeAboveSubtotalCents: rate.freeAboveSubtotalCents,
        estimatedDaysMin: rate.estimatedDaysMin,
        estimatedDaysMax: rate.estimatedDaysMax,
        position: rate.position,
        isActive: true,
      },
      create: {
        code: rate.code,
        name: rate.name,
        description: rate.description,
        countries: ['US'],
        regions: [],
        priceCents: rate.priceCents,
        freeAboveSubtotalCents: rate.freeAboveSubtotalCents,
        estimatedDaysMin: rate.estimatedDaysMin,
        estimatedDaysMax: rate.estimatedDaysMax,
        position: rate.position,
        isActive: true,
      },
    });
  }

  const variants = await prisma.productVariant.findMany({
    where: { isActive: true, deletedAt: null, product: { deletedAt: null } },
    select: { id: true },
  });

  for (const variant of variants) {
    const item = await prisma.inventoryItem.upsert({
      where: { variantId_warehouseId: { variantId: variant.id, warehouseId: warehouse.id } },
      update: {},
      create: {
        variantId: variant.id,
        warehouseId: warehouse.id,
        trackInventory: true,
        allowBackorder: false,
        reorderPoint: 10,
      },
    });

    // Stock arrives as lots, through the ledger, so it has the same provenance
    // any real receipt would. Re-running the seed adds nothing once the lots
    // exist, and never removes units an operator added.
    // Lot tracking first, and independent of the quantity top-up. A re-run
    // whose stock is already at the seed level still needs its lots, and
    // nesting the two meant the second run silently produced none.
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { lotTracked: true } });

    // Two lots with different dates, because one lot cannot demonstrate
    // first-expiry-first-out doing anything.
    const lots = [
      { code: 'DEV-LOT-A', quantity: Math.ceil(SEED_ON_HAND / 2), months: 6 },
      { code: 'DEV-LOT-B', quantity: Math.floor(SEED_ON_HAND / 2), months: 18 },
    ];

    for (const lot of lots) {
      const existing = await prisma.inventoryBatch.findUnique({
        where: { inventoryItemId_lotCode: { inventoryItemId: item.id, lotCode: lot.code } },
        select: { id: true },
      });
      if (existing) continue;

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + lot.months);

      await prisma.$transaction(async (tx) => {
        const batch = await tx.inventoryBatch.create({
          data: {
            inventoryItemId: item.id,
            lotCode: lot.code,
            status: 'AVAILABLE',
            quantityOnHand: lot.quantity,
            expiresAt,
            supplier: `${SEED_MARKER} Development supplier`,
            notes: `${SEED_MARKER} Opening lot for local development.`,
          },
        });

        await tx.batchEvent.create({
          data: {
            batchId: batch.id,
            type: 'RECEIVED',
            toStatus: 'AVAILABLE',
            quantityDelta: lot.quantity,
            reason: `${SEED_MARKER} Opening lot for local development.`,
            actorLabel: `${SEED_MARKER} seed`,
          },
        });

        const updated = await tx.inventoryItem.update({
          where: { id: item.id },
          data: { onHandQuantity: { increment: lot.quantity } },
        });

        // Through the ledger, like every other movement, so the stock has the
        // same provenance any real receipt would.
        await tx.inventoryAdjustment.create({
          data: {
            inventoryItemId: item.id,
            warehouseId: warehouse.id,
            quantityDelta: lot.quantity,
            resultingOnHand: updated.onHandQuantity,
            reason: 'RECEIPT',
            reference: lot.code,
            notes: `${SEED_MARKER} Opening stock for local development.`,
            actorLabel: `${SEED_MARKER} seed`,
          },
        });
      });
    }
  }
}
