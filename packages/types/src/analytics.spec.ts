import { describe, expect, it } from 'vitest';
import {
  attributionChannel,
  dailySaltPeriod,
  dayKeyRange,
  funnelReport,
  funnelStepForEvent,
  furthestStep,
  hasCampaign,
  isClientReportableEvent,
  looksLikeBot,
  normalisePath,
  parseCampaign,
  parseDoNotTrack,
  parseGlobalPrivacyControl,
  rawEventCutoff,
  ratio,
  referrerHost,
  shouldCollect,
  utcDayKey,
  visitorFingerprintMaterial,
  RAW_EVENT_RETENTION_DAYS,
} from './analytics.js';

/**
 * These tests are mostly about what the analytics system refuses to do.
 *
 * The measurement arithmetic matters, but the properties worth protecting with
 * a test are the privacy ones: a query string never survives, a browser opt-out
 * always wins, and a client can never report a purchase.
 */

describe('what a browser is allowed to report', () => {
  it('accepts the ordinary browsing events', () => {
    expect(isClientReportableEvent('page_view')).toBe(true);
    expect(isClientReportableEvent('product_view')).toBe(true);
    expect(isClientReportableEvent('add_to_cart')).toBe(true);
    expect(isClientReportableEvent('checkout_started')).toBe(true);
  });

  it('refuses a purchase reported by a client', () => {
    // A conversion claimed by a browser is a conversion claimed by whoever is
    // holding the keyboard. This one is written server-side from a real order.
    expect(isClientReportableEvent('order_placed')).toBe(false);
  });

  it('refuses an event name nobody declared', () => {
    expect(isClientReportableEvent('health_condition_selected')).toBe(false);
    expect(isClientReportableEvent('')).toBe(false);
    expect(isClientReportableEvent('__proto__')).toBe(false);
  });
});

describe('normalising a path', () => {
  it('discards the query string entirely', () => {
    // Not filtered — discarded. A deny-list of parameter names loses the next
    // time somebody adds one, and on this site the thing that leaks could be a
    // health detail.
    expect(normalisePath('/products/magnesium?utm_source=email&email=ada@example.test')).toBe(
      '/products/magnesium',
    );
    expect(normalisePath('/reset?token=abc123')).toBe('/reset');
  });

  it('discards the fragment', () => {
    expect(normalisePath('/pages/faq#my-symptoms')).toBe('/pages/faq');
  });

  it('reduces an absolute URL on this site to its path', () => {
    expect(normalisePath('https://shop.example.test/products/zinc?x=1')).toBe('/products/zinc');
  });

  it('refuses anything that is not a path', () => {
    expect(normalisePath('javascript:alert(1)')).toBeNull();
    expect(normalisePath('products/zinc')).toBeNull();
    expect(normalisePath('')).toBeNull();
    expect(normalisePath(null)).toBeNull();
    expect(normalisePath('   ')).toBeNull();
  });

  it('collapses paths that are the same page', () => {
    expect(normalisePath('/products/')).toBe('/products');
    expect(normalisePath('/products//zinc')).toBe('/products/zinc');
    expect(normalisePath('/')).toBe('/');
  });

  it('refuses a protocol-relative URL rather than guessing', () => {
    // `//evil.example/x` is a URL pointing at another host, not a path of this
    // site. It could equally be a doubled-slash typo — and when the readings
    // disagree, losing one row of traffic data is the cheaper mistake.
    expect(normalisePath('//evil.example.test/products/zinc')).toBeNull();
  });

  it('truncates a path long enough to be an attack on the column', () => {
    const long = `/${'a'.repeat(5000)}`;
    expect(normalisePath(long)!.length).toBeLessThanOrEqual(300);
  });
});

describe('deciding whether to collect anything', () => {
  it('collects only with explicit consent', () => {
    expect(shouldCollect({ analyticsConsent: true })).toEqual({ collect: true });
  });

  it('treats silence as a no', () => {
    // Consent is opt-in. A visitor who has not answered the banner has not
    // agreed, and reading silence as agreement is the interpretation that gets
    // fined.
    expect(shouldCollect({})).toEqual({ collect: false, reason: 'no_consent' });
    expect(shouldCollect({ analyticsConsent: false })).toEqual({
      collect: false,
      reason: 'no_consent',
    });
  });

  it('lets Global Privacy Control override a banner click', () => {
    // GPC is legally binding under the CPRA. It is the more considered
    // instruction and it wins over a click in a banner.
    expect(shouldCollect({ analyticsConsent: true, globalPrivacyControl: true })).toEqual({
      collect: false,
      reason: 'global_privacy_control',
    });
  });

  it('honours Do Not Track even though it is not binding', () => {
    expect(shouldCollect({ analyticsConsent: true, doNotTrack: true })).toEqual({
      collect: false,
      reason: 'do_not_track',
    });
  });

  it('does not measure bots however willing they are', () => {
    expect(shouldCollect({ analyticsConsent: true }, { isBot: true })).toEqual({
      collect: false,
      reason: 'bot',
    });
  });

  it('reads only a literal 1 as a privacy signal', () => {
    expect(parseDoNotTrack('1')).toBe(true);
    expect(parseDoNotTrack('0')).toBe(false);
    expect(parseDoNotTrack('unspecified')).toBe(false);
    expect(parseDoNotTrack(null)).toBe(false);
    expect(parseGlobalPrivacyControl('1')).toBe(true);
    expect(parseGlobalPrivacyControl('true')).toBe(false);
  });
});

describe('bot detection', () => {
  it('catches the obvious ones', () => {
    expect(looksLikeBot('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(looksLikeBot('curl/8.4.0')).toBe(true);
    expect(looksLikeBot('python-requests/2.31.0')).toBe(true);
    expect(looksLikeBot('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
  });

  it('treats a missing user agent as a bot', () => {
    // Every real browser sends one. Counting a crawler as a customer makes the
    // conversion rate look worse than it is, and people act on that number.
    expect(looksLikeBot(null)).toBe(true);
    expect(looksLikeBot('')).toBe(true);
  });

  it('lets an ordinary browser through', () => {
    expect(
      looksLikeBot(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
    ).toBe(false);
  });
});

describe('campaigns', () => {
  it('reads the five UTM parameters and nothing else', () => {
    const campaign = parseCampaign(
      '?utm_source=newsletter&utm_medium=email&utm_campaign=spring&secret=abc&email=ada@example.test',
    );
    expect(campaign).toEqual({
      source: 'newsletter',
      medium: 'email',
      campaign: 'spring',
      term: null,
      content: null,
    });
    expect(JSON.stringify(campaign)).not.toContain('ada@example.test');
    expect(JSON.stringify(campaign)).not.toContain('abc');
  });

  it('copes with an absent or malformed query', () => {
    expect(hasCampaign(parseCampaign(null))).toBe(false);
    expect(hasCampaign(parseCampaign(''))).toBe(false);
    expect(hasCampaign(parseCampaign('?'))).toBe(false);
  });

  it('strips control characters from values that reach a dashboard', () => {
    const campaign = parseCampaign('?utm_source=news\u0000letter\u001b[31m');
    expect(campaign.source).toBe('newsletter[31m');
  });

  it('truncates a value long enough to be an attack on the column', () => {
    const campaign = parseCampaign(`?utm_campaign=${'x'.repeat(1000)}`);
    expect(campaign.campaign!.length).toBeLessThanOrEqual(120);
  });

  it('treats a blank value as absent', () => {
    expect(parseCampaign('?utm_source=&utm_medium=cpc').source).toBeNull();
    expect(parseCampaign('?utm_source=&utm_medium=cpc').medium).toBe('cpc');
  });
});

describe('referrers', () => {
  it('keeps the host and throws the path away', () => {
    // A referrer path is a page on somebody else's site, and paths carry search
    // terms. "Which sites send us traffic" is answered by the host.
    expect(referrerHost('https://www.example.test/search?q=insomnia+treatment')).toBe(
      'www.example.test',
    );
  });

  it('does not count this site as a referrer to itself', () => {
    expect(referrerHost('https://shop.example.test/products', 'shop.example.test')).toBeNull();
    expect(referrerHost('https://SHOP.example.test/x', 'shop.example.test')).toBeNull();
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(referrerHost('not a url')).toBeNull();
    expect(referrerHost(null)).toBeNull();
  });
});

describe('attribution channel', () => {
  it('prefers what marketing tagged over what the browser sent', () => {
    expect(
      attributionChannel(
        { source: 'newsletter', medium: 'email', campaign: null, term: null, content: null },
        'https://www.example.test',
      ),
    ).toBe('email');
  });

  it('falls back to referral, then direct', () => {
    expect(
      attributionChannel(
        { source: null, medium: null, campaign: null, term: null, content: null },
        'https://www.example.test',
      ),
    ).toBe('referral');
    expect(
      attributionChannel(
        { source: null, medium: null, campaign: null, term: null, content: null },
        null,
      ),
    ).toBe('direct');
  });
});

describe('the funnel', () => {
  it('maps events onto steps', () => {
    expect(funnelStepForEvent('page_view')).toBe('visited');
    expect(funnelStepForEvent('product_view')).toBe('viewed_product');
    expect(funnelStepForEvent('add_to_cart')).toBe('added_to_cart');
    expect(funnelStepForEvent('order_placed')).toBe('ordered');
    // Removing something from the basket is not a step backwards; it is not a
    // step at all.
    expect(funnelStepForEvent('remove_from_cart')).toBeNull();
  });

  it('never moves a session backwards', () => {
    // Someone who reaches checkout and browses back to a product has still
    // reached checkout. Letting them slip back would under-report every
    // abandoned basket — the number the funnel exists to show.
    expect(furthestStep('started_checkout', 'viewed_product')).toBe('started_checkout');
    expect(furthestStep('viewed_product', 'started_checkout')).toBe('started_checkout');
    expect(furthestStep(null, 'visited')).toBe('visited');
  });

  it('reports continuation and overall rates', () => {
    const report = funnelReport({
      visited: 1000,
      viewed_product: 400,
      added_to_cart: 100,
      started_checkout: 50,
      ordered: 40,
    });

    expect(report.map((stage) => stage.step)).toEqual([
      'visited',
      'viewed_product',
      'added_to_cart',
      'started_checkout',
      'ordered',
    ]);
    expect(report[0]!.continuationRate).toBeNull();
    expect(report[1]!.continuationRate).toBeCloseTo(0.4);
    expect(report[3]!.continuationRate).toBeCloseTo(0.5);
    expect(report[4]!.continuationRate).toBeCloseTo(0.8);
    expect(report[4]!.overallRate).toBeCloseTo(0.04);
  });

  it('reports zero rather than NaN on a day with no traffic', () => {
    // A dashboard showing NaN teaches people to distrust the whole page.
    const report = funnelReport({
      visited: 0,
      viewed_product: 0,
      added_to_cart: 0,
      started_checkout: 0,
      ordered: 0,
    });
    for (const stage of report) {
      expect(Number.isFinite(stage.overallRate)).toBe(true);
      expect(stage.overallRate).toBe(0);
    }
    expect(ratio(5, 0)).toBe(0);
  });
});

describe('visitor identity', () => {
  it('rotates the salt period every UTC day', () => {
    expect(dailySaltPeriod(new Date('2026-03-01T00:00:00Z'))).toBe('2026-03-01');
    expect(dailySaltPeriod(new Date('2026-03-01T23:59:59Z'))).toBe('2026-03-01');
    expect(dailySaltPeriod(new Date('2026-03-02T00:00:00Z'))).toBe('2026-03-02');
  });

  it('produces different material for the same visitor on different days', () => {
    // This is the property that makes a cross-day profile impossible: yesterday
    // and today hash to unrelated ids, and yesterday's salt is gone.
    const monday = visitorFingerprintMaterial({
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
      salt: 'salt-for-monday',
    });
    const tuesday = visitorFingerprintMaterial({
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
      salt: 'salt-for-tuesday',
    });
    expect(monday).not.toBe(tuesday);
  });

  it('separates fields so two visitors cannot collapse into one', () => {
    // Without a separator, ("ab", "c") and ("a", "bc") concatenate identically.
    const first = visitorFingerprintMaterial({
      ipAddress: '10.0.0.1',
      userAgent: '2Mozilla',
      salt: 's',
    });
    const second = visitorFingerprintMaterial({
      ipAddress: '10.0.0.12',
      userAgent: 'Mozilla',
      salt: 's',
    });
    expect(first).not.toBe(second);
  });
});

describe('retention', () => {
  it('cuts raw events off at thirty days', () => {
    const now = new Date('2026-03-31T12:00:00Z');
    expect(rawEventCutoff(now).toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(RAW_EVENT_RETENTION_DAYS).toBe(30);
  });
});

describe('day bucketing', () => {
  it('buckets in UTC', () => {
    expect(utcDayKey(new Date('2026-03-08T23:30:00Z'))).toBe('2026-03-08');
  });

  it('enumerates an inclusive range', () => {
    expect(dayKeyRange(new Date('2026-03-01T05:00:00Z'), new Date('2026-03-04T20:00:00Z'))).toEqual(
      ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'],
    );
  });

  it('spans a daylight-saving boundary without gaining or losing a day', () => {
    // US clocks change on 2026-03-08. In UTC nothing happens, which is exactly
    // why rollups are bucketed in UTC: a 23-hour day produces a dip people
    // explain with a story about customer behaviour.
    expect(dayKeyRange(new Date('2026-03-07T12:00:00Z'), new Date('2026-03-09T12:00:00Z'))).toEqual(
      ['2026-03-07', '2026-03-08', '2026-03-09'],
    );
  });

  it('returns a single day for a range inside one day', () => {
    expect(dayKeyRange(new Date('2026-03-01T01:00:00Z'), new Date('2026-03-01T23:00:00Z'))).toEqual(
      ['2026-03-01'],
    );
  });

  it('terminates on an inverted range instead of spinning', () => {
    expect(dayKeyRange(new Date('2026-03-05T00:00:00Z'), new Date('2026-03-01T00:00:00Z'))).toEqual(
      [],
    );
  });
});
