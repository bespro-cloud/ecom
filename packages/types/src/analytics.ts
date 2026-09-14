/**
 * First-party analytics.
 *
 * The whole design follows from one fact: **what somebody browses on a
 * supplements site is health-adjacent information about them.** A record that
 * a named person looked at a menopause supplement, a fertility supplement or a
 * sleep aid is, in substance, a health inference — and the FTC has brought
 * enforcement actions against health companies for exactly that kind of data
 * reaching advertisers and analytics vendors.
 *
 * So this module does not implement "analytics, with a privacy policy bolted
 * on". It implements a measurement system that is structurally incapable of
 * building a per-person browsing profile:
 *
 * **No identity ever enters analytics.** There is no customer id, no user id,
 * no email and no order id on an analytics event, and no field one could be
 * put in. Not "we don't populate it" — there is nowhere to put it.
 *
 * **Visitor ids are derived, salted and rotate daily.** The salt changes every
 * day and the previous salt is discarded, so the same person visiting on two
 * days produces two unrelated ids. That makes "unique visitors today" possible
 * and "this person's history" impossible, which is the trade this business
 * should want.
 *
 * **No raw IP address is ever stored.** The address is an input to the hash and
 * is then gone. Nothing downstream can recover it.
 *
 * **Conversion is measured without joining a person to their browsing.** The
 * order carries denormalised campaign fields; the analytics session records the
 * furthest funnel step it reached. Conversion rate is one aggregate divided by
 * another. There is deliberately no session id on the order, because that
 * single foreign key would reconstruct exactly the profile the rest of this is
 * built to prevent.
 *
 * **Revenue never comes from a browser.** Money figures are read from the
 * orders table. A client-reported purchase value is a number a stranger can
 * type.
 *
 * Everything here is pure. Nothing reads a clock, a database or a request.
 */

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/**
 * The events a browser may report.
 *
 * An allow-list, not a convention. A collector that accepted arbitrary event
 * names would accept arbitrary payloads with them, and the first thing to
 * appear in those payloads is personal data somebody thought would be useful.
 */
export const ANALYTICS_EVENT_TYPES = [
  'page_view',
  'product_view',
  'search_performed',
  'add_to_cart',
  'remove_from_cart',
  'checkout_started',
  /**
   * Recorded by the *server* when an order is placed, never accepted from a
   * browser. Listed here because it is a funnel step; see `SERVER_ONLY_EVENTS`.
   */
  'order_placed',
] as const;
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/**
 * Events a browser may never report.
 *
 * A purchase reported by a client is a purchase claimed by whoever is holding
 * the keyboard. This one is written server-side from a real order, so the
 * conversion numbers cannot be inflated by anybody with `curl`.
 */
export const SERVER_ONLY_EVENTS: readonly AnalyticsEventType[] = ['order_placed'];

export function isClientReportableEvent(type: string): type is AnalyticsEventType {
  return (
    (ANALYTICS_EVENT_TYPES as readonly string[]).includes(type) &&
    !(SERVER_ONLY_EVENTS as readonly string[]).includes(type)
  );
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

/**
 * The purchase funnel, in order.
 *
 * A session's progress is stored as the furthest step it reached, not as a
 * list of steps, because the ratio between consecutive steps is the only thing
 * anyone acts on and a list invites reconstructing an individual's path.
 */
export const FUNNEL_STEPS = [
  'visited',
  'viewed_product',
  'added_to_cart',
  'started_checkout',
  'ordered',
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

const FUNNEL_STEP_FOR_EVENT: Partial<Record<AnalyticsEventType, FunnelStep>> = {
  page_view: 'visited',
  search_performed: 'visited',
  product_view: 'viewed_product',
  add_to_cart: 'added_to_cart',
  checkout_started: 'started_checkout',
  order_placed: 'ordered',
};

export function funnelStepForEvent(type: AnalyticsEventType): FunnelStep | null {
  return FUNNEL_STEP_FOR_EVENT[type] ?? null;
}

export function funnelStepRank(step: FunnelStep): number {
  return FUNNEL_STEPS.indexOf(step);
}

/**
 * The further of two steps.
 *
 * Progress only ever moves forward. A customer who reaches checkout and then
 * browses back to a product has still reached checkout, and a funnel that let
 * them slip backwards would under-report every abandoned basket — the exact
 * number the funnel exists to show.
 */
export function furthestStep(current: FunnelStep | null, next: FunnelStep): FunnelStep {
  if (current === null) return next;
  return funnelStepRank(next) > funnelStepRank(current) ? next : current;
}

export interface FunnelCounts {
  readonly visited: number;
  readonly viewed_product: number;
  readonly added_to_cart: number;
  readonly started_checkout: number;
  readonly ordered: number;
}

export interface FunnelStage {
  step: FunnelStep;
  sessions: number;
  /** Share of the sessions that reached the previous step. Null for the first. */
  continuationRate: number | null;
  /** Share of the sessions that entered the funnel at all. */
  overallRate: number;
}

/**
 * Turns per-step session counts into the report a person reads.
 *
 * Counts are *cumulative by construction*: a session that ordered also reached
 * every earlier step, because progress is stored as the furthest step and this
 * function is fed "sessions whose furthest step was at least this one". Rates
 * are computed rather than stored so a rounding choice cannot get baked into
 * the data.
 *
 * Division by zero yields zero, not `NaN`. A dashboard showing NaN teaches
 * people to distrust the whole page.
 */
export function funnelReport(counts: FunnelCounts): FunnelStage[] {
  const entered = counts.visited;

  return FUNNEL_STEPS.map((step, index) => {
    const sessions = counts[step];
    const previous = index === 0 ? null : counts[FUNNEL_STEPS[index - 1]!];

    return {
      step,
      sessions,
      continuationRate: previous === null ? null : ratio(sessions, previous),
      overallRate: ratio(sessions, entered),
    };
  });
}

/** A proportion in [0, 1], or zero when the denominator is zero. */
export function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// Consent and signals the visitor sends
// ---------------------------------------------------------------------------

/**
 * What the visitor's browser said about being measured.
 *
 * `globalPrivacyControl` is the `Sec-GPC: 1` header. Unlike Do Not Track it is
 * legally binding under the CPRA as an opt-out of sale and sharing, and several
 * other state laws treat it the same way. It is honoured here as an opt-out of
 * analytics entirely, which is stricter than the letter of the law and much
 * easier to defend than a debate about whether first-party measurement counts
 * as "sharing".
 */
export interface VisitorSignals {
  doNotTrack?: boolean;
  globalPrivacyControl?: boolean;
  /** Whether the visitor accepted analytics in the consent banner. */
  analyticsConsent?: boolean;
}

export type CollectionDecision = { collect: true } | { collect: false; reason: CollectionRefusal };

export type CollectionRefusal = 'global_privacy_control' | 'do_not_track' | 'no_consent' | 'bot';

/**
 * Whether to record anything at all.
 *
 * Consent is **opt-in**: an absent decision is a no, not a yes. A visitor who
 * has not answered the banner has not agreed, and treating silence as consent
 * is the interpretation that gets fined.
 *
 * The order matters. A binding signal is checked before consent, so a visitor
 * who clicked "accept" in a banner and whose browser then sent GPC is still
 * not measured: the browser-level opt-out is the more considered instruction
 * and the one with legal force.
 */
export function shouldCollect(
  signals: VisitorSignals,
  options: { isBot?: boolean } = {},
): CollectionDecision {
  if (options.isBot) return { collect: false, reason: 'bot' };
  if (signals.globalPrivacyControl) {
    return { collect: false, reason: 'global_privacy_control' };
  }
  if (signals.doNotTrack) return { collect: false, reason: 'do_not_track' };
  if (signals.analyticsConsent !== true) return { collect: false, reason: 'no_consent' };
  return { collect: true };
}

/**
 * Parses the `DNT` header. Only the literal "1" means "do not track"; "0" is an
 * explicit permission and anything else is an unset preference.
 */
export function parseDoNotTrack(header: string | null | undefined): boolean {
  return header?.trim() === '1';
}

/** Parses `Sec-GPC`. Same rule: only "1" asserts the signal. */
export function parseGlobalPrivacyControl(header: string | null | undefined): boolean {
  return header?.trim() === '1';
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

const BOT_PATTERNS = [
  'bot',
  'crawler',
  'spider',
  'crawl',
  'slurp',
  'curl',
  'wget',
  'python-requests',
  'headlesschrome',
  'phantomjs',
  'lighthouse',
  'pingdom',
  'uptimerobot',
  'facebookexternalhit',
  'preview',
  'monitoring',
  'scraper',
] as const;

/**
 * A cheap user-agent heuristic.
 *
 * Deliberately biased toward calling things bots. A misclassified human costs
 * one row of traffic data; a crawler counted as a customer inflates every
 * number on the dashboard and quietly makes the conversion rate look worse
 * than it is, which is the kind of error people make decisions on.
 *
 * An absent user agent counts as a bot. Every real browser sends one.
 */
export function looksLikeBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  const lower = userAgent.toLowerCase();
  return BOT_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MAX_PATH_LENGTH = 300;

/**
 * Reduces a reported URL to a storable path.
 *
 * **The query string is discarded in full.** Not filtered — discarded. Query
 * strings are where personal data ends up by accident: an email in an
 * unsubscribe link, a password-reset token, a support reference, a session id
 * pasted into a share. Keeping a curated deny-list of parameter names means
 * losing the next time somebody adds one, and on this site the thing that leaks
 * could be a health detail.
 *
 * The fragment goes too, since the server never sees it anyway and a client
 * could put anything there.
 *
 * Returns null for anything that is not a same-site absolute path, so a crafted
 * payload cannot store an arbitrary external URL as though it were a page of
 * this site.
 */
export function normalisePath(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // A protocol-relative URL is refused outright rather than guessed at.
  // `//evil.example/x` is a URL pointing at somebody else's host, and recording
  // it as a path of this site is exactly the confusion to avoid. It is also a
  // plausible doubled-slash typo — and when the two readings disagree, dropping
  // one row of traffic data is the cheaper mistake.
  if (trimmed.startsWith('//')) return null;

  // Absolute URLs are accepted only to be reduced to their path. Anything
  // pointing elsewhere is not a page of this site and is not recorded as one.
  let path = trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }

  if (!path.startsWith('/')) return null;

  path = path.split('#')[0]!.split('?')[0]!;

  // Collapse repeated slashes and drop a trailing one, so "/products/",
  // "/products" and "//products" are one row rather than three.
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  if (path.length > MAX_PATH_LENGTH) path = path.slice(0, MAX_PATH_LENGTH);

  return path;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface Campaign {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
}

export const EMPTY_CAMPAIGN: Campaign = {
  source: null,
  medium: null,
  campaign: null,
  term: null,
  content: null,
};

const MAX_CAMPAIGN_FIELD = 120;

/**
 * Reads UTM parameters from a landing URL's query string.
 *
 * This is the one place a query string is read, and it reads exactly five named
 * parameters and stores nothing else — the rest of the query never leaves this
 * function. Values are truncated and stripped of control characters, because
 * they are attacker-controlled strings that will be rendered on a dashboard.
 *
 * A campaign value is not personal data by nature, but it is by accident:
 * `utm_content=jane@example.com` happens. Callers should treat these as public
 * labels, which is why nothing downstream joins on them to a person.
 */
export function parseCampaign(search: string | null | undefined): Campaign {
  if (!search) return EMPTY_CAMPAIGN;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return EMPTY_CAMPAIGN;
  }

  return {
    source: cleanCampaignValue(params.get('utm_source')),
    medium: cleanCampaignValue(params.get('utm_medium')),
    campaign: cleanCampaignValue(params.get('utm_campaign')),
    term: cleanCampaignValue(params.get('utm_term')),
    content: cleanCampaignValue(params.get('utm_content')),
  };
}

function cleanCampaignValue(value: string | null): string | null {
  if (value === null) return null;
  // Stripping control characters is the entire point of this line: these values
  // are attacker-controlled and get rendered on a dashboard and into logs, where
  // an escape sequence can rewrite a terminal.
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (stripped.length === 0) return null;
  return stripped.slice(0, MAX_CAMPAIGN_FIELD);
}

export function hasCampaign(campaign: Campaign): boolean {
  return (
    campaign.source !== null ||
    campaign.medium !== null ||
    campaign.campaign !== null ||
    campaign.term !== null ||
    campaign.content !== null
  );
}

/**
 * The host of a referring URL, or null.
 *
 * The **host only**. A full referrer URL is a path on somebody else's site,
 * and paths carry search terms and worse. "Which sites send us traffic" is the
 * question anyone actually has, and the host answers it.
 *
 * A referrer from this site's own host is not a referrer at all; callers pass
 * `ownHost` so internal navigation does not show up as an acquisition channel.
 */
export function referrerHost(
  referrer: string | null | undefined,
  ownHost?: string | null,
): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    if (host.length === 0) return null;
    if (ownHost && host === ownHost.toLowerCase()) return null;
    return host.slice(0, MAX_CAMPAIGN_FIELD);
  } catch {
    return null;
  }
}

/**
 * How a session arrived, as a single label.
 *
 * Precedence is explicit rather than clever: a tagged link is what marketing
 * chose to say about the visit, so it beats a referrer header the visitor's
 * browser happened to send.
 */
export function attributionChannel(campaign: Campaign, referrer: string | null): string {
  if (campaign.medium) return campaign.medium;
  if (campaign.source) return campaign.source;
  if (referrer) return 'referral';
  return 'direct';
}

// ---------------------------------------------------------------------------
// Visitor identity
// ---------------------------------------------------------------------------

/**
 * The inputs a visitor id is derived from.
 *
 * No cookie, no fingerprint, no local storage. Those persist, and anything that
 * persists across days is a profile.
 */
export interface VisitorFingerprintInput {
  ipAddress: string;
  userAgent: string;
  /** Rotates daily. See `dailySaltPeriod`. */
  salt: string;
}

/**
 * The day a salt belongs to, as `YYYY-MM-DD` in UTC.
 *
 * A salt is retired when its day ends and is not kept. Once it is gone, the
 * visitor ids derived with it cannot be recomputed from an IP address even by
 * someone holding the database and the address — which is the property that
 * makes "unique visitors" measurable without keeping a way back to a person.
 */
export function dailySaltPeriod(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The canonical string a visitor id is hashed from.
 *
 * Separate from the hashing itself so this can be unit-tested without a crypto
 * dependency in this package, and so the field separator is explicit: without
 * one, two different inputs could concatenate to the same string and collapse
 * two visitors into one.
 */
export function visitorFingerprintMaterial(input: VisitorFingerprintInput): string {
  return [input.salt, input.ipAddress.trim(), input.userAgent.trim()].join('\u0000');
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * How long a raw, session-scoped event is kept.
 *
 * Short on purpose. Raw events are the only rows with enough shape to
 * reconstruct one session's path through the site; the aggregates that survive
 * them are counts, which cannot. Thirty days is long enough to investigate a
 * measurement bug and to rebuild a rollup that failed, and not long enough to
 * be a store of browsing histories.
 *
 * The rollups have no such limit: "4,102 people viewed this product in March"
 * is not about anybody.
 */
export const RAW_EVENT_RETENTION_DAYS = 30;

export function rawEventCutoff(now: Date, retentionDays = RAW_EVENT_RETENTION_DAYS): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * A session is over after this long without an event.
 *
 * Thirty minutes is the long-standing convention, and the value matters less
 * than picking one and stating it: every "sessions" number on every dashboard
 * means "visits separated by at least this much idle time".
 */
export const SESSION_IDLE_TIMEOUT_MINUTES = 30;

// ---------------------------------------------------------------------------
// Day bucketing
// ---------------------------------------------------------------------------

/**
 * The UTC day an instant belongs to.
 *
 * Rollups are bucketed in UTC rather than a business-local timezone, because a
 * local day changes length twice a year and a "day" that is 23 or 25 hours long
 * produces a dip and a spike that people then explain with a story about
 * customer behaviour.
 */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function utcDayStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

export function utcDayEnd(dayKey: string): Date {
  return new Date(utcDayStart(dayKey).getTime() + 24 * 60 * 60 * 1000);
}

/** Every day key from `from` to `to`, inclusive. */
export function dayKeyRange(from: Date, to: Date): string[] {
  const keys: string[] = [];
  let cursor = utcDayStart(utcDayKey(from));
  const last = utcDayStart(utcDayKey(to));

  // Bounded so a bad range cannot spin: five years of days is far more than any
  // report asks for and still terminates.
  for (let guard = 0; cursor <= last && guard < 1830; guard += 1) {
    keys.push(utcDayKey(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }

  return keys;
}
