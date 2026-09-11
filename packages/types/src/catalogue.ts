/**
 * Catalogue vocabulary shared by the API and both front ends.
 *
 * Kept here rather than derived from the Prisma client so the storefront can
 * use it without depending on the database package.
 */

export const PRODUCT_TYPES = [
  'SUPPLEMENT',
  'COSMETIC',
  'FOOD',
  'DEVICE',
  'WELLNESS',
  'ACCESSORY',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/**
 * How each product type is described to a customer, and what it may claim.
 *
 * The distinction is regulatory, not cosmetic: a supplement carries the DSHEA
 * disclaimer and may make structure/function claims with substantiation; a
 * cosmetic may describe appearance but not structure or function; a device has
 * its own FDA guidance. Flattening these into "product" is how a listing ends
 * up making a claim it is not entitled to make.
 */
export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  SUPPLEMENT: 'Dietary supplement',
  COSMETIC: 'Cosmetic',
  FOOD: 'Food',
  DEVICE: 'Device',
  WELLNESS: 'General wellness',
  ACCESSORY: 'Accessory',
};

/** Product types that must carry the DSHEA disclaimer before publication. */
export const DSHEA_REQUIRED_TYPES: readonly ProductType[] = ['SUPPLEMENT'];

/** Product types that require a label image and a facts panel. */
export const LABEL_REQUIRED_TYPES: readonly ProductType[] = ['SUPPLEMENT', 'FOOD', 'COSMETIC'];

export const PRODUCT_STATUSES = ['DRAFT', 'IN_REVIEW', 'READY', 'PUBLISHED', 'ARCHIVED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/**
 * Permitted product status transitions.
 *
 * A product cannot jump from DRAFT straight to PUBLISHED: publication is gated
 * on the checklist, and the gate is enforced on the transition rather than
 * trusted to the caller.
 */
export const PRODUCT_STATUS_TRANSITIONS: Record<ProductStatus, readonly ProductStatus[]> = {
  DRAFT: ['IN_REVIEW', 'ARCHIVED'],
  IN_REVIEW: ['DRAFT', 'READY', 'ARCHIVED'],
  READY: ['PUBLISHED', 'DRAFT', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export function canTransitionProduct(from: ProductStatus, to: ProductStatus): boolean {
  return PRODUCT_STATUS_TRANSITIONS[from].includes(to);
}

export const COMPLIANCE_STATUSES = [
  'NOT_REVIEWED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export const PRODUCT_IMAGE_ROLES = [
  'HERO',
  'GALLERY',
  'LABEL',
  'FACTS_PANEL',
  'CERTIFICATE',
] as const;
export type ProductImageRole = (typeof PRODUCT_IMAGE_ROLES)[number];

export const WARNING_SEVERITIES = ['INFORMATION', 'CAUTION', 'WARNING'] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];

export const WARNING_AUDIENCES = [
  'GENERAL',
  'PREGNANCY',
  'NURSING',
  'CHILDREN',
  'MEDICATION_INTERACTION',
  'ALLERGY',
  'MEDICAL_CONDITION',
] as const;
export type WarningAudience = (typeof WARNING_AUDIENCES)[number];

export const WARNING_AUDIENCE_LABELS: Record<WarningAudience, string> = {
  GENERAL: 'Everyone',
  PREGNANCY: 'If you are pregnant',
  NURSING: 'If you are nursing',
  CHILDREN: 'Children',
  MEDICATION_INTERACTION: 'If you take medication',
  ALLERGY: 'Allergies',
  MEDICAL_CONDITION: 'If you have a medical condition',
};

export const INGREDIENT_SOURCE_TYPES = [
  'PLANT',
  'ANIMAL',
  'MINERAL',
  'SYNTHETIC',
  'FERMENTATION',
  'MICROBIAL',
  'OTHER',
] as const;
export type IngredientSourceType = (typeof INGREDIENT_SOURCE_TYPES)[number];

export const DISCLAIMER_KINDS = ['DSHEA', 'GENERAL_HEALTH', 'ALLERGEN', 'OTHER'] as const;
export type DisclaimerKind = (typeof DISCLAIMER_KINDS)[number];

/**
 * The nine major food allergens that must be declared under US law
 * (FALCPA, extended by the FASTER Act to include sesame).
 */
export const MAJOR_ALLERGENS = [
  'milk',
  'eggs',
  'fish',
  'crustacean shellfish',
  'tree nuts',
  'peanuts',
  'wheat',
  'soybeans',
  'sesame',
] as const;
export type MajorAllergen = (typeof MAJOR_ALLERGENS)[number];

export const PAGE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

/**
 * Advisory SEO limits.
 *
 * Google does not truncate at a character count — it truncates at a pixel
 * width — but these are the figures that keep a title and description visible
 * in practice.
 */
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 160;
