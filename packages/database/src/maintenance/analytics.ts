import { rawEventCutoff, utcDayKey, RAW_EVENT_RETENTION_DAYS } from '@health/types';
import type { PrismaClient } from '../../generated/client/index.js';

/**
 * Analytics rollups and retention.
 *
 * Shared between the API and the worker for the same reason the commerce,
 * compliance and subscription sweeps are: the scheduled code should be the code
 * the integration tests cover.
 *
 * Two things about the design are worth stating up front, because they are what
 * make the numbers trustworthy and the data defensible.
 *
 * **Rollups are recomputed, never incremented.** Each run rebuilds a day from
 * the raw events and the orders tables and overwrites the row. A counter that
 * is incremented as events arrive drifts the first time a job is retried or a
 * transaction rolls back, and nobody notices because the number still looks
 * plausible. Recomputation means a failed run is fixed by running it again.
 *
 * **Money never comes from analytics.** Revenue and units are read from
 * `orders` and `order_items`, which is the only place that knows what was
 * actually charged. The analytics side contributes sessions and views; the
 * orders side contributes money; they are joined on a day and a channel label,
 * never on anything that names a person.
 */

export interface RollupDeps {
  prisma: PrismaClient;
  now: () => Date;
  onError?: (error: unknown, context: Record<string, string>) => void;
}

export interface RollupResult {
  day: string;
  sessions: number;
  orders: number;
  revenueCents: number;
  products: number;
  channels: number;
}

/**
 * Rebuilds every rollup for one UTC day.
 *
 * Safe to run repeatedly and safe to run for a day already computed. The three
 * tables are written in one transaction so a dashboard never reads a day whose
 * site totals have been updated but whose per-product rows have not.
 */
export async function rollUpDay(deps: RollupDeps, day: string): Promise<RollupResult> {
  const { prisma } = deps;

  const [site, products, channels] = await Promise.all([
    siteTotals(prisma, day),
    productTotals(prisma, day),
    channelTotals(prisma, day),
  ]);

  await prisma.$transaction(async (tx) => {
    await tx.analyticsDailyMetric.upsert({
      where: { day },
      create: { day, ...site, computedAt: deps.now() },
      update: { ...site, computedAt: deps.now() },
    });

    // Deleted and rewritten rather than upserted row by row: a product that
    // stopped being viewed must lose its row, and an upsert would leave
    // yesterday's count sitting there looking like today's.
    await tx.analyticsProductDaily.deleteMany({ where: { day } });
    if (products.length > 0) {
      await tx.analyticsProductDaily.createMany({
        data: products.map((row) => ({ ...row, day, computedAt: deps.now() })),
      });
    }

    await tx.analyticsChannelDaily.deleteMany({ where: { day } });
    if (channels.length > 0) {
      await tx.analyticsChannelDaily.createMany({
        data: channels.map((row) => ({ ...row, day, computedAt: deps.now() })),
      });
    }
  });

  return {
    day,
    sessions: site.sessions,
    orders: channels.reduce((sum, row) => sum + row.orders, 0),
    revenueCents: channels.reduce((sum, row) => sum + row.revenueCents, 0),
    products: products.length,
    channels: channels.length,
  };
}

/**
 * Rolls up yesterday and today.
 *
 * Yesterday because it is now complete; today because a dashboard read at noon
 * should not show an empty morning. Today's row is rewritten on the next run,
 * which is exactly why recomputation rather than incrementing matters.
 */
export async function rollUpRecentDays(deps: RollupDeps): Promise<RollupResult[]> {
  const now = deps.now();
  const today = utcDayKey(now);
  const yesterday = utcDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  const results: RollupResult[] = [];
  for (const day of [yesterday, today]) {
    try {
      results.push(await rollUpDay(deps, day));
    } catch (error) {
      // One bad day must not stop the other. A rollup is derived data: the next
      // run rebuilds it.
      deps.onError?.(error, { day });
    }
  }
  return results;
}

/**
 * Deletes raw events and sessions past their retention window, and the daily
 * salts that went with them.
 *
 * The salts are the important part. Once a day's salt is gone, that day's
 * visitor hashes cannot be recomputed from an IP address by anyone — including
 * someone holding this database. Deleting the events without the salt would
 * leave the weaker property behind.
 *
 * The rollups are untouched and have no expiry. "4,102 people viewed this
 * product in March" is not about anybody.
 */
export async function pruneAnalytics(
  deps: RollupDeps,
  retentionDays = RAW_EVENT_RETENTION_DAYS,
): Promise<{ events: number; sessions: number; salts: number }> {
  const { prisma } = deps;
  const cutoff = rawEventCutoff(deps.now(), retentionDays);
  const cutoffDay = utcDayKey(cutoff);

  const events = await prisma.analyticsEvent.deleteMany({
    where: { occurredAt: { lt: cutoff } },
  });
  const sessions = await prisma.analyticsSession.deleteMany({
    where: { lastSeenAt: { lt: cutoff } },
  });
  const salts = await prisma.analyticsSalt.deleteMany({
    where: { day: { lt: cutoffDay } },
  });

  return { events: events.count, sessions: sessions.count, salts: salts.count };
}

// ---------------------------------------------------------------------------

async function siteTotals(prisma: PrismaClient, day: string) {
  const [sessionAgg, uniqueAgg, eventCounts, stepCounts] = await Promise.all([
    prisma.analyticsSession.count({ where: { day } }),
    prisma.analyticsSession.findMany({
      where: { day },
      distinct: ['visitorHash'],
      select: { visitorHash: true },
    }),
    prisma.analyticsEvent.groupBy({
      by: ['type'],
      where: { day },
      _count: { _all: true },
    }),
    prisma.analyticsSession.groupBy({
      by: ['furthestStep'],
      where: { day },
      _count: { _all: true },
    }),
  ]);

  const eventCount = (type: string) =>
    eventCounts.find((row) => row.type === type)?._count._all ?? 0;
  const atStep = (step: string) =>
    stepCounts.find((row) => row.furthestStep === step)?._count._all ?? 0;

  // Cumulative: a session that ordered also reached every earlier step. The
  // stored value is the *furthest* step, so each level sums the ones beyond it.
  const ordered = atStep('ORDERED');
  const startedCheckout = atStep('STARTED_CHECKOUT') + ordered;
  const addedToCart = atStep('ADDED_TO_CART') + startedCheckout;
  const viewedProduct = atStep('VIEWED_PRODUCT') + addedToCart;

  return {
    sessions: sessionAgg,
    uniqueVisitors: uniqueAgg.length,
    pageViews: eventCount('page_view'),
    productViews: eventCount('product_view'),
    addToCarts: eventCount('add_to_cart'),
    checkoutsStarted: eventCount('checkout_started'),
    reachedViewedProduct: viewedProduct,
    reachedAddedToCart: addedToCart,
    reachedStartedCheckout: startedCheckout,
    reachedOrdered: ordered,
  };
}

async function productTotals(prisma: PrismaClient, day: string) {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const [views, carts, sold] = await Promise.all([
    prisma.analyticsEvent.groupBy({
      by: ['productId'],
      where: { day, type: 'product_view', productId: { not: null } },
      _count: { _all: true },
    }),
    prisma.analyticsEvent.groupBy({
      by: ['productId'],
      where: { day, type: 'add_to_cart', productId: { not: null } },
      _count: { _all: true },
    }),
    // Units and money from the orders side. Cancelled orders are excluded:
    // revenue that was refunded into nothing was never revenue.
    prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        order: {
          placedAt: { gte: start, lt: end },
          status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] },
        },
      },
      _sum: { quantity: true, lineTotalCents: true },
    }),
  ]);

  const byProduct = new Map<
    string,
    {
      productId: string;
      views: number;
      addToCarts: number;
      unitsOrdered: number;
      revenueCents: number;
    }
  >();

  const ensure = (productId: string) => {
    let row = byProduct.get(productId);
    if (!row) {
      row = { productId, views: 0, addToCarts: 0, unitsOrdered: 0, revenueCents: 0 };
      byProduct.set(productId, row);
    }
    return row;
  };

  for (const row of views) {
    if (row.productId) ensure(row.productId).views = row._count._all;
  }
  for (const row of carts) {
    if (row.productId) ensure(row.productId).addToCarts = row._count._all;
  }
  for (const row of sold) {
    const entry = ensure(row.productId);
    entry.unitsOrdered = row._sum.quantity ?? 0;
    entry.revenueCents = row._sum.lineTotalCents ?? 0;
  }

  return [...byProduct.values()];
}

async function channelTotals(prisma: PrismaClient, day: string) {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const [sessions, orders] = await Promise.all([
    prisma.analyticsSession.groupBy({
      by: ['channel'],
      where: { day },
      _count: { _all: true },
    }),
    // The join between the two halves of this system: a channel *label*, on a
    // day. Not a session id, not a customer id. This is the whole reason
    // campaign ROI can be reported without a per-person browsing profile
    // existing anywhere.
    prisma.order.groupBy({
      by: ['attributionChannel'],
      where: {
        placedAt: { gte: start, lt: end },
        status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] },
      },
      _count: { _all: true },
      _sum: { totalCents: true },
    }),
  ]);

  const byChannel = new Map<
    string,
    { channel: string; sessions: number; orders: number; revenueCents: number }
  >();

  const ensure = (channel: string) => {
    let row = byChannel.get(channel);
    if (!row) {
      row = { channel, sessions: 0, orders: 0, revenueCents: 0 };
      byChannel.set(channel, row);
    }
    return row;
  };

  for (const row of sessions) {
    ensure(row.channel).sessions = row._count._all;
  }
  for (const row of orders) {
    // An order with no recorded channel is 'direct' rather than being dropped.
    // Silently losing orders from a revenue report is worse than attributing
    // them to the least specific bucket.
    const entry = ensure(row.attributionChannel ?? 'direct');
    entry.orders = row._count._all;
    entry.revenueCents = row._sum.totalCents ?? 0;
  }

  return [...byChannel.values()];
}
