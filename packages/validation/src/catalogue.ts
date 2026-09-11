import { z } from 'zod';
import {
  COMPLIANCE_STATUSES,
  DISCLAIMER_KINDS,
  INGREDIENT_SOURCE_TYPES,
  PRODUCT_IMAGE_ROLES,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  WARNING_AUDIENCES,
  WARNING_SEVERITIES,
} from '@health/types';
import { paginationSchema, slugSchema, uuidSchema } from './primitives.js';

/**
 * SKU format.
 *
 * Deliberately narrow: SKUs end up on invoices, 3PL manifests and barcode
 * labels, and a SKU containing a space or a slash breaks at least one of those
 * eventually.
 */
export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(64)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use letters, numbers, dots, hyphens and underscores.');

/** Money in integer minor units. A float price is never acceptable. */
export const moneyCentsSchema = z
  .number()
  .int('Enter a whole number of cents.')
  .min(0, 'Cannot be negative.')
  .max(100_000_000, 'That is larger than any price we support.');

const positiveIntSchema = z.number().int().min(0).max(10_000_000);

export const productTypeSchema = z.enum(PRODUCT_TYPES);
export const productStatusSchema = z.enum(PRODUCT_STATUSES);
export const complianceStatusSchema = z.enum(COMPLIANCE_STATUSES);

export const createProductSchema = z
  .object({
    sku: skuSchema,
    slug: slugSchema,
    name: z.string().trim().min(2, 'Enter a product name.').max(200),
    shortDescription: z.string().trim().max(500).optional(),
    longDescription: z.string().trim().max(20_000).optional(),
    type: productTypeSchema,
    brand: z.string().trim().max(120).optional(),
    manufacturer: z.string().trim().max(200).optional(),
    countryOfOrigin: z.string().trim().toUpperCase().length(2).optional(),

    priceCents: moneyCentsSchema,
    compareAtPriceCents: moneyCentsSchema.optional(),
    costCents: moneyCentsSchema.optional(),
    currency: z.string().trim().toUpperCase().length(3).default('USD'),

    taxable: z.boolean().default(true),
    taxCode: z.string().trim().max(60).optional(),

    weightGrams: positiveIntSchema.optional(),
    lengthMm: positiveIntSchema.optional(),
    widthMm: positiveIntSchema.optional(),
    heightMm: positiveIntSchema.optional(),

    requiresShipping: z.boolean().default(true),
    subscriptionEligible: z.boolean().default(false),
  })
  .refine(
    (value) =>
      value.compareAtPriceCents === undefined || value.compareAtPriceCents > value.priceCents,
    {
      // A compare-at price at or below the price shows a "discount" that is not
      // one, which is a deceptive-pricing problem rather than a display bug.
      message: 'The compare-at price must be higher than the price, or left empty.',
      path: ['compareAtPriceCents'],
    },
  );
export type CreateProductInput = z.infer<typeof createProductSchema>;

/**
 * Updates are partial, but the compare-at rule still has to hold. It is
 * re-checked server-side against the merged record, because a request that
 * lowers only the price could otherwise slip past.
 */
export const updateProductSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().trim().min(2).max(200).optional(),
  shortDescription: z.string().trim().max(500).nullish(),
  longDescription: z.string().trim().max(20_000).nullish(),
  type: productTypeSchema.optional(),
  brand: z.string().trim().max(120).nullish(),
  manufacturer: z.string().trim().max(200).nullish(),
  countryOfOrigin: z.string().trim().toUpperCase().length(2).nullish(),

  priceCents: moneyCentsSchema.optional(),
  compareAtPriceCents: moneyCentsSchema.nullish(),
  costCents: moneyCentsSchema.nullish(),
  currency: z.string().trim().toUpperCase().length(3).optional(),

  taxable: z.boolean().optional(),
  taxCode: z.string().trim().max(60).nullish(),

  weightGrams: positiveIntSchema.nullish(),
  lengthMm: positiveIntSchema.nullish(),
  widthMm: positiveIntSchema.nullish(),
  heightMm: positiveIntSchema.nullish(),

  requiresShipping: z.boolean().optional(),
  subscriptionEligible: z.boolean().optional(),
});
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const changeProductStatusSchema = z.object({
  status: productStatusSchema,
  /** Recorded in the audit trail. Required when taking a listing out of sale. */
  reason: z.string().trim().max(500).optional(),
});
export type ChangeProductStatusInput = z.infer<typeof changeProductStatusSchema>;

export const productVariantSchema = z.object({
  sku: skuSchema,
  name: z.string().trim().min(1).max(200),
  barcode: z
    .string()
    .trim()
    .regex(/^\d{8,14}$/, 'A barcode is 8 to 14 digits (UPC, EAN or GTIN).')
    .optional(),
  priceCents: moneyCentsSchema.nullish(),
  compareAtPriceCents: moneyCentsSchema.nullish(),
  costCents: moneyCentsSchema.nullish(),
  weightGrams: positiveIntSchema.nullish(),
  options: z.record(z.string().trim().max(60), z.string().trim().max(120)).default({}),
  position: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});
export type ProductVariantInput = z.infer<typeof productVariantSchema>;

export const productImageSchema = z.object({
  mediaId: uuidSchema,
  variantId: uuidSchema.nullish(),
  role: z.enum(PRODUCT_IMAGE_ROLES).default('GALLERY'),
  /**
   * Required, and not allowed to be a filename. An image with no real
   * alternative text is inaccessible, and "IMG_4821.jpg" is worse than nothing
   * because it defeats the checks that would otherwise catch it.
   */
  altText: z
    .string()
    .trim()
    .min(3, 'Describe what the image shows.')
    .max(300)
    .refine((value) => !/^(img|dsc|photo|image)[\s_-]?\d+(\.\w+)?$/i.test(value), {
      message: 'Describe what the image shows, rather than using the filename.',
    }),
  position: z.number().int().min(0).max(1000).default(0),
});
export type ProductImageInput = z.infer<typeof productImageSchema>;

export const productIngredientSchema = z.object({
  ingredientId: uuidSchema,
  amount: z.number().nonnegative().max(1_000_000).nullish(),
  unit: z.string().trim().max(20).nullish(),
  dailyValuePercent: z.number().nonnegative().max(10_000).nullish(),
  isActive: z.boolean().default(true),
  position: z.number().int().min(0).max(1000).default(0),
  notes: z.string().trim().max(500).nullish(),
});
export type ProductIngredientInput = z.infer<typeof productIngredientSchema>;

export const setProductIngredientsSchema = z.object({
  ingredients: z.array(productIngredientSchema).max(200),
});
export type SetProductIngredientsInput = z.infer<typeof setProductIngredientsSchema>;

export const productWarningSchema = z.object({
  severity: z.enum(WARNING_SEVERITIES).default('WARNING'),
  audience: z.enum(WARNING_AUDIENCES).default('GENERAL'),
  text: z.string().trim().min(5, 'Write the warning as it should appear.').max(1000),
  position: z.number().int().min(0).max(100).default(0),
});
export type ProductWarningInput = z.infer<typeof productWarningSchema>;

export const productDisclaimerSchema = z.object({
  kind: z.enum(DISCLAIMER_KINDS),
  text: z.string().trim().min(10).max(2000),
  position: z.number().int().min(0).max(100).default(0),
});
export type ProductDisclaimerInput = z.infer<typeof productDisclaimerSchema>;

export const setProductCategoriesSchema = z
  .object({
    categoryIds: z.array(uuidSchema).max(20),
    primaryCategoryId: uuidSchema.nullish(),
  })
  .refine(
    (value) =>
      value.primaryCategoryId == null || value.categoryIds.includes(value.primaryCategoryId),
    {
      message: 'The primary category must be one of the assigned categories.',
      path: ['primaryCategoryId'],
    },
  );
export type SetProductCategoriesInput = z.infer<typeof setProductCategoriesSchema>;

/**
 * The complete image set for a product.
 *
 * Replace rather than append, so the request describes the intended end state
 * and two editors cannot each add a hero image without noticing.
 */
export const setProductImagesSchema = z
  .object({
    images: z.array(productImageSchema).max(50),
  })
  .refine((value) => value.images.filter((image) => image.role === 'HERO').length <= 1, {
    // A partial unique index enforces this in PostgreSQL too; catching it here
    // turns a constraint violation into a field-level message.
    message: 'Only one image can be the hero image.',
    path: ['images'],
  })
  .refine(
    (value) => new Set(value.images.map((image) => image.mediaId)).size === value.images.length,
    {
      message: 'The same image is used more than once.',
      path: ['images'],
    },
  );
export type SetProductImagesInput = z.infer<typeof setProductImagesSchema>;

/**
 * Product warnings.
 *
 * Free text, because a warning is a labelling statement and the wording is the
 * business's to write. Nothing here generates warning text.
 */
export const setProductWarningsSchema = z.object({
  warnings: z.array(productWarningSchema).max(50),
});
export type SetProductWarningsInput = z.infer<typeof setProductWarningsSchema>;

export const setProductDisclaimersSchema = z
  .object({
    disclaimers: z.array(productDisclaimerSchema).max(20),
  })
  .refine(
    (value) =>
      new Set(value.disclaimers.map((entry) => entry.kind)).size === value.disclaimers.length,
    {
      message: 'Each kind of disclaimer can appear only once.',
      path: ['disclaimers'],
    },
  );
export type SetProductDisclaimersInput = z.infer<typeof setProductDisclaimersSchema>;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createCategorySchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  parentId: uuidSchema.nullish(),
  position: z.number().int().min(0).max(10_000).default(0),
  isActive: z.boolean().default(true),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema.partial();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------

export const createIngredientSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(200),
  scientificName: z.string().trim().max(200).optional(),
  commonNames: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  description: z.string().trim().max(5000).optional(),
  casNumber: z
    .string()
    .trim()
    .regex(/^\d{2,7}-\d{2}-\d$/, 'A CAS number looks like 50-81-7.')
    .optional(),
  allergen: z.string().trim().max(60).optional(),
  isAllergen: z.boolean().default(false),
});
export type CreateIngredientInput = z.infer<typeof createIngredientSchema>;

export const updateIngredientSchema = createIngredientSchema.partial();
export type UpdateIngredientInput = z.infer<typeof updateIngredientSchema>;

export const ingredientSourceSchema = z.object({
  type: z.enum(INGREDIENT_SOURCE_TYPES),
  description: z.string().trim().max(1000).optional(),
  originCountry: z.string().trim().toUpperCase().length(2).optional(),
  supplier: z.string().trim().max(200).optional(),
  isVegan: z.boolean().default(false),
  isVegetarian: z.boolean().default(false),
});
export type IngredientSourceInput = z.infer<typeof ingredientSourceSchema>;

export const ingredientWarningSchema = z.object({
  severity: z.enum(WARNING_SEVERITIES).default('CAUTION'),
  audience: z.enum(WARNING_AUDIENCES).default('GENERAL'),
  text: z.string().trim().min(5).max(1000),
});
export type IngredientWarningInput = z.infer<typeof ingredientWarningSchema>;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const adminProductQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  status: productStatusSchema.optional(),
  type: productTypeSchema.optional(),
  complianceStatus: complianceStatusSchema.optional(),
  categoryId: uuidSchema.optional(),
  brand: z.string().trim().max(120).optional(),
});
export type AdminProductQuery = z.infer<typeof adminProductQuerySchema>;

export const PRODUCT_SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'name'] as const;

export const catalogueQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  category: slugSchema.optional(),
  type: productTypeSchema.optional(),
  brand: z.string().trim().max(120).optional(),
  minPriceCents: z.coerce.number().int().min(0).optional(),
  maxPriceCents: z.coerce.number().int().min(0).optional(),
  /** Repeatable `attr` filters, e.g. `?attr=form:capsule&attr=vegan:true`. */
  attr: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
    .pipe(
      z
        .array(
          z
            .string()
            .max(160)
            .regex(/^[a-z0-9_-]+:[^:]{1,120}$/i, 'Filters look like key:value.'),
        )
        .max(10),
    ),
  sort: z.enum(PRODUCT_SORTS).default('relevance'),
});
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export const complianceDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  /** A decision without reasoning is not a review. */
  notes: z
    .string()
    .trim()
    .min(20, 'Record what you reviewed and why you reached this decision.')
    .max(5000),
});
export type ComplianceDecisionInput = z.infer<typeof complianceDecisionSchema>;
