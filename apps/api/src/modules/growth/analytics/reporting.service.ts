import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@health/config';
import { dayKeyRange, funnelReport, ratio, utcDayKey, type FunnelStage } from '@health/types';
import type { AnalyticsRangeInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';

/**
 * Analytics reporting.
 *
 * Reads rollups, not raw events. That is a privacy decision as much as a
 * performance one: the rollups are counts, and a reporting endpoint that
 * queried raw events would be an endpoint that could be coaxed into returning
 * one session's path through the site.
 *
 * Every number here is either a count of sessions or a figure from the orders
 * tables. There is no endpoint that takes a customer id, because there is no
 * query it could answer.
 */

export interface OverviewReport {
  from: string;
  to: string;
  totals: {
    sessions: number;
    uniqueVisitors: number;
    pageViews: number;
    productViews: number;
    addToCarts: number;
    orders: number;
    revenueCents: number;
    /** Orders divided by sessions. Both aggregates; nothing is joined. */
    conversionRate: number;
    /** Revenue divided by orders, in minor units, rounded to the cent. */
    averageOrderValueCents: number;
  };
  funnel: FunnelStage[];
  daily: Array<{
    day: string;
    sessions: number;
    uniqueVisitors: number;
    orders: number;
    revenueCents: number;
  }>;
}

export interface ChannelReport {
  channel: string;
  sessions: number;
  orders: number;
  revenueCents: number;
  conversionRate: number;
  revenuePerSessionCents: number;
}

export interface ProductReport {
  productId: string;
  productName: string;
  productSlug: string;
  views: number;
  addToCarts: number;
  unitsOrdered: number;
  revenueCents: number;
  /** Add-to-carts divided by views. The number a listing is judged on. */
  addToCartRate: number;
}

@Injectable()
export class AnalyticsReportingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async overview(range: AnalyticsRangeInput): Promise<OverviewReport> {
    const days = dayKeyRange(range.from, range.to);
    if (days.length === 0) return emptyOverview(range);

    const [metrics, channels] = await Promise.all([
      this.prisma.analyticsDailyMetric.findMany({
        where: { day: { in: days } },
        orderBy: { day: 'asc' },
      }),
      this.prisma.analyticsChannelDaily.findMany({ where: { day: { in: days } } }),
    ]);

    const totals = metrics.reduce(
      (sum, row) => ({
        sessions: sum.sessions + row.sessions,
        uniqueVisitors: sum.uniqueVisitors + row.uniqueVisitors,
        pageViews: sum.pageViews + row.pageViews,
        productViews: sum.productViews + row.productViews,
        addToCarts: sum.addToCarts + row.addToCarts,
        reachedViewedProduct: sum.reachedViewedProduct + row.reachedViewedProduct,
        reachedAddedToCart: sum.reachedAddedToCart + row.reachedAddedToCart,
        reachedStartedCheckout: sum.reachedStartedCheckout + row.reachedStartedCheckout,
        reachedOrdered: sum.reachedOrdered + row.reachedOrdered,
      }),
      {
        sessions: 0,
        uniqueVisitors: 0,
        pageViews: 0,
        productViews: 0,
        addToCarts: 0,
        reachedViewedProduct: 0,
        reachedAddedToCart: 0,
        reachedStartedCheckout: 0,
        reachedOrdered: 0,
      },
    );

    // Money comes from the channel rollup, which took it from the orders table.
    const orders = channels.reduce((sum, row) => sum + row.orders, 0);
    const revenueCents = channels.reduce((sum, row) => sum + row.revenueCents, 0);

    const ordersByDay = new Map<string, { orders: number; revenueCents: number }>();
    for (const row of channels) {
      const entry = ordersByDay.get(row.day) ?? { orders: 0, revenueCents: 0 };
      entry.orders += row.orders;
      entry.revenueCents += row.revenueCents;
      ordersByDay.set(row.day, entry);
    }

    // Note that "unique visitors" is summed across days rather than
    // de-duplicated. It cannot be de-duplicated: visitor hashes are salted per
    // day and two days' hashes for the same person are unrelated by design.
    // The report labels this "visitors per day, summed" rather than pretending
    // to a number this system deliberately cannot produce.
    return {
      from: days[0]!,
      to: days[days.length - 1]!,
      totals: {
        sessions: totals.sessions,
        uniqueVisitors: totals.uniqueVisitors,
        pageViews: totals.pageViews,
        productViews: totals.productViews,
        addToCarts: totals.addToCarts,
        orders,
        revenueCents,
        conversionRate: ratio(orders, totals.sessions),
        averageOrderValueCents: orders === 0 ? 0 : Math.round(revenueCents / orders),
      },
      funnel: funnelReport({
        visited: totals.sessions,
        viewed_product: totals.reachedViewedProduct,
        added_to_cart: totals.reachedAddedToCart,
        started_checkout: totals.reachedStartedCheckout,
        ordered: totals.reachedOrdered,
      }),
      daily: days.map((day) => {
        const metric = metrics.find((row) => row.day === day);
        const money = ordersByDay.get(day);
        return {
          day,
          sessions: metric?.sessions ?? 0,
          uniqueVisitors: metric?.uniqueVisitors ?? 0,
          orders: money?.orders ?? 0,
          revenueCents: money?.revenueCents ?? 0,
        };
      }),
    };
  }

  async channels(range: AnalyticsRangeInput): Promise<ChannelReport[]> {
    const days = dayKeyRange(range.from, range.to);
    if (days.length === 0) return [];

    const rows = await this.prisma.analyticsChannelDaily.findMany({
      where: { day: { in: days } },
    });

    const byChannel = new Map<string, { sessions: number; orders: number; revenueCents: number }>();
    for (const row of rows) {
      const entry = byChannel.get(row.channel) ?? { sessions: 0, orders: 0, revenueCents: 0 };
      entry.sessions += row.sessions;
      entry.orders += row.orders;
      entry.revenueCents += row.revenueCents;
      byChannel.set(row.channel, entry);
    }

    return [...byChannel.entries()]
      .map(([channel, totals]) => ({
        channel,
        ...totals,
        conversionRate: ratio(totals.orders, totals.sessions),
        revenuePerSessionCents:
          totals.sessions === 0 ? 0 : Math.round(totals.revenueCents / totals.sessions),
      }))
      .sort((a, b) => b.revenueCents - a.revenueCents || b.sessions - a.sessions);
  }

  async products(range: AnalyticsRangeInput, limit = 50): Promise<ProductReport[]> {
    const days = dayKeyRange(range.from, range.to);
    if (days.length === 0) return [];

    const rows = await this.prisma.analyticsProductDaily.findMany({
      where: { day: { in: days } },
      include: { product: { select: { id: true, name: true, slug: true } } },
    });

    const byProduct = new Map<string, ProductReport>();
    for (const row of rows) {
      const entry = byProduct.get(row.productId) ?? {
        productId: row.productId,
        productName: row.product.name,
        productSlug: row.product.slug,
        views: 0,
        addToCarts: 0,
        unitsOrdered: 0,
        revenueCents: 0,
        addToCartRate: 0,
      };
      entry.views += row.views;
      entry.addToCarts += row.addToCarts;
      entry.unitsOrdered += row.unitsOrdered;
      entry.revenueCents += row.revenueCents;
      byProduct.set(row.productId, entry);
    }

    return [...byProduct.values()]
      .map((entry) => ({ ...entry, addToCartRate: ratio(entry.addToCarts, entry.views) }))
      .sort((a, b) => b.revenueCents - a.revenueCents || b.views - a.views)
      .slice(0, limit);
  }

  /**
   * The default range a dashboard opens on: the last 28 days ending yesterday.
   *
   * Ending yesterday because today is incomplete, and a partial day at the end
   * of a trend line looks like a collapse in traffic every single morning.
   */
  defaultRange(): AnalyticsRangeInput {
    const now = this.clock.now();
    const to = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const from = new Date(to.getTime() - 27 * 24 * 60 * 60 * 1000);
    return { from, to };
  }
}

function emptyOverview(range: AnalyticsRangeInput): OverviewReport {
  return {
    from: utcDayKey(range.from),
    to: utcDayKey(range.to),
    totals: {
      sessions: 0,
      uniqueVisitors: 0,
      pageViews: 0,
      productViews: 0,
      addToCarts: 0,
      orders: 0,
      revenueCents: 0,
      conversionRate: 0,
      averageOrderValueCents: 0,
    },
    funnel: funnelReport({
      visited: 0,
      viewed_product: 0,
      added_to_cart: 0,
      started_checkout: 0,
      ordered: 0,
    }),
    daily: [],
  };
}
