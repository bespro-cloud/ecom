import type { PrismaClient } from '../client.js';

/**
 * Development catalogue fixtures.
 *
 * Everything here is clearly-labelled test data. Two things it deliberately
 * does **not** do:
 *
 *  - It does not publish anything. Products are left as drafts, because
 *    publication runs through the checklist and a compliance reviewer, and
 *    seeding past that gate would defeat the point of having one.
 *  - It does not invent evidence, certifications or health claims. Descriptions
 *    say what a product contains, not what it does.
 *
 * The ingredient facts (forms, common allergen status, the interaction
 * warnings) are widely documented and are here to exercise the model. They are
 * not a substitute for the real substantiation work a launch requires.
 */

export const SEED_MARKER = '[DEV SEED]';

interface IngredientSeed {
  slug: string;
  name: string;
  scientificName?: string;
  commonNames?: string[];
  description: string;
  casNumber?: string;
  isAllergen?: boolean;
  allergen?: string;
  sources: Array<{
    type: 'PLANT' | 'ANIMAL' | 'MINERAL' | 'SYNTHETIC' | 'FERMENTATION' | 'MICROBIAL' | 'OTHER';
    description?: string;
    isVegan: boolean;
    isVegetarian: boolean;
    originCountry?: string;
  }>;
  warnings?: Array<{
    severity: 'INFORMATION' | 'CAUTION' | 'WARNING';
    audience:
      | 'GENERAL'
      | 'PREGNANCY'
      | 'NURSING'
      | 'CHILDREN'
      | 'MEDICATION_INTERACTION'
      | 'ALLERGY'
      | 'MEDICAL_CONDITION';
    text: string;
  }>;
}

const INGREDIENTS: IngredientSeed[] = [
  {
    slug: 'magnesium-glycinate',
    name: 'Magnesium glycinate',
    scientificName: 'Magnesium bisglycinate',
    commonNames: ['magnesium bisglycinate', 'chelated magnesium'],
    description:
      'A magnesium salt of the amino acid glycine. Commonly used in supplements because it is well tolerated by the digestive system compared with magnesium oxide.',
    casNumber: '14783-68-7',
    sources: [
      {
        type: 'SYNTHETIC',
        description: 'Produced by reacting magnesium oxide with glycine.',
        isVegan: true,
        isVegetarian: true,
        originCountry: 'US',
      },
    ],
    warnings: [
      {
        severity: 'CAUTION',
        audience: 'MEDICAL_CONDITION',
        text: 'If you have reduced kidney function, speak to your clinician before taking supplemental magnesium.',
      },
      {
        severity: 'CAUTION',
        audience: 'MEDICATION_INTERACTION',
        text: 'Magnesium can affect the absorption of some antibiotics and thyroid medication. Separate doses by several hours, and check with your pharmacist.',
      },
    ],
  },
  {
    slug: 'vitamin-d3-cholecalciferol',
    name: 'Vitamin D3 (cholecalciferol)',
    scientificName: 'Cholecalciferol',
    commonNames: ['cholecalciferol', 'vitamin d'],
    description:
      'The form of vitamin D produced in human skin on exposure to ultraviolet B light. Fat soluble, so it accumulates in the body rather than being excreted.',
    casNumber: '67-97-0',
    sources: [
      {
        type: 'ANIMAL',
        description: 'Extracted from lanolin, a wax from sheep wool.',
        isVegan: false,
        isVegetarian: true,
        originCountry: 'AU',
      },
      {
        type: 'PLANT',
        description: 'Derived from lichen. Used in the vegan formulation.',
        isVegan: true,
        isVegetarian: true,
        originCountry: 'US',
      },
    ],
    warnings: [
      {
        severity: 'WARNING',
        audience: 'GENERAL',
        text: 'Vitamin D is fat soluble and accumulates in the body. Do not exceed the labelled dose without advice from a clinician.',
      },
    ],
  },
  {
    slug: 'omega-3-fish-oil',
    name: 'Omega-3 fish oil (EPA and DHA)',
    description:
      'A concentrated oil from cold-water fish, standardised for the long-chain fatty acids EPA and DHA.',
    isAllergen: true,
    allergen: 'fish',
    sources: [
      {
        type: 'ANIMAL',
        description: 'Wild-caught anchovy and sardine, molecularly distilled.',
        isVegan: false,
        isVegetarian: false,
        originCountry: 'PE',
      },
    ],
    warnings: [
      {
        severity: 'WARNING',
        audience: 'ALLERGY',
        text: 'Contains fish. Do not take this product if you are allergic to fish.',
      },
      {
        severity: 'CAUTION',
        audience: 'MEDICATION_INTERACTION',
        text: 'Fish oil may increase the effect of anticoagulant medication. Tell your clinician before surgery or if you take a blood thinner.',
      },
    ],
  },
  {
    slug: 'vitamin-c-ascorbic-acid',
    name: 'Vitamin C (ascorbic acid)',
    scientificName: 'L-ascorbic acid',
    description:
      'A water-soluble vitamin. Not stored by the body in appreciable amounts, so it is obtained continuously from diet or supplementation.',
    casNumber: '50-81-7',
    sources: [
      {
        type: 'FERMENTATION',
        description: 'Produced by fermentation of glucose derived from maize.',
        isVegan: true,
        isVegetarian: true,
        originCountry: 'US',
      },
    ],
    warnings: [
      {
        severity: 'INFORMATION',
        audience: 'GENERAL',
        text: 'Large doses may cause digestive discomfort in some people.',
      },
    ],
  },
  {
    slug: 'microcrystalline-cellulose',
    name: 'Microcrystalline cellulose',
    description:
      'A purified plant fibre used as a bulking agent and to help a capsule or tablet hold its form. It has no nutritional role.',
    casNumber: '9004-34-6',
    sources: [{ type: 'PLANT', description: 'Wood pulp.', isVegan: true, isVegetarian: true }],
  },
  {
    slug: 'hypromellose-capsule',
    name: 'Hypromellose (capsule shell)',
    description:
      'A plant-derived cellulose used to make the capsule shell. Chosen over gelatine so the product is suitable for vegetarians and vegans.',
    sources: [{ type: 'PLANT', isVegan: true, isVegetarian: true }],
  },
];

interface ProductSeed {
  sku: string;
  slug: string;
  name: string;
  type: 'SUPPLEMENT' | 'COSMETIC' | 'FOOD' | 'DEVICE' | 'WELLNESS' | 'ACCESSORY';
  shortDescription: string;
  longDescription: string;
  brand: string;
  manufacturer: string;
  countryOfOrigin: string;
  priceCents: number;
  compareAtPriceCents?: number;
  costCents: number;
  weightGrams: number;
  subscriptionEligible: boolean;
  categorySlugs: string[];
  primaryCategorySlug: string;
  ingredients: Array<{
    slug: string;
    amount?: number;
    unit?: string;
    dailyValuePercent?: number;
    isActive: boolean;
    notes?: string;
  }>;
  attributes: Record<string, string>;
  seo: { title: string; description: string };
}

const PRODUCTS: ProductSeed[] = [
  {
    sku: 'HC-MAG-GLY-120',
    slug: 'magnesium-glycinate-120-capsules',
    name: 'Magnesium Glycinate, 120 capsules',
    type: 'SUPPLEMENT',
    shortDescription:
      '200 mg of elemental magnesium per serving, as magnesium bisglycinate. 60 servings.',
    longDescription:
      'Each serving provides 200 mg of elemental magnesium in the bisglycinate form, bound to the amino acid glycine.\n\nThe capsule shell is hypromellose, so the product contains no gelatine. It is manufactured in a facility in Utah that also handles fish-derived ingredients.\n\nWe publish the full ingredient list, including the excipients, because "other ingredients" on a label is not an answer.',
    brand: 'Health Commerce',
    manufacturer: 'Wasatch Nutraceutical Manufacturing, Inc.',
    countryOfOrigin: 'US',
    priceCents: 2400,
    compareAtPriceCents: 2900,
    costCents: 780,
    weightGrams: 140,
    subscriptionEligible: true,
    categorySlugs: ['minerals', 'supplements'],
    primaryCategorySlug: 'minerals',
    ingredients: [
      {
        slug: 'magnesium-glycinate',
        amount: 1000,
        unit: 'mg',
        dailyValuePercent: 48,
        isActive: true,
        notes: 'Provides 200 mg of elemental magnesium.',
      },
      { slug: 'microcrystalline-cellulose', isActive: false, notes: 'Bulking agent.' },
      { slug: 'hypromellose-capsule', isActive: false, notes: 'Capsule shell.' },
    ],
    attributes: { form: 'capsule', vegan: 'true', servings: '60' },
    seo: {
      title: 'Magnesium Glycinate, 120 capsules',
      description:
        '200 mg elemental magnesium per serving as bisglycinate. Full ingredient list, sourcing and manufacturer published.',
    },
  },
  {
    sku: 'HC-VITD3-90',
    slug: 'vitamin-d3-2000-iu-90-capsules',
    name: 'Vitamin D3 2000 IU, 90 capsules',
    type: 'SUPPLEMENT',
    shortDescription: '50 micrograms (2000 IU) of cholecalciferol per capsule. 90 servings.',
    longDescription:
      'Each capsule provides 50 micrograms of vitamin D3 as cholecalciferol, derived from lanolin.\n\nVitamin D is fat soluble, which means the body stores it rather than excreting the excess. The labelled dose should not be exceeded without advice from a clinician.\n\nA lichen-derived vegan formulation of this product is also available.',
    brand: 'Health Commerce',
    manufacturer: 'Wasatch Nutraceutical Manufacturing, Inc.',
    countryOfOrigin: 'US',
    priceCents: 1600,
    costCents: 420,
    weightGrams: 90,
    subscriptionEligible: true,
    categorySlugs: ['vitamins', 'supplements'],
    primaryCategorySlug: 'vitamins',
    ingredients: [
      {
        slug: 'vitamin-d3-cholecalciferol',
        amount: 50,
        unit: 'mcg',
        dailyValuePercent: 250,
        isActive: true,
      },
      { slug: 'hypromellose-capsule', isActive: false, notes: 'Capsule shell.' },
    ],
    attributes: { form: 'capsule', vegan: 'false', servings: '90' },
    seo: {
      title: 'Vitamin D3 2000 IU, 90 capsules',
      description:
        '50 mcg cholecalciferol per capsule, from lanolin. Sourcing, manufacturer and full ingredient list published.',
    },
  },
  {
    sku: 'HC-OMEGA3-60',
    slug: 'omega-3-fish-oil-60-softgels',
    name: 'Omega-3 Fish Oil, 60 softgels',
    type: 'SUPPLEMENT',
    shortDescription:
      '1000 mg fish oil per softgel, providing 330 mg EPA and 220 mg DHA. Contains fish.',
    longDescription:
      'Each softgel provides 1000 mg of fish oil from wild-caught anchovy and sardine, standardised to 330 mg EPA and 220 mg DHA.\n\nThe oil is molecularly distilled. Batch testing for heavy metals and oxidation is carried out by the manufacturer; results are held with the batch record.\n\nThis product contains fish and is not suitable for anyone with a fish allergy.',
    brand: 'Health Commerce',
    manufacturer: 'Pacific Marine Lipids, LLC',
    countryOfOrigin: 'US',
    priceCents: 3200,
    costCents: 1150,
    weightGrams: 180,
    subscriptionEligible: true,
    categorySlugs: ['omega-3', 'supplements'],
    primaryCategorySlug: 'omega-3',
    ingredients: [
      {
        slug: 'omega-3-fish-oil',
        amount: 1000,
        unit: 'mg',
        isActive: true,
        notes: 'Providing 330 mg EPA and 220 mg DHA.',
      },
    ],
    attributes: { form: 'softgel', vegan: 'false', servings: '60' },
    seo: {
      title: 'Omega-3 Fish Oil, 60 softgels',
      description:
        '1000 mg fish oil per softgel with 330 mg EPA and 220 mg DHA, from wild-caught anchovy and sardine. Contains fish.',
    },
  },
  {
    sku: 'HC-VITC-100',
    slug: 'vitamin-c-500mg-100-tablets',
    name: 'Vitamin C 500 mg, 100 tablets',
    type: 'SUPPLEMENT',
    shortDescription: '500 mg of ascorbic acid per tablet. 100 servings.',
    longDescription:
      'Each tablet provides 500 mg of vitamin C as L-ascorbic acid, produced by fermentation of maize-derived glucose.\n\nVitamin C is water soluble and is not stored by the body in appreciable amounts.',
    brand: 'Health Commerce',
    manufacturer: 'Wasatch Nutraceutical Manufacturing, Inc.',
    countryOfOrigin: 'US',
    priceCents: 1200,
    costCents: 310,
    weightGrams: 120,
    subscriptionEligible: true,
    categorySlugs: ['vitamins', 'supplements'],
    primaryCategorySlug: 'vitamins',
    ingredients: [
      {
        slug: 'vitamin-c-ascorbic-acid',
        amount: 500,
        unit: 'mg',
        dailyValuePercent: 556,
        isActive: true,
      },
      { slug: 'microcrystalline-cellulose', isActive: false, notes: 'Tablet base.' },
    ],
    attributes: { form: 'tablet', vegan: 'true', servings: '100' },
    seo: {
      title: 'Vitamin C 500 mg, 100 tablets',
      description:
        '500 mg L-ascorbic acid per tablet, produced by fermentation. Full ingredient list published.',
    },
  },
  {
    sku: 'HC-PILL-ORG-01',
    slug: 'weekly-pill-organiser',
    name: 'Weekly Pill Organiser',
    type: 'ACCESSORY',
    shortDescription: 'A seven-day organiser with two compartments per day. BPA-free.',
    longDescription:
      'A seven-day organiser with separate morning and evening compartments, moulded from BPA-free polypropylene. Dishwasher safe on the top rack.',
    brand: 'Health Commerce',
    manufacturer: 'Midwest Plastics Co.',
    countryOfOrigin: 'US',
    priceCents: 900,
    costCents: 240,
    weightGrams: 95,
    subscriptionEligible: false,
    categorySlugs: ['accessories'],
    primaryCategorySlug: 'accessories',
    ingredients: [],
    attributes: { form: 'accessory', vegan: 'true' },
    seo: {
      title: 'Weekly Pill Organiser',
      description:
        'Seven-day pill organiser with morning and evening compartments. BPA-free polypropylene.',
    },
  },
];

const CATEGORIES = [
  { slug: 'supplements', name: 'Supplements', parent: null, position: 0 },
  { slug: 'vitamins', name: 'Vitamins', parent: 'supplements', position: 0 },
  { slug: 'minerals', name: 'Minerals', parent: 'supplements', position: 1 },
  { slug: 'omega-3', name: 'Omega-3', parent: 'supplements', position: 2 },
  { slug: 'accessories', name: 'Accessories', parent: null, position: 1 },
];

const ATTRIBUTES = [
  {
    key: 'form',
    label: 'Form',
    type: 'ENUM' as const,
    isFilterable: true,
    position: 0,
    allowedValues: ['capsule', 'tablet', 'softgel', 'powder', 'liquid', 'accessory'],
  },
  {
    key: 'vegan',
    label: 'Suitable for vegans',
    type: 'BOOLEAN' as const,
    isFilterable: true,
    position: 1,
    allowedValues: [],
  },
  {
    key: 'servings',
    label: 'Servings per container',
    type: 'NUMBER' as const,
    isFilterable: false,
    position: 2,
    allowedValues: [],
  },
];

export async function seedCatalogue(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed catalogue fixtures: NODE_ENV is production.');
  }

  // --- categories ----------------------------------------------------------
  const categoryIds = new Map<string, string>();
  for (const definition of CATEGORIES) {
    const parentId = definition.parent ? categoryIds.get(definition.parent) : null;
    const parent = parentId ? await prisma.category.findUnique({ where: { id: parentId } }) : null;

    // Slug uniqueness is a *partial* index — unique among live rows only, so a
    // deleted category does not permanently reserve its slug. Prisma cannot
    // express that as a unique constraint, so there is no `upsert` to use here.
    const existing = await prisma.category.findFirst({
      where: { slug: definition.slug, deletedAt: null },
    });

    const category = existing
      ? await prisma.category.update({
          where: { id: existing.id },
          data: { name: definition.name, position: definition.position },
        })
      : await prisma.category.create({
          data: {
            slug: definition.slug,
            name: definition.name,
            parentId: parentId ?? null,
            path: parent ? [...parent.path, parent.id] : [],
            depth: parent ? parent.depth + 1 : 0,
            position: definition.position,
            isActive: true,
          },
        });
    categoryIds.set(definition.slug, category.id);
  }

  // --- attributes ----------------------------------------------------------
  const attributeIds = new Map<string, string>();
  for (const definition of ATTRIBUTES) {
    const attribute = await prisma.productAttribute.upsert({
      where: { key: definition.key },
      update: { label: definition.label, isFilterable: definition.isFilterable },
      create: {
        key: definition.key,
        label: definition.label,
        type: definition.type,
        isFilterable: definition.isFilterable,
        position: definition.position,
        allowedValues: definition.allowedValues,
      },
    });
    attributeIds.set(definition.key, attribute.id);
  }

  // --- ingredients ---------------------------------------------------------
  const ingredientIds = new Map<string, string>();
  for (const definition of INGREDIENTS) {
    // Same partial-index reason as categories: find, then update or create.
    const existingIngredient = await prisma.ingredient.findFirst({
      where: { slug: definition.slug, deletedAt: null },
    });

    const ingredient = existingIngredient
      ? await prisma.ingredient.update({
          where: { id: existingIngredient.id },
          data: {
            name: definition.name,
            description: definition.description,
            isAllergen: definition.isAllergen ?? false,
            allergen: definition.allergen ?? null,
          },
        })
      : await prisma.ingredient.create({
          data: {
            slug: definition.slug,
            name: definition.name,
            scientificName: definition.scientificName ?? null,
            commonNames: definition.commonNames ?? [],
            description: definition.description,
            casNumber: definition.casNumber ?? null,
            isAllergen: definition.isAllergen ?? false,
            allergen: definition.allergen ?? null,
          },
        });
    ingredientIds.set(definition.slug, ingredient.id);

    // Replace rather than append, so re-running the seed does not duplicate.
    await prisma.ingredientSource.deleteMany({ where: { ingredientId: ingredient.id } });
    await prisma.ingredientSource.createMany({
      data: definition.sources.map((source) => ({
        ingredientId: ingredient.id,
        type: source.type,
        description: source.description ?? null,
        originCountry: source.originCountry ?? null,
        isVegan: source.isVegan,
        isVegetarian: source.isVegetarian,
      })),
    });

    await prisma.ingredientWarning.deleteMany({ where: { ingredientId: ingredient.id } });
    if (definition.warnings && definition.warnings.length > 0) {
      await prisma.ingredientWarning.createMany({
        data: definition.warnings.map((warning) => ({
          ingredientId: ingredient.id,
          severity: warning.severity,
          audience: warning.audience,
          text: warning.text,
        })),
      });
    }
  }

  // --- products ------------------------------------------------------------
  const dsheaText = await settingValue(prisma, 'compliance.disclaimer_supplement');
  const generalText = await settingValue(prisma, 'compliance.disclaimer_general_health');

  for (const definition of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { sku: definition.sku },
      update: {
        name: definition.name,
        priceCents: definition.priceCents,
        shortDescription: definition.shortDescription,
        longDescription: definition.longDescription,
      },
      create: {
        sku: definition.sku,
        slug: definition.slug,
        name: definition.name,
        type: definition.type,
        shortDescription: definition.shortDescription,
        longDescription: definition.longDescription,
        brand: definition.brand,
        manufacturer: definition.manufacturer,
        countryOfOrigin: definition.countryOfOrigin,
        priceCents: definition.priceCents,
        compareAtPriceCents: definition.compareAtPriceCents ?? null,
        costCents: definition.costCents,
        weightGrams: definition.weightGrams,
        subscriptionEligible: definition.subscriptionEligible,
        // Left as a draft on purpose. Publication runs through the checklist
        // and a compliance reviewer; seeding past that would defeat the gate.
        status: 'DRAFT',
      },
    });

    await prisma.productCategory.deleteMany({ where: { productId: product.id } });
    await prisma.productCategory.createMany({
      data: definition.categorySlugs
        .map((slug, index) => ({
          productId: product.id,
          categoryId: categoryIds.get(slug)!,
          isPrimary: slug === definition.primaryCategorySlug,
          position: index,
        }))
        .filter((entry) => entry.categoryId !== undefined),
    });

    await prisma.productIngredient.deleteMany({ where: { productId: product.id } });
    if (definition.ingredients.length > 0) {
      await prisma.productIngredient.createMany({
        data: definition.ingredients.map((entry, index) => ({
          productId: product.id,
          ingredientId: ingredientIds.get(entry.slug)!,
          amount: entry.amount ?? null,
          unit: entry.unit ?? null,
          dailyValuePercent: entry.dailyValuePercent ?? null,
          isActive: entry.isActive,
          position: index,
          notes: entry.notes ?? null,
        })),
      });
    }

    await prisma.productAttributeValue.deleteMany({ where: { productId: product.id } });
    await prisma.productAttributeValue.createMany({
      data: Object.entries(definition.attributes)
        .filter(([key]) => attributeIds.has(key))
        .map(([key, value]) => ({
          productId: product.id,
          attributeId: attributeIds.get(key)!,
          value,
          numericValue: /^\d+(\.\d+)?$/.test(value) ? Number(value) : null,
        })),
    });

    // Disclaimers are copied onto the product rather than referenced, so a
    // listing shows the text that was current when it was approved.
    const disclaimers: Array<{ kind: 'DSHEA' | 'GENERAL_HEALTH'; text: string }> = [];
    if (definition.type === 'SUPPLEMENT' && dsheaText) {
      disclaimers.push({ kind: 'DSHEA', text: dsheaText });
    }
    if (generalText) disclaimers.push({ kind: 'GENERAL_HEALTH', text: generalText });

    await prisma.productDisclaimer.deleteMany({ where: { productId: product.id } });
    if (disclaimers.length > 0) {
      await prisma.productDisclaimer.createMany({
        data: disclaimers.map((entry, index) => ({
          productId: product.id,
          kind: entry.kind,
          text: entry.text,
          position: index,
        })),
      });
    }

    // The fish-oil product contains a declared allergen, so it carries an
    // explicit allergen warning — the publishing checklist requires one.
    await prisma.productWarning.deleteMany({ where: { productId: product.id } });
    if (definition.sku === 'HC-OMEGA3-60') {
      await prisma.productWarning.create({
        data: {
          productId: product.id,
          severity: 'WARNING',
          audience: 'ALLERGY',
          text: 'Contains fish. Do not take this product if you are allergic to fish.',
          position: 0,
        },
      });
    }

    await prisma.seoMetadata.upsert({
      where: { entityType_entityId: { entityType: 'PRODUCT', entityId: product.id } },
      update: { title: definition.seo.title, description: definition.seo.description },
      create: {
        entityType: 'PRODUCT',
        entityId: product.id,
        title: definition.seo.title,
        description: definition.seo.description,
      },
    });
  }
}

async function settingValue(prisma: PrismaClient, key: string): Promise<string | null> {
  const setting = await prisma.systemSetting.findUnique({ where: { key } });
  return typeof setting?.value === 'string' ? setting.value : null;
}
