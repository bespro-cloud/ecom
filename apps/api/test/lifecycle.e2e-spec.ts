import {
  createHarness,
  signedInCustomer,
  signedInStaff,
  type SignedInCustomer,
  type SignedInStaff,
  type TestHarness,
} from './harness.js';
import { SubscriptionsService } from '../src/modules/lifecycle/subscriptions/subscriptions.service.js';
import { DEV_DECLINING_PAYMENT_METHOD, createPaymentProvider } from '@health/payments';
import { billSubscriptionPeriod, listDueSubscriptions } from '@health/database';
import { parseServerEnv } from '@health/config';

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

const ACCOUNT = '/api/v1/account';
const ADMIN = '/api/v1/admin/lifecycle';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedProduct(options: { priceCents?: number; subscribable?: boolean } = {}) {
  const sku = `HC-LC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const product = await harness.prisma.product.create({
    data: {
      sku,
      slug: sku.toLowerCase(),
      name: 'Test Magnesium',
      type: 'SUPPLEMENT',
      status: 'PUBLISHED',
      complianceStatus: 'APPROVED',
      priceCents: options.priceCents ?? 2400,
      weightGrams: 200,
      subscriptionEligible: options.subscribable ?? true,
      publishedAt: new Date(),
    },
  });
  const variant = await harness.prisma.productVariant.create({
    data: { productId: product.id, sku: `${sku}-V1`, name: '120 capsules', isActive: true },
  });
  return {
    productId: product.id,
    variantId: variant.id,
    slug: product.slug,
    priceCents: options.priceCents ?? 2400,
  };
}

/** A delivered order line, so a review can be a verified purchase. */
async function seedOrderLine(customerId: string, productId: string, variantId: string) {
  const order = await harness.prisma.order.create({
    data: {
      reference: `HC-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      customerId,
      email: 'ada@example.test',
      status: 'DELIVERED',
      paymentStatus: 'CAPTURED',
      subtotalCents: 2400,
      totalCents: 2400,
      amountPaidCents: 2400,
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
  const item = await harness.prisma.orderItem.create({
    data: {
      orderId: order.id,
      productId,
      variantId,
      sku: 'X',
      productName: 'Test Magnesium',
      variantName: '120 capsules',
      quantity: 1,
      unitPriceCents: 2400,
      lineSubtotalCents: 2400,
      lineTotalCents: 2400,
    },
  });
  return { orderId: order.id, orderItemId: item.id };
}

const REVIEW = {
  rating: 5,
  title: 'Good',
  body: 'Arrived quickly and the capsules are easy to swallow.',
  authorDisplayName: 'Ada',
};

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

describe('writing a review', () => {
  it('is never visible on the strength of writing it', async () => {
    // The assertion the whole moderation design exists for. A review that
    // appeared immediately would put unreviewed customer claims about a health
    // product straight onto a public listing.
    const product = await seedProduct();
    const customer = await signedInCustomer(harness);

    const response = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(customer))
      .send({ productId: product.productId, ...REVIEW })
      .expect(201);

    expect(response.body.status).toBe('PENDING');
    expect(response.body.visibility).toMatch(/waiting to be read/i);

    const published = await harness.prisma.productReview.findMany({
      where: { productId: product.productId, status: 'PUBLISHED' },
    });
    expect(published).toEqual([]);
  });

  it('earns the verified badge only from the reviewer’s own purchase', async () => {
    const product = await seedProduct();
    const customer = await signedInCustomer(harness);
    const line = await seedOrderLine(customer.customerId, product.productId, product.variantId);

    const response = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(customer))
      .send({ productId: product.productId, orderItemId: line.orderItemId, ...REVIEW })
      .expect(201);

    expect(response.body.verifiedPurchase).toBe(true);
  });

  it('refuses a badge claimed against somebody else’s order', async () => {
    // The badge is the whole value of "verified purchase". If another
    // customer's order line could earn it, it would mean nothing.
    const product = await seedProduct();
    const buyer = await signedInCustomer(harness, 'buyer@example.test');
    const stranger = await signedInCustomer(harness, 'stranger@example.test');
    const line = await seedOrderLine(buyer.customerId, product.productId, product.variantId);

    const response = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(stranger))
      .send({ productId: product.productId, orderItemId: line.orderItemId, ...REVIEW });

    expect(response.status).toBe(422);
  });

  it('refuses a badge claimed against a purchase of a different product', async () => {
    const bought = await seedProduct();
    const other = await seedProduct();
    const customer = await signedInCustomer(harness);
    const line = await seedOrderLine(customer.customerId, bought.productId, bought.variantId);

    const response = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(customer))
      .send({ productId: other.productId, orderItemId: line.orderItemId, ...REVIEW });

    expect(response.status).toBe(422);
  });

  it('cannot review the same purchase twice', async () => {
    const product = await seedProduct();
    const customer = await signedInCustomer(harness);
    const line = await seedOrderLine(customer.customerId, product.productId, product.variantId);

    const body = { productId: product.productId, orderItemId: line.orderItemId, ...REVIEW };
    await harness.http().post(`${ACCOUNT}/reviews`).set(auth(customer)).send(body).expect(201);
    const second = await harness.http().post(`${ACCOUNT}/reviews`).set(auth(customer)).send(body);

    expect(second.status).toBe(409);
  });

  it('flags wording that needs a health-claim check, without acting on it', async () => {
    const product = await seedProduct();
    const customer = await signedInCustomer(harness);

    await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(customer))
      .send({
        productId: product.productId,
        rating: 5,
        body: 'This cured my insomnia completely, I no longer need my prescription.',
        authorDisplayName: 'Ada',
      })
      .expect(201);

    const review = await harness.prisma.productReview.findFirstOrThrow({
      where: { productId: product.productId },
    });

    expect(review.claimPromptTerms).toContain('cured');
    // The prompt changed nothing about the review's state. It is a banner for
    // a moderator, not a decision.
    expect(review.status).toBe('PENDING');
  });
});

describe('the reviews a product page may show', () => {
  const PUBLIC = '/api/v1/catalogue/products';

  async function publishedReview(productId: string, rating: number) {
    const customer = await signedInCustomer(harness);
    const created = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(customer))
      .send({ productId, ...REVIEW, rating })
      .expect(201);
    const moderator = await signedInStaff(
      harness,
      'ADMIN',
      `mod-${Math.random().toString(36).slice(2, 8)}@example.test`,
    );
    await harness
      .http()
      .post(`${ADMIN}/reviews/${created.body.id}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'PUBLISHED', notes: 'Ordinary feedback, no health claim.' })
      .expect(201);
    return created.body.id as string;
  }

  it('is readable without an account, and shows only what a moderator approved', async () => {
    const product = await seedProduct();
    await publishedReview(product.productId, 5);

    // Written but never moderated. It must not appear, and must not move the
    // average — a rating averaged over unmoderated text lets rejected words
    // influence the number even while they stay hidden.
    const pendingAuthor = await signedInCustomer(harness);
    await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(pendingAuthor))
      .send({ productId: product.productId, ...REVIEW, rating: 1 })
      .expect(201);

    const response = await harness.http().get(`${PUBLIC}/${product.slug}/reviews`).expect(200);

    expect(response.body.reviews).toHaveLength(1);
    expect(response.body.summary.count).toBe(1);
    expect(response.body.summary.average).toBe(5);
  });

  it('reports no rating rather than zero stars when nothing is published', async () => {
    const product = await seedProduct();
    const response = await harness.http().get(`${PUBLIC}/${product.slug}/reviews`).expect(200);
    expect(response.body.summary.count).toBe(0);
    expect(response.body.summary.average).toBeNull();
  });

  it('never exposes a reviewer’s email address', async () => {
    const product = await seedProduct();
    await publishedReview(product.productId, 4);

    const response = await harness.http().get(`${PUBLIC}/${product.slug}/reviews`).expect(200);
    expect(JSON.stringify(response.body)).not.toContain('@example.test');
    expect(response.body.reviews[0]).not.toHaveProperty('customerId');
  });

  it('says nothing about a listing that is not published', async () => {
    const product = await seedProduct();
    await publishedReview(product.productId, 5);
    await harness.prisma.product.update({
      where: { id: product.productId },
      data: { status: 'DRAFT', publishedAt: null },
    });

    // Empty rather than 404: whether a slug exists in the catalogue is not
    // something an unauthenticated caller needs confirmed.
    const response = await harness.http().get(`${PUBLIC}/${product.slug}/reviews`).expect(200);
    expect(response.body.reviews).toEqual([]);
    expect(response.body.summary.count).toBe(0);
  });
});

describe('moderating a review', () => {
  async function pendingReview() {
    const product = await seedProduct();
    const customer = await signedInCustomer(harness);
    const created = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(customer))
      .send({ productId: product.productId, ...REVIEW })
      .expect(201);
    return { product, customer, reviewId: created.body.id as string };
  }

  it('publishes only when a moderator says so, and records why', async () => {
    const { product, reviewId } = await pendingReview();
    const moderator = await signedInStaff(harness, 'ADMIN', 'mod@example.test');

    await harness
      .http()
      .post(`${ADMIN}/reviews/${reviewId}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'PUBLISHED', notes: 'Ordinary product feedback, makes no health claim.' })
      .expect(201);

    const review = await harness.prisma.productReview.findUniqueOrThrow({
      where: { id: reviewId },
    });
    expect(review.status).toBe('PUBLISHED');
    expect(review.publishedAt).not.toBeNull();

    const decisions = await harness.prisma.reviewModeration.findMany({ where: { reviewId } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.notes).toMatch(/no health claim/i);

    void product;
  });

  it('refuses a customer trying to moderate', async () => {
    const { reviewId, customer } = await pendingReview();

    const response = await harness
      .http()
      .post(`${ADMIN}/reviews/${reviewId}/moderate`)
      .set(auth(customer))
      .send({ decision: 'PUBLISHED', notes: 'Publishing my own review, which must not work.' });

    expect(response.status).toBe(403);
  });

  it('requires a reason when rejecting', async () => {
    const { reviewId } = await pendingReview();
    const moderator = await signedInStaff(harness, 'ADMIN', 'mod@example.test');

    const response = await harness
      .http()
      .post(`${ADMIN}/reviews/${reviewId}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'REJECTED', notes: 'Not publishing this one at all.' });

    expect(response.status).toBe(400);
  });

  it('does not let an escalated review be quietly taken back', async () => {
    // Escalation hands the decision to compliance. A moderator who escalated
    // must not be able to walk it back to the routine queue.
    const { reviewId } = await pendingReview();
    const moderator = await signedInStaff(harness, 'ADMIN', 'mod@example.test');

    await harness
      .http()
      .post(`${ADMIN}/reviews/${reviewId}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'ESCALATED', notes: 'Reads like it might be a disease claim.' })
      .expect(201);

    const back = await harness
      .http()
      .post(`${ADMIN}/reviews/${reviewId}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'ESCALATED', notes: 'Trying to move it back into the ordinary queue.' });

    expect(back.status).toBe(409);
  });

  it('keeps the moderation record beyond editing', async () => {
    const { reviewId } = await pendingReview();
    const moderator = await signedInStaff(harness, 'ADMIN', 'mod@example.test');

    await harness
      .http()
      .post(`${ADMIN}/reviews/${reviewId}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'PUBLISHED', notes: 'Ordinary product feedback, makes no health claim.' })
      .expect(201);

    const decision = await harness.prisma.reviewModeration.findFirstOrThrow({
      where: { reviewId },
    });
    await expect(
      harness.prisma.reviewModeration.update({
        where: { id: decision.id },
        data: { notes: 'rewritten' },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('averages the rating over published reviews only', async () => {
    // A rating computed over unmoderated reviews would let rejected text move
    // the number on the page even while its words stayed hidden.
    const product = await seedProduct();
    const moderator = await signedInStaff(harness, 'ADMIN', 'mod@example.test');

    const five = await signedInCustomer(harness, 'five@example.test');
    const one = await signedInCustomer(harness, 'one@example.test');

    const published = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(five))
      .send({ productId: product.productId, ...REVIEW, rating: 5 })
      .expect(201);

    await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(one))
      .send({ productId: product.productId, ...REVIEW, rating: 1 })
      .expect(201);

    await harness
      .http()
      .post(`${ADMIN}/reviews/${published.body.id}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'PUBLISHED', notes: 'Ordinary product feedback, makes no health claim.' })
      .expect(201);

    const detail = await harness
      .http()
      .get(
        `/api/v1/catalogue/products/${(await harness.prisma.product.findUniqueOrThrow({ where: { id: product.productId } })).slug}`,
      )
      .expect(200);

    expect(detail.body.reviews.summary.count).toBe(1);
    expect(detail.body.reviews.summary.average).toBe(5);
    expect(detail.body.reviews.reviews).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

async function seedShippingRate(priceCents = 0): Promise<string> {
  const rate = await harness.prisma.shippingRate.create({
    data: {
      code: `standard-${Math.random().toString(36).slice(2, 6)}`,
      name: 'Standard delivery',
      countries: ['US'],
      regions: [],
      priceCents,
    },
  });
  return rate.code;
}

async function seedStock(variantId: string, onHand = 50) {
  const warehouse = await harness.prisma.warehouse.create({
    data: {
      code: `WH${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      name: 'Test warehouse',
      line1: '1 Depot Road',
      city: 'Salt Lake City',
      region: 'UT',
      postalCode: '84101',
    },
  });
  await harness.prisma.inventoryItem.create({
    data: { variantId, warehouseId: warehouse.id, onHandQuantity: onHand, trackInventory: true },
  });
}

/** Returns the supertest chain, so callers can `.expect()` on it. */
function createCoupon(staff: SignedInStaff, body: Record<string, unknown>) {
  return harness.http().post(`${ADMIN}/coupons`).set(auth(staff)).send(body);
}

const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  line1: '12 Analytical Way',
  city: 'Salt Lake City',
  region: 'UT',
  postalCode: '84101',
  country: 'US',
};

/** A guest with a basket, taken as far as a priced checkout. */
async function checkoutWith(variantId: string, quantity = 1, shippingCode?: string) {
  const agent = harness.http();
  await agent.post('/api/v1/cart/items').send({ variantId, quantity }).expect(201);

  const started = await agent
    .post('/api/v1/checkout')
    .send({
      idempotencyKey: `lc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      email: 'ada@example.test',
    })
    .expect(201);

  await agent
    .patch(`/api/v1/checkout/${started.body.id}`)
    .send({
      shippingAddress: ADDRESS,
      shippingMethodCode: shippingCode ?? (await seedShippingRate(0)),
    })
    .expect(200);

  return { agent, checkoutId: started.body.id as string };
}

describe('discount codes', () => {
  it('takes the coupon’s value, not a value the client asks for', async () => {
    // The central property. There is no field on any request that names an
    // amount off, so a caller can ask for a code and get its real worth or a
    // refusal — never a number of their choosing.
    const product = await seedProduct({ priceCents: 5000 });
    await seedStock(product.variantId);
    const staff = await signedInStaff(harness, 'ADMIN', 'coupons@example.test');

    await createCoupon(staff, {
      code: 'TENOFF',
      name: 'Ten dollars off',
      type: 'FIXED_AMOUNT',
      amountCents: 1000,
    }).expect(201);

    const { agent, checkoutId } = await checkoutWith(product.variantId);

    const applied = await agent
      .post(`/api/v1/checkout/${checkoutId}/coupon`)
      // A caller trying to name their own discount alongside the code.
      .send({ code: 'TENOFF', discountCents: 4999, amountCents: 4999 })
      .expect(201);

    expect(applied.body.discountCents).toBe(1000);
    expect(applied.body.totalCents).toBe(4000);
  });

  it('recomputes when the basket changes underneath', async () => {
    // A customer who applies "$20 off orders over $100" and then removes items
    // does not keep the twenty dollars.
    const product = await seedProduct({ priceCents: 5000 });
    await seedStock(product.variantId);
    const staff = await signedInStaff(harness, 'ADMIN', 'coupons@example.test');

    await createCoupon(staff, {
      code: 'BIGSPEND',
      name: 'Twenty off a hundred',
      type: 'FIXED_AMOUNT',
      amountCents: 2000,
      minSubtotalCents: 10_000,
    }).expect(201);

    const { agent, checkoutId } = await checkoutWith(product.variantId, 2);
    const applied = await agent
      .post(`/api/v1/checkout/${checkoutId}/coupon`)
      .send({ code: 'BIGSPEND' })
      .expect(201);
    expect(applied.body.discountCents).toBe(2000);

    // Drop to one unit: below the minimum.
    const cart = await agent.get('/api/v1/cart').expect(200);
    await agent
      .patch(`/api/v1/cart/items/${cart.body.lines[0].id}`)
      .send({ quantity: 1 })
      .expect(200);

    const repriced = await agent.get(`/api/v1/checkout/${checkoutId}`).expect(200);
    expect(repriced.body.discountCents).toBe(0);
    expect(repriced.body.coupon.applied).toBe(false);
    expect(repriced.body.coupon.message).toMatch(/minimum/i);
  });

  it('rounds a percentage down rather than up', async () => {
    const product = await seedProduct({ priceCents: 999 });
    await seedStock(product.variantId);
    const staff = await signedInStaff(harness, 'ADMIN', 'coupons@example.test');

    await createCoupon(staff, {
      code: 'THIRD',
      name: 'A third off',
      type: 'PERCENTAGE',
      basisPoints: 3333,
    }).expect(201);

    const { agent, checkoutId } = await checkoutWith(product.variantId);
    const applied = await agent
      .post(`/api/v1/checkout/${checkoutId}/coupon`)
      .send({ code: 'THIRD' })
      .expect(201);

    // 33.33% of 999 is 332.967. Rounding up would give away a cent per order.
    expect(applied.body.discountCents).toBe(332);
  });

  it('cannot be redeemed past its limit, even by concurrent checkouts', async () => {
    // The lost-update bug this design exists to prevent: two checkouts reading
    // the same remaining count, both passing, both redeeming.
    const product = await seedProduct({ priceCents: 2000 });
    await seedStock(product.variantId, 100);
    const staff = await signedInStaff(harness, 'ADMIN', 'coupons@example.test');
    const shippingCode = await seedShippingRate(0);

    await createCoupon(staff, {
      code: 'ONLYONE',
      name: 'One redemption',
      type: 'FIXED_AMOUNT',
      amountCents: 500,
      maxRedemptions: 1,
    }).expect(201);

    const coupon = await harness.prisma.coupon.findFirstOrThrow({ where: { code: 'ONLYONE' } });

    // Two orders, both redeeming the same last remaining use, in parallel.
    const orders = await Promise.all(
      [0, 1].map(async () => {
        const order = await harness.prisma.order.create({
          data: {
            reference: `HC-C-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
            email: 'ada@example.test',
            status: 'PAID',
            paymentStatus: 'CAPTURED',
            subtotalCents: 2000,
            discountCents: 500,
            totalCents: 1500,
            amountPaidCents: 1500,
            shippingAddress: ADDRESS as never,
          },
        });
        return order.id;
      }),
    );

    const results = await Promise.allSettled(
      orders.map((orderId) =>
        harness.prisma.$transaction(async (tx) =>
          harness.app
            .get(
              // Resolved through the container so the real service runs.
              (await import('../src/modules/lifecycle/coupons/coupons.service.js')).CouponsService,
            )
            .redeemIn(tx, {
              couponId: coupon.id,
              orderId,
              customerId: null,
              amountCents: 500,
              currency: 'USD',
            }),
        ),
      ),
    );

    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    expect(succeeded).toBe(1);

    const redemptions = await harness.prisma.couponRedemption.count({
      where: { couponId: coupon.id },
    });
    expect(redemptions).toBe(1);

    void shippingCode;
  });

  it('gives the same answer for an unknown code and a switched-off one', async () => {
    // Distinguishing them turns the checkout into an oracle for enumerating
    // valid codes.
    const product = await seedProduct();
    await seedStock(product.variantId);
    const staff = await signedInStaff(harness, 'ADMIN', 'coupons@example.test');

    await createCoupon(staff, {
      code: 'SWITCHEDOFF',
      name: 'Disabled',
      type: 'FIXED_AMOUNT',
      amountCents: 500,
      isActive: false,
    }).expect(201);

    const { agent, checkoutId } = await checkoutWith(product.variantId);

    const unknown = await agent
      .post(`/api/v1/checkout/${checkoutId}/coupon`)
      .send({ code: 'NOSUCHCODE' });
    const disabled = await agent
      .post(`/api/v1/checkout/${checkoutId}/coupon`)
      .send({ code: 'SWITCHEDOFF' });

    expect(unknown.status).toBe(422);
    expect(disabled.status).toBe(422);
    expect(disabled.body.error.message).toBe(unknown.body.error.message);
  });

  it('refuses a per-customer limit that nothing could enforce', async () => {
    // A per-customer limit against guests counts nobody. The schema refuses the
    // combination rather than letting an operator configure a limit that
    // silently does nothing.
    const staff = await signedInStaff(harness, 'ADMIN', 'coupons@example.test');

    const response = await createCoupon(staff, {
      code: 'PERPERSON',
      name: 'One each',
      type: 'FIXED_AMOUNT',
      amountCents: 500,
      maxPerCustomer: 1,
      requiresCustomer: false,
    });

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

async function seedAddress(customerId: string) {
  const address = await harness.prisma.customerAddress.create({
    data: { customerId, type: 'SHIPPING', ...ADDRESS },
  });
  return address.id;
}

/** Saves a payment method directly, standing in for the provider handshake. */
async function seedPaymentMethod(
  customerId: string,
  token = `dev_pm_${Math.random().toString(36).slice(2, 10)}`,
) {
  const method = await harness.prisma.customerPaymentMethod.create({
    data: {
      customerId,
      provider: 'development',
      providerPaymentMethodId: token,
      cardBrand: 'devcard',
      cardLast4: '0000',
      isDefault: true,
    },
  });
  return method.id;
}

async function subscribe(
  customer: SignedInCustomer,
  variantId: string,
  options: { token?: string } = {},
) {
  const [addressId, methodId] = await Promise.all([
    seedAddress(customer.customerId),
    seedPaymentMethod(customer.customerId, options.token),
  ]);

  return harness
    .http()
    .post(`${ACCOUNT}/subscriptions`)
    .set(auth(customer))
    .send({
      items: [{ variantId, quantity: 1 }],
      interval: 'MONTH',
      intervalCount: 1,
      paymentMethodId: methodId,
      shippingAddressId: addressId,
    });
}

/** Subscribes and asserts it worked, so call sites read as one step. */
async function subscribeOk(
  customer: SignedInCustomer,
  variantId: string,
  options: { token?: string } = {},
) {
  const response = await subscribe(customer, variantId, options);
  expect(response.status).toBe(201);
  return response;
}

describe('starting a subscription', () => {
  it('charges immediately and becomes active', async () => {
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);

    const response = await subscribeOk(customer, product.variantId);

    expect(response.body.status).toBe('ACTIVE');
    expect(response.body.nextBillingAt).not.toBeNull();

    const invoices = await harness.prisma.subscriptionInvoice.findMany({
      where: { subscriptionId: response.body.id },
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe('PAID');
  });

  it('holds a subscription whose first charge declined, and does not make it active', async () => {
    // A subscription that shipped before anything settled would be goods given
    // away on the promise of a card nobody had tried.
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);

    const response = await subscribeOk(customer, product.variantId, {
      token: DEV_DECLINING_PAYMENT_METHOD,
    });

    expect(response.body.status).toBe('PENDING');

    const invoice = await harness.prisma.subscriptionInvoice.findFirstOrThrow({
      where: { subscriptionId: response.body.id },
    });
    expect(invoice.status).toBe('FAILED');
  });

  it('refuses a product that is not offered on subscription', async () => {
    const product = await seedProduct({ subscribable: false });
    const customer = await signedInCustomer(harness);

    const response = await subscribe(customer, product.variantId);
    expect(response.status).toBe(422);
  });

  it('holds the agreed price, so a catalogue change does not reach it', async () => {
    // A subscription is a standing agreement about an amount. Charging more
    // because a catalogue price moved changes the terms without asking.
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    await harness.prisma.product.update({
      where: { id: product.productId },
      data: { priceCents: 9900 },
    });

    const items = await harness.prisma.subscriptionItem.findMany({
      where: { subscriptionId: created.body.id },
    });
    expect(items[0]!.unitPriceCents).toBe(2400);
  });
});

describe('renewals', () => {
  it('charges once per period however many times the run fires', async () => {
    // The idempotency property. An overlapping worker, a retried run or a crash
    // between charging and recording must not produce a second charge.
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    const subscriptions = harness.app.get(SubscriptionsService);

    // Make it due, then bill it three times over.
    await harness.prisma.subscription.update({
      where: { id: created.body.id },
      data: { nextBillingAt: new Date(Date.now() - 60_000) },
    });

    const first = await subscriptions.bill(created.body.id);
    const second = await subscriptions.bill(created.body.id);
    const third = await subscriptions.bill(created.body.id);

    expect(first.charged).toBe(true);
    expect(second.charged).toBe(false);
    expect(third.charged).toBe(false);

    // Two invoices in total: the one from signing up, and one for this period.
    const invoices = await harness.prisma.subscriptionInvoice.findMany({
      where: { subscriptionId: created.body.id, status: 'PAID' },
    });
    expect(invoices).toHaveLength(2);
  });

  it('is collected by the scheduled run, which selects and charges the same way', async () => {
    // The worker's billing run is `listDueSubscriptions` followed by
    // `billSubscriptionPeriod`, with a provider from `createPaymentProvider`.
    // This test *is* that run — if it passes, the scheduler charges renewals;
    // the alternative is a cron that looks busy and collects nothing.
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    const notYet = await subscribeOk(await signedInCustomer(harness), product.variantId);

    await harness.prisma.subscription.update({
      where: { id: created.body.id },
      data: { nextBillingAt: new Date(Date.now() - 60_000) },
    });

    const deps = {
      prisma: harness.prisma,
      payments: createPaymentProvider(parseServerEnv()),
      now: () => new Date(),
    };

    const due = await listDueSubscriptions(harness.prisma, new Date(), 500);
    expect(due).toContain(created.body.id);
    // A subscription whose date has not arrived is never even selected.
    expect(due).not.toContain(notYet.body.id);

    const outcomes = [];
    for (const subscriptionId of due) {
      outcomes.push(await billSubscriptionPeriod(deps, { subscriptionId }));
    }
    expect(outcomes.filter((outcome) => outcome.charged)).toHaveLength(1);

    // Money actually moved: the period rolled forward and a paid invoice for it
    // exists, priced by the same engine a checkout uses.
    const after = await harness.prisma.subscription.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(after.status).toBe('ACTIVE');
    expect(after.nextBillingAt!.getTime()).toBeGreaterThan(Date.now());

    const paid = await harness.prisma.subscriptionInvoice.findMany({
      where: { subscriptionId: created.body.id, status: 'PAID' },
      orderBy: { periodStart: 'asc' },
    });
    expect(paid).toHaveLength(2);
    expect(paid[1]!.totalCents).toBeGreaterThan(0);

    // A second run in the same hour finds nothing due and charges nothing.
    const second = await listDueSubscriptions(harness.prisma, new Date(), 500);
    expect(second).not.toContain(created.body.id);
  });

  it('stops shipping the moment a renewal fails', async () => {
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    // Swap to a card that declines, and make the renewal due.
    const declining = await seedPaymentMethod(customer.customerId, DEV_DECLINING_PAYMENT_METHOD);
    await harness.prisma.subscription.update({
      where: { id: created.body.id },
      data: {
        paymentMethodId: declining,
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        nextBillingAt: new Date(Date.now() - 60_000),
      },
    });

    const result = await harness.app.get(SubscriptionsService).bill(created.body.id);
    expect(result.charged).toBe(false);

    const subscription = await harness.prisma.subscription.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(subscription.status).toBe('PAST_DUE');
    expect(subscription.failedAttempts).toBe(1);
    // Still scheduled: collection keeps being attempted while dispatch stops.
    expect(subscription.nextBillingAt).not.toBeNull();
  });

  it('gives up after a bounded number of attempts rather than retrying forever', async () => {
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    const declining = await seedPaymentMethod(customer.customerId, DEV_DECLINING_PAYMENT_METHOD);
    await harness.prisma.subscription.update({
      where: { id: created.body.id },
      data: { paymentMethodId: declining },
    });

    const subscriptions = harness.app.get(SubscriptionsService);
    // Four attempts against a three-step schedule. Each iteration moves the
    // period back and makes the charge due again, which is what the dunning
    // schedule does in production as each retry date arrives.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await harness.prisma.subscription.update({
        where: { id: created.body.id },
        data: {
          currentPeriodStart: new Date(Date.now() - (attempt + 1) * 86_400_000),
          nextBillingAt: new Date(Date.now() - 60_000),
        },
      });
      await subscriptions.bill(created.body.id);
    }

    const subscription = await harness.prisma.subscription.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(subscription.status).toBe('UNPAID');
    // No further attempt is scheduled.
    expect(subscription.nextBillingAt).toBeNull();
  });

  it('never bills a cancelled subscription', async () => {
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    await harness
      .http()
      .post(`${ACCOUNT}/subscriptions/${created.body.id}/cancel`)
      .set(auth(customer))
      .send({ reason: 'Too much magnesium.' })
      .expect(201);

    const result = await harness.app.get(SubscriptionsService).bill(created.body.id);
    expect(result.charged).toBe(false);

    // And the database will not even hold a charge date against a cancelled
    // subscription, so a billing run cannot find it.
    const subscription = await harness.prisma.subscription.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(subscription.nextBillingAt).toBeNull();

    const due = await harness.app.get(SubscriptionsService).listDue();
    expect(due).not.toContain(created.body.id);
  });

  it('never bills a paused subscription', async () => {
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    await harness
      .http()
      .post(`${ACCOUNT}/subscriptions/${created.body.id}/pause`)
      .set(auth(customer))
      .send({})
      .expect(201);

    const due = await harness.app.get(SubscriptionsService).listDue();
    expect(due).not.toContain(created.body.id);
  });
});

describe('a customer’s own subscriptions', () => {
  it('cannot be cancelled by somebody else', async () => {
    const product = await seedProduct({ priceCents: 2400 });
    const owner = await signedInCustomer(harness, 'owner@example.test');
    const stranger = await signedInCustomer(harness, 'stranger@example.test');
    const created = await subscribeOk(owner, product.variantId);

    const response = await harness
      .http()
      .post(`${ACCOUNT}/subscriptions/${created.body.id}/cancel`)
      .set(auth(stranger))
      .send({ reason: 'Cancelling a subscription that is not mine.' });

    // Not found rather than forbidden: confirming somebody else's subscription
    // exists is itself information.
    expect(response.status).toBe(404);
  });

  it('cancels without demanding a reason', async () => {
    // Cancelling must not be harder than subscribing was.
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    const response = await harness
      .http()
      .post(`${ACCOUNT}/subscriptions/${created.body.id}/cancel`)
      .set(auth(customer))
      .send({});

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('CANCELLED');
  });

  it('refuses to remove a card a live subscription still bills to', async () => {
    const product = await seedProduct({ priceCents: 2400 });
    const customer = await signedInCustomer(harness);
    const created = await subscribeOk(customer, product.variantId);

    const methodId = (
      await harness.prisma.subscription.findUniqueOrThrow({ where: { id: created.body.id } })
    ).paymentMethodId!;

    const response = await harness
      .http()
      .delete(`${ACCOUNT}/payment-methods/${methodId}`)
      .set(auth(customer));

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Account: export and erasure
// ---------------------------------------------------------------------------

describe('erasure', () => {
  it('says what it will and will not remove before the customer asks', async () => {
    const customer = await signedInCustomer(harness);

    const response = await harness.http().get(`${ACCOUNT}/erasure`).set(auth(customer)).expect(200);

    expect(response.body.removed.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body.retained)).toMatch(/recall/i);
    expect(JSON.stringify(response.body.retained)).toMatch(/Orders, payments/i);
  });

  it('needs the acknowledgement typed out', async () => {
    const customer = await signedInCustomer(harness);

    const response = await harness
      .http()
      .post(`${ACCOUNT}/erasure`)
      .set(auth(customer))
      .send({ acknowledgement: 'yes' });

    expect(response.status).toBe(400);
  });

  it('keeps order history, so the books and a recall still work', async () => {
    // The property that makes erasure lawful rather than a different legal
    // problem: records the business must retain are retained.
    const product = await seedProduct();
    const customer = await signedInCustomer(harness);
    const line = await seedOrderLine(customer.customerId, product.productId, product.variantId);
    await seedAddress(customer.customerId);

    await harness
      .http()
      .post(`${ACCOUNT}/erasure`)
      .set(auth(customer))
      .send({ acknowledgement: 'DELETE MY ACCOUNT' })
      .expect(201);

    const staff = await signedInStaff(harness, 'ADMIN', 'privacy@example.test');
    const pending = await harness
      .http()
      .get(`${ADMIN}/erasure-requests`)
      .set(auth(staff))
      .expect(200);

    await harness
      .http()
      .post(`${ADMIN}/erasure-requests/${pending.body.data[0].id}/decision`)
      .set(auth(staff))
      .send({
        decision: 'COMPLETED',
        notes:
          'Removed addresses, saved cards and sign-in. Retained order and payment records as required.',
      })
      .expect(201);

    // Gone.
    const addresses = await harness.prisma.customerAddress.findMany({
      where: { customerId: customer.customerId, deletedAt: null },
    });
    expect(addresses).toEqual([]);

    // Kept.
    const order = await harness.prisma.order.findUniqueOrThrow({ where: { id: line.orderId } });
    expect(order.totalCents).toBe(2400);

    const consents = await harness.prisma.customerConsent.findMany({
      where: { customerId: customer.customerId },
    });
    expect(consents.length).toBeGreaterThan(0);
  });

  it('anonymises reviews rather than deleting them', async () => {
    // Deleting them would silently move a published rating average other
    // customers are relying on.
    const product = await seedProduct();
    const customer = await signedInCustomer(harness);
    const moderator = await signedInStaff(harness, 'ADMIN', 'mod@example.test');

    const review = await harness
      .http()
      .post(`${ACCOUNT}/reviews`)
      .set(auth(customer))
      .send({ productId: product.productId, ...REVIEW })
      .expect(201);

    await harness
      .http()
      .post(`${ADMIN}/reviews/${review.body.id}/moderate`)
      .set(auth(moderator))
      .send({ decision: 'PUBLISHED', notes: 'Ordinary product feedback, makes no health claim.' })
      .expect(201);

    await harness
      .http()
      .post(`${ACCOUNT}/erasure`)
      .set(auth(customer))
      .send({ acknowledgement: 'DELETE MY ACCOUNT' })
      .expect(201);

    const pending = await harness
      .http()
      .get(`${ADMIN}/erasure-requests`)
      .set(auth(moderator))
      .expect(200);

    await harness
      .http()
      .post(`${ADMIN}/erasure-requests/${pending.body.data[0].id}/decision`)
      .set(auth(moderator))
      .send({
        decision: 'COMPLETED',
        notes: 'Removed personal details. Reviews anonymised so published ratings stay correct.',
      })
      .expect(201);

    const after = await harness.prisma.productReview.findUniqueOrThrow({
      where: { id: review.body.id },
    });
    expect(after.status).toBe('PUBLISHED');
    expect(after.authorDisplayName).toBe('Former customer');
  });

  it('records a decision that cannot be made without reasoning', async () => {
    const customer = await signedInCustomer(harness);
    const staff = await signedInStaff(harness, 'ADMIN', 'privacy@example.test');

    await harness
      .http()
      .post(`${ACCOUNT}/erasure`)
      .set(auth(customer))
      .send({ acknowledgement: 'DELETE MY ACCOUNT' })
      .expect(201);

    const pending = await harness
      .http()
      .get(`${ADMIN}/erasure-requests`)
      .set(auth(staff))
      .expect(200);

    const response = await harness
      .http()
      .post(`${ADMIN}/erasure-requests/${pending.body.data[0].id}/decision`)
      .set(auth(staff))
      .send({ decision: 'COMPLETED', notes: 'done' });

    expect(response.status).toBe(400);
  });
});

describe('support', () => {
  it('never shows an internal note to the customer', async () => {
    const customer = await signedInCustomer(harness);
    const staff = await signedInStaff(harness, 'ADMIN', 'support@example.test');

    const thread = await harness
      .http()
      .post(`${ACCOUNT}/support`)
      .set(auth(customer))
      .send({ topic: 'DELIVERY', subject: 'Where is my order', body: 'It has not arrived yet.' })
      .expect(201);

    await harness
      .http()
      .post(`${ADMIN}/support/${thread.body.id}/replies`)
      .set(auth(staff))
      .send({
        body: 'Customer has complained twice, consider a goodwill refund.',
        isInternal: true,
      })
      .expect(201);

    const asCustomer = await harness
      .http()
      .get(`${ACCOUNT}/support/${thread.body.id}`)
      .set(auth(customer))
      .expect(200);

    expect(JSON.stringify(asCustomer.body)).not.toMatch(/goodwill/i);
    expect(asCustomer.body.messages).toHaveLength(1);
  });

  it('does not let a customer mark their own message internal', async () => {
    const customer = await signedInCustomer(harness);

    const thread = await harness
      .http()
      .post(`${ACCOUNT}/support`)
      .set(auth(customer))
      .send({ topic: 'ORDER', subject: 'A question', body: 'Something about my order.' })
      .expect(201);

    await harness
      .http()
      .post(`${ACCOUNT}/support/${thread.body.id}/replies`)
      .set(auth(customer))
      .send({ body: 'Another message.', isInternal: true })
      .expect(201);

    const messages = await harness.prisma.supportMessage.findMany({
      where: { threadId: thread.body.id, authorType: 'CUSTOMER' },
    });
    expect(messages.every((message) => !message.isInternal)).toBe(true);
  });

  it('cannot be read by another customer', async () => {
    const owner = await signedInCustomer(harness, 'owner@example.test');
    const stranger = await signedInCustomer(harness, 'stranger@example.test');

    const thread = await harness
      .http()
      .post(`${ACCOUNT}/support`)
      .set(auth(owner))
      .send({ topic: 'ORDER', subject: 'A question', body: 'Something about my order.' })
      .expect(201);

    const response = await harness
      .http()
      .get(`${ACCOUNT}/support/${thread.body.id}`)
      .set(auth(stranger));

    expect(response.status).toBe(404);
  });

  it('tells the customer this is not a place for clinical questions', async () => {
    const customer = await signedInCustomer(harness);

    const response = await harness
      .http()
      .get(`${ACCOUNT}/support/guidance`)
      .set(auth(customer))
      .expect(200);

    expect(response.body.medicalRedirect).toMatch(/cannot answer questions about your health/i);
    expect(response.body.medicalRedirect).toMatch(/doctor or pharmacist/i);
  });
});
