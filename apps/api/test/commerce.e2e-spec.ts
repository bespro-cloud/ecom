import type { DevelopmentPaymentProvider } from '@health/payments';
import { PAYMENT_PROVIDER } from '../src/modules/commerce/payments/payment.provider.js';
import { createHarness, signedInStaff, type SignedInStaff, type TestHarness } from './harness.js';

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

const auth = (staff: SignedInStaff) => ({ Authorization: `Bearer ${staff.token}` });

/**
 * A key that satisfies the idempotency-key format. Unique per call unless a
 * test deliberately reuses one.
 */
function idemKey(label = 'k'): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Fixtures
//
// Built through Prisma rather than the API: these tests are about commerce, and
// walking the whole publishing gate for every one of them would make the suite
// about the catalogue instead. The gate has its own suite.
// ---------------------------------------------------------------------------

interface Fixture {
  productId: string;
  variantId: string;
  warehouseId: string;
  inventoryItemId: string;
  sku: string;
}

async function seedSellableProduct(
  options: { onHand?: number; priceCents?: number; sku?: string; trackInventory?: boolean } = {},
): Promise<Fixture> {
  const sku = options.sku ?? `HC-TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

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
      publishedAt: new Date(),
    },
  });

  const variant = await harness.prisma.productVariant.create({
    data: { productId: product.id, sku: `${sku}-V1`, name: '120 capsules', isActive: true },
  });

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

  const item = await harness.prisma.inventoryItem.create({
    data: {
      variantId: variant.id,
      warehouseId: warehouse.id,
      onHandQuantity: options.onHand ?? 10,
      trackInventory: options.trackInventory ?? true,
    },
  });

  return {
    productId: product.id,
    variantId: variant.id,
    warehouseId: warehouse.id,
    inventoryItemId: item.id,
    sku: variant.sku,
  };
}

async function seedShippingRate(priceCents = 599): Promise<string> {
  const rate = await harness.prisma.shippingRate.create({
    data: {
      code: `standard-${Math.random().toString(36).slice(2, 6)}`,
      name: 'Standard delivery',
      countries: ['US'],
      regions: [],
      priceCents,
      estimatedDaysMin: 3,
      estimatedDaysMax: 5,
    },
  });
  return rate.code;
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

/**
 * A guest browser: one supertest agent that keeps its cookies, so the cart
 * token behaves exactly as it would for a real customer.
 */
function guest() {
  return harness.http();
}

async function addToCart(agent: ReturnType<typeof guest>, variantId: string, quantity = 1) {
  const response = await agent.post('/api/v1/cart/items').send({ variantId, quantity });
  return response;
}

/** Drives a guest all the way to a placed order. */
async function buy(
  fixture: Fixture,
  options: { quantity?: number; shippingCode?: string; agent?: ReturnType<typeof guest> } = {},
) {
  const agent = options.agent ?? guest();
  const shippingCode = options.shippingCode ?? (await seedShippingRate());

  await addToCart(agent, fixture.variantId, options.quantity ?? 1);

  const started = await agent
    .post('/api/v1/checkout')
    .send({ idempotencyKey: idemKey('start'), email: 'ada@example.test' });
  expect(started.status).toBe(201);

  const checkoutId = started.body.id as string;

  await agent
    .patch(`/api/v1/checkout/${checkoutId}`)
    .send({ shippingAddress: ADDRESS, shippingMethodCode: shippingCode })
    .expect(200);

  const priced = await agent.get(`/api/v1/checkout/${checkoutId}`).expect(200);

  const prepared = await agent
    .post(`/api/v1/checkout/${checkoutId}/prepare`)
    .send({ pricingFingerprint: priced.body.pricingFingerprint });

  return { agent, checkoutId, priced: priced.body, prepared };
}

/** The payment provider the API is actually running, for test-side simulation. */
function provider(): DevelopmentPaymentProvider {
  return harness.app.get<DevelopmentPaymentProvider>(PAYMENT_PROVIDER);
}

/**
 * Completes a payment the way the real flow does.
 *
 * Two steps, matching production exactly: the customer's browser completes the
 * payment with the provider, and the provider then tells us via a
 * signature-verified webhook. Nothing is written directly to the payments
 * table — doing that would leave the provider's own state disagreeing with
 * ours, and would skip the verification that decides whether an order may be
 * marked paid at all.
 */
async function payViaWebhook(checkoutId: string): Promise<void> {
  const payment = await harness.prisma.payment.findFirstOrThrow({
    where: { checkoutId },
    orderBy: { createdAt: 'desc' },
  });

  const dev = provider();
  await dev.simulateCustomerPayment(payment.providerPaymentId);

  const body = JSON.stringify({
    id: `evt_${payment.id}`,
    type: 'payment.captured',
    created: Math.floor(Date.now() / 1000),
    data: {
      providerPaymentId: payment.providerPaymentId,
      amountCents: payment.amountCents,
      currency: payment.currency,
    },
  });

  await harness
    .http()
    .post('/api/v1/webhooks/payments')
    .set('content-type', 'application/json')
    .set('x-payment-signature', dev.signWebhook(body))
    .send(body)
    .expect(200);
}

async function payAndComplete(agent: ReturnType<typeof guest>, checkoutId: string) {
  await payViaWebhook(checkoutId);
  return agent.post(`/api/v1/checkout/${checkoutId}/complete`).send({});
}

// ---------------------------------------------------------------------------

describe('the cart', () => {
  it('gives a guest a cart without an account', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();

    const response = await addToCart(agent, fixture.variantId, 2);

    expect(response.status).toBe(201);
    expect(response.body.itemCount).toBe(2);
    expect(response.body.subtotalCents).toBe(4800);
  });

  it('keeps the basket across requests via the cookie', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();

    await addToCart(agent, fixture.variantId);
    const second = await agent.get('/api/v1/cart');

    expect(second.body.itemCount).toBe(1);
  });

  it('does not leak one guest’s basket to another', async () => {
    // The token in the cookie is the only thing addressing a guest cart, and
    // there is no route that takes a cart id.
    const fixture = await seedSellableProduct();
    const first = guest();
    await addToCart(first, fixture.variantId);

    const second = await guest().get('/api/v1/cart');
    expect(second.body.itemCount).toBe(0);
  });

  it('adds to an existing line rather than duplicating it', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();

    await addToCart(agent, fixture.variantId, 1);
    const response = await addToCart(agent, fixture.variantId, 2);

    expect(response.body.lines).toHaveLength(1);
    expect(response.body.lines[0].quantity).toBe(3);
  });

  it('refuses a product that is not published', async () => {
    const fixture = await seedSellableProduct();
    await harness.prisma.product.update({
      where: { id: fixture.productId },
      data: { status: 'DRAFT' },
    });

    // The same answer as "no such product": distinguishing them would let
    // anyone enumerate unpublished listings through a public endpoint.
    const response = await addToCart(guest(), fixture.variantId);
    expect(response.status).toBe(404);
  });

  it('reports a line that became unavailable instead of dropping it', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();
    await addToCart(agent, fixture.variantId);

    await harness.prisma.product.update({
      where: { id: fixture.productId },
      data: { status: 'ARCHIVED' },
    });

    const response = await agent.get('/api/v1/cart');
    expect(response.body.lines).toHaveLength(0);
    expect(response.body.unavailable).toHaveLength(1);
    expect(response.body.unavailable[0].reason).toMatch(/not currently available/i);
  });

  it('reprices from the catalogue rather than from the cart row', async () => {
    // A cart is a wish, not a contract. The stored quote is shown as "the price
    // changed", never charged.
    const fixture = await seedSellableProduct({ priceCents: 2400 });
    const agent = guest();
    await addToCart(agent, fixture.variantId);

    await harness.prisma.product.update({
      where: { id: fixture.productId },
      data: { priceCents: 2900 },
    });

    const response = await agent.get('/api/v1/cart');
    expect(response.body.lines[0].unitPriceCents).toBe(2900);
    expect(response.body.lines[0].priceChanged).toBe(true);
    expect(response.body.subtotalCents).toBe(2900);
  });

  it('removes a line when the quantity is set to zero', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();
    const added = await addToCart(agent, fixture.variantId);
    const itemId = added.body.lines[0].id as string;

    const response = await agent.patch(`/api/v1/cart/items/${itemId}`).send({ quantity: 0 });
    expect(response.body.lines).toHaveLength(0);
  });

  it('refuses a negative quantity', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();
    const added = await addToCart(agent, fixture.variantId);
    const itemId = added.body.lines[0].id as string;

    const response = await agent.patch(`/api/v1/cart/items/${itemId}`).send({ quantity: -1 });
    expect(response.status).toBe(400);
  });
});

describe('pricing at checkout', () => {
  // `system_settings` is reference data and survives the per-test reset, so a
  // test that changes a rate has to put it back — otherwise it silently
  // changes the totals every later test expects.
  afterEach(async () => {
    await harness.prisma.systemSetting.updateMany({
      where: { key: 'tax.rates_by_region' },
      data: { value: {} },
    });
  });

  it('never takes a price from the request', async () => {
    // There is no field on any commerce schema a caller could use to name a
    // price, and one supplied anyway is ignored rather than honoured.
    const fixture = await seedSellableProduct({ priceCents: 2400 });
    const agent = guest();

    await agent
      .post('/api/v1/cart/items')
      .send({ variantId: fixture.variantId, quantity: 1, unitPriceCents: 1, priceCents: 1 });

    const cart = await agent.get('/api/v1/cart');
    expect(cart.body.subtotalCents).toBe(2400);
  });

  it('adds the chosen shipping rate to the total', async () => {
    const fixture = await seedSellableProduct({ priceCents: 2400 });
    const { priced } = await buy(fixture, { shippingCode: await seedShippingRate(599) });

    expect(priced.subtotalCents).toBe(2400);
    expect(priced.shippingCents).toBe(599);
    expect(priced.totalCents).toBe(2999);
  });

  it('reports that no tax rate was configured rather than implying zero tax', async () => {
    const fixture = await seedSellableProduct();
    const { priced } = await buy(fixture);

    expect(priced.taxCents).toBe(0);
    expect(priced.taxRateApplied).toBeNull();
  });

  it('applies a configured state rate', async () => {
    await harness.prisma.systemSetting.upsert({
      where: { key: 'tax.rates_by_region' },
      update: { value: { UT: 0.0725 } },
      create: {
        key: 'tax.rates_by_region',
        value: { UT: 0.0725 },
        valueType: 'JSON',
        description: 'Test fixture.',
      },
    });

    const fixture = await seedSellableProduct({ priceCents: 10_000 });
    const { priced } = await buy(fixture, { shippingCode: await seedShippingRate(0) });

    expect(priced.taxRateApplied).toBe(0.0725);
    expect(priced.taxCents).toBe(725);
    expect(priced.totalCents).toBe(10_725);
  });

  it('produces line totals that sum exactly to the order', async () => {
    const fixture = await seedSellableProduct({ priceCents: 1003 });
    const { priced } = await buy(fixture, { quantity: 3 });

    const lineSum = priced.lines.reduce(
      (sum: number, line: { lineSubtotalCents: number }) => sum + line.lineSubtotalCents,
      0,
    );
    expect(lineSum).toBe(priced.subtotalCents);
    expect(priced.totalCents).toBe(
      priced.subtotalCents - priced.discountCents + priced.shippingCents + priced.taxCents,
    );
  });
});

describe('the checkout gate', () => {
  it('refuses to pay against a stale quote', async () => {
    // The case this exists for: the catalogue was repriced between the customer
    // seeing a total and confirming it.
    const fixture = await seedSellableProduct({ priceCents: 2400 });
    const shippingCode = await seedShippingRate();
    const agent = guest();

    await addToCart(agent, fixture.variantId);
    const started = await agent
      .post('/api/v1/checkout')
      .send({ idempotencyKey: idemKey(), email: 'ada@example.test' });
    const checkoutId = started.body.id as string;

    await agent
      .patch(`/api/v1/checkout/${checkoutId}`)
      .send({ shippingAddress: ADDRESS, shippingMethodCode: shippingCode });
    const priced = await agent.get(`/api/v1/checkout/${checkoutId}`);

    await harness.prisma.product.update({
      where: { id: fixture.productId },
      data: { priceCents: 9900 },
    });

    const response = await agent
      .post(`/api/v1/checkout/${checkoutId}/prepare`)
      .send({ pricingFingerprint: priced.body.pricingFingerprint });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/basket changed/i);
  });

  it('refuses without a delivery address', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();
    await addToCart(agent, fixture.variantId);

    const started = await agent
      .post('/api/v1/checkout')
      .send({ idempotencyKey: idemKey(), email: 'ada@example.test' });
    const priced = await agent.get(`/api/v1/checkout/${started.body.id}`);

    const response = await agent
      .post(`/api/v1/checkout/${started.body.id}/prepare`)
      .send({ pricingFingerprint: priced.body.pricingFingerprint });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/delivery address/i);
  });

  it('refuses a delivery method that no longer applies', async () => {
    const fixture = await seedSellableProduct();
    const shippingCode = await seedShippingRate();
    const agent = guest();

    await addToCart(agent, fixture.variantId);
    const started = await agent
      .post('/api/v1/checkout')
      .send({ idempotencyKey: idemKey(), email: 'ada@example.test' });
    await agent
      .patch(`/api/v1/checkout/${started.body.id}`)
      .send({ shippingAddress: ADDRESS, shippingMethodCode: shippingCode });
    const priced = await agent.get(`/api/v1/checkout/${started.body.id}`);

    // The rate is withdrawn while they are paying. Substituting a different one
    // would silently change what they pay for delivery.
    await harness.prisma.shippingRate.updateMany({
      where: { code: shippingCode },
      data: { isActive: false },
    });

    const response = await agent
      .post(`/api/v1/checkout/${started.body.id}/prepare`)
      .send({ pricingFingerprint: priced.body.pricingFingerprint });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/no longer available/i);
  });

  it('refuses an empty basket', async () => {
    const agent = guest();
    const response = await agent
      .post('/api/v1/checkout')
      .send({ idempotencyKey: idemKey(), email: 'ada@example.test' });

    expect(response.status).toBe(422);
  });

  it('does not let one guest reach another’s checkout', async () => {
    const fixture = await seedSellableProduct();
    const { checkoutId } = await buy(fixture);

    // Knowing a checkout UUID is not authority to use it.
    const stranger = await guest().get(`/api/v1/checkout/${checkoutId}`);
    expect(stranger.status).toBe(404);
  });
});

describe('idempotency', () => {
  it('returns the same checkout for a repeated key rather than starting a second', async () => {
    const fixture = await seedSellableProduct();
    const agent = guest();
    await addToCart(agent, fixture.variantId);

    const key = idemKey('repeat');
    const first = await agent
      .post('/api/v1/checkout')
      .send({ idempotencyKey: key, email: 'ada@example.test' });
    const second = await agent
      .post('/api/v1/checkout')
      .send({ idempotencyKey: key, email: 'ada@example.test' });

    expect(second.body.id).toBe(first.body.id);
    expect(await harness.prisma.checkout.count()).toBe(1);
  });

  it('produces one order when complete is called twice', async () => {
    // A double-clicked confirm button, or a retried request, must not produce
    // two orders for one payment.
    const fixture = await seedSellableProduct();
    const { agent, checkoutId } = await buy(fixture);

    const first = await payAndComplete(agent, checkoutId);
    const second = await agent.post(`/api/v1/checkout/${checkoutId}/complete`).send({});

    expect(first.status).toBe(201);
    expect(second.body.orderId).toBe(first.body.orderId);
    expect(await harness.prisma.order.count()).toBe(1);
  });

  it('survives two concurrent complete calls', async () => {
    const fixture = await seedSellableProduct();
    const { agent, checkoutId } = await buy(fixture);

    await payViaWebhook(checkoutId);

    const [a, b] = await Promise.all([
      agent.post(`/api/v1/checkout/${checkoutId}/complete`).send({}),
      agent.post(`/api/v1/checkout/${checkoutId}/complete`).send({}),
    ]);

    const succeeded = [a, b].filter((response) => response.status < 400);
    expect(succeeded.length).toBeGreaterThan(0);
    expect(await harness.prisma.order.count()).toBe(1);
  });

  it('refuses to place an order the provider has not confirmed payment for', async () => {
    // The only authority on whether money moved is the provider. A caller
    // saying "it worked" is not evidence.
    const fixture = await seedSellableProduct();
    const { agent, checkoutId } = await buy(fixture);

    const response = await agent.post(`/api/v1/checkout/${checkoutId}/complete`).send({});

    expect(response.status).toBe(422);
    expect(await harness.prisma.order.count()).toBe(0);
  });
});

describe('inventory', () => {
  it('reserves stock at the payment step, not before', async () => {
    const fixture = await seedSellableProduct({ onHand: 10 });
    const agent = guest();

    await addToCart(agent, fixture.variantId, 3);

    // Adding to a basket must not hold stock: browsing is not buying.
    let item = await harness.prisma.inventoryItem.findUniqueOrThrow({
      where: { id: fixture.inventoryItemId },
    });
    expect(item.reservedQuantity).toBe(0);

    await buy(fixture, { agent, quantity: 0 });

    item = await harness.prisma.inventoryItem.findUniqueOrThrow({
      where: { id: fixture.inventoryItemId },
    });
    expect(item.reservedQuantity).toBe(3);
  });

  it('refuses to take payment for stock that is not there', async () => {
    const fixture = await seedSellableProduct({ onHand: 1 });
    const shippingCode = await seedShippingRate();
    const agent = guest();

    await addToCart(agent, fixture.variantId, 5);
    const started = await agent
      .post('/api/v1/checkout')
      .send({ idempotencyKey: idemKey(), email: 'ada@example.test' });
    await agent
      .patch(`/api/v1/checkout/${started.body.id}`)
      .send({ shippingAddress: ADDRESS, shippingMethodCode: shippingCode });
    const priced = await agent.get(`/api/v1/checkout/${started.body.id}`);

    const response = await agent
      .post(`/api/v1/checkout/${started.body.id}/prepare`)
      .send({ pricingFingerprint: priced.body.pricingFingerprint });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/sold out/i);

    // And crucially, no payment was created.
    expect(await harness.prisma.payment.count()).toBe(0);
  });

  it('does not oversell when two customers race for the last unit', async () => {
    // The whole reason the reservation path takes a row lock. Without it, both
    // transactions read "1 available" and both reserve it.
    const fixture = await seedSellableProduct({ onHand: 1 });
    const shippingCode = await seedShippingRate();

    async function attempt() {
      const agent = guest();
      await addToCart(agent, fixture.variantId, 1);
      const started = await agent
        .post('/api/v1/checkout')
        .send({ idempotencyKey: idemKey(), email: 'ada@example.test' });
      await agent
        .patch(`/api/v1/checkout/${started.body.id}`)
        .send({ shippingAddress: ADDRESS, shippingMethodCode: shippingCode });
      const priced = await agent.get(`/api/v1/checkout/${started.body.id}`);
      return agent
        .post(`/api/v1/checkout/${started.body.id}/prepare`)
        .send({ pricingFingerprint: priced.body.pricingFingerprint });
    }

    // `allSettled`, because a transport-level failure under concurrency is a
    // failed attempt from the customer's point of view — which is what the
    // assertion is actually about.
    const settled = await Promise.allSettled([attempt(), attempt(), attempt()]);
    const succeeded = settled.filter(
      (result) => result.status === 'fulfilled' && result.value.status < 400,
    );

    expect(succeeded).toHaveLength(1);

    const item = await harness.prisma.inventoryItem.findUniqueOrThrow({
      where: { id: fixture.inventoryItemId },
    });
    expect(item.reservedQuantity).toBe(1);
    expect(item.reservedQuantity).toBeLessThanOrEqual(item.onHandQuantity);
  });

  it('sells an untracked variant without limit', async () => {
    const fixture = await seedSellableProduct({ onHand: 0, trackInventory: false });
    const { prepared } = await buy(fixture, { quantity: 50 });

    expect(prepared.status).toBe(201);
  });

  it('releases stock when an order is cancelled', async () => {
    const fixture = await seedSellableProduct({ onHand: 10 });
    const { agent, checkoutId } = await buy(fixture, { quantity: 2 });
    const placed = await payAndComplete(agent, checkoutId);

    const staff = await signedInStaff(harness, 'ORDER_MANAGER');
    await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${placed.body.orderId}/cancel`)
      .set(auth(staff))
      .send({ reason: 'Customer changed their mind.', refund: false })
      .expect(201);

    const item = await harness.prisma.inventoryItem.findUniqueOrThrow({
      where: { id: fixture.inventoryItemId },
    });
    expect(item.reservedQuantity).toBe(0);
    // On-hand is untouched: nothing shipped, so nothing left the shelf.
    expect(item.onHandQuantity).toBe(10);
  });

  it('records every stock movement in the append-only ledger', async () => {
    const fixture = await seedSellableProduct({ onHand: 10 });
    const staff = await signedInStaff(harness, 'WAREHOUSE_MANAGER');

    await harness
      .http()
      .post('/api/v1/admin/commerce/inventory/adjustments')
      .set(auth(staff))
      .send({
        variantId: fixture.variantId,
        warehouseId: fixture.warehouseId,
        quantityDelta: 5,
        reason: 'RECEIPT',
        notes: 'Delivery from the manufacturer.',
      })
      .expect(201);

    const ledger = await harness.prisma.inventoryAdjustment.findMany({
      where: { inventoryItemId: fixture.inventoryItemId },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.quantityDelta).toBe(5);
    expect(ledger[0]!.resultingOnHand).toBe(15);

    // The ledger is the arithmetic behind the running total, so it cannot be
    // edited after the fact.
    await expect(
      harness.prisma.inventoryAdjustment.update({
        where: { id: ledger[0]!.id },
        data: { quantityDelta: 500 },
      }),
    ).rejects.toThrow();
  });

  it('refuses an adjustment that would take stock negative', async () => {
    const fixture = await seedSellableProduct({ onHand: 3 });
    const staff = await signedInStaff(harness, 'WAREHOUSE_MANAGER');

    const response = await harness
      .http()
      .post('/api/v1/admin/commerce/inventory/adjustments')
      .set(auth(staff))
      .send({
        variantId: fixture.variantId,
        warehouseId: fixture.warehouseId,
        quantityDelta: -10,
        reason: 'CYCLE_COUNT',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/negative/i);
  });

  it('refuses an adjustment that would strand a reserved order', async () => {
    // Removing stock customers have already been promised is a decision
    // someone has to make deliberately, by releasing the orders first.
    const fixture = await seedSellableProduct({ onHand: 5 });
    await buy(fixture, { quantity: 4 });

    const staff = await signedInStaff(harness, 'WAREHOUSE_MANAGER');
    const response = await harness
      .http()
      .post('/api/v1/admin/commerce/inventory/adjustments')
      .set(auth(staff))
      .send({
        variantId: fixture.variantId,
        warehouseId: fixture.warehouseId,
        quantityDelta: -3,
        reason: 'DAMAGE',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/reserved/i);
  });

  it('requires INVENTORY_ADJUST to move stock', async () => {
    const fixture = await seedSellableProduct();
    const staff = await signedInStaff(harness, 'SUPPORT_AGENT');

    const response = await harness
      .http()
      .post('/api/v1/admin/commerce/inventory/adjustments')
      .set(auth(staff))
      .send({
        variantId: fixture.variantId,
        warehouseId: fixture.warehouseId,
        quantityDelta: 1,
        reason: 'CORRECTION',
      });

    expect(response.status).toBe(403);
  });
});

describe('orders', () => {
  it('copies product details onto the line rather than joining at read time', async () => {
    // A listing can be renamed, repriced or withdrawn; the invoice must still
    // say what was bought and what it cost.
    const fixture = await seedSellableProduct({ priceCents: 2400 });
    const { agent, checkoutId } = await buy(fixture);
    const placed = await payAndComplete(agent, checkoutId);

    await harness.prisma.product.update({
      where: { id: fixture.productId },
      data: { name: 'Renamed Entirely', priceCents: 9900, status: 'ARCHIVED' },
    });

    const item = await harness.prisma.orderItem.findFirstOrThrow({
      where: { orderId: placed.body.orderId },
    });
    expect(item.productName).toBe('Test Magnesium');
    expect(item.unitPriceCents).toBe(2400);
  });

  it('stores totals that satisfy the database’s own arithmetic checks', async () => {
    const fixture = await seedSellableProduct({ priceCents: 1003 });
    const { agent, checkoutId } = await buy(fixture, { quantity: 3 });
    const placed = await payAndComplete(agent, checkoutId);

    const order = await harness.prisma.order.findUniqueOrThrow({
      where: { id: placed.body.orderId },
      include: { items: true },
    });

    expect(order.totalCents).toBe(
      order.subtotalCents - order.discountCents + order.shippingCents + order.taxCents,
    );
    const lineSum = order.items.reduce((sum, item) => sum + item.lineSubtotalCents, 0);
    expect(lineSum).toBe(order.subtotalCents);
  });

  it('gives every order an unguessable reference', async () => {
    // A sequential reference tells every customer how many orders the business
    // has taken, and lets anyone enumerate them.
    const first = await seedSellableProduct();
    const second = await seedSellableProduct();

    const a = await buy(first).then((flow) => payAndComplete(flow.agent, flow.checkoutId));
    const b = await buy(second).then((flow) => payAndComplete(flow.agent, flow.checkoutId));

    const refs = await harness.prisma.order.findMany({ select: { reference: true } });
    expect(new Set(refs.map((entry) => entry.reference)).size).toBe(2);
    for (const entry of refs) expect(entry.reference).toMatch(/^HC-\d{4}-[0-9A-Z]{6}$/);
    expect(a.body.reference).not.toBe(b.body.reference);
  });

  it('writes an append-only timeline', async () => {
    const fixture = await seedSellableProduct();
    const { agent, checkoutId } = await buy(fixture);
    const placed = await payAndComplete(agent, checkoutId);

    const events = await harness.prisma.orderEvent.findMany({
      where: { orderId: placed.body.orderId },
    });
    expect(events.map((event) => event.type)).toContain('order.placed');

    // The first place anyone looks when a customer disputes a charge.
    await expect(
      harness.prisma.orderEvent.update({
        where: { id: events[0]!.id },
        data: { message: 'rewritten' },
      }),
    ).rejects.toThrow();
    await expect(
      harness.prisma.orderEvent.delete({ where: { id: events[0]!.id } }),
    ).rejects.toThrow();
  });

  it('refuses an impossible status transition', async () => {
    const fixture = await seedSellableProduct();
    const { agent, checkoutId } = await buy(fixture);
    const placed = await payAndComplete(agent, checkoutId);

    const staff = await signedInStaff(harness, 'ORDER_MANAGER');
    await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${placed.body.orderId}/cancel`)
      .set(auth(staff))
      .send({ reason: 'Duplicate order.', refund: false })
      .expect(201);

    // Cancelled is terminal: an order that needs to come back is a new order.
    const again = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${placed.body.orderId}/cancel`)
      .set(auth(staff))
      .send({ reason: 'Trying again.', refund: false });

    expect(again.status).toBe(409);
  });

  it('requires a reason to cancel', async () => {
    const fixture = await seedSellableProduct();
    const { agent, checkoutId } = await buy(fixture);
    const placed = await payAndComplete(agent, checkoutId);

    const staff = await signedInStaff(harness, 'ORDER_MANAGER');
    const response = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${placed.body.orderId}/cancel`)
      .set(auth(staff))
      .send({ refund: false });

    expect(response.status).toBe(400);
  });

  it('shows a customer only their own orders', async () => {
    const fixture = await seedSellableProduct();
    const { agent, checkoutId } = await buy(fixture);
    await payAndComplete(agent, checkoutId);

    const customer = await signedInStaff(harness, 'CUSTOMER', 'someone@example.test');
    const response = await harness.http().get('/api/v1/orders').set(auth(customer));

    // The guest order belongs to no customer, so it is not theirs.
    expect(response.status).toBe(404);
  });

  it('refuses order administration to a role without ORDER_READ', async () => {
    const staff = await signedInStaff(harness, 'CONTENT_MANAGER');
    const response = await harness.http().get('/api/v1/admin/commerce/orders').set(auth(staff));

    expect(response.status).toBe(403);
  });
});

describe('refunds', () => {
  async function placedOrder(priceCents = 2400) {
    const fixture = await seedSellableProduct({ priceCents, onHand: 10 });
    const { agent, checkoutId } = await buy(fixture, { shippingCode: await seedShippingRate(0) });
    const placed = await payAndComplete(agent, checkoutId);
    return { fixture, orderId: placed.body.orderId as string };
  }

  /** A reviewer with REFUND_ISSUE and a completed MFA session. */
  async function refunder() {
    return signedInStaff(harness, 'ORDER_MANAGER', 'refunds@example.test');
  }

  it('refunds up to what was captured', async () => {
    const { orderId } = await placedOrder(2400);
    const staff = await refunder();

    const response = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
      .set(auth(staff))
      .send({
        idempotencyKey: idemKey('refund'),
        amountCents: 1000,
        reason: 'REQUESTED_BY_CUSTOMER',
        notes: 'Customer asked for a partial refund on a damaged outer box.',
      });

    expect(response.status).toBe(201);

    const order = await harness.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.amountRefundedCents).toBe(1000);
    expect(order.paymentStatus).toBe('PARTIALLY_REFUNDED');
  });

  it('refuses to refund more than was captured', async () => {
    const { orderId } = await placedOrder(2400);
    const staff = await refunder();

    const response = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
      .set(auth(staff))
      .send({
        idempotencyKey: idemKey('over'),
        amountCents: 999_999,
        reason: 'GOODWILL',
        notes: 'Attempting to refund far more than was ever charged.',
      });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/remains refundable/i);
  });

  it('refuses a second refund that would exceed the capture in total', async () => {
    const { orderId } = await placedOrder(2400);
    const staff = await refunder();

    const send = (amountCents: number, key: string) =>
      harness
        .http()
        .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
        .set(auth(staff))
        .send({
          idempotencyKey: key,
          amountCents,
          reason: 'GOODWILL',
          notes: 'A partial refund, issued in two parts for testing.',
        });

    await send(2000, idemKey('first')).expect(201);
    const second = await send(1000, idemKey('second'));

    expect(second.status).toBe(422);
  });

  it('gives money back once for a repeated idempotency key', async () => {
    const { orderId } = await placedOrder(2400);
    const staff = await refunder();
    const key = idemKey('once');

    const body = {
      idempotencyKey: key,
      amountCents: 500,
      reason: 'GOODWILL' as const,
      notes: 'A retried request must not refund twice.',
    };

    const first = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
      .set(auth(staff))
      .send(body);
    const second = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
      .set(auth(staff))
      .send(body);

    expect(second.body.id).toBe(first.body.id);
    expect(await harness.prisma.refund.count({ where: { orderId } })).toBe(1);

    const order = await harness.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.amountRefundedCents).toBe(500);
  });

  it('requires a written reason', async () => {
    const { orderId } = await placedOrder();
    const staff = await refunder();

    const response = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
      .set(auth(staff))
      .send({
        idempotencyKey: idemKey(),
        amountCents: 100,
        reason: 'GOODWILL',
        notes: 'too short',
      });

    expect(response.status).toBe(400);
  });

  it('refuses refunds to a role without REFUND_ISSUE', async () => {
    const { orderId } = await placedOrder();
    const staff = await signedInStaff(harness, 'SUPPORT_AGENT');

    const response = await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
      .set(auth(staff))
      .send({
        idempotencyKey: idemKey(),
        amountCents: 100,
        reason: 'GOODWILL',
        notes: 'A support agent should not be able to move money.',
      });

    expect(response.status).toBe(403);
  });

  it('records who issued it and why, permanently', async () => {
    const { orderId } = await placedOrder();
    const staff = await refunder();

    await harness
      .http()
      .post(`/api/v1/admin/commerce/orders/${orderId}/refunds`)
      .set(auth(staff))
      .send({
        idempotencyKey: idemKey(),
        amountCents: 400,
        reason: 'DAMAGED',
        notes: 'Bottle arrived with a broken seal; photograph on the support ticket.',
      })
      .expect(201);

    const refund = await harness.prisma.refund.findFirstOrThrow({ where: { orderId } });
    expect(refund.actorId).toBe(staff.userId);
    expect(refund.notes).toMatch(/broken seal/);

    const audit = await harness.prisma.auditLog.findFirst({
      where: { entityId: orderId, action: 'refund.issued' },
    });
    expect(audit).not.toBeNull();
  });
});

describe('the publishing gate now checks inventory', () => {
  it('blocks a product with no stock record in an active warehouse', async () => {
    const product = await harness.prisma.product.create({
      data: {
        sku: 'HC-NOSTOCK-1',
        slug: 'no-stock',
        name: 'Unstocked Product',
        type: 'SUPPLEMENT',
        priceCents: 1000,
      },
    });
    await harness.prisma.productVariant.create({
      data: { productId: product.id, sku: 'HC-NOSTOCK-1-V1', name: 'Default' },
    });

    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${product.id}/readiness`)
      .set(auth(staff));

    expect(readiness.body.blockedBy).toContain('INVENTORY_CONFIGURED');
    // And it is no longer reported as a future phase.
    expect(readiness.body.notYetEnforced).not.toContain('INVENTORY_CONFIGURED');
  });

  it('passes once the variant is stocked', async () => {
    const fixture = await seedSellableProduct();
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${fixture.productId}/readiness`)
      .set(auth(staff));

    expect(readiness.body.blockedBy).not.toContain('INVENTORY_CONFIGURED');
  });
});
