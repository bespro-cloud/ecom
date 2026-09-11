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

    // Top up to the seed level through the ledger, so the stock has the same
    // provenance any other stock would. Re-running the seed adds nothing once
    // the level is already there, and never removes units an operator added.
    const delta = SEED_ON_HAND - item.onHandQuantity;
    if (delta <= 0) continue;

    await prisma.$transaction(async (tx) => {
      const updated = await tx.inventoryItem.update({
        where: { id: item.id },
        data: { onHandQuantity: { increment: delta } },
      });

      await tx.inventoryAdjustment.create({
        data: {
          inventoryItemId: item.id,
          warehouseId: warehouse.id,
          quantityDelta: delta,
          resultingOnHand: updated.onHandQuantity,
          reason: 'RECEIPT',
          reference: 'DEV-SEED',
          notes: `${SEED_MARKER} Opening stock for local development.`,
          actorLabel: `${SEED_MARKER} seed`,
        },
      });
    });
  }
}
