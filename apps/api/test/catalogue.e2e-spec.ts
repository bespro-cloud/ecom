import sharp from 'sharp';
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
 * A real PNG, generated rather than checked in.
 *
 * The media pipeline decodes before it trusts anything, so a fixture that is
 * not actually an image would be rejected — which means this exercises the
 * real path rather than a stub.
 */
async function pngBytes(width = 800, height = 800, tint = { r: 240, g: 240, b: 240 }) {
  return sharp({
    create: { width, height, channels: 3, background: tint },
  })
    .png()
    .toBuffer();
}

async function uploadImage(staff: SignedInStaff, tint?: { r: number; g: number; b: number }) {
  const response = await harness
    .http()
    .post('/api/v1/media/images')
    .set(auth(staff))
    .attach('file', await pngBytes(800, 800, tint), 'product.png');

  expect(response.status).toBe(201);
  return response.body as { id: string; checksum: string; url: string | null };
}

async function createCategory(staff: SignedInStaff, slug: string, parentId?: string) {
  const response = await harness
    .http()
    .post('/api/v1/admin/catalogue/categories')
    .set(auth(staff))
    .send({ slug, name: slug.replace(/-/g, ' '), ...(parentId ? { parentId } : {}) });

  expect(response.status).toBe(201);
  return response.body as { id: string; slug: string; depth: number };
}

async function createIngredient(staff: SignedInStaff, slug: string, extra: object = {}) {
  const response = await harness
    .http()
    .post('/api/v1/admin/catalogue/ingredients')
    .set(auth(staff))
    .send({
      slug,
      name: slug.replace(/-/g, ' '),
      description: 'Seeded by the integration suite.',
      ...extra,
    });

  expect(response.status).toBe(201);
  return response.body as { id: string; slug: string };
}

async function createDraftProduct(staff: SignedInStaff, overrides: object = {}) {
  const response = await harness
    .http()
    .post('/api/v1/admin/catalogue/products')
    .set(auth(staff))
    .send({
      sku: 'HC-TEST-001',
      slug: 'test-magnesium',
      name: 'Test Magnesium Glycinate',
      type: 'SUPPLEMENT',
      shortDescription: '120 capsules.',
      longDescription: 'A chelated magnesium supplement in a vegetarian capsule.',
      brand: 'Health Commerce',
      manufacturer: 'Example Manufacturing LLC',
      countryOfOrigin: 'US',
      priceCents: 2499,
      ...overrides,
    });

  expect(response.status).toBe(201);
  return response.body as { id: string; sku: string; slug: string; status: string };
}

/**
 * Brings a draft all the way to "everything except the compliance signature".
 *
 * Written as a helper because almost every gate test needs a product that is
 * failing exactly one check, and building it inline five times would hide
 * which check each test is actually about.
 */
/**
 * Gives a product somewhere to be stocked.
 *
 * Phase 3 made `INVENTORY_CONFIGURED` a real check: a product cannot be
 * published unless a warehouse could actually fill an order for it. These
 * fixtures therefore need a variant with a stock record, the same as a real
 * listing would.
 */
async function stockProduct(productId: string): Promise<void> {
  const variant = await harness.prisma.productVariant.create({
    data: {
      productId,
      sku: `V-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      name: 'Default',
      isActive: true,
    },
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

  await harness.prisma.inventoryItem.create({
    data: { variantId: variant.id, warehouseId: warehouse.id, onHandQuantity: 100 },
  });
}

async function makeReadyExceptCompliance(staff: SignedInStaff, productId: string) {
  await stockProduct(productId);

  const [hero, label, facts] = await Promise.all([
    uploadImage(staff, { r: 250, g: 250, b: 250 }),
    uploadImage(staff, { r: 200, g: 200, b: 200 }),
    uploadImage(staff, { r: 150, g: 150, b: 150 }),
  ]);

  await harness
    .http()
    .put(`/api/v1/admin/catalogue/products/${productId}/images`)
    .set(auth(staff))
    .send({
      images: [
        { mediaId: hero.id, role: 'HERO', altText: 'A white bottle of magnesium capsules.' },
        { mediaId: label.id, role: 'LABEL', altText: 'The product label and ingredient list.' },
        { mediaId: facts.id, role: 'FACTS_PANEL', altText: 'The supplement facts panel.' },
      ],
    })
    .expect(200);

  const ingredient = await createIngredient(staff, 'magnesium-glycinate');
  await harness
    .http()
    .put(`/api/v1/admin/catalogue/products/${productId}/ingredients`)
    .set(auth(staff))
    .send({ ingredients: [{ ingredientId: ingredient.id, amount: 200, unit: 'mg' }] })
    .expect(200);

  const category = await createCategory(staff, 'minerals');
  await harness
    .http()
    .put(`/api/v1/admin/catalogue/products/${productId}/categories`)
    .set(auth(staff))
    .send({ categoryIds: [category.id], primaryCategoryId: category.id })
    .expect(200);

  await harness
    .http()
    .put(`/api/v1/content/admin/seo/PRODUCT/${productId}`)
    .set(auth(staff))
    .send({
      title: 'Test Magnesium Glycinate, 120 Capsules',
      description: 'Chelated magnesium glycinate, 200 mg elemental magnesium per capsule.',
    })
    .expect(200);

  return { hero, label, facts, ingredient, category };
}

async function approveCompliance(
  reviewer: SignedInStaff,
  productId: string,
  notes = 'Label, ingredient list and disclaimers checked against the supplier documentation.',
) {
  return harness
    .http()
    .post(`/api/v1/compliance/products/${productId}/decision`)
    .set(auth(reviewer))
    .send({ decision: 'APPROVED', notes });
}

async function setStatus(staff: SignedInStaff, productId: string, status: string, reason?: string) {
  return harness
    .http()
    .put(`/api/v1/admin/catalogue/products/${productId}/status`)
    .set(auth(staff))
    .send({ status, ...(reason ? { reason } : {}) });
}

/**
 * Walks a draft towards publication and returns the response to the first step
 * that was refused, or to the publication attempt itself.
 *
 * There is no DRAFT-to-PUBLISHED transition: the state machine makes someone
 * pass through review, and both READY and PUBLISHED are gated. Returning the
 * first refusal is what lets a test assert on the gate without caring which of
 * the two transitions it tripped.
 */
async function publish(staff: SignedInStaff, productId: string) {
  let status = (await harness.prisma.product.findUniqueOrThrow({ where: { id: productId } }))
    .status;

  for (const next of ['IN_REVIEW', 'READY', 'PUBLISHED']) {
    if (status === next) continue;
    const response = await setStatus(staff, productId, next);
    if (response.status >= 400) return response;
    status = response.body.product.status as string;
  }

  return setStatus(staff, productId, 'PUBLISHED');
}

/** The checks the gate reported as failing, from the error payload. */
function blockedBy(response: { body: { error: { details: Array<{ path: string }> } } }): string[] {
  return response.body.error.details.map((detail) => detail.path);
}

async function auditActions(productId: string): Promise<string[]> {
  const logs = await harness.prisma.auditLog.findMany({
    where: { entityType: 'product', entityId: productId },
    orderBy: { createdAt: 'asc' },
    select: { action: true },
  });
  return logs.map((log) => log.action);
}

// ---------------------------------------------------------------------------

describe('product creation', () => {
  it('always creates a draft, whatever the request asks for', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff, { status: 'PUBLISHED' });

    // There is deliberately no field that produces a publicly visible listing
    // in one step.
    expect(product.status).toBe('DRAFT');
  });

  it('applies the disclaimers the product type requires', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff);

    const disclaimers = await harness.prisma.productDisclaimer.findMany({
      where: { productId: product.id },
      select: { kind: true, text: true },
    });

    expect(disclaimers.map((entry) => entry.kind).sort()).toEqual(['DSHEA', 'GENERAL_HEALTH']);
    // The text is copied onto the listing, not referenced, so a later edit to
    // the setting cannot rewrite what an approved listing says.
    expect(disclaimers.find((entry) => entry.kind === 'DSHEA')?.text).toContain(
      'have not been evaluated by the Food and Drug Administration',
    );
  });

  it('refuses a duplicate SKU, and says why SKUs are not reused', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    await createDraftProduct(staff);

    const response = await harness
      .http()
      .post('/api/v1/admin/catalogue/products')
      .set(auth(staff))
      .send({
        sku: 'HC-TEST-001',
        slug: 'a-different-slug',
        name: 'Another Product',
        type: 'SUPPLEMENT',
        priceCents: 1000,
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/historical orders/i);
  });

  it('refuses a compare-at price that does not describe a real discount', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const response = await harness
      .http()
      .post('/api/v1/admin/catalogue/products')
      .set(auth(staff))
      .send({
        sku: 'HC-TEST-002',
        slug: 'fake-discount',
        name: 'Fake Discount Product',
        type: 'SUPPLEMENT',
        priceCents: 2000,
        compareAtPriceCents: 1500,
      });

    expect(response.status).toBe(400);
  });

  it('refuses creation to a role without PRODUCT_WRITE', async () => {
    const staff = await signedInStaff(harness, 'SUPPORT_AGENT');
    const response = await harness
      .http()
      .post('/api/v1/admin/catalogue/products')
      .set(auth(staff))
      .send({
        sku: 'HC-X',
        slug: 'x-product',
        name: 'X Product',
        type: 'SUPPLEMENT',
        priceCents: 1,
      });

    expect(response.status).toBe(403);
  });
});

describe('the publishing gate', () => {
  it('refuses to publish a bare draft and records why', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff);

    const response = await publish(staff, product.id);

    expect(response.status).toBe(422);
    // Stopped at the first gated transition, which is READY. The compliance
    // signature is not expected there — that is what a reviewer is for — so it
    // is correctly absent from this refusal.
    expect(blockedBy(response)).toEqual(
      expect.arrayContaining([
        'IMAGES',
        'LABEL',
        'INGREDIENTS',
        'SEO',
        'CATEGORY',
        'INVENTORY_CONFIGURED',
      ]),
    );

    const stored = await harness.prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(stored.status).not.toBe('PUBLISHED');
    expect(stored.publishedAt).toBeNull();

    // A blocked attempt is itself worth recording: it is evidence that the gate
    // was exercised, and it is how a pattern of attempts becomes visible.
    expect(await auditActions(product.id)).toContain('product.publish.blocked');
  });

  it('still refuses when everything is ready except the compliance signature', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${product.id}/readiness`)
      .set(auth(staff));

    expect(readiness.body.blockedBy).toEqual(['COMPLIANCE_APPROVED']);

    const response = await publish(staff, product.id);
    expect(response.status).toBe(422);
  });

  it('reports later-phase checks as not-yet-enforced rather than as passes', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff);

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${product.id}/readiness`)
      .set(auth(staff));

    // Inventory became enforceable in Phase 3; claims and evidence arrive in
    // Phase 4.
    expect(readiness.body.notYetEnforced.sort()).toEqual(['CLAIMS_REVIEWED', 'EVIDENCE_REVIEWED']);
  });

  it('publishes once a compliance reviewer has approved it', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);

    const decision = await approveCompliance(reviewer, product.id);
    expect(decision.status).toBe(201);

    const response = await publish(staff, product.id);
    expect(response.status).toBe(200);
    expect(response.body.product.status).toBe('PUBLISHED');
    expect(response.body.product.publishedAt).not.toBeNull();

    expect(await auditActions(product.id)).toContain('product.published');
  });

  it('evaluates the gate at the transition, not when the screen was rendered', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);
    await approveCompliance(reviewer, product.id);

    // The admin screen is rendered here: the checklist is green.
    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${product.id}/readiness`)
      .set(auth(staff));
    expect(readiness.body.ready).toBe(true);

    // Someone withdraws the approval while that screen is still open.
    await harness
      .http()
      .post(`/api/v1/compliance/products/${product.id}/decision`)
      .set(auth(reviewer))
      .send({ decision: 'REJECTED', notes: 'The supplier documentation does not match the label.' })
      .expect(201);

    const response = await publish(staff, product.id);
    expect(response.status).toBe(422);
    expect(blockedBy(response)).toContain('COMPLIANCE_APPROVED');
  });

  it('refuses publication to a role that can write products but not publish them', async () => {
    const writer = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(writer);
    await makeReadyExceptCompliance(writer, product.id);
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    await approveCompliance(reviewer, product.id);

    // The compliance reviewer approved it, but approving is not publishing.
    const response = await publish(reviewer, product.id);
    expect(response.status).toBe(403);
  });

  it('requires a reason to take a live listing out of sale', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);
    await approveCompliance(reviewer, product.id);
    await publish(staff, product.id);

    const withoutReason = await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${product.id}/status`)
      .set(auth(staff))
      .send({ status: 'DRAFT' });
    expect(withoutReason.status).toBe(400);

    const withReason = await setStatus(
      staff,
      product.id,
      'DRAFT',
      'A supplier recall notice arrived this morning.',
    );
    expect(withReason.status).toBe(200);

    const log = await harness.prisma.auditLog.findFirst({
      where: { entityId: product.id, action: 'product.unpublished' },
    });
    expect(log?.reason).toMatch(/recall/i);
  });
});

describe('compliance approval', () => {
  it('is not available to an administrator', async () => {
    const admin = await signedInStaff(harness, 'ADMIN');
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff);

    // Separation of duty: administering the store is not the same authority as
    // signing off a health product listing.
    const response = await approveCompliance(admin, product.id);
    expect(response.status).toBe(403);
  });

  it('records an append-only decision with the checklist the reviewer saw', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);
    await approveCompliance(reviewer, product.id);

    const review = await harness.prisma.complianceReview.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(review.reviewerId).toBe(reviewer.userId);
    expect(review.reviewDueAt).not.toBeNull();

    const snapshot = review.checklistSnapshot as {
      ready: boolean;
      checks: Array<{ key: string; state: string }>;
    };
    // The snapshot is what the reviewer was looking at *while deciding*, so the
    // one outstanding check is their own signature. Everything else has to have
    // been green, or the record would not show what it claims to.
    expect(snapshot.checks.filter((check) => check.state === 'FAIL').map((c) => c.key)).toEqual([
      'COMPLIANCE_APPROVED',
    ]);

    // A decision that could be edited afterwards is not evidence of anything.
    await expect(
      harness.prisma.complianceReview.update({
        where: { id: review.id },
        data: { notes: 'rewritten' },
      }),
    ).rejects.toThrow();
    await expect(
      harness.prisma.complianceReview.delete({ where: { id: review.id } }),
    ).rejects.toThrow();
  });

  it('takes a live listing down the moment it is rejected', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);
    await approveCompliance(reviewer, product.id);
    await publish(staff, product.id);

    await harness
      .http()
      .post(`/api/v1/compliance/products/${product.id}/decision`)
      .set(auth(reviewer))
      .send({ decision: 'REJECTED', notes: 'The country of origin on the label is wrong.' })
      .expect(201);

    const stored = await harness.prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(stored.status).toBe('DRAFT');
    expect(stored.publishedAt).toBeNull();
  });
});

describe('changes that invalidate an approval', () => {
  let staff: SignedInStaff;
  let reviewer: SignedInStaff;
  let productId: string;

  beforeEach(async () => {
    staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);
    await approveCompliance(reviewer, product.id);
    await publish(staff, product.id);
    productId = product.id;
  });

  async function currentState() {
    const product = await harness.prisma.product.findUniqueOrThrow({ where: { id: productId } });
    return { status: product.status, complianceStatus: product.complianceStatus };
  }

  it('withdraws a live listing when the formulation changes', async () => {
    const replacement = await createIngredient(staff, 'magnesium-citrate');
    await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${productId}/ingredients`)
      .set(auth(staff))
      .send({ ingredients: [{ ingredientId: replacement.id, amount: 200, unit: 'mg' }] })
      .expect(200);

    expect(await currentState()).toEqual({ status: 'DRAFT', complianceStatus: 'NOT_REVIEWED' });
  });

  it('withdraws a live listing when the manufacturer changes', async () => {
    await harness
      .http()
      .patch(`/api/v1/admin/catalogue/products/${productId}`)
      .set(auth(staff))
      .send({ manufacturer: 'A Completely Different Contract Manufacturer Inc' })
      .expect(200);

    expect(await currentState()).toEqual({ status: 'DRAFT', complianceStatus: 'NOT_REVIEWED' });
  });

  it('withdraws a live listing when the warnings change', async () => {
    await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${productId}/warnings`)
      .set(auth(staff))
      .send({
        warnings: [
          { text: 'Keep out of reach of children.', severity: 'WARNING', audience: 'GENERAL' },
        ],
      })
      .expect(200);

    expect(await currentState()).toEqual({ status: 'DRAFT', complianceStatus: 'NOT_REVIEWED' });
  });

  it('withdraws a live listing when the label photograph is replaced', async () => {
    const product = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${productId}`)
      .set(auth(staff));
    const images = product.body.images as Array<{ mediaId: string; role: string; altText: string }>;
    const newLabel = await uploadImage(staff, { r: 10, g: 20, b: 30 });

    await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${productId}/images`)
      .set(auth(staff))
      .send({
        images: images.map((image) =>
          image.role === 'LABEL'
            ? { mediaId: newLabel.id, role: 'LABEL', altText: 'The corrected product label.' }
            : { mediaId: image.mediaId, role: image.role, altText: image.altText },
        ),
      })
      .expect(200);

    expect(await currentState()).toEqual({ status: 'DRAFT', complianceStatus: 'NOT_REVIEWED' });
  });

  it('leaves a live listing alone when only the gallery order changes', async () => {
    // Not everything is material. Re-ordering the gallery does not change what
    // the reviewer read, and voiding an approval over it would train people to
    // stop believing the signal.
    const product = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${productId}`)
      .set(auth(staff));
    const images = product.body.images as Array<{ mediaId: string; role: string; altText: string }>;

    await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${productId}/images`)
      .set(auth(staff))
      .send({
        images: images.map((image, index) => ({
          mediaId: image.mediaId,
          role: image.role,
          altText: image.altText,
          position: images.length - index,
        })),
      })
      .expect(200);

    expect(await currentState()).toEqual({ status: 'PUBLISHED', complianceStatus: 'APPROVED' });
  });

  it('withdraws every listing containing an ingredient that gains a warning', async () => {
    const ingredient = await harness.prisma.ingredient.findFirstOrThrow({
      where: { slug: 'magnesium-glycinate' },
    });

    await harness
      .http()
      .post(`/api/v1/admin/catalogue/ingredients/${ingredient.id}/warnings`)
      .set(auth(staff))
      .send({
        severity: 'WARNING',
        audience: 'PREGNANCY',
        text: 'Talk to your doctor before taking this if you are pregnant or nursing.',
      })
      .expect(201);

    // Blunt on purpose: a new safety warning is exactly the kind of change the
    // previous approval did not cover.
    expect(await currentState()).toEqual({ status: 'DRAFT', complianceStatus: 'NOT_REVIEWED' });
  });
});

describe('allergen disclosure', () => {
  it('blocks a listing whose allergen ingredient is not declared anywhere', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff, { sku: 'HC-FISH-001', slug: 'fish-oil' });
    await makeReadyExceptCompliance(staff, product.id);

    const fishOil = await createIngredient(staff, 'omega-3-fish-oil', {
      isAllergen: true,
      allergen: 'fish',
    });
    await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${product.id}/ingredients`)
      .set(auth(staff))
      .send({ ingredients: [{ ingredientId: fishOil.id, amount: 1000, unit: 'mg' }] })
      .expect(200);

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${product.id}/readiness`)
      .set(auth(staff));

    expect(readiness.body.blockedBy).toContain('WARNINGS');
    const check = readiness.body.checks.find((entry: { key: string }) => entry.key === 'WARNINGS');
    expect(check.detail).toContain('omega 3 fish oil');
  });

  it('clears once a person writes a warning that names the allergen', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff, { sku: 'HC-FISH-002', slug: 'fish-oil-2' });
    await makeReadyExceptCompliance(staff, product.id);

    const fishOil = await createIngredient(staff, 'omega-3-fish-oil', {
      isAllergen: true,
      allergen: 'fish',
    });
    await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${product.id}/ingredients`)
      .set(auth(staff))
      .send({ ingredients: [{ ingredientId: fishOil.id, amount: 1000, unit: 'mg' }] })
      .expect(200);

    await harness
      .http()
      .put(`/api/v1/admin/catalogue/products/${product.id}/warnings`)
      .set(auth(staff))
      .send({
        warnings: [
          {
            text: 'Contains fish. Do not take this product if you are allergic to fish.',
            severity: 'WARNING',
            audience: 'ALLERGY',
          },
        ],
      })
      .expect(200);

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${product.id}/readiness`)
      .set(auth(staff));

    expect(readiness.body.blockedBy).toEqual(['COMPLIANCE_APPROVED']);
  });
});

describe('the public catalogue', () => {
  async function publishedProduct() {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const reviewer = await signedInStaff(harness, 'COMPLIANCE_REVIEWER');
    const product = await createDraftProduct(staff);
    await makeReadyExceptCompliance(staff, product.id);
    await approveCompliance(reviewer, product.id);
    await publish(staff, product.id);
    return { staff, reviewer, product };
  }

  it('does not expose a draft, even by its exact slug', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const product = await createDraftProduct(staff);

    const bySlug = await harness.http().get(`/api/v1/catalogue/products/${product.slug}`);
    expect(bySlug.status).toBe(404);

    const browse = await harness.http().get('/api/v1/catalogue/products');
    expect(browse.body.data).toEqual([]);
  });

  it('serves a published product without authentication', async () => {
    const { product } = await publishedProduct();

    const response = await harness.http().get(`/api/v1/catalogue/products/${product.slug}`);
    expect(response.status).toBe(200);
    expect(response.body.sku).toBe('HC-TEST-001');
    expect(response.body.disclaimers.map((entry: { kind: string }) => entry.kind).sort()).toEqual([
      'DSHEA',
      'GENERAL_HEALTH',
    ]);
    expect(response.body.ingredients).toHaveLength(1);
  });

  it('stops serving it the moment it is withdrawn', async () => {
    const { staff, product } = await publishedProduct();

    expect(
      (await setStatus(staff, product.id, 'DRAFT', 'Withdrawn while a label question is resolved.'))
        .status,
    ).toBe(200);

    expect((await harness.http().get(`/api/v1/catalogue/products/${product.slug}`)).status).toBe(
      404,
    );
  });

  it('finds a published product by full-text search', async () => {
    await publishedProduct();

    const response = await harness
      .http()
      .get('/api/v1/catalogue/products')
      .query({ q: 'magnesium' });
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta.total).toBe(1);
  });

  it('finds it despite a misspelling', async () => {
    await publishedProduct();

    // Trigram similarity, not exact matching: a customer who types "magnesim"
    // should still be sold the product.
    const response = await harness
      .http()
      .get('/api/v1/catalogue/products')
      .query({ q: 'magnesim' });
    expect(response.body.data.length).toBeGreaterThan(0);
  });

  it('returns facet counts for the result set', async () => {
    await publishedProduct();

    const response = await harness.http().get('/api/v1/catalogue/products');
    expect(response.body.facets.categories).toEqual([
      expect.objectContaining({ value: 'minerals', count: 1 }),
    ]);
    expect(response.body.facets.types).toEqual([
      expect.objectContaining({ value: 'SUPPLEMENT', count: 1 }),
    ]);
  });

  it('does not fall over on a query full of tsquery syntax', async () => {
    await publishedProduct();

    for (const q of ["')|'", '!!!', '&&', 'magnesium & | !', '"unclosed']) {
      const response = await harness.http().get('/api/v1/catalogue/products').query({ q });
      expect(response.status).toBe(200);
    }
  });

  it('lists only indexable products in the sitemap feed', async () => {
    const { staff, product } = await publishedProduct();

    const before = await harness.http().get('/api/v1/catalogue/sitemap');
    expect(before.body.products.map((entry: { slug: string }) => entry.slug)).toEqual([
      product.slug,
    ]);

    await harness
      .http()
      .put(`/api/v1/content/admin/seo/PRODUCT/${product.id}`)
      .set(auth(staff))
      .send({
        title: 'Test Magnesium Glycinate, 120 Capsules',
        description: 'Chelated magnesium glycinate, 200 mg elemental magnesium per capsule.',
        noindex: true,
      })
      .expect(200);

    const after = await harness.http().get('/api/v1/catalogue/sitemap');
    expect(after.body.products).toEqual([]);
  });
});

describe('the category tree', () => {
  it('materialises a path that makes a subtree one query', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const root = await createCategory(staff, 'supplements');
    const child = await createCategory(staff, 'vitamins', root.id);
    const grandchild = await createCategory(staff, 'vitamin-d', child.id);

    const stored = await harness.prisma.category.findUniqueOrThrow({
      where: { id: grandchild.id },
    });
    expect(stored.path).toEqual([root.id, child.id]);
    expect(stored.depth).toBe(2);
  });

  it('rewrites descendant paths on a move, keeping the subtree intact', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const root = await createCategory(staff, 'supplements');
    const other = await createCategory(staff, 'wellness');
    const child = await createCategory(staff, 'vitamins', root.id);
    const grandchild = await createCategory(staff, 'vitamin-d', child.id);

    await harness
      .http()
      .patch(`/api/v1/admin/catalogue/categories/${child.id}`)
      .set(auth(staff))
      .send({ parentId: other.id })
      .expect(200);

    const movedChild = await harness.prisma.category.findUniqueOrThrow({ where: { id: child.id } });
    const movedGrandchild = await harness.prisma.category.findUniqueOrThrow({
      where: { id: grandchild.id },
    });

    expect(movedChild.path).toEqual([other.id]);
    // The grandchild is still a child of the moved node, not flattened up to it.
    expect(movedGrandchild.path).toEqual([other.id, child.id]);
    expect(movedGrandchild.depth).toBe(2);
  });

  it('refuses to make a category its own ancestor', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const root = await createCategory(staff, 'supplements');
    const child = await createCategory(staff, 'vitamins', root.id);

    const response = await harness
      .http()
      .patch(`/api/v1/admin/catalogue/categories/${root.id}`)
      .set(auth(staff))
      .send({ parentId: child.id });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);

    const unchanged = await harness.prisma.category.findUniqueOrThrow({ where: { id: root.id } });
    expect(unchanged.parentId).toBeNull();
  });

  it('refuses to make a category its own parent', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const root = await createCategory(staff, 'supplements');

    const response = await harness
      .http()
      .patch(`/api/v1/admin/catalogue/categories/${root.id}`)
      .set(auth(staff))
      .send({ parentId: root.id });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe('media upload', () => {
  it('stores an image under a key derived from its content', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const first = await uploadImage(staff, { r: 12, g: 34, b: 56 });
    const second = await uploadImage(staff, { r: 12, g: 34, b: 56 });

    // The same bytes twice is one stored object, so a media library full of
    // re-uploaded label photographs does not multiply storage.
    expect(second.checksum).toBe(first.checksum);
  });

  it('refuses a file that is not an image, whatever it is called', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const response = await harness
      .http()
      .post('/api/v1/media/images')
      .set(auth(staff))
      .attach('file', Buffer.from('<?php system($_GET["c"]); ?>'), 'product.png');

    // Decoded before it is trusted: the extension and the declared content type
    // are both attacker-controlled, the bytes are not.
    expect(response.status).toBe(400);
  });

  it('refuses an SVG', async () => {
    const staff = await signedInStaff(harness, 'PRODUCT_MANAGER');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const response = await harness
      .http()
      .post('/api/v1/media/images')
      .set(auth(staff))
      .attach('file', Buffer.from(svg), 'logo.svg');

    // An SVG is a document that can carry script, and serving one from our own
    // origin would be stored XSS.
    expect(response.status).toBe(400);
  });

  it('refuses an upload from a role without PRODUCT_WRITE', async () => {
    const staff = await signedInStaff(harness, 'SUPPORT_AGENT');
    const response = await harness
      .http()
      .post('/api/v1/media/images')
      .set(auth(staff))
      .attach('file', await pngBytes(64, 64), 'product.png');

    expect(response.status).toBe(403);
  });
});

describe('CMS pages', () => {
  const blocks = [
    { id: 'block-heading', type: 'heading', level: 2, text: 'Shipping' },
    { id: 'block-body', type: 'richText', markdown: 'Orders ship within two business days.' },
  ];

  it('keeps an edit to a live page out of sight until it is published', async () => {
    const staff = await signedInStaff(harness, 'ADMIN');

    const created = await harness
      .http()
      .post('/api/v1/content/admin/pages')
      .set(auth(staff))
      .send({ slug: 'shipping', title: 'Shipping', blocks })
      .expect(201);

    await harness
      .http()
      .post(`/api/v1/content/admin/pages/${created.body.id}/publish`)
      .set(auth(staff))
      .expect(201);

    await harness
      .http()
      .patch(`/api/v1/content/admin/pages/${created.body.id}`)
      .set(auth(staff))
      .send({
        blocks: [
          {
            id: 'block-body',
            type: 'richText',
            markdown: 'HALF FINISHED EDIT — do not ship this.',
          },
        ],
      })
      .expect(200);

    // The live page is untouched: saving a draft must not change the shipping
    // policy customers are reading.
    const live = await harness.http().get('/api/v1/content/pages/shipping');
    expect(live.status).toBe(200);
    expect(JSON.stringify(live.body.blocks)).not.toContain('HALF FINISHED');

    await harness
      .http()
      .post(`/api/v1/content/admin/pages/${created.body.id}/publish`)
      .set(auth(staff))
      .expect(201);

    const afterPublish = await harness.http().get('/api/v1/content/pages/shipping');
    expect(JSON.stringify(afterPublish.body.blocks)).toContain('HALF FINISHED');
  });

  it('will not store HTML as page content', async () => {
    const staff = await signedInStaff(harness, 'ADMIN');
    const response = await harness
      .http()
      .post('/api/v1/content/admin/pages')
      .set(auth(staff))
      .send({
        slug: 'xss',
        title: 'XSS',
        blocks: [{ id: 'block-evil', type: 'html', html: '<script>alert(1)</script>' }],
      });

    // Blocks are a fixed vocabulary. There is no block that can express script,
    // which is what makes stored XSS structurally impossible rather than
    // filtered.
    expect(response.status).toBe(400);
  });

  it('does not serve an unpublished page', async () => {
    const staff = await signedInStaff(harness, 'ADMIN');
    await harness
      .http()
      .post('/api/v1/content/admin/pages')
      .set(auth(staff))
      .send({ slug: 'returns', title: 'Returns', blocks })
      .expect(201);

    expect((await harness.http().get('/api/v1/content/pages/returns')).status).toBe(404);
  });
});
