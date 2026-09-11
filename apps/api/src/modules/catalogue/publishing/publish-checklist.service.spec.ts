import { PUBLISH_CHECK_DEFINITIONS, type PublishCheckKey } from '@health/types';
import { PublishChecklistService } from './publish-checklist.service.js';
import type { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import type { SettingsService } from '../../settings/settings.service.js';

/**
 * The publishing gate, exercised without a database.
 *
 * These tests are about the *decision*, not the persistence: given a product in
 * a particular state, does the gate let it through? The integration suite
 * covers the same gate against real rows and the real HTTP surface; this suite
 * is where the awkward combinations live, because constructing thirty product
 * variants in PostgreSQL to assert on one boolean is not a good trade.
 */

const NOW = new Date('2026-09-11T00:00:00.000Z');

type ProductRow = Record<string, unknown>;

/** A supplement that passes every Phase 2 check. Tests break one thing at a time. */
function compliantSupplement(overrides: ProductRow = {}): ProductRow {
  return {
    id: 'product-1',
    type: 'SUPPLEMENT',
    name: 'Magnesium Glycinate',
    shortDescription: '120 capsules, 200 mg elemental magnesium.',
    longDescription: 'A chelated magnesium supplement in a vegetarian capsule.',
    brand: 'Health Commerce',
    manufacturer: 'Example Manufacturing LLC',
    countryOfOrigin: 'US',
    priceCents: 2499,
    compareAtPriceCents: null,
    complianceStatus: 'APPROVED',
    complianceReviewDueAt: new Date('2027-09-11T00:00:00.000Z'),
    images: [
      { role: 'HERO', altText: 'A white bottle of magnesium glycinate capsules.' },
      { role: 'LABEL', altText: 'The product label, showing the ingredient list.' },
      { role: 'FACTS_PANEL', altText: 'The supplement facts panel.' },
    ],
    categories: [{ isPrimary: true }],
    ingredients: [
      {
        isActive: true,
        amount: 200,
        unit: 'mg',
        notes: null,
        ingredient: {
          name: 'Magnesium glycinate',
          isAllergen: false,
          allergen: null,
          warnings: [],
        },
      },
    ],
    warnings: [],
    disclaimers: [{ kind: 'DSHEA' }, { kind: 'GENERAL_HEALTH' }],
    ...overrides,
  };
}

interface Harness {
  service: PublishChecklistService;
  setSeo: (seo: { title: string | null; description: string | null } | null) => void;
}

function build(
  product: ProductRow | null,
  options: {
    seo?: { title: string | null; description: string | null } | null;
    required?: PublishCheckKey[] | null;
  } = {},
): Harness {
  let seo =
    options.seo === undefined
      ? {
          title: 'Magnesium Glycinate 120 Capsules',
          description: 'Chelated magnesium, 200 mg per capsule.',
        }
      : options.seo;

  const prisma = {
    product: { findFirst: jest.fn(async () => product) },
    seoMetadata: { findUnique: jest.fn(async () => seo) },
  } as unknown as PrismaService;

  const settings = {
    get: jest.fn(async (key: string) =>
      key === 'catalog.publish_checklist' ? (options.required ?? null) : null,
    ),
  } as unknown as SettingsService;

  const clock = { now: () => NOW, timestamp: () => NOW.getTime() };

  return {
    service: new PublishChecklistService(prisma, settings, clock),
    setSeo: (next) => {
      seo = next;
    },
  };
}

function stateOf(
  checks: Array<{ key: PublishCheckKey; state: string }>,
  key: PublishCheckKey,
): string {
  const found = checks.find((check) => check.key === key);
  if (!found) throw new Error(`Check ${key} was not reported at all`);
  return found.state;
}

describe('PublishChecklistService', () => {
  it('passes a complete supplement', async () => {
    const { service } = build(compliantSupplement());
    const readiness = await service.evaluate('product-1');

    expect(readiness.blockedBy).toEqual([]);
    expect(readiness.ready).toBe(true);
  });

  it('reports every defined check, so nothing passes by being left out', async () => {
    const { service } = build(compliantSupplement());
    const readiness = await service.evaluate('product-1');

    expect(readiness.checks.map((check) => check.key).sort()).toEqual(
      PUBLISH_CHECK_DEFINITIONS.map((definition) => definition.key).sort(),
    );
  });

  it('reports unbuilt checks as not-yet-enforced rather than as passes', async () => {
    const { service } = build(compliantSupplement());
    const readiness = await service.evaluate('product-1');

    // Claims and evidence arrive in Phase 4, inventory in Phase 3. Counting
    // them as passes would make the checklist look like assurance it is not.
    expect(readiness.notYetEnforced.sort()).toEqual([
      'CLAIMS_REVIEWED',
      'EVIDENCE_REVIEWED',
      'INVENTORY_CONFIGURED',
    ]);
    for (const key of readiness.notYetEnforced) {
      expect(stateOf(readiness.checks, key)).toBe('NOT_YET_ENFORCED');
    }
    // They do not block: nobody could satisfy them yet.
    expect(readiness.ready).toBe(true);
  });

  it('throws for a product that does not exist', async () => {
    const { service } = build(null);
    await expect(service.evaluate('missing')).rejects.toThrow('does not exist');
  });

  describe('compliance approval', () => {
    it('blocks a product no compliance reviewer has approved', async () => {
      const { service } = build(
        compliantSupplement({ complianceStatus: 'NOT_REVIEWED', complianceReviewDueAt: null }),
      );
      const readiness = await service.evaluate('product-1');

      expect(readiness.ready).toBe(false);
      expect(readiness.blockedBy).toContain('COMPLIANCE_APPROVED');
    });

    it('blocks a product whose approval has expired', async () => {
      // An approval granted against evidence that has since been superseded is
      // not an approval. Lapsing is the entire point of the review interval.
      const { service } = build(
        compliantSupplement({ complianceReviewDueAt: new Date('2026-09-10T23:59:59.000Z') }),
      );
      const readiness = await service.evaluate('product-1');

      expect(readiness.blockedBy).toContain('COMPLIANCE_APPROVED');
      expect(readiness.checks.find((check) => check.key === 'COMPLIANCE_APPROVED')?.detail).toMatch(
        /expired/i,
      );
    });

    it('accepts an approval that expires later today', async () => {
      const { service } = build(
        compliantSupplement({ complianceReviewDueAt: new Date('2026-09-11T00:00:01.000Z') }),
      );
      expect(stateOf((await service.evaluate('product-1')).checks, 'COMPLIANCE_APPROVED')).toBe(
        'PASS',
      );
    });
  });

  describe('allergen disclosure', () => {
    const withFishOil = (extra: ProductRow = {}) =>
      compliantSupplement({
        ingredients: [
          {
            isActive: true,
            amount: 1000,
            unit: 'mg',
            notes: null,
            ingredient: {
              name: 'Omega-3 fish oil',
              isAllergen: true,
              allergen: 'fish',
              warnings: [],
            },
          },
        ],
        ...extra,
      });

    it('blocks an allergen ingredient with nothing declaring it', async () => {
      const { service } = build(withFishOil());
      const readiness = await service.evaluate('product-1');

      expect(readiness.blockedBy).toContain('WARNINGS');
      expect(readiness.checks.find((check) => check.key === 'WARNINGS')?.detail).toContain(
        'Omega-3 fish oil',
      );
    });

    it('accepts a warning that names the allergen', async () => {
      const { service } = build(
        withFishOil({
          warnings: [
            {
              text: 'Contains fish. Do not take this product if you are allergic to fish.',
              audience: 'ALLERGY',
              severity: 'WARNING',
            },
          ],
        }),
      );
      expect(stateOf((await service.evaluate('product-1')).checks, 'WARNINGS')).toBe('PASS');
    });

    it('accepts an explicit allergen disclaimer', async () => {
      const { service } = build(
        withFishOil({
          disclaimers: [{ kind: 'DSHEA' }, { kind: 'GENERAL_HEALTH' }, { kind: 'ALLERGEN' }],
        }),
      );
      expect(stateOf((await service.evaluate('product-1')).checks, 'WARNINGS')).toBe('PASS');
    });

    it('is not satisfied by an unrelated warning', async () => {
      const { service } = build(
        withFishOil({
          warnings: [
            {
              text: 'Keep out of reach of children.',
              audience: 'GENERAL',
              severity: 'WARNING',
            },
          ],
        }),
      );
      expect(stateOf((await service.evaluate('product-1')).checks, 'WARNINGS')).toBe('FAIL');
    });

    it('does not demand an invented warning when there is no allergen', async () => {
      const { service } = build(compliantSupplement());
      expect(stateOf((await service.evaluate('product-1')).checks, 'WARNINGS')).toBe('PASS');
    });
  });

  describe('disclaimers', () => {
    it('blocks a supplement with no DSHEA statement', async () => {
      const { service } = build(compliantSupplement({ disclaimers: [{ kind: 'GENERAL_HEALTH' }] }));
      const readiness = await service.evaluate('product-1');

      expect(readiness.blockedBy).toContain('DISCLAIMERS');
      expect(readiness.checks.find((c) => c.key === 'DISCLAIMERS')?.detail).toMatch(/DSHEA/);
    });

    it('does not demand DSHEA on an accessory, but still demands general health', async () => {
      const { service } = build(
        compliantSupplement({
          type: 'ACCESSORY',
          disclaimers: [{ kind: 'GENERAL_HEALTH' }],
          ingredients: [],
        }),
      );
      const readiness = await service.evaluate('product-1');

      expect(stateOf(readiness.checks, 'DISCLAIMERS')).toBe('PASS');
      // Ingredients, label and warnings do not apply to a pill organiser.
      expect(stateOf(readiness.checks, 'INGREDIENTS')).toBe('NOT_APPLICABLE');
      expect(stateOf(readiness.checks, 'LABEL')).toBe('NOT_APPLICABLE');
      expect(readiness.ready).toBe(true);
    });
  });

  describe('pricing', () => {
    it('blocks a zero price', async () => {
      const { service } = build(compliantSupplement({ priceCents: 0 }));
      expect((await service.evaluate('product-1')).blockedBy).toContain('PRICING');
    });

    it('blocks a compare-at price that advertises a discount that does not exist', async () => {
      const { service } = build(compliantSupplement({ compareAtPriceCents: 2499 }));
      const readiness = await service.evaluate('product-1');

      expect(readiness.blockedBy).toContain('PRICING');
      expect(readiness.checks.find((c) => c.key === 'PRICING')?.detail).toMatch(/compare-at/i);
    });

    it('accepts a genuine compare-at price', async () => {
      const { service } = build(compliantSupplement({ compareAtPriceCents: 2999 }));
      expect(stateOf((await service.evaluate('product-1')).checks, 'PRICING')).toBe('PASS');
    });
  });

  describe('images and label', () => {
    it('blocks a listing with no hero image', async () => {
      const { service } = build(
        compliantSupplement({
          images: [
            { role: 'LABEL', altText: 'The product label.' },
            { role: 'FACTS_PANEL', altText: 'The supplement facts panel.' },
          ],
        }),
      );
      expect((await service.evaluate('product-1')).blockedBy).toContain('IMAGES');
    });

    it('blocks an image with no usable alternative text', async () => {
      const { service } = build(
        compliantSupplement({
          images: [
            { role: 'HERO', altText: '  ' },
            { role: 'LABEL', altText: 'The product label.' },
            { role: 'FACTS_PANEL', altText: 'The supplement facts panel.' },
          ],
        }),
      );
      expect((await service.evaluate('product-1')).blockedBy).toContain('IMAGES');
    });

    it('blocks a supplement with no facts panel', async () => {
      // A customer cannot check a dosage or an allergen without being able to
      // read the panel.
      const { service } = build(
        compliantSupplement({
          images: [
            { role: 'HERO', altText: 'A white bottle.' },
            { role: 'LABEL', altText: 'The product label.' },
          ],
        }),
      );
      const readiness = await service.evaluate('product-1');

      expect(readiness.blockedBy).toContain('LABEL');
      expect(readiness.checks.find((c) => c.key === 'LABEL')?.detail).toMatch(/facts panel/i);
    });
  });

  describe('ingredients', () => {
    it('blocks a supplement with no active ingredient', async () => {
      const { service } = build(
        compliantSupplement({
          ingredients: [
            {
              isActive: false,
              amount: null,
              unit: null,
              notes: 'Capsule shell.',
              ingredient: { name: 'Hypromellose', isAllergen: false, allergen: null, warnings: [] },
            },
          ],
        }),
      );
      expect((await service.evaluate('product-1')).blockedBy).toContain('INGREDIENTS');
    });

    it('accepts an undisclosed amount when it is a deliberate note', async () => {
      // Proprietary blends exist. An empty field and a documented decision are
      // not the same thing, and only the first is a defect.
      const { service } = build(
        compliantSupplement({
          ingredients: [
            {
              isActive: true,
              amount: null,
              unit: null,
              notes: 'Part of a proprietary blend; the total blend weight is on the panel.',
              ingredient: { name: 'Herbal blend', isAllergen: false, allergen: null, warnings: [] },
            },
          ],
        }),
      );
      expect(stateOf((await service.evaluate('product-1')).checks, 'INGREDIENTS')).toBe('PASS');
    });

    it('blocks an amount with no unit', async () => {
      const { service } = build(
        compliantSupplement({
          ingredients: [
            {
              isActive: true,
              amount: 200,
              unit: null,
              notes: null,
              ingredient: { name: 'Magnesium', isAllergen: false, allergen: null, warnings: [] },
            },
          ],
        }),
      );
      expect((await service.evaluate('product-1')).blockedBy).toContain('INGREDIENTS');
    });
  });

  describe('SEO and categorisation', () => {
    it('blocks a listing with no SEO metadata at all', async () => {
      const { service } = build(compliantSupplement(), { seo: null });
      expect((await service.evaluate('product-1')).blockedBy).toContain('SEO');
    });

    it('blocks metadata longer than search engines display', async () => {
      const { service } = build(compliantSupplement(), {
        seo: { title: 'x'.repeat(400), description: 'A description.' },
      });
      expect((await service.evaluate('product-1')).blockedBy).toContain('SEO');
    });

    it('blocks a listing with categories but no primary one', async () => {
      // No primary category means no canonical URL, which means duplicate
      // indexed pages for the same product.
      const { service } = build(compliantSupplement({ categories: [{ isPrimary: false }] }));
      const readiness = await service.evaluate('product-1');

      expect(readiness.blockedBy).toContain('CATEGORY');
      expect(readiness.checks.find((c) => c.key === 'CATEGORY')?.detail).toMatch(/canonical/i);
    });
  });

  describe('product information', () => {
    it('names every missing field rather than just failing', async () => {
      const { service } = build(
        compliantSupplement({ manufacturer: null, countryOfOrigin: '   ' }),
      );
      const detail = (await service.evaluate('product-1')).checks.find(
        (check) => check.key === 'PRODUCT_INFORMATION',
      )?.detail;

      expect(detail).toContain('manufacturer');
      expect(detail).toContain('country of origin');
    });
  });

  describe('the configured required set', () => {
    it('still reports a finding an operator has not marked required', async () => {
      // Downgrading it to NOT_APPLICABLE must not hide what was found —
      // otherwise removing a key from the checklist erases the evidence.
      const { service } = build(compliantSupplement({ compareAtPriceCents: 2499 }), {
        required: ['COMPLIANCE_APPROVED'],
      });
      const readiness = await service.evaluate('product-1');

      const pricing = readiness.checks.find((check) => check.key === 'PRICING');
      expect(pricing?.state).toBe('NOT_APPLICABLE');
      expect(pricing?.detail).toMatch(/compare-at/i);
      expect(pricing?.detail).toMatch(/Not required by the configured checklist/);
      expect(readiness.ready).toBe(true);
    });

    it('cannot be used to publish without compliance approval when that check is required', async () => {
      const { service } = build(compliantSupplement({ complianceStatus: 'REJECTED' }), {
        required: ['COMPLIANCE_APPROVED'],
      });
      expect((await service.evaluate('product-1')).ready).toBe(false);
    });

    it('requires every implemented check when nothing is configured', async () => {
      const { service } = build(
        compliantSupplement({ priceCents: 0, complianceStatus: 'REJECTED' }),
        {
          required: null,
        },
      );
      const readiness = await service.evaluate('product-1');

      expect(readiness.blockedBy).toEqual(
        expect.arrayContaining(['PRICING', 'COMPLIANCE_APPROVED']),
      );
    });

    it('falls back to every implemented check when the setting is an empty list', async () => {
      // An empty list is far more likely to be a mistake than a decision to
      // publish with no checks at all, and the safe reading is the strict one.
      const { service } = build(compliantSupplement({ priceCents: 0 }), { required: [] });
      expect((await service.evaluate('product-1')).blockedBy).toContain('PRICING');
    });
  });
});
