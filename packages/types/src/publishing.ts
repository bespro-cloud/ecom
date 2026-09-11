import type { ProductType } from './catalogue.js';

/**
 * The product publishing gate.
 *
 * A healthcare product listing must not become publicly visible until it is
 * actually ready. "Ready" is a list of specific, checkable conditions rather
 * than a judgement, so the gate can be enforced by code and audited afterwards.
 *
 * The list is configurable (`catalog.publish_checklist`) because what a
 * business must verify before publishing is a legal and operational question,
 * not one this codebase can settle. Checks whose domain has not been built yet
 * are declared here with the phase that implements them, and reported as
 * `NOT_YET_ENFORCED` rather than silently passing — a checklist that quietly
 * approves is worse than no checklist.
 */

export const PUBLISH_CHECKS = [
  'PRODUCT_INFORMATION',
  'PRICING',
  'IMAGES',
  'LABEL',
  'INGREDIENTS',
  'WARNINGS',
  'DISCLAIMERS',
  'SEO',
  'CATEGORY',
  'COMPLIANCE_APPROVED',
  'CLAIMS_REVIEWED',
  'EVIDENCE_REVIEWED',
  'INVENTORY_CONFIGURED',
] as const;

export type PublishCheckKey = (typeof PUBLISH_CHECKS)[number];

export type PublishCheckState =
  /** The condition is satisfied. */
  | 'PASS'
  /** The condition is not satisfied. Publication is blocked. */
  | 'FAIL'
  /** Not applicable to this product type (e.g. a label for an accessory). */
  | 'NOT_APPLICABLE'
  /**
   * The domain that would evaluate this check does not exist yet. Reported
   * honestly rather than counted as a pass; it does not block publication
   * because it cannot yet be satisfied by anyone.
   */
  | 'NOT_YET_ENFORCED';

export interface PublishCheckDefinition {
  key: PublishCheckKey;
  label: string;
  description: string;
  /** Phase that implements the evaluation. */
  implementedInPhase: number;
  /** Product types this check applies to. Empty means all. */
  appliesTo?: readonly ProductType[];
}

export const PUBLISH_CHECK_DEFINITIONS: readonly PublishCheckDefinition[] = [
  {
    key: 'PRODUCT_INFORMATION',
    label: 'Product information complete',
    description: 'Name, SKU, slug, type, brand, manufacturer and both descriptions are present.',
    implementedInPhase: 2,
  },
  {
    key: 'PRICING',
    label: 'Price configured',
    description: 'A non-zero price in a supported currency, with a coherent compare-at price.',
    implementedInPhase: 2,
  },
  {
    key: 'IMAGES',
    label: 'Images available',
    description: 'At least a hero image, and every image has alternative text.',
    implementedInPhase: 2,
  },
  {
    key: 'LABEL',
    label: 'Label available',
    description: 'A photograph of the product label, and a facts panel where one is required.',
    implementedInPhase: 2,
    appliesTo: ['SUPPLEMENT', 'FOOD', 'COSMETIC'],
  },
  {
    key: 'INGREDIENTS',
    label: 'Ingredients complete',
    description: 'At least one active ingredient, each with an amount or an explicit note.',
    implementedInPhase: 2,
    appliesTo: ['SUPPLEMENT', 'FOOD', 'COSMETIC'],
  },
  {
    key: 'WARNINGS',
    label: 'Required warnings present',
    description: 'Every warning inherited from an ingredient is shown on the listing.',
    implementedInPhase: 2,
    appliesTo: ['SUPPLEMENT', 'FOOD', 'COSMETIC'],
  },
  {
    key: 'DISCLAIMERS',
    label: 'Required disclaimers present',
    description: 'The DSHEA statement on supplements, and the general health disclaimer.',
    implementedInPhase: 2,
  },
  {
    key: 'SEO',
    label: 'SEO metadata complete',
    description: 'A title and description within the lengths search engines display.',
    implementedInPhase: 2,
  },
  {
    key: 'CATEGORY',
    label: 'Categorised',
    description: 'Assigned to at least one category, with one marked primary.',
    implementedInPhase: 2,
  },
  {
    key: 'COMPLIANCE_APPROVED',
    label: 'Compliance approved',
    description:
      'A compliance reviewer has signed the listing off, and the approval has not expired.',
    implementedInPhase: 2,
  },
  {
    key: 'CLAIMS_REVIEWED',
    label: 'Claims reviewed',
    description: 'Every health claim on the listing has an approved claim record.',
    implementedInPhase: 4,
  },
  {
    key: 'EVIDENCE_REVIEWED',
    label: 'Evidence reviewed',
    description: 'Each approved claim is supported by reviewed evidence.',
    implementedInPhase: 4,
  },
  {
    key: 'INVENTORY_CONFIGURED',
    label: 'Inventory configuration valid',
    description: 'A warehouse, a stock record and a batch-tracking policy exist for the product.',
    implementedInPhase: 3,
  },
];

export interface PublishCheckResult {
  key: PublishCheckKey;
  label: string;
  description: string;
  state: PublishCheckState;
  /** Why the check failed, or what is still missing. */
  detail?: string;
  implementedInPhase: number;
}

export interface PublishReadiness {
  ready: boolean;
  checks: PublishCheckResult[];
  blockedBy: PublishCheckKey[];
  /** Checks that cannot yet be evaluated, listed so nobody mistakes them for passes. */
  notYetEnforced: PublishCheckKey[];
}

export function summarisePublishReadiness(checks: PublishCheckResult[]): PublishReadiness {
  const blockedBy = checks.filter((c) => c.state === 'FAIL').map((c) => c.key);
  const notYetEnforced = checks.filter((c) => c.state === 'NOT_YET_ENFORCED').map((c) => c.key);

  return { ready: blockedBy.length === 0, checks, blockedBy, notYetEnforced };
}
