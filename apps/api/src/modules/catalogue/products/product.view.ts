import { Prisma } from '@health/database';

/**
 * Product projections.
 *
 * Two deliberately different shapes. The admin view carries everything an
 * editor needs, including cost price and compliance state. The public view
 * carries what a customer should see — and notably *not* cost, margin, internal
 * notes or compliance workflow state, none of which are anyone's business
 * outside the company.
 *
 * Keeping them as separate mappers rather than one with flags means a new field
 * added to the admin view does not silently appear on the storefront.
 */

export const PRODUCT_ADMIN_INCLUDE = {
  images: {
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    include: { media: true },
  },
  variants: { orderBy: [{ position: 'asc' }], where: { deletedAt: null } },
  categories: { include: { category: { select: { id: true, name: true, slug: true } } } },
  ingredients: {
    orderBy: [{ position: 'asc' }],
    include: {
      ingredient: {
        select: {
          id: true,
          name: true,
          slug: true,
          scientificName: true,
          isAllergen: true,
          allergen: true,
        },
      },
    },
  },
  warnings: { orderBy: [{ position: 'asc' }] },
  disclaimers: { orderBy: [{ position: 'asc' }] },
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof PRODUCT_ADMIN_INCLUDE }>;

export interface AdminProductView {
  id: string;
  sku: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  type: string;
  brand: string | null;
  manufacturer: string | null;
  countryOfOrigin: string | null;
  status: string;
  complianceStatus: string;
  complianceApprovedAt: string | null;
  complianceReviewDueAt: string | null;
  publishedAt: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  costCents: number | null;
  currency: string;
  taxable: boolean;
  taxCode: string | null;
  weightGrams: number | null;
  dimensionsMm: { length: number | null; width: number | null; height: number | null };
  requiresShipping: boolean;
  subscriptionEligible: boolean;
  images: Array<{
    id: string;
    mediaId: string;
    role: string;
    altText: string;
    position: number;
    url: string | null;
    width: number | null;
    height: number | null;
  }>;
  variants: Array<{
    id: string;
    sku: string;
    name: string;
    barcode: string | null;
    priceCents: number | null;
    options: unknown;
    position: number;
    isActive: boolean;
  }>;
  categories: Array<{ id: string; name: string; slug: string; isPrimary: boolean }>;
  ingredients: Array<{
    ingredientId: string;
    name: string;
    slug: string;
    scientificName: string | null;
    isAllergen: boolean;
    amount: string | null;
    unit: string | null;
    dailyValuePercent: string | null;
    isActive: boolean;
    position: number;
    notes: string | null;
  }>;
  warnings: Array<{ id: string; severity: string; audience: string; text: string }>;
  disclaimers: Array<{ id: string; kind: string; text: string }>;
  createdAt: string;
  updatedAt: string;
}

export function toAdminProductView(product: ProductWithRelations): AdminProductView {
  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    shortDescription: product.shortDescription,
    longDescription: product.longDescription,
    type: product.type,
    brand: product.brand,
    manufacturer: product.manufacturer,
    countryOfOrigin: product.countryOfOrigin,
    status: product.status,
    complianceStatus: product.complianceStatus,
    complianceApprovedAt: product.complianceApprovedAt?.toISOString() ?? null,
    complianceReviewDueAt: product.complianceReviewDueAt?.toISOString() ?? null,
    publishedAt: product.publishedAt?.toISOString() ?? null,
    priceCents: product.priceCents,
    compareAtPriceCents: product.compareAtPriceCents,
    costCents: product.costCents,
    currency: product.currency,
    taxable: product.taxable,
    taxCode: product.taxCode,
    weightGrams: product.weightGrams,
    dimensionsMm: {
      length: product.lengthMm,
      width: product.widthMm,
      height: product.heightMm,
    },
    requiresShipping: product.requiresShipping,
    subscriptionEligible: product.subscriptionEligible,
    images: product.images.map((image) => ({
      id: image.id,
      mediaId: image.mediaId,
      role: image.role,
      altText: image.altText,
      position: image.position,
      // Populated by the controller, which owns the storage provider.
      url: null,
      width: image.media.width,
      height: image.media.height,
    })),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      barcode: variant.barcode,
      priceCents: variant.priceCents,
      options: variant.options,
      position: variant.position,
      isActive: variant.isActive,
    })),
    categories: product.categories.map((entry) => ({
      id: entry.category.id,
      name: entry.category.name,
      slug: entry.category.slug,
      isPrimary: entry.isPrimary,
    })),
    ingredients: product.ingredients.map((entry) => ({
      ingredientId: entry.ingredientId,
      name: entry.ingredient.name,
      slug: entry.ingredient.slug,
      scientificName: entry.ingredient.scientificName,
      isAllergen: entry.ingredient.isAllergen,
      // Decimal is serialised as a string: a supplement dose is exactly the
      // kind of value that must not lose precision to a float.
      amount: entry.amount?.toString() ?? null,
      unit: entry.unit,
      dailyValuePercent: entry.dailyValuePercent?.toString() ?? null,
      isActive: entry.isActive,
      position: entry.position,
      notes: entry.notes,
    })),
    warnings: product.warnings.map((warning) => ({
      id: warning.id,
      severity: warning.severity,
      audience: warning.audience,
      text: warning.text,
    })),
    disclaimers: product.disclaimers.map((disclaimer) => ({
      id: disclaimer.id,
      kind: disclaimer.kind,
      text: disclaimer.text,
    })),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
