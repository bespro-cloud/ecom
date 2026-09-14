import { randomUUID } from 'node:crypto';
import {
  createHarness,
  signedInCustomer,
  signedInStaff,
  type SignedInCustomer,
  type SignedInStaff,
  type TestHarness,
} from './harness.js';
import { rollUpDay } from '@health/database';
import { utcDayKey } from '@health/types';

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

const auth = (who: SignedInStaff | SignedInCustomer) => ({ Authorization: `Bearer ${who.token}` });

const COLLECT = '/api/v1/analytics/collect';
const ADMIN = '/api/v1/admin/growth';
const PUBLIC = '/api/v1';

const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedProduct(options: { slug?: string; status?: 'PUBLISHED' | 'DRAFT' } = {}) {
  const sku = `HC-GR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const product = await harness.prisma.product.create({
    data: {
      sku,
      slug: options.slug ?? sku.toLowerCase(),
      name: 'Test Magnesium',
      type: 'SUPPLEMENT',
      status: options.status ?? 'PUBLISHED',
      complianceStatus: 'APPROVED',
      priceCents: 2400,
      weightGrams: 200,
      publishedAt: new Date(),
    },
  });
  return { productId: product.id, slug: product.slug };
}

/** Sends a beacon as an ordinary consenting browser would. */
function beacon(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return harness
    .http()
    .post(COLLECT)
    .set('user-agent', BROWSER)
    .set(headers)
    .send({ consent: true, ...body });
}

async function contentEditor(email = `editor-${randomUUID().slice(0, 8)}@example.test`) {
  return signedInStaff(harness, 'CONTENT_MANAGER', email);
}

async function complianceReviewer(email = `compliance-${randomUUID().slice(0, 8)}@example.test`) {
  return signedInStaff(harness, 'COMPLIANCE_REVIEWER', email);
}

// ===========================================================================
// Analytics collection — mostly tests of what is refused
// ===========================================================================

describe('the analytics beacon', () => {
  it('records an ordinary page view', async () => {
    await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'page_view', url: '/products' }],
    }).expect(202);

    const events = await harness.prisma.analyticsEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe('/products');
  });

  it('never stores a query string', async () => {
    // The property the whole path-handling design exists for. Query strings are
    // where personal data ends up by accident — an email in an unsubscribe
    // link, a reset token, a support reference — and on this site the thing
    // that leaks could be a health detail.
    await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'page_view', url: '/products?email=ada@example.test&token=secret123' }],
    }).expect(202);

    const events = await harness.prisma.analyticsEvent.findMany();
    expect(events[0]!.path).toBe('/products');

    const everything = JSON.stringify(events);
    expect(everything).not.toContain('ada@example.test');
    expect(everything).not.toContain('secret123');
  });

  it('refuses a purchase reported by a browser', async () => {
    // A conversion claimed by a client is a conversion claimed by whoever is
    // holding the keyboard. Inflating the funnel with curl must not be possible.
    const response = await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'order_placed', url: '/checkout' }],
    });

    expect(response.status).toBe(400);
    expect(await harness.prisma.analyticsEvent.count()).toBe(0);
  });

  it('refuses an event type nobody declared', async () => {
    await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'health_condition_selected', url: '/quiz' }],
    }).expect(400);
  });

  it('refuses an unexpected field rather than ignoring it', async () => {
    // `.strict()` on the schema. A silently-ignored field is a field somebody
    // later assumes is being stored.
    await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'page_view', url: '/', customerEmail: 'ada@example.test' }],
    }).expect(400);
  });

  it('honours Global Privacy Control over a consent flag', async () => {
    // GPC is legally binding under the CPRA. A browser-level opt-out is the
    // more considered instruction and beats a click in a banner.
    await beacon(
      { sessionId: randomUUID(), events: [{ type: 'page_view', url: '/' }] },
      { 'sec-gpc': '1' },
    ).expect(202);

    expect(await harness.prisma.analyticsEvent.count()).toBe(0);
    expect(await harness.prisma.analyticsSession.count()).toBe(0);
  });

  it('honours Do Not Track', async () => {
    await beacon(
      { sessionId: randomUUID(), events: [{ type: 'page_view', url: '/' }] },
      { dnt: '1' },
    ).expect(202);
    expect(await harness.prisma.analyticsEvent.count()).toBe(0);
  });

  it('records nothing without consent, and says nothing about why', async () => {
    // Consent is opt-in, and the response is identical either way: reporting
    // the refusal would make this an oracle for probing which visitors are
    // being measured.
    const refused = await harness
      .http()
      .post(COLLECT)
      .set('user-agent', BROWSER)
      .send({ sessionId: randomUUID(), consent: false, events: [{ type: 'page_view', url: '/' }] })
      .expect(202);

    expect(refused.body).toEqual({});
    expect(await harness.prisma.analyticsEvent.count()).toBe(0);
  });

  it('does not measure crawlers', async () => {
    await harness
      .http()
      .post(COLLECT)
      .set('user-agent', 'Googlebot/2.1 (+http://www.google.com/bot.html)')
      .send({ sessionId: randomUUID(), consent: true, events: [{ type: 'page_view', url: '/' }] })
      .expect(202);

    expect(await harness.prisma.analyticsEvent.count()).toBe(0);
  });

  it('stores no IP address anywhere', async () => {
    // The address is an input to a salted hash inside one function and is then
    // gone. Nothing downstream can recover it.
    await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'page_view', url: '/' }],
    })
      .set('x-forwarded-for', '203.0.113.45')
      .expect(202);

    const sessions = await harness.prisma.analyticsSession.findMany();
    expect(JSON.stringify(sessions)).not.toContain('203.0.113.45');

    // And structurally: no analytics table has a column one could be put in.
    const columns = await harness.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name LIKE 'analytics%'`,
    );
    const names = columns.map((row) => row.column_name);
    for (const forbidden of ['ip_address', 'customer_id', 'user_id', 'email', 'order_id']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('keeps a referrer host and throws its path away', async () => {
    await beacon({
      sessionId: randomUUID(),
      referrer: 'https://www.example.test/search?q=insomnia+treatment',
      events: [{ type: 'page_view', url: '/products' }],
    }).expect(202);

    const session = await harness.prisma.analyticsSession.findFirstOrThrow();
    expect(session.referrerHost).toBe('www.example.test');
    expect(JSON.stringify(session)).not.toContain('insomnia');
  });

  it('reads campaign labels from the landing URL and nothing else from it', async () => {
    await beacon({
      sessionId: randomUUID(),
      events: [
        {
          type: 'page_view',
          url: '/products?utm_source=newsletter&utm_medium=email&utm_campaign=spring&ref=ada@example.test',
        },
      ],
    }).expect(202);

    const session = await harness.prisma.analyticsSession.findFirstOrThrow();
    expect(session.utmSource).toBe('newsletter');
    expect(session.channel).toBe('email');
    expect(JSON.stringify(session)).not.toContain('ada@example.test');
  });

  it('cannot backdate an event into a rollup that is already closed', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'page_view', url: '/', occurredAt: yesterday.toISOString() }],
    }).expect(202);

    const event = await harness.prisma.analyticsEvent.findFirstOrThrow();
    expect(event.day).toBe(utcDayKey(new Date()));
  });

  it('moves a session forward through the funnel and never backwards', async () => {
    const sessionId = randomUUID();
    const product = await seedProduct();

    await beacon({
      sessionId,
      events: [
        { type: 'page_view', url: '/' },
        { type: 'product_view', url: `/products/${product.slug}`, productId: product.productId },
        {
          type: 'add_to_cart',
          url: `/products/${product.slug}`,
          productId: product.productId,
          quantity: 2,
        },
        { type: 'checkout_started', url: '/checkout' },
      ],
    }).expect(202);

    // Browsing back to a product afterwards must not undo reaching checkout.
    await beacon({
      sessionId,
      events: [
        { type: 'product_view', url: `/products/${product.slug}`, productId: product.productId },
      ],
    }).expect(202);

    const session = await harness.prisma.analyticsSession.findFirstOrThrow();
    expect(session.furthestStep).toBe('STARTED_CHECKOUT');
  });

  it('gives the same visitor a different id on a different day', async () => {
    // Yesterday's salt is discarded, so two days' hashes for one person are
    // unrelated. This is what makes "unique visitors today" possible and a
    // cross-day browsing profile impossible.
    await beacon({ sessionId: randomUUID(), events: [{ type: 'page_view', url: '/' }] }).expect(
      202,
    );
    const today = await harness.prisma.analyticsSession.findFirstOrThrow();

    const yesterdayKey = utcDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await harness.prisma.analyticsSalt.create({
      data: { day: yesterdayKey, secret: 'a-different-salt-entirely' },
    });

    const salts = await harness.prisma.analyticsSalt.findMany();
    expect(salts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(salts.map((salt) => salt.secret)).size).toBe(salts.length);
    expect(today.visitorHash).not.toContain('203.0.113');
  });
});

// ===========================================================================
// The database refuses to let analytics become identifying
// ===========================================================================

describe('the anonymity guarantee', () => {
  it('refuses a migration that would add an identifying column', async () => {
    // Not a convention or a comment — an event trigger. If somebody two years
    // from now adds a customer_id to an analytics table, the migration fails.
    await expect(
      harness.prisma.$executeRawUnsafe('ALTER TABLE analytics_events ADD COLUMN customer_id uuid'),
    ).rejects.toThrow(/would make analytics identifying/i);

    await expect(
      harness.prisma.$executeRawUnsafe('ALTER TABLE analytics_sessions ADD COLUMN email text'),
    ).rejects.toThrow(/would make analytics identifying/i);
  });

  it('refuses a stored path that is really a URL with a query string', async () => {
    const session = await harness.prisma.analyticsSession.create({
      data: { publicId: randomUUID(), visitorHash: 'h', day: utcDayKey(new Date()) },
    });

    await expect(
      harness.prisma.analyticsEvent.create({
        data: {
          sessionId: session.id,
          type: 'page_view',
          path: '/products?email=ada@example.test',
          day: utcDayKey(new Date()),
        },
      }),
    ).rejects.toThrow(/analytics_event_path_is_a_path/i);
  });

  it('refuses a referrer stored as a path rather than a host', async () => {
    await expect(
      harness.prisma.analyticsSession.create({
        data: {
          publicId: randomUUID(),
          visitorHash: 'h',
          day: utcDayKey(new Date()),
          referrerHost: 'www.example.test/search?q=symptoms',
        },
      }),
    ).rejects.toThrow(/analytics_session_referrer_is_a_host/i);
  });

  it('refuses a funnel that widens as it descends', async () => {
    // A rollup producing more orders than sessions is a bug, and it would show
    // up as a conversion rate above 100% on a dashboard somebody trusts.
    await expect(
      harness.prisma.analyticsDailyMetric.create({
        data: {
          day: '2026-01-01',
          sessions: 10,
          reachedViewedProduct: 5,
          reachedAddedToCart: 4,
          reachedStartedCheckout: 3,
          reachedOrdered: 99,
        },
      }),
    ).rejects.toThrow(/analytics_daily_funnel_is_cumulative/i);
  });
});

// ===========================================================================
// Conversion and revenue
// ===========================================================================

describe('conversion and revenue', () => {
  /** An order placed today, with a campaign label on it. */
  async function seedOrder(channel: string, totalCents: number, status = 'PAID') {
    return harness.prisma.order.create({
      data: {
        reference: `HC-G-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        email: 'ada@example.test',
        status: status as never,
        paymentStatus: 'CAPTURED',
        subtotalCents: totalCents,
        totalCents,
        amountPaidCents: totalCents,
        attributionChannel: channel,
        placedAt: new Date(),
        shippingAddress: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          line1: '1 Way',
          city: 'SLC',
          region: 'UT',
          postalCode: '84101',
          country: 'US',
        } as never,
      },
    });
  }

  it('takes revenue from the orders table, never from a browser', async () => {
    const day = utcDayKey(new Date());
    await seedOrder('email', 5000);
    await seedOrder('email', 2500);

    await rollUpDay({ prisma: harness.prisma, now: () => new Date() }, day);

    const channel = await harness.prisma.analyticsChannelDaily.findFirstOrThrow({
      where: { day, channel: 'email' },
    });
    expect(channel.orders).toBe(2);
    expect(channel.revenueCents).toBe(7500);
  });

  it('excludes cancelled and unpaid orders from revenue', async () => {
    // Revenue that was never collected was never revenue.
    const day = utcDayKey(new Date());
    await seedOrder('email', 5000);
    await seedOrder('email', 9999, 'CANCELLED');
    await seedOrder('email', 8888, 'PENDING_PAYMENT');

    await rollUpDay({ prisma: harness.prisma, now: () => new Date() }, day);

    const channel = await harness.prisma.analyticsChannelDaily.findFirstOrThrow({
      where: { day, channel: 'email' },
    });
    expect(channel.orders).toBe(1);
    expect(channel.revenueCents).toBe(5000);
  });

  it('attributes an order with no recorded channel to direct rather than dropping it', async () => {
    // Silently losing orders from a revenue report is worse than filing them
    // under the least specific bucket.
    const day = utcDayKey(new Date());
    await harness.prisma.order.create({
      data: {
        reference: `HC-G-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        email: 'ada@example.test',
        status: 'PAID',
        paymentStatus: 'CAPTURED',
        subtotalCents: 1000,
        totalCents: 1000,
        amountPaidCents: 1000,
        placedAt: new Date(),
        shippingAddress: {
          firstName: 'A',
          lastName: 'B',
          line1: '1',
          city: 'C',
          region: 'UT',
          postalCode: '84101',
          country: 'US',
        } as never,
      },
    });

    await rollUpDay({ prisma: harness.prisma, now: () => new Date() }, day);

    const direct = await harness.prisma.analyticsChannelDaily.findFirstOrThrow({
      where: { day, channel: 'direct' },
    });
    expect(direct.orders).toBe(1);
    expect(direct.revenueCents).toBe(1000);
  });

  it('never stores a link from an order to the visit that produced it', async () => {
    // The central privacy property of the whole design. Campaign ROI is one
    // aggregate divided by another; there is no session id on an order and no
    // column to put one in, so a named customer cannot be joined to their
    // browsing.
    const columns = await harness.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('orders', 'checkouts')`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain('analytics_session_id');
    expect(names).not.toContain('session_id');
    expect(names).not.toContain('visitor_hash');
  });

  it('rebuilds a day rather than incrementing it, so a re-run is safe', async () => {
    const day = utcDayKey(new Date());
    await seedOrder('email', 5000);

    const deps = { prisma: harness.prisma, now: () => new Date() };
    await rollUpDay(deps, day);
    await rollUpDay(deps, day);
    await rollUpDay(deps, day);

    const channel = await harness.prisma.analyticsChannelDaily.findFirstOrThrow({
      where: { day, channel: 'email' },
    });
    // Three runs, one order. A counter that incremented would read 3 / 15000.
    expect(channel.orders).toBe(1);
    expect(channel.revenueCents).toBe(5000);
  });

  it('reports a funnel and a conversion rate through the admin API', async () => {
    const analyst = await signedInStaff(
      harness,
      'ANALYST',
      `analyst-${randomUUID().slice(0, 8)}@example.test`,
    );
    const day = utcDayKey(new Date());

    await beacon({
      sessionId: randomUUID(),
      events: [{ type: 'page_view', url: '/' }],
    }).expect(202);
    await seedOrder('direct', 4200);
    await rollUpDay({ prisma: harness.prisma, now: () => new Date() }, day);

    const response = await harness
      .http()
      .get(`${ADMIN}/analytics/overview?from=${day}&to=${day}`)
      .set(auth(analyst))
      .expect(200);

    expect(response.body.totals.sessions).toBe(1);
    expect(response.body.totals.orders).toBe(1);
    expect(response.body.totals.revenueCents).toBe(4200);
    expect(response.body.totals.conversionRate).toBeCloseTo(1);
    expect(response.body.funnel).toHaveLength(5);
  });

  it('refuses a reader without ANALYTICS_READ', async () => {
    const customer = await signedInCustomer(harness);
    await harness.http().get(`${ADMIN}/analytics/overview`).set(auth(customer)).expect(403);
  });
});

// ===========================================================================
// Retention
// ===========================================================================

describe('retention', () => {
  it('deletes raw events and the salts that went with them', async () => {
    const { pruneAnalytics } = await import('@health/database');

    const oldDay = '2020-01-01';
    const session = await harness.prisma.analyticsSession.create({
      data: {
        publicId: randomUUID(),
        visitorHash: 'old',
        day: oldDay,
        startedAt: new Date('2020-01-01T00:00:00Z'),
        lastSeenAt: new Date('2020-01-01T00:00:00Z'),
      },
    });
    await harness.prisma.analyticsEvent.create({
      data: {
        sessionId: session.id,
        type: 'page_view',
        path: '/products/something-revealing',
        day: oldDay,
        occurredAt: new Date('2020-01-01T00:00:00Z'),
      },
    });
    await harness.prisma.analyticsSalt.create({ data: { day: oldDay, secret: 'old-salt' } });

    // The rollup for that day survives: a count is not about anybody.
    await harness.prisma.analyticsDailyMetric.create({ data: { day: oldDay, sessions: 1 } });

    const removed = await pruneAnalytics({ prisma: harness.prisma, now: () => new Date() });

    expect(removed.events).toBeGreaterThanOrEqual(1);
    expect(removed.salts).toBeGreaterThanOrEqual(1);
    expect(await harness.prisma.analyticsEvent.count({ where: { day: oldDay } })).toBe(0);
    expect(await harness.prisma.analyticsSalt.count({ where: { day: oldDay } })).toBe(0);
    expect(await harness.prisma.analyticsDailyMetric.count({ where: { day: oldDay } })).toBe(1);
  });
});

// ===========================================================================
// Blog and its compliance gate
// ===========================================================================

describe('the blog compliance gate', () => {
  async function draftPost(options: { productIds?: string[]; slug?: string } = {}) {
    const editor = await contentEditor();
    const created = await harness
      .http()
      .post(`${ADMIN}/blog/posts`)
      .set(auth(editor))
      .send({
        slug: options.slug ?? `post-${randomUUID().slice(0, 8)}`,
        title: 'How magnesium supports restful sleep',
        excerpt: 'A look at the evidence.',
        blocks: [{ id: 'b1', type: 'richText', markdown: 'Magnesium is an essential mineral.' }],
        productIds: options.productIds ?? [],
      })
      .expect(201);
    return { editor, postId: created.body.id as string, body: created.body };
  }

  it('publishes a post that names no product on the editor’s own authority', async () => {
    // The gate is on claims about products, not a bureaucracy for every page.
    const { editor, postId } = await draftPost();

    const published = await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(201);

    expect(published.body.status).toBe('PUBLISHED');
    expect(published.body.needsCompliance).toBe(false);
  });

  it('refuses to publish a post that names a product without compliance approval', async () => {
    // The property this whole gate exists for. An article headlined "how
    // magnesium helps you sleep" that links to a magnesium product is making a
    // claim about that product.
    const product = await seedProduct();
    const { editor, postId } = await draftPost({ productIds: [product.productId] });

    const refused = await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(422);

    expect(refused.body.error.message).toMatch(/compliance approval/i);

    const post = await harness.prisma.blogPost.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).not.toBe('PUBLISHED');
  });

  it('refuses it in the database too, whatever the code path', async () => {
    const product = await seedProduct();
    const { postId } = await draftPost({ productIds: [product.productId] });

    await expect(
      harness.prisma.blogPost.update({
        where: { id: postId },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      }),
    ).rejects.toThrow(/blog_post_with_products_needs_compliance/i);
  });

  it('does not let the writer approve their own copy', async () => {
    // Separation of duty, the same as claims: a writer who could sign off their
    // own product claims is not a gate, it is a formality.
    const product = await seedProduct();
    const { editor, postId } = await draftPost({ productIds: [product.productId] });

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(editor))
      .send({ decision: 'APPROVED', notes: 'Looks fine to me, I wrote it.' })
      .expect(403);
  });

  it('does not let an administrator approve it either', async () => {
    const product = await seedProduct();
    const { postId } = await draftPost({ productIds: [product.productId] });
    const admin = await signedInStaff(
      harness,
      'ADMIN',
      `admin-${randomUUID().slice(0, 8)}@example.test`,
    );

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(admin))
      .send({ decision: 'APPROVED', notes: 'Approving this as the administrator.' })
      .expect(403);
  });

  it('publishes once a compliance reviewer approves, and records what they read', async () => {
    const product = await seedProduct();
    const { editor, postId } = await draftPost({ productIds: [product.productId] });
    const reviewer = await complianceReviewer();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(reviewer))
      .send({
        decision: 'APPROVED',
        notes:
          'Structure/function wording only; no disease claim. Evidence on file for the cited study.',
      })
      .expect(201);

    const published = await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(201);
    expect(published.body.status).toBe('PUBLISHED');

    const decisions = await harness.prisma.blogPostReview.findMany({ where: { postId } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.notes).toMatch(/no disease claim/i);
    // The text is snapshotted, so "what did they approve?" survives later edits.
    expect(decisions[0]!.reviewedTitle).toMatch(/magnesium/i);
  });

  it('requires written reasoning on either outcome', async () => {
    const product = await seedProduct();
    const { postId } = await draftPost({ productIds: [product.productId] });
    const reviewer = await complianceReviewer();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(reviewer))
      .send({ decision: 'APPROVED', notes: 'ok' })
      .expect(400);
  });

  it('will not publish text that differs from what was approved', async () => {
    // The property the gate actually needs. "A published post has an approval"
    // is necessary and not sufficient — a post could be approved as a recipe
    // and published as a disease claim. The approval is bound to the text.
    const product = await seedProduct();
    const { editor, postId } = await draftPost({ productIds: [product.productId] });
    const reviewer = await complianceReviewer();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(reviewer))
      .send({ decision: 'APPROVED', notes: 'No disease claim in this wording.' })
      .expect(201);

    await harness
      .http()
      .patch(`${ADMIN}/blog/posts/${postId}`)
      .set(auth(editor))
      .send({ blocks: [{ id: 'b1', type: 'richText', markdown: 'Magnesium cures insomnia.' }] })
      .expect(200);

    const refused = await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(422);
    expect(refused.body.error.message).toMatch(/changed since it was approved/i);

    // The record of what the reviewer read survives the edit. Editing does not
    // change what they read, and destroying the record would lose the answer to
    // "what was approved, and by whom?".
    const post = await harness.prisma.blogPost.findUniqueOrThrow({ where: { id: postId } });
    expect(post.complianceApprovedAt).not.toBeNull();
    expect(post.complianceApprovedByLabel).toBe(reviewer.email);

    const detail = await harness
      .http()
      .get(`${ADMIN}/blog/posts/${postId}`)
      .set(auth(editor))
      .expect(200);
    expect(detail.body.publishable).toBe(false);
    expect(detail.body.approvalMatchesCurrentText).toBe(false);
  });

  it('refuses in the database too when the published text is not the approved text', async () => {
    // Belt and braces: even a direct UPDATE cannot put unapproved words on a
    // public page, because the CHECK recomputes the hash from what is actually
    // published.
    const product = await seedProduct();
    const { editor, postId } = await draftPost({ productIds: [product.productId] });
    const reviewer = await complianceReviewer();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(reviewer))
      .send({ decision: 'APPROVED', notes: 'Structure/function wording only.' })
      .expect(201);
    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(201);

    await expect(
      harness.prisma.blogPost.update({
        where: { id: postId },
        data: { blocks: [{ id: 'b1', type: 'richText', markdown: 'Cures insomnia.' }] as never },
      }),
    ).rejects.toThrow(/blog_post_with_products_needs_compliance/i);
  });

  it('keeps serving the approved text when a live post is edited', async () => {
    // Editing must not silently take a live page down, and must not silently
    // put unreviewed words on it either. The edit sits in the draft.
    const product = await seedProduct();
    const { editor, postId } = await draftPost({ productIds: [product.productId] });
    const reviewer = await complianceReviewer();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(reviewer))
      .send({ decision: 'APPROVED', notes: 'Approved: structure/function wording only.' })
      .expect(201);
    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(201);

    await harness
      .http()
      .patch(`${ADMIN}/blog/posts/${postId}`)
      .set(auth(editor))
      .send({ title: 'Magnesium cures insomnia' })
      .expect(200);

    const post = await harness.prisma.blogPost.findUniqueOrThrow({ where: { id: postId } });
    // Still live, still serving the words the reviewer approved. The unapproved
    // edit is in the draft and cannot reach a reader without a fresh review.
    expect(post.status).toBe('PUBLISHED');
    expect(post.title).not.toMatch(/cures/i);
    expect(post.draftTitle).toMatch(/cures/i);

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(422);

    const reader = await harness.http().get(`${PUBLIC}/blog/posts/${post.slug}`).expect(200);
    expect(reader.body.title).not.toMatch(/cures/i);
  });

  it('surfaces wording worth a second look without acting on it', async () => {
    const product = await seedProduct();
    const editor = await contentEditor();
    const created = await harness
      .http()
      .post(`${ADMIN}/blog/posts`)
      .set(auth(editor))
      .send({
        slug: `post-${randomUUID().slice(0, 8)}`,
        title: 'Our guide',
        blocks: [
          { id: 'b1', type: 'richText', markdown: 'Some customers say it cures their insomnia.' },
        ],
        productIds: [product.productId],
      })
      .expect(201);

    const detail = await harness
      .http()
      .get(`${ADMIN}/blog/posts/${created.body.id}`)
      .set(auth(editor))
      .expect(200);

    // A prompt for the reviewer, and nothing more: the post is not rejected,
    // not escalated, and its state is unchanged.
    expect(detail.body.claimPromptTerms.length).toBeGreaterThan(0);
    expect(detail.body.status).toBe('DRAFT');
  });

  it('shows only published posts to a visitor', async () => {
    const { editor, postId } = await draftPost({ slug: 'visible-post' });
    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(201);
    await draftPost({ slug: 'hidden-draft' });

    const listed = await harness.http().get(`${PUBLIC}/blog/posts`).expect(200);
    const slugs = listed.body.data.map((post: { slug: string }) => post.slug);
    expect(slugs).toContain('visible-post');
    expect(slugs).not.toContain('hidden-draft');

    await harness.http().get(`${PUBLIC}/blog/posts/hidden-draft`).expect(404);
  });

  it('stops linking to a product that was withdrawn after approval', async () => {
    // A withdrawn listing is usually withdrawn for a reason, and a blog post is
    // not a back door to it.
    const product = await seedProduct({ slug: 'withdrawn-product' });
    const { editor, postId } = await draftPost({
      productIds: [product.productId],
      slug: 'linked-post',
    });
    const reviewer = await complianceReviewer();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(reviewer))
      .send({ decision: 'APPROVED', notes: 'Approved against the current listing.' })
      .expect(201);
    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(201);

    const before = await harness.http().get(`${PUBLIC}/blog/posts/linked-post`).expect(200);
    expect(before.body.products).toHaveLength(1);

    await harness.prisma.product.update({
      where: { id: product.productId },
      data: { status: 'DRAFT', publishedAt: null },
    });

    const after = await harness.http().get(`${PUBLIC}/blog/posts/linked-post`).expect(200);
    expect(after.body.products).toHaveLength(0);
  });

  it('does not let a compliance decision be edited or deleted afterwards', async () => {
    const product = await seedProduct();
    const { postId } = await draftPost({ productIds: [product.productId] });
    const reviewer = await complianceReviewer();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/review`)
      .set(auth(reviewer))
      .send({ decision: 'REJECTED', notes: 'This reads as a disease claim; please reword.' })
      .expect(201);

    const decision = await harness.prisma.blogPostReview.findFirstOrThrow({ where: { postId } });

    await expect(
      harness.prisma.blogPostReview.update({
        where: { id: decision.id },
        data: { notes: 'Actually it was fine.' },
      }),
    ).rejects.toThrow();

    await expect(
      harness.prisma.blogPostReview.delete({ where: { id: decision.id } }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// Redirects
// ===========================================================================

describe('redirects', () => {
  async function seoStaff() {
    return signedInStaff(
      harness,
      'CONTENT_MANAGER',
      `seo-${randomUUID().slice(0, 8)}@example.test`,
    );
  }

  it('writes one automatically when a published product is renamed', async () => {
    // A listing indexed for two years that silently starts 404ing loses its
    // ranking, and nobody notices until the traffic has gone.
    const staff = await signedInStaff(
      harness,
      'PRODUCT_MANAGER',
      `pm-${randomUUID().slice(0, 8)}@example.test`,
    );
    const product = await seedProduct({ slug: 'old-magnesium' });

    await harness
      .http()
      .patch(`/api/v1/admin/catalogue/products/${product.productId}`)
      .set(auth(staff))
      .send({ slug: 'new-magnesium' })
      .expect(200);

    const redirect = await harness.prisma.redirect.findUniqueOrThrow({
      where: { fromPath: '/products/old-magnesium' },
    });
    expect(redirect.toPath).toBe('/products/new-magnesium');
    expect(redirect.statusCode).toBe(301);
    expect(redirect.isAutomatic).toBe(true);
  });

  it('collapses a chain rather than letting it grow', async () => {
    // Rename twice and a naive implementation gives A → B → C, which costs a
    // round trip and which search engines stop following.
    const staff = await signedInStaff(
      harness,
      'PRODUCT_MANAGER',
      `pm-${randomUUID().slice(0, 8)}@example.test`,
    );
    const product = await seedProduct({ slug: 'first-name' });

    const patch = (slug: string) =>
      harness
        .http()
        .patch(`/api/v1/admin/catalogue/products/${product.productId}`)
        .set(auth(staff))
        .send({ slug })
        .expect(200);

    await patch('second-name');
    await patch('third-name');

    const first = await harness.prisma.redirect.findUniqueOrThrow({
      where: { fromPath: '/products/first-name' },
    });
    expect(first.toPath).toBe('/products/third-name');
  });

  it('resolves a path to its destination for the storefront', async () => {
    const staff = await seoStaff();
    await harness
      .http()
      .post(`${ADMIN}/redirects`)
      .set(auth(staff))
      .send({ fromPath: '/old', toPath: '/new', reason: 'moved' })
      .expect(201);

    const resolved = await harness
      .http()
      .post(`${PUBLIC}/redirects/resolve`)
      .send({ path: '/old' })
      .expect(200);

    expect(resolved.body.redirect).toEqual({ toPath: '/new', statusCode: 301 });
  });

  it('says nothing for a path with no redirect', async () => {
    const resolved = await harness
      .http()
      .post(`${PUBLIC}/redirects/resolve`)
      .send({ path: '/products/whatever' })
      .expect(200);
    expect(resolved.body.redirect).toBeNull();
  });

  it('refuses a rule that would close a loop', async () => {
    // A loop is not a degraded experience; it is the page becoming unreachable.
    const staff = await seoStaff();
    await harness
      .http()
      .post(`${ADMIN}/redirects`)
      .set(auth(staff))
      .send({ fromPath: '/a', toPath: '/b' })
      .expect(201);

    await harness
      .http()
      .post(`${ADMIN}/redirects`)
      .set(auth(staff))
      .send({ fromPath: '/b', toPath: '/a' })
      .expect(409);
  });

  it('refuses a redirect to itself in the database too', async () => {
    await expect(
      harness.prisma.redirect.create({ data: { fromPath: '/same', toPath: '/same' } }),
    ).rejects.toThrow(/redirect_is_not_a_self_loop/i);
  });

  it('refuses an insecure destination', async () => {
    // Redirecting from a secure page to an insecure one is a downgrade, and a
    // 301 makes it sticky in the visitor's browser.
    const staff = await seoStaff();
    await harness
      .http()
      .post(`${ADMIN}/redirects`)
      .set(auth(staff))
      .send({ fromPath: '/x', toPath: 'http://elsewhere.example.test/x' })
      .expect(400);
  });

  it('counts hits without recording who made them', async () => {
    const staff = await seoStaff();
    await harness
      .http()
      .post(`${ADMIN}/redirects`)
      .set(auth(staff))
      .send({ fromPath: '/counted', toPath: '/destination' })
      .expect(201);

    await harness.http().post(`${PUBLIC}/redirects/resolve`).send({ path: '/counted' }).expect(200);
    // The counter is updated fire-and-forget, so give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const redirect = await harness.prisma.redirect.findUniqueOrThrow({
      where: { fromPath: '/counted' },
    });
    expect(redirect.hitCount).toBeGreaterThanOrEqual(1);
    // A count, with no visitor attached to it.
    expect(Object.keys(redirect)).not.toContain('visitorHash');
  });
});

// ===========================================================================
// SEO audit
// ===========================================================================

describe('the SEO audit', () => {
  it('reports a missing description rather than writing one', async () => {
    // The line through "SEO automation": mechanics are automated, words are
    // not. A generated meta description for a supplement is exactly the
    // plausible sentence that claims something nobody reviewed.
    const staff = await signedInStaff(
      harness,
      'CONTENT_MANAGER',
      `seo-${randomUUID().slice(0, 8)}@example.test`,
    );
    const product = await seedProduct();

    const report = await harness.http().get(`${ADMIN}/seo/audit`).set(auth(staff)).expect(200);

    const finding = report.body.issues.find(
      (issue: { entityId: string; code: string }) =>
        issue.entityId === product.productId && issue.code === 'missing_description',
    );
    expect(finding).toBeDefined();
    expect(finding.message).toMatch(/nothing in this system will generate copy/i);

    // And nothing was written.
    const meta = await harness.prisma.seoMetadata.findFirst({
      where: { entityType: 'PRODUCT', entityId: product.productId },
    });
    expect(meta?.description ?? null).toBeNull();
  });

  it('flags a published product that is excluded from the index', async () => {
    const staff = await signedInStaff(
      harness,
      'CONTENT_MANAGER',
      `seo-${randomUUID().slice(0, 8)}@example.test`,
    );
    const product = await seedProduct();
    await harness.prisma.seoMetadata.create({
      data: {
        entityType: 'PRODUCT',
        entityId: product.productId,
        title: 'A perfectly reasonable title here',
        description: 'A description long enough to pass the minimum length check for this audit.',
        noindex: true,
      },
    });

    const report = await harness.http().get(`${ADMIN}/seo/audit`).set(auth(staff)).expect(200);
    expect(
      report.body.issues.some(
        (issue: { entityId: string; code: string }) =>
          issue.entityId === product.productId && issue.code === 'published_but_noindex',
      ),
    ).toBe(true);
  });

  it('keeps a noindex page out of the sitemap', async () => {
    const page = await harness.prisma.page.create({
      data: { slug: 'hidden-page', title: 'Hidden', status: 'PUBLISHED', publishedAt: new Date() },
    });
    await harness.prisma.page.create({
      data: { slug: 'listed-page', title: 'Listed', status: 'PUBLISHED', publishedAt: new Date() },
    });
    await harness.prisma.seoMetadata.create({
      data: { entityType: 'PAGE', entityId: page.id, noindex: true },
    });

    const sitemap = await harness.http().get('/api/v1/catalogue/sitemap').expect(200);
    const slugs = sitemap.body.pages.map((entry: { slug: string }) => entry.slug);
    expect(slugs).toContain('listed-page');
    expect(slugs).not.toContain('hidden-page');
  });

  it('lists published blog posts in the sitemap', async () => {
    const { editor, postId } = await (async () => {
      const editor = await contentEditor();
      const created = await harness
        .http()
        .post(`${ADMIN}/blog/posts`)
        .set(auth(editor))
        .send({ slug: 'indexed-post', title: 'An indexable post', blocks: [] })
        .expect(201);
      return { editor, postId: created.body.id as string };
    })();

    await harness
      .http()
      .post(`${ADMIN}/blog/posts/${postId}/publish`)
      .set(auth(editor))
      .expect(201);

    const sitemap = await harness.http().get('/api/v1/catalogue/sitemap').expect(200);
    expect(sitemap.body.posts.map((entry: { slug: string }) => entry.slug)).toContain(
      'indexed-post',
    );
  });
});
