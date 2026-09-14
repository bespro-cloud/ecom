import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import {
  attributionChannel,
  dailySaltPeriod,
  funnelStepForEvent,
  furthestStep,
  isClientReportableEvent,
  looksLikeBot,
  normalisePath,
  parseCampaign,
  parseDoNotTrack,
  parseGlobalPrivacyControl,
  referrerHost,
  shouldCollect,
  utcDayKey,
  visitorFingerprintMaterial,
  type AnalyticsEventType,
  type CollectionRefusal,
  type FunnelStep,
} from '@health/types';
import type { AnalyticsBeaconInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';

/**
 * Analytics collection.
 *
 * This service exists at the boundary between a stranger's browser and a
 * database on a site that sells health products, and it is written as though
 * both of those facts are dangerous, because they are.
 *
 * **Nothing identifying is written, and there is nowhere to write it.** The
 * event and session tables have no customer, user, email, order or IP column; a
 * database event trigger refuses a migration that would add one. So the
 * guarantee here is not "this code is careful" — it is "the shape of the
 * storage makes the mistake impossible".
 *
 * **The IP address is used and discarded inside one function.** It is hashed
 * with a salt that rotates every UTC day, and the salt is deleted along with
 * the events it protected. After that, nobody holding this database and the
 * address can recompute the hash.
 *
 * **The client is not trusted about anything that matters.** Not the path (the
 * query string is stripped here, not there), not the timestamp (clamped to
 * arrival), not whether a purchase happened (that event is server-only), and
 * not whether it may be measured at all (the browser's own privacy headers
 * override the consent flag in the body).
 *
 * The whole thing returns success whether or not anything was recorded. A
 * beacon that reported "refused: no consent" would be a free oracle for
 * probing which visitors are being measured, and there is nothing the browser
 * would do differently with the answer.
 */

export interface CollectionContext {
  ipAddress: string | null;
  userAgent: string | null;
  doNotTrackHeader: string | null;
  globalPrivacyControlHeader: string | null;
  /** From an edge/CDN header, when the deployment has one. Country only. */
  country: string | null;
}

export interface CollectionResult {
  accepted: number;
  /** Present only when nothing was recorded. Never returned to the browser. */
  refusedBecause?: CollectionRefusal;
}

const DEVICE_MOBILE = /\b(iphone|android.+mobile|windows phone|ipod)\b/i;
const DEVICE_TABLET = /\b(ipad|android(?!.+mobile)|tablet|kindle|silk)\b/i;

@Injectable()
export class AnalyticsCollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(AnalyticsCollectionService.name);
  }

  /**
   * Records a beacon, or decides not to.
   *
   * Never throws for a business reason. A visitor's page must not break because
   * measurement failed, and a 500 from the analytics endpoint is a 500 in
   * somebody's browser console on a page where they are trying to buy
   * something.
   */
  async collect(
    input: AnalyticsBeaconInput,
    context: CollectionContext,
  ): Promise<CollectionResult> {
    const decision = shouldCollect(
      {
        analyticsConsent: input.consent,
        doNotTrack: parseDoNotTrack(context.doNotTrackHeader),
        globalPrivacyControl: parseGlobalPrivacyControl(context.globalPrivacyControlHeader),
      },
      { isBot: looksLikeBot(context.userAgent) },
    );

    if (!decision.collect) {
      return { accepted: 0, refusedBecause: decision.reason };
    }

    const now = this.clock.now();
    const day = utcDayKey(now);

    // Everything reportable is reduced to storable shape *here*, before any
    // write. A client that sent a full URL with a token in the query string has
    // already had it thrown away by the time anything touches the database.
    const events = input.events
      .map((event) => this.toStorableEvent(event, now, day))
      .filter((event): event is StorableEvent => event !== null);

    if (events.length === 0) return { accepted: 0 };

    const visitorHash = await this.visitorHash(context, now);
    const session = await this.upsertSession(input, context, {
      now,
      day,
      visitorHash,
      landingPath: events[0]!.path,
    });

    const step = events.reduce<FunnelStep>((furthest, event) => {
      const next = funnelStepForEvent(event.type);
      return next === null ? furthest : furthestStep(furthest, next);
    }, fromEnumStep(session.furthestStep));

    await this.prisma.$transaction(async (tx) => {
      await tx.analyticsEvent.createMany({
        data: events.map((event) => ({
          sessionId: session.id,
          type: event.type,
          path: event.path,
          productId: event.productId,
          quantity: event.quantity,
          day: event.day,
          occurredAt: event.occurredAt,
        })),
      });

      await tx.analyticsSession.update({
        where: { id: session.id },
        data: {
          lastSeenAt: now,
          eventCount: { increment: events.length },
          ...(toEnumStep(step) === session.furthestStep ? {} : { furthestStep: toEnumStep(step) }),
        },
      });
    });

    return { accepted: events.length };
  }

  /**
   * Records that an order was placed, from the server.
   *
   * Called after an order exists, never from a browser. A conversion reported
   * by a client is a conversion claimed by whoever is holding the keyboard, and
   * the `order_placed` event type is refused by the collection endpoint for
   * exactly that reason.
   *
   * Takes a session id and not an order id: the analytics side learns that
   * *this visit* converted, and nothing more. The order's own campaign labels
   * carry the money, and the two are joined by day and channel rather than by
   * anything that names a person.
   */
  async recordConversion(sessionPublicId: string | null, path = '/checkout'): Promise<void> {
    if (!sessionPublicId) return;

    try {
      const session = await this.prisma.analyticsSession.findUnique({
        where: { publicId: sessionPublicId },
        select: { id: true, furthestStep: true },
      });
      if (!session) return;

      const now = this.clock.now();
      await this.prisma.$transaction(async (tx) => {
        await tx.analyticsEvent.create({
          data: {
            sessionId: session.id,
            type: 'order_placed',
            path: normalisePath(path) ?? '/checkout',
            day: utcDayKey(now),
            occurredAt: now,
          },
        });
        await tx.analyticsSession.update({
          where: { id: session.id },
          data: { furthestStep: 'ORDERED', lastSeenAt: now, eventCount: { increment: 1 } },
        });
      });
    } catch (error) {
      // A measurement failure must never fail a checkout. The order is real
      // whether or not the funnel heard about it, and the money path is not
      // allowed to depend on the analytics path.
      this.logger.warn({ err: error }, 'could not record a conversion event');
    }
  }

  // -------------------------------------------------------------------------

  private toStorableEvent(
    event: AnalyticsBeaconInput['events'][number],
    now: Date,
    fallbackDay: string,
  ): StorableEvent | null {
    if (!isClientReportableEvent(event.type)) return null;

    const path = normalisePath(event.url);
    if (path === null) return null;

    // Clamped to arrival. A client that could backdate an event could rewrite a
    // rollup that has already been computed; one that could forward-date it
    // could file traffic against a day that has not happened. Neither is
    // interesting enough to allow.
    const reported = event.occurredAt ?? now;
    const occurredAt = reported > now || Number.isNaN(reported.getTime()) ? now : reported;

    return {
      type: event.type,
      path,
      productId:
        event.type === 'product_view' || event.type === 'add_to_cart'
          ? (event.productId ?? null)
          : null,
      quantity: event.type === 'add_to_cart' ? (event.quantity ?? null) : null,
      occurredAt,
      // Filed on the day the beacon arrived, not the day it claims. A late
      // beacon — a tab reopened after a laptop woke up — would otherwise land
      // in a rollup that has already been computed and closed.
      day: fallbackDay,
    };
  }

  /**
   * The salted daily hash that stands in for "a visitor".
   *
   * The salt is per-day and generated on first use. Two consequences worth
   * being explicit about: the same person on two days is two visitors, and
   * yesterday's hashes stop being reproducible the moment yesterday's salt is
   * pruned. Both are deliberate. "Unique visitors today" is a number a business
   * legitimately needs; "everything this person has ever looked at" is not a
   * number, it is a dossier.
   */
  private async visitorHash(context: CollectionContext, now: Date): Promise<string> {
    const day = dailySaltPeriod(now);
    const salt = await this.dailySalt(day);

    const material = visitorFingerprintMaterial({
      // An absent address still produces a stable-enough bucket for the day.
      ipAddress: context.ipAddress ?? 'unknown',
      userAgent: context.userAgent ?? 'unknown',
      salt,
    });

    // The address exists only as an argument to this call. It is not returned,
    // not logged and not stored.
    return createHash('sha256').update(material).digest('base64url').slice(0, 32);
  }

  private async dailySalt(day: string): Promise<string> {
    const existing = await this.prisma.analyticsSalt.findUnique({ where: { day } });
    if (existing) return existing.secret;

    const secret = randomBytes(32).toString('base64url');
    // Two concurrent first-requests of the day race here; the unique primary
    // key decides, and the loser re-reads the winner's salt. Both must end up
    // with the same salt or the day's visitor counts would be double-counted.
    const created = await this.prisma.analyticsSalt
      .create({ data: { day, secret } })
      .catch(async () => this.prisma.analyticsSalt.findUniqueOrThrow({ where: { day } }));

    return created.secret;
  }

  private async upsertSession(
    input: AnalyticsBeaconInput,
    context: CollectionContext,
    meta: { now: Date; day: string; visitorHash: string; landingPath: string },
  ) {
    const existing = await this.prisma.analyticsSession.findUnique({
      where: { publicId: input.sessionId },
    });
    if (existing) return existing;

    // Campaign labels are read from the landing URL's query string — the one
    // place a query string is read at all, and it reads five named parameters
    // and keeps nothing else.
    const landingUrl = input.events[0]?.url ?? '';
    const campaign = parseCampaign(
      landingUrl.includes('?') ? landingUrl.slice(landingUrl.indexOf('?')) : null,
    );
    const referrer = referrerHost(input.referrer ?? null);

    return this.prisma.analyticsSession.create({
      data: {
        publicId: input.sessionId,
        visitorHash: meta.visitorHash,
        day: meta.day,
        channel: attributionChannel(campaign, referrer),
        utmSource: campaign.source,
        utmMedium: campaign.medium,
        utmCampaign: campaign.campaign,
        utmTerm: campaign.term,
        utmContent: campaign.content,
        referrerHost: referrer,
        landingPath: meta.landingPath,
        deviceType: deviceType(context.userAgent),
        country: normaliseCountry(context.country),
        startedAt: meta.now,
        lastSeenAt: meta.now,
      },
    });
  }
}

interface StorableEvent {
  type: AnalyticsEventType;
  path: string;
  productId: string | null;
  quantity: number | null;
  occurredAt: Date;
  day: string;
}

function fromEnumStep(value: string): FunnelStep {
  return (
    (
      {
        VISITED: 'visited',
        VIEWED_PRODUCT: 'viewed_product',
        ADDED_TO_CART: 'added_to_cart',
        STARTED_CHECKOUT: 'started_checkout',
        ORDERED: 'ordered',
      } as const
    )[value as 'VISITED'] ?? 'visited'
  );
}

function toEnumStep(step: FunnelStep) {
  return (
    {
      visited: 'VISITED',
      viewed_product: 'VIEWED_PRODUCT',
      added_to_cart: 'ADDED_TO_CART',
      started_checkout: 'STARTED_CHECKOUT',
      ordered: 'ORDERED',
    } as const
  )[step];
}

/**
 * Three buckets, from the user agent.
 *
 * Deliberately coarse. Screen size, installed fonts, canvas rendering and the
 * rest are what a fingerprint is made of; "this was a phone" is a fact a
 * business can act on and nobody can be identified by.
 */
function deviceType(userAgent: string | null): string | null {
  if (!userAgent) return null;
  if (DEVICE_TABLET.test(userAgent)) return 'tablet';
  if (DEVICE_MOBILE.test(userAgent)) return 'mobile';
  return 'desktop';
}

/** Two-letter country or nothing. A city on a health site is a small crowd. */
function normaliseCountry(value: string | null): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}
