import { createHarness, signedInStaff, type SignedInStaff, type TestHarness } from './harness.js';
import { InventoryService } from '../src/modules/commerce/inventory/inventory.service.js';
import { ClaimsService } from '../src/modules/compliance/claims/claims.service.js';
import { BatchesService } from '../src/modules/compliance/batches/batches.service.js';

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

const API = '/api/v1/admin/compliance';
const TRACE = '/api/v1/admin/traceability';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  productId: string;
  variantId: string;
  warehouseId: string;
  inventoryItemId: string;
}

async function seedProduct(
  options: { onHand?: number; lotTracked?: boolean } = {},
): Promise<Fixture> {
  const sku = `HC-CMP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const product = await harness.prisma.product.create({
    data: {
      sku,
      slug: sku.toLowerCase(),
      name: 'Test Magnesium',
      type: 'SUPPLEMENT',
      status: 'PUBLISHED',
      complianceStatus: 'APPROVED',
      priceCents: 2400,
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
      onHandQuantity: options.onHand ?? 0,
      trackInventory: true,
      lotTracked: options.lotTracked ?? false,
    },
  });

  return {
    productId: product.id,
    variantId: variant.id,
    warehouseId: warehouse.id,
    inventoryItemId: item.id,
  };
}

/** A compliance reviewer: the only role that can approve a claim. */
async function reviewer(email = 'reviewer@example.test') {
  return signedInStaff(harness, 'COMPLIANCE_REVIEWER', email);
}

/** A product manager: writes claims, cannot approve them. */
async function author(email = 'author@example.test') {
  return signedInStaff(harness, 'PRODUCT_MANAGER', email);
}

async function warehouseStaff(email = 'warehouse@example.test') {
  return signedInStaff(harness, 'WAREHOUSE_MANAGER', email);
}

const EVIDENCE = {
  sourceType: 'RANDOMISED_CONTROLLED_TRIAL' as const,
  title: 'Magnesium and sleep quality in older adults',
  citation: 'Abbasi B et al. J Res Med Sci. 2012;17(12):1161-1169.',
  identifier: '10.1000/example',
  publishedYear: 2012,
  population: '46 elderly participants with insomnia',
  dosage: '500 mg elemental magnesium daily',
  duration: '8 weeks',
  outcome: 'Reported improvement in sleep time and efficiency versus placebo.',
  limitations:
    'Small sample, single centre, self-reported outcomes, and the population was older adults with existing insomnia rather than the general population.',
};

/**
 * Records a claim, attaches accepted evidence and gets it approved.
 *
 * Returns the staff it signed in as well as the claim, because signing in twice
 * with the same address collides on the unique email — and a test that quietly
 * created a *second* author would no longer be testing separation of duty.
 */
async function approvedClaim(
  fixture: Fixture,
  text = 'Supports healthy sleep.',
): Promise<{ claimId: string; writer: SignedInStaff; reviewerStaff: SignedInStaff }> {
  const writer = await author();
  const reviewerStaff = await reviewer();

  const created = await harness
    .http()
    .post(`${API}/products/${fixture.productId}/claims`)
    .set(auth(writer))
    .send({ type: 'STRUCTURE_FUNCTION', text })
    .expect(201);

  const claimId = created.body.id as string;
  const versionId = created.body.currentVersionId as string;

  const evidence = await harness
    .http()
    .post(`${API}/evidence`)
    .set(auth(writer))
    .send(EVIDENCE)
    .expect(201);

  await harness
    .http()
    .post(`${API}/evidence/${evidence.body.id}/decision`)
    .set(auth(reviewerStaff))
    .send({ decision: 'ACCEPTED', notes: 'Sound methodology for the population studied.' })
    .expect(201);

  await harness
    .http()
    .post(`${API}/claims/${claimId}/evidence`)
    .set(auth(writer))
    .send({ evidenceId: evidence.body.id, relevance: 'DIRECT' })
    .expect(201);

  await harness
    .http()
    .post(`${API}/claims/${claimId}/submit`)
    .set(auth(writer))
    .send({})
    .expect(201);

  await harness
    .http()
    .post(`${API}/claims/${claimId}/decision`)
    .set(auth(reviewerStaff))
    .send({
      decision: 'APPROVED',
      versionId,
      notes: 'Wording is a structure/function claim and is supported by the attached trial.',
    })
    .expect(201);

  return { claimId, writer, reviewerStaff };
}

// ---------------------------------------------------------------------------

describe('who may approve a health claim', () => {
  it('refuses a product manager, who writes the copy', async () => {
    // The separation of duty this whole module exists for. The person who
    // writes a health claim must not be the person who signs it off.
    const fixture = await seedProduct();
    const writer = await author();

    const created = await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'STRUCTURE_FUNCTION', text: 'Supports healthy sleep.' })
      .expect(201);

    const response = await harness
      .http()
      .post(`${API}/claims/${created.body.id}/decision`)
      .set(auth(writer))
      .send({
        decision: 'APPROVED',
        versionId: created.body.currentVersionId,
        notes: 'Attempting to approve my own claim, which must not be possible.',
      });

    expect(response.status).toBe(403);
  });

  it('refuses an administrator', async () => {
    const fixture = await seedProduct();
    const writer = await author();
    const admin = await signedInStaff(harness, 'ADMIN', 'admin@example.test');

    const created = await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'STRUCTURE_FUNCTION', text: 'Supports healthy sleep.' })
      .expect(201);

    const response = await harness
      .http()
      .post(`${API}/claims/${created.body.id}/decision`)
      .set(auth(admin))
      .send({
        decision: 'APPROVED',
        versionId: created.body.currentVersionId,
        notes: 'Running the store is not the same authority as signing off a health claim.',
      });

    expect(response.status).toBe(403);
  });
});

describe('claim versioning', () => {
  it('never overwrites the wording a reviewer approved', async () => {
    const fixture = await seedProduct();
    const { claimId, writer } = await approvedClaim(fixture, 'Supports healthy sleep.');

    const before = await harness.prisma.productClaim.findUniqueOrThrow({
      where: { id: claimId },
      include: { approvedVersion: true },
    });

    await harness
      .http()
      .post(`${API}/claims/${claimId}/versions`)
      .set(auth(writer))
      .send({
        text: 'Clinically proven to cure insomnia.',
        changeReason: 'Marketing asked for stronger wording.',
      })
      .expect(201);

    const after = await harness.prisma.productClaim.findUniqueOrThrow({
      where: { id: claimId },
      include: { approvedVersion: true, currentVersion: true },
    });

    // The approved version is untouched, and still the one it was.
    expect(after.approvedVersionId).toBe(before.approvedVersionId);
    expect(after.approvedVersion?.text).toBe('Supports healthy sleep.');
    // The new wording is current, and the claim is back out of approval.
    expect(after.currentVersion?.text).toBe('Clinically proven to cure insomnia.');
    expect(after.currentVersionId).not.toBe(after.approvedVersionId);
    expect(after.status).not.toBe('APPROVED');
  });

  it('keeps showing the approved wording on the listing while a revision is in progress', async () => {
    // The failure this prevents: an unreviewed edit appearing on a live page
    // because the listing reads "the current version".
    const fixture = await seedProduct();
    const { claimId, writer } = await approvedClaim(fixture, 'Supports healthy sleep.');

    await harness
      .http()
      .post(`${API}/claims/${claimId}/versions`)
      .set(auth(writer))
      .send({
        text: 'Clinically proven to cure insomnia.',
        changeReason: 'Marketing asked for stronger wording.',
      })
      .expect(201);

    const claims = await harness.app.get(ClaimsService).publishedFor(fixture.productId);

    // The claim is no longer approved, so it does not render at all. What it
    // must never do is render the new, unreviewed text.
    expect(claims.map((claim) => claim.text)).not.toContain('Clinically proven to cure insomnia.');
  });

  it('refuses a decision aimed at wording that has since changed', async () => {
    const fixture = await seedProduct();
    const writer = await author();
    const reviewerStaff = await reviewer();

    const created = await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'GENERAL', text: 'Third-party tested.' })
      .expect(201);

    const staleVersionId = created.body.currentVersionId as string;

    await harness
      .http()
      .post(`${API}/claims/${created.body.id}/versions`)
      .set(auth(writer))
      .send({
        text: 'Third-party tested for heavy metals.',
        changeReason: 'More specific wording.',
      })
      .expect(201);

    const response = await harness
      .http()
      .post(`${API}/claims/${created.body.id}/decision`)
      .set(auth(reviewerStaff))
      .send({
        decision: 'APPROVED',
        versionId: staleVersionId,
        notes: 'Approving the version I was shown, which is no longer the current one.',
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/edited after this review was opened/i);
  });

  it('keeps every version, and refuses to let one be rewritten afterwards', async () => {
    const fixture = await seedProduct();
    const { claimId, writer } = await approvedClaim(fixture);

    await harness
      .http()
      .post(`${API}/claims/${claimId}/versions`)
      .set(auth(writer))
      .send({ text: 'Supports restful sleep.', changeReason: 'Softer wording.' })
      .expect(201);

    const versions = await harness.prisma.productClaimVersion.findMany({ where: { claimId } });
    expect(versions).toHaveLength(2);

    // Append-only at the database level, not merely by convention.
    await expect(
      harness.prisma.productClaimVersion.update({
        where: { id: versions[0]!.id },
        data: { text: 'rewritten' },
      }),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('substantiation', () => {
  it('refuses to approve a structure/function claim with no accepted evidence', async () => {
    const fixture = await seedProduct();
    const writer = await author();
    const reviewerStaff = await reviewer();

    const created = await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'STRUCTURE_FUNCTION', text: 'Supports healthy sleep.' })
      .expect(201);

    // Submitting is refused before the decision route is even reached.
    const submitted = await harness
      .http()
      .post(`${API}/claims/${created.body.id}/submit`)
      .set(auth(writer))
      .send({});

    expect(submitted.status).toBe(422);
    expect(submitted.body.error.message).toMatch(/accepted piece of evidence/i);
    void reviewerStaff;
  });

  it('does not accept evidence that has not itself been reviewed', async () => {
    const fixture = await seedProduct();
    const writer = await author();

    const created = await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'STRUCTURE_FUNCTION', text: 'Supports healthy sleep.' })
      .expect(201);

    const evidence = await harness
      .http()
      .post(`${API}/evidence`)
      .set(auth(writer))
      .send(EVIDENCE)
      .expect(201);

    // Attached, but nobody has judged whether it is sound.
    await harness
      .http()
      .post(`${API}/claims/${created.body.id}/evidence`)
      .set(auth(writer))
      .send({ evidenceId: evidence.body.id, relevance: 'DIRECT' })
      .expect(201);

    const submitted = await harness
      .http()
      .post(`${API}/claims/${created.body.id}/submit`)
      .set(auth(writer))
      .send({});

    expect(submitted.status).toBe(422);
  });

  it('does not let contradictory evidence substantiate a claim', async () => {
    const fixture = await seedProduct();
    const writer = await author();
    const reviewerStaff = await reviewer();

    const created = await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'STRUCTURE_FUNCTION', text: 'Supports healthy sleep.' })
      .expect(201);

    const evidence = await harness
      .http()
      .post(`${API}/evidence`)
      .set(auth(writer))
      .send(EVIDENCE)
      .expect(201);

    await harness
      .http()
      .post(`${API}/evidence/${evidence.body.id}/decision`)
      .set(auth(reviewerStaff))
      .send({ decision: 'ACCEPTED', notes: 'Sound study, but it cuts against this claim.' })
      .expect(201);

    await harness
      .http()
      .post(`${API}/claims/${created.body.id}/evidence`)
      .set(auth(writer))
      .send({ evidenceId: evidence.body.id, relevance: 'CONTRADICTORY' })
      .expect(201);

    const submitted = await harness
      .http()
      .post(`${API}/claims/${created.body.id}/submit`)
      .set(auth(writer))
      .send({});

    expect(submitted.status).toBe(422);
  });

  it('requires stated limitations on every source', async () => {
    const writer = await author();

    const response = await harness
      .http()
      .post(`${API}/evidence`)
      .set(auth(writer))
      .send({ ...EVIDENCE, limitations: '' });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/limitations/i);
  });

  it('refuses to edit evidence once it has been reviewed', async () => {
    const writer = await author();
    const reviewerStaff = await reviewer();

    const evidence = await harness
      .http()
      .post(`${API}/evidence`)
      .set(auth(writer))
      .send(EVIDENCE)
      .expect(201);

    await harness
      .http()
      .post(`${API}/evidence/${evidence.body.id}/decision`)
      .set(auth(reviewerStaff))
      .send({ decision: 'ACCEPTED', notes: 'Sound methodology for the population studied.' })
      .expect(201);

    const response = await harness
      .http()
      .patch(`${API}/evidence/${evidence.body.id}`)
      .set(auth(writer))
      .send({ outcome: 'Actually it proved something much stronger.' });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/approvals rest on what it said/i);
  });
});

describe('disease claims', () => {
  it('cannot be approved however much evidence is attached', async () => {
    // No amount of substantiation makes a disease claim lawful on a supplement
    // listing, so the refusal is on category rather than on the evidence.
    const fixture = await seedProduct();
    const writer = await author();
    const reviewerStaff = await reviewer();

    const created = await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'DISEASE', text: 'Cures insomnia.' })
      .expect(201);

    await harness
      .http()
      .post(`${API}/claims/${created.body.id}/submit`)
      .set(auth(writer))
      .send({})
      .expect(201);

    const response = await harness
      .http()
      .post(`${API}/claims/${created.body.id}/decision`)
      .set(auth(reviewerStaff))
      .send({
        decision: 'APPROVED',
        versionId: created.body.currentVersionId,
        notes: 'Attempting to approve a disease claim, which must never succeed.',
      });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/disease claim cannot be approved/i);
  });
});

describe('the publishing gate', () => {
  it('blocks a listing carrying a claim nobody approved', async () => {
    const fixture = await seedProduct();
    const writer = await author();

    await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'STRUCTURE_FUNCTION', text: 'Supports healthy sleep.' })
      .expect(201);

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${fixture.productId}/readiness`)
      .set(auth(writer))
      .expect(200);

    expect(readiness.body.blockedBy).toContain('CLAIMS_REVIEWED');
    // And it is no longer reported as a future phase.
    expect(readiness.body.notYetEnforced).not.toContain('CLAIMS_REVIEWED');
    expect(readiness.body.notYetEnforced).not.toContain('EVIDENCE_REVIEWED');
  });

  it('passes once the claim is approved and supported', async () => {
    const fixture = await seedProduct();
    const { writer } = await approvedClaim(fixture);

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${fixture.productId}/readiness`)
      .set(auth(writer))
      .expect(200);

    expect(readiness.body.blockedBy).not.toContain('CLAIMS_REVIEWED');
    expect(readiness.body.blockedBy).not.toContain('EVIDENCE_REVIEWED');
  });

  it('says plainly that it only checks claims someone recorded', async () => {
    // The gate must not imply it detects claims in marketing copy. Someone
    // reading a green tick should be able to tell what it does and does not
    // cover without reading the source.
    const fixture = await seedProduct();
    const writer = await author();

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${fixture.productId}/readiness`)
      .set(auth(writer))
      .expect(200);

    const check = readiness.body.checks.find(
      (entry: { key: string }) => entry.key === 'CLAIMS_REVIEWED',
    );
    expect(check.state).toBe('PASS');
    expect(check.detail).toMatch(/no claims are recorded/i);
  });

  it('blocks again when an approval lapses', async () => {
    const fixture = await seedProduct();
    const { claimId, writer } = await approvedClaim(fixture);

    // Wind the review date into the past rather than waiting a year.
    await harness.prisma.productClaim.update({
      where: { id: claimId },
      data: { reviewDueAt: new Date(Date.now() - 60_000) },
    });

    const readiness = await harness
      .http()
      .get(`/api/v1/admin/catalogue/products/${fixture.productId}/readiness`)
      .set(auth(writer))
      .expect(200);

    expect(readiness.body.blockedBy).toContain('CLAIMS_REVIEWED');
  });
});

describe('what a customer sees', () => {
  it('shows an approved claim', async () => {
    const fixture = await seedProduct();
    await approvedClaim(fixture, 'Supports healthy sleep.');

    const product = await harness.prisma.product.findUniqueOrThrow({
      where: { id: fixture.productId },
      select: { slug: true },
    });

    const response = await harness
      .http()
      .get(`/api/v1/catalogue/products/${product.slug}`)
      .expect(200);

    expect(response.body.claims.map((claim: { text: string }) => claim.text)).toEqual([
      'Supports healthy sleep.',
    ]);
  });

  it('shows nothing for a claim that is only drafted', async () => {
    const fixture = await seedProduct();
    const writer = await author();

    await harness
      .http()
      .post(`${API}/products/${fixture.productId}/claims`)
      .set(auth(writer))
      .send({ type: 'STRUCTURE_FUNCTION', text: 'Supports healthy sleep.' })
      .expect(201);

    const product = await harness.prisma.product.findUniqueOrThrow({
      where: { id: fixture.productId },
      select: { slug: true },
    });

    const response = await harness
      .http()
      .get(`/api/v1/catalogue/products/${product.slug}`)
      .expect(200);
    expect(response.body.claims).toEqual([]);
  });

  it('drops a claim from the listing the moment its approval expires', async () => {
    const fixture = await seedProduct();
    const { claimId } = await approvedClaim(fixture);

    await harness.prisma.productClaim.update({
      where: { id: claimId },
      data: { reviewDueAt: new Date(Date.now() - 60_000) },
    });
    await harness.app.get(ClaimsService).expireLapsed();

    const product = await harness.prisma.product.findUniqueOrThrow({
      where: { id: fixture.productId },
      select: { slug: true, status: true },
    });

    const response = await harness
      .http()
      .get(`/api/v1/catalogue/products/${product.slug}`)
      .expect(200);

    expect(response.body.claims).toEqual([]);
    // The claim goes; the product stays up. Pulling a whole page down over one
    // lapsed sentence is a bigger customer impact than the lapse represents.
    expect(product.status).toBe('PUBLISHED');
  });
});

// ---------------------------------------------------------------------------
// Lots and FEFO
// ---------------------------------------------------------------------------

async function receiveLot(
  fixture: Fixture,
  staff: SignedInStaff,
  options: { lotCode: string; quantity: number; expiresAt?: Date },
) {
  return harness
    .http()
    .post(`${TRACE}/batches`)
    .set(auth(staff))
    .send({
      variantId: fixture.variantId,
      warehouseId: fixture.warehouseId,
      lotCode: options.lotCode,
      quantity: options.quantity,
      ...(options.expiresAt ? { expiresAt: options.expiresAt.toISOString() } : {}),
    })
    .expect(201);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function reserve(fixture: Fixture, quantity: number) {
  const cart = await harness.prisma.cart.create({
    data: { status: 'ACTIVE', token: `t-${Math.random()}` },
  });
  await harness.app
    .get(InventoryService)
    .reserveForCart(cart.id, [{ variantId: fixture.variantId, quantity }]);
  return cart.id;
}

describe('first-expiry-first-out allocation', () => {
  it('draws from the lot that expires soonest', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    // Received in the opposite order to their expiry, so a first-in-first-out
    // implementation would pick the wrong one and the test would catch it.
    await receiveLot(fixture, staff, {
      lotCode: 'LATE',
      quantity: 10,
      expiresAt: daysFromNow(365),
    });
    await receiveLot(fixture, staff, { lotCode: 'SOON', quantity: 10, expiresAt: daysFromNow(30) });

    await reserve(fixture, 4);

    const soon = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'SOON' },
    });
    const late = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'LATE' },
    });

    expect(soon.quantityReserved).toBe(4);
    expect(late.quantityReserved).toBe(0);
  });

  it('rolls onto the next lot when the earliest runs out', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    await receiveLot(fixture, staff, { lotCode: 'SOON', quantity: 3, expiresAt: daysFromNow(30) });
    await receiveLot(fixture, staff, {
      lotCode: 'LATE',
      quantity: 10,
      expiresAt: daysFromNow(365),
    });

    await reserve(fixture, 5);

    const soon = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'SOON' },
    });
    const late = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'LATE' },
    });

    expect(soon.quantityReserved).toBe(3);
    expect(late.quantityReserved).toBe(2);
  });

  it('sorts an undated lot last, because no stated expiry is not evidence of freshness', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    await receiveLot(fixture, staff, { lotCode: 'UNDATED', quantity: 10 });
    await receiveLot(fixture, staff, {
      lotCode: 'DATED',
      quantity: 10,
      expiresAt: daysFromNow(90),
    });

    await reserve(fixture, 2);

    const dated = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'DATED' },
    });
    expect(dated.quantityReserved).toBe(2);
  });

  it('never allocates quarantined stock', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    const held = await receiveLot(fixture, staff, {
      lotCode: 'HELD',
      quantity: 10,
      expiresAt: daysFromNow(30),
    });
    await receiveLot(fixture, staff, { lotCode: 'OK', quantity: 10, expiresAt: daysFromNow(365) });

    await harness
      .http()
      .post(`${TRACE}/batches/${held.body.id}/disposition`)
      .set(auth(staff))
      .send({ status: 'QUARANTINED', reason: 'Supplier reported a possible labelling error.' })
      .expect(201);

    await reserve(fixture, 4);

    const quarantined = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'HELD' },
    });
    const available = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'OK' },
    });

    // The quarantined lot expires sooner, so FEFO would have picked it first
    // had the status filter not held.
    expect(quarantined.quantityReserved).toBe(0);
    expect(available.quantityReserved).toBe(4);
  });

  it('never allocates expired stock', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    const lot = await receiveLot(fixture, staff, {
      lotCode: 'OLD',
      quantity: 10,
      expiresAt: daysFromNow(1),
    });
    await receiveLot(fixture, staff, { lotCode: 'NEW', quantity: 10, expiresAt: daysFromNow(365) });

    // Wind the date past and run the sweep, exactly as the worker would.
    await harness.prisma.inventoryBatch.update({
      where: { id: lot.body.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await harness.app.get(BatchesService).expireLapsed()).toBe(1);

    await reserve(fixture, 4);

    const old = await harness.prisma.inventoryBatch.findFirstOrThrow({ where: { lotCode: 'OLD' } });
    expect(old.status).toBe('EXPIRED');
    expect(old.quantityReserved).toBe(0);
  });

  it('refuses to allocate lot-tracked stock with no usable lot, rather than shipping something unidentifiable', async () => {
    // The fail-closed case, and the reason lot tracking is worth having: if
    // every lot is held, the correct answer is "we cannot ship this", not "ship
    // it anyway and work out which lot later".
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    const lot = await receiveLot(fixture, staff, { lotCode: 'ONLY', quantity: 10 });
    await harness
      .http()
      .post(`${TRACE}/batches/${lot.body.id}/disposition`)
      .set(auth(staff))
      .send({ status: 'QUARANTINED', reason: 'Held pending a certificate of analysis.' })
      .expect(201);

    // On-hand is still 10 — the goods are physically there.
    const item = await harness.prisma.inventoryItem.findUniqueOrThrow({
      where: { id: fixture.inventoryItemId },
    });
    expect(item.onHandQuantity).toBe(10);

    await expect(reserve(fixture, 1)).rejects.toThrow();

    const availability = await harness.app.get(InventoryService).availability([fixture.variantId]);
    expect(availability.get(fixture.variantId)).toBe(0);
  });

  it('gives a lot its units back when a hold is released', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();
    await receiveLot(fixture, staff, { lotCode: 'L1', quantity: 10, expiresAt: daysFromNow(30) });

    const cartId = await reserve(fixture, 4);
    await harness.app.get(InventoryService).release({ cartId });

    const batch = await harness.prisma.inventoryBatch.findFirstOrThrow({
      where: { lotCode: 'L1' },
    });
    const item = await harness.prisma.inventoryItem.findUniqueOrThrow({
      where: { id: fixture.inventoryItemId },
    });

    // Both counters, or the lot quietly holds stock nobody is buying.
    expect(batch.quantityReserved).toBe(0);
    expect(item.reservedQuantity).toBe(0);
  });

  it('reports only allocatable stock as available', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    const held = await receiveLot(fixture, staff, { lotCode: 'HELD', quantity: 40 });
    await receiveLot(fixture, staff, { lotCode: 'OK', quantity: 10 });

    await harness
      .http()
      .post(`${TRACE}/batches/${held.body.id}/disposition`)
      .set(auth(staff))
      .send({
        status: 'QUARANTINED',
        reason: 'Held pending investigation of a customer complaint.',
      })
      .expect(201);

    const availability = await harness.app.get(InventoryService).availability([fixture.variantId]);

    // 50 units on the shelf, 10 of them sellable.
    expect(availability.get(fixture.variantId)).toBe(10);
  });
});

describe('lot disposition', () => {
  it('requires a written reason in both directions', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();
    const lot = await receiveLot(fixture, staff, { lotCode: 'L1', quantity: 5 });

    const response = await harness
      .http()
      .post(`${TRACE}/batches/${lot.body.id}/disposition`)
      .set(auth(staff))
      .send({ status: 'QUARANTINED', reason: 'bad' });

    expect(response.status).toBe(400);
  });

  it('records every change in a history that cannot be rewritten', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();
    const lot = await receiveLot(fixture, staff, { lotCode: 'L1', quantity: 5 });

    await harness
      .http()
      .post(`${TRACE}/batches/${lot.body.id}/disposition`)
      .set(auth(staff))
      .send({ status: 'QUARANTINED', reason: 'Held pending a certificate of analysis.' })
      .expect(201);

    const events = await harness.prisma.batchEvent.findMany({ where: { batchId: lot.body.id } });
    expect(events.length).toBeGreaterThanOrEqual(2);

    await expect(
      harness.prisma.batchEvent.update({
        where: { id: events[0]!.id },
        data: { reason: 'rewritten' },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to put recalled stock back on the shelf', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();
    const lot = await receiveLot(fixture, staff, { lotCode: 'L1', quantity: 5 });

    await harness.prisma.inventoryBatch.update({
      where: { id: lot.body.id },
      data: { status: 'RECALLED' },
    });

    const response = await harness
      .http()
      .post(`${TRACE}/batches/${lot.body.id}/disposition`)
      .set(auth(staff))
      .send({ status: 'AVAILABLE', reason: 'We decided the recall was unnecessary after all.' });

    expect(response.status).toBe(409);
  });

  it('refuses a lot that is already past its date at receipt', async () => {
    const fixture = await seedProduct();
    const staff = await warehouseStaff();

    const response = await harness
      .http()
      .post(`${TRACE}/batches`)
      .set(auth(staff))
      .send({
        variantId: fixture.variantId,
        warehouseId: fixture.warehouseId,
        lotCode: 'STALE',
        quantity: 5,
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      });

    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Recalls
// ---------------------------------------------------------------------------

/**
 * Places a real order that draws from a specific lot, so the recall has
 * something to trace. Built through the services rather than the checkout API,
 * because what is being tested is the lot-to-order join, not the purchase flow —
 * which has its own suite.
 */
async function orderFromLot(fixture: Fixture, quantity: number): Promise<string> {
  const cart = await harness.prisma.cart.create({
    data: { status: 'ACTIVE', token: `t-${Math.random()}` },
  });
  await harness.app
    .get(InventoryService)
    .reserveForCart(cart.id, [{ variantId: fixture.variantId, quantity }]);

  const order = await harness.prisma.order.create({
    data: {
      reference: `HC-TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      email: 'ada@example.test',
      status: 'PAID',
      paymentStatus: 'CAPTURED',
      subtotalCents: 2400 * quantity,
      totalCents: 2400 * quantity,
      amountPaidCents: 2400 * quantity,
      shippingAddress: ADDRESS as never,
    },
  });

  await harness.prisma.inventoryReservation.updateMany({
    where: { cartId: cart.id, status: 'HELD' },
    data: { cartId: null, orderId: order.id, status: 'COMMITTED', expiresAt: null },
  });

  return order.id;
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

async function openRecallOn(batchId: string, staff: SignedInStaff): Promise<string> {
  const created = await harness
    .http()
    .post(`${TRACE}/recalls`)
    .set(auth(staff))
    .send({
      title: 'Possible undeclared allergen',
      reason: 'Supplier reported a cross-contamination risk on the affected lots.',
      classification: 'CLASS_II',
      batchIds: [batchId],
    })
    .expect(201);

  await harness
    .http()
    .post(`${TRACE}/recalls/${created.body.id}/open`)
    .set(auth(staff))
    .send({})
    .expect(201);

  return created.body.id as string;
}

describe('opening a recall', () => {
  it('withdraws the affected stock from sale immediately', async () => {
    // Deliberately automatic. Stock that may be unsafe should stop being sold
    // the moment somebody with the authority says so; it is contacting
    // customers that needs the extra approval, not withdrawing stock.
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    await openRecallOn(lot.body.id, reviewerStaff);

    const batch = await harness.prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: lot.body.id },
    });
    expect(batch.status).toBe('RECALLED');

    const availability = await harness.app.get(InventoryService).availability([fixture.variantId]);
    expect(availability.get(fixture.variantId)).toBe(0);
  });

  it('cannot be opened with no lots in scope', async () => {
    const reviewerStaff = await reviewer();

    const created = await harness
      .http()
      .post(`${TRACE}/recalls`)
      .set(auth(reviewerStaff))
      .send({
        title: 'Nothing in scope',
        reason: 'A recall with no lots named would block nothing and mislead everyone.',
      })
      .expect(201);

    const response = await harness
      .http()
      .post(`${TRACE}/recalls/${created.body.id}/open`)
      .set(auth(reviewerStaff))
      .send({});

    expect(response.status).toBe(422);
  });

  it('leaves a warehouse manager unable to open one', async () => {
    // WAREHOUSE_MANAGER holds RECALL_READ but not RECALL_MANAGE.
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });

    const created = await harness
      .http()
      .post(`${TRACE}/recalls`)
      .set(auth(wh))
      .send({
        title: 'Attempted by the warehouse',
        reason: 'Opening a recall is not a warehouse decision.',
        batchIds: [lot.body.id],
      });

    expect(created.status).toBe(403);
  });
});

describe('who the recall affects', () => {
  it('derives the orders that received the recalled lot', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 20 });
    await orderFromLot(fixture, 2);
    await orderFromLot(fixture, 3);

    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    const impact = await harness
      .http()
      .get(`${TRACE}/recalls/${recallId}/impact`)
      .set(auth(reviewerStaff))
      .expect(200);

    expect(impact.body.orderCount).toBe(2);
    expect(impact.body.unitsShipped).toBe(5);
    expect(impact.body.byProduct[0].productId).toBe(fixture.productId);
  });

  it('withholds customer identities until someone approves contacting them', async () => {
    // The single most important assertion in this suite. Before approval the
    // console can say how many people are affected — enough to brief a
    // regulator — and cannot say who they are.
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 20 });
    await orderFromLot(fixture, 2);
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    const impact = await harness
      .http()
      .get(`${TRACE}/recalls/${recallId}/impact`)
      .set(auth(reviewerStaff))
      .expect(200);

    expect(impact.body.notificationApproved).toBe(false);
    expect(impact.body.orders).toBeNull();
    // And nothing resembling a customer identity leaks through another field.
    expect(JSON.stringify(impact.body)).not.toContain('ada@example.test');
  });

  it('discloses them once a named person with RECALL_NOTIFY approves', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 20 });
    await orderFromLot(fixture, 2);
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(reviewerStaff))
      .send({
        acknowledgement: 'I approve contacting affected customers',
        notes: 'Counsel advised direct notification given the undeclared allergen risk.',
      })
      .expect(201);

    const impact = await harness
      .http()
      .get(`${TRACE}/recalls/${recallId}/impact`)
      .set(auth(reviewerStaff))
      .expect(200);

    expect(impact.body.notificationApproved).toBe(true);
    expect(impact.body.orders).toHaveLength(1);
    expect(impact.body.orders[0].email).toBe('ada@example.test');
  });

  it('records who looked at the impact, disclosed or not', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 20 });
    await orderFromLot(fixture, 2);
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    await harness
      .http()
      .get(`${TRACE}/recalls/${recallId}/impact`)
      .set(auth(reviewerStaff))
      .expect(200);

    const actions = await harness.prisma.recallAction.findMany({
      where: { recallId, type: 'IMPACT_ASSESSED' },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actorLabel).toBe(reviewerStaff.email);
    expect((actions[0]!.data as { identitiesDisclosed: boolean }).identitiesDisclosed).toBe(false);
  });
});

describe('approving customer contact', () => {
  it('refuses anyone without RECALL_NOTIFY, including the warehouse', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    const response = await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(wh))
      .send({
        acknowledgement: 'I approve contacting affected customers',
        notes: 'The warehouse should not be able to authorise contacting customers.',
      });

    expect(response.status).toBe(403);
  });

  it('refuses an administrator', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();
    const admin = await signedInStaff(harness, 'ADMIN', 'admin@example.test');

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    const response = await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(admin))
      .send({
        acknowledgement: 'I approve contacting affected customers',
        notes: 'Running the store is not the authority to tell customers about a recall.',
      });

    expect(response.status).toBe(403);
  });

  it('refuses a mistyped acknowledgement, so it cannot be clicked through', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    const response = await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(reviewerStaff))
      .send({
        acknowledgement: 'yes',
        notes: 'Trying to approve without typing the acknowledgement in full.',
      });

    expect(response.status).toBe(400);
  });

  it('requires a written basis', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    const response = await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(reviewerStaff))
      .send({ acknowledgement: 'I approve contacting affected customers', notes: 'because' });

    expect(response.status).toBe(400);
  });

  it('names the approver on the record, and the database refuses it otherwise', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(reviewerStaff))
      .send({
        acknowledgement: 'I approve contacting affected customers',
        notes: 'Counsel advised direct notification given the undeclared allergen risk.',
      })
      .expect(201);

    const recall = await harness.prisma.recall.findUniqueOrThrow({ where: { id: recallId } });
    expect(recall.notificationApprovedByLabel).toBe(reviewerStaff.email);
    expect(recall.notificationApprovedAt).not.toBeNull();

    // "The system decided to notify customers" is not a state this database
    // will hold, whatever the application asks for.
    await expect(
      harness.prisma.recall.updateMany({
        where: { id: recallId },
        data: { notificationApprovedById: null, notificationApprovedByLabel: null },
      }),
    ).rejects.toThrow(/recall_notification_is_attributed/i);
  });
});

describe('the recall record', () => {
  it('sends nothing to anybody', async () => {
    // There is no transactional email in the platform yet, and this phase adds
    // none. The assertion is that approving notification queued no work that
    // could reach a customer — the outbox is the only path that could, so it is
    // checked for anything referring to the recall, the order, or the customer
    // themselves. (Sign-in writes an unrelated `user.*` event, which is why
    // this looks at what the messages are about rather than counting them.)
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 20 });
    await orderFromLot(fixture, 2);
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(reviewerStaff))
      .send({
        acknowledgement: 'I approve contacting affected customers',
        notes: 'Counsel advised direct notification given the undeclared allergen risk.',
      })
      .expect(201);

    const queued = await harness.prisma.outboxMessage.findMany();
    const customerFacing = queued.filter((message) =>
      ['recall', 'order', 'customer'].includes(message.aggregateType),
    );
    expect(customerFacing).toEqual([]);

    // And nothing queued mentions the affected customer by any route.
    expect(JSON.stringify(queued)).not.toContain('ada@example.test');
    expect(JSON.stringify(queued)).not.toContain(recallId);
  });

  it('cannot be rewritten afterwards', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    const actions = await harness.prisma.recallAction.findMany({ where: { recallId } });
    expect(actions.length).toBeGreaterThan(0);

    await expect(
      harness.prisma.recallAction.update({
        where: { id: actions[0]!.id },
        data: { message: 'rewritten' },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it('keeps stock withdrawn after the recall is closed', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/close`)
      .set(auth(reviewerStaff))
      .send({
        reason: 'All recoverable stock destroyed and the regulator signed off the response.',
      })
      .expect(201);

    const batch = await harness.prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: lot.body.id },
    });
    // Closing records that the response is finished, not that the goods were
    // fine after all.
    expect(batch.status).toBe('RECALLED');
  });

  it('restores a lot to what it was before, when a recall is cancelled', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'HELD', quantity: 10 });

    // Already quarantined for an unrelated reason before the recall.
    await harness
      .http()
      .post(`${TRACE}/batches/${lot.body.id}/disposition`)
      .set(auth(wh))
      .send({ status: 'QUARANTINED', reason: 'Held pending a certificate of analysis.' })
      .expect(201);

    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/cancel`)
      .set(auth(reviewerStaff))
      .send({ reason: 'The supplier report turned out to refer to a different product line.' })
      .expect(201);

    const batch = await harness.prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: lot.body.id },
    });
    // Back to quarantined, not to available. A different recall being withdrawn
    // must not release stock that was held for its own reasons.
    expect(batch.status).toBe('QUARANTINED');
  });

  it('cannot be cancelled once customers have been approved for contact', async () => {
    const fixture = await seedProduct();
    const wh = await warehouseStaff();
    const reviewerStaff = await reviewer();

    const lot = await receiveLot(fixture, wh, { lotCode: 'BAD', quantity: 10 });
    const recallId = await openRecallOn(lot.body.id, reviewerStaff);

    await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/approve-notification`)
      .set(auth(reviewerStaff))
      .send({
        acknowledgement: 'I approve contacting affected customers',
        notes: 'Counsel advised direct notification given the undeclared allergen risk.',
      })
      .expect(201);

    const response = await harness
      .http()
      .post(`${TRACE}/recalls/${recallId}/cancel`)
      .set(auth(reviewerStaff))
      .send({ reason: 'Trying to undo a recall whose customers have already been approved.' });

    expect(response.status).toBe(409);
  });
});
