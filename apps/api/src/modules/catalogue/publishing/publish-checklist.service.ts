import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@health/config';
import {
  DSHEA_REQUIRED_TYPES,
  LABEL_REQUIRED_TYPES,
  EVIDENCE_REQUIRED_CLAIM_TYPES,
  PUBLISH_CHECK_DEFINITIONS,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  SUBSTANTIATING_RELEVANCE,
  summarisePublishReadiness,
  type ProductType,
  type PublishCheckDefinition,
  type PublishCheckKey,
  type PublishCheckResult,
  type PublishReadiness,
} from '@health/types';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { SettingsService } from '../../settings/settings.service.js';
import { WarehousesService } from '../../commerce/inventory/warehouses.service.js';

/**
 * The product publishing gate.
 *
 * A healthcare listing does not become publicly visible because someone
 * clicked publish. It becomes visible because a specific list of conditions is
 * satisfied, and this service is what decides that.
 *
 * Three rules shape the design:
 *
 *  1. **Nothing passes by omission.** A check whose domain does not exist yet
 *     reports `NOT_YET_ENFORCED` and is listed explicitly. A checklist that
 *     silently approves is worse than no checklist, because it looks like
 *     assurance.
 *  2. **Which checks block is configuration, not code.** What a business must
 *     verify before publishing is a legal question, so an operator can relax a
 *     check without a deploy — but the default is that every implemented check
 *     blocks, and a relaxed check is still evaluated and still reported.
 *  3. **The gate is evaluated server-side at the moment of the transition**,
 *     not when the admin screen was rendered. A stale screen cannot publish a
 *     product that has since lost its compliance approval.
 */
/**
 * The highest phase whose checks are actually evaluated.
 *
 * Anything declared for a later phase reports `NOT_YET_ENFORCED`. Bumping this
 * constant is the one edit that turns a declared check into an enforced one,
 * so it is deliberately a single, visible line rather than a number repeated
 * through the file.
 */
const IMPLEMENTED_THROUGH_PHASE = 4;

@Injectable()
export class PublishChecklistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly warehouses: WarehousesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The checks that block publication.
   *
   * **Every implemented check is required unless an operator has explicitly
   * relaxed it.** The configuration is therefore a list of *relaxations*
   * (`catalog.publish_checklist_relaxed`), not a list of requirements.
   *
   * That inversion is deliberate, and it replaced an inclusion list that was
   * subtly fail-open: with a stored list of required keys, adding a new check
   * to the codebase meant every existing deployment silently did not enforce
   * it, because the key was absent from a value written before it existed.
   * Absence would have meant "not required" when it actually meant "nobody has
   * decided". On a gate that governs what health products customers can see,
   * the safe reading of silence is that the check applies.
   *
   * Relaxing a check never hides it: the finding is still evaluated and still
   * reported, it simply does not block.
   */
  private async requiredChecks(): Promise<Set<PublishCheckKey>> {
    const relaxed = await this.settings.get<string[]>('catalog.publish_checklist_relaxed');
    const excluded = new Set(Array.isArray(relaxed) ? relaxed : []);

    return new Set(
      PUBLISH_CHECK_DEFINITIONS.map((check) => check.key).filter((key) => !excluded.has(key)),
    );
  }

  async evaluate(productId: string): Promise<PublishReadiness> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: {
        images: { select: { role: true, altText: true } },
        categories: { select: { isPrimary: true } },
        ingredients: {
          select: {
            isActive: true,
            amount: true,
            unit: true,
            notes: true,
            ingredient: {
              select: {
                name: true,
                isAllergen: true,
                allergen: true,
                warnings: { select: { id: true, text: true } },
              },
            },
          },
        },
        warnings: { select: { text: true, audience: true, severity: true } },
        disclaimers: { select: { kind: true } },
      },
    });

    if (!product) {
      throw new Error(`Product ${productId} does not exist`);
    }

    const seo = await this.prisma.seoMetadata.findUnique({
      where: { entityType_entityId: { entityType: 'PRODUCT', entityId: productId } },
    });

    const required = await this.requiredChecks();
    const type = product.type as ProductType;

    const results: PublishCheckResult[] = [];

    for (const definition of PUBLISH_CHECK_DEFINITIONS) {
      const base = {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        implementedInPhase: definition.implementedInPhase,
      };

      // Not applicable to this product type — an accessory has no label panel.
      if (definition.appliesTo && !definition.appliesTo.includes(type)) {
        results.push({ ...base, state: 'NOT_APPLICABLE' as const });
        continue;
      }

      // The domain that would evaluate this does not exist yet. Reported
      // plainly; it cannot block, because nobody could satisfy it.
      if (definition.implementedInPhase > IMPLEMENTED_THROUGH_PHASE) {
        results.push({
          ...base,
          state: 'NOT_YET_ENFORCED' as const,
          detail: `Evaluated from Phase ${definition.implementedInPhase}.`,
        });
        continue;
      }

      const outcome =
        definition.key === 'INVENTORY_CONFIGURED'
          ? await this.checkInventory(productId)
          : definition.key === 'CLAIMS_REVIEWED'
            ? await this.checkClaims(productId)
            : definition.key === 'EVIDENCE_REVIEWED'
              ? await this.checkEvidence(productId)
              : this.runCheck(definition, product, seo, type);

      // An operator has excluded this check from the required set: report the
      // real finding, but do not block on it.
      if (outcome.state === 'FAIL' && !required.has(definition.key)) {
        results.push({
          ...base,
          state: 'NOT_APPLICABLE' as const,
          detail: `${outcome.detail ?? 'Not satisfied.'} Not required by the configured checklist.`,
        });
        continue;
      }

      results.push({ ...base, ...outcome });
    }

    return summarisePublishReadiness(results);
  }

  // -------------------------------------------------------------------------
  // Individual checks
  // -------------------------------------------------------------------------

  private runCheck(
    definition: PublishCheckDefinition,
    product: ProductForChecklist,
    seo: SeoForChecklist,
    type: ProductType,
  ): { state: 'PASS' | 'FAIL'; detail?: string } {
    switch (definition.key) {
      case 'PRODUCT_INFORMATION':
        return this.checkProductInformation(product);
      case 'PRICING':
        return this.checkPricing(product);
      case 'IMAGES':
        return this.checkImages(product);
      case 'LABEL':
        return this.checkLabel(product, type);
      case 'INGREDIENTS':
        return this.checkIngredients(product);
      case 'WARNINGS':
        return this.checkWarnings(product);
      case 'DISCLAIMERS':
        return this.checkDisclaimers(product, type);
      case 'SEO':
        return this.checkSeo(seo);
      case 'CATEGORY':
        return this.checkCategory(product);
      case 'COMPLIANCE_APPROVED':
        return this.checkCompliance(product);
      default:
        return { state: 'FAIL', detail: 'No evaluation is implemented for this check.' };
    }
  }

  private checkProductInformation(product: ProductForChecklist) {
    const missing: string[] = [];
    if (!product.name?.trim()) missing.push('name');
    if (!product.shortDescription?.trim()) missing.push('short description');
    if (!product.longDescription?.trim()) missing.push('full description');
    if (!product.brand?.trim()) missing.push('brand');
    if (!product.manufacturer?.trim()) missing.push('manufacturer');
    if (!product.countryOfOrigin?.trim()) missing.push('country of origin');

    return missing.length === 0
      ? { state: 'PASS' as const }
      : { state: 'FAIL' as const, detail: `Missing: ${missing.join(', ')}.` };
  }

  private checkPricing(product: ProductForChecklist) {
    if (product.priceCents <= 0) {
      return { state: 'FAIL' as const, detail: 'The price is zero.' };
    }
    if (product.compareAtPriceCents !== null && product.compareAtPriceCents <= product.priceCents) {
      // A "was" price at or below the selling price advertises a discount that
      // does not exist, which is a deceptive-pricing problem, not a display bug.
      return {
        state: 'FAIL' as const,
        detail: 'The compare-at price is not higher than the price.',
      };
    }
    return { state: 'PASS' as const };
  }

  private checkImages(product: ProductForChecklist) {
    const hero = product.images.filter((image) => image.role === 'HERO');
    if (hero.length === 0) {
      return { state: 'FAIL' as const, detail: 'No hero image.' };
    }
    const withoutAlt = product.images.filter((image) => image.altText.trim().length < 3);
    if (withoutAlt.length > 0) {
      return {
        state: 'FAIL' as const,
        detail: `${withoutAlt.length} image(s) have no usable alternative text.`,
      };
    }
    return { state: 'PASS' as const };
  }

  private checkLabel(product: ProductForChecklist, type: ProductType) {
    if (!LABEL_REQUIRED_TYPES.includes(type)) return { state: 'PASS' as const };

    const hasLabel = product.images.some((image) => image.role === 'LABEL');
    const hasFacts = product.images.some((image) => image.role === 'FACTS_PANEL');

    const missing: string[] = [];
    if (!hasLabel) missing.push('a photograph of the label');
    // Supplements and foods carry a mandatory facts panel; a customer cannot
    // check a dosage or an allergen without being able to read it.
    if (!hasFacts && (type === 'SUPPLEMENT' || type === 'FOOD')) {
      missing.push('a facts panel image');
    }

    return missing.length === 0
      ? { state: 'PASS' as const }
      : { state: 'FAIL' as const, detail: `Missing ${missing.join(' and ')}.` };
  }

  private checkIngredients(product: ProductForChecklist) {
    const active = product.ingredients.filter((entry) => entry.isActive);
    if (active.length === 0) {
      return { state: 'FAIL' as const, detail: 'No active ingredients recorded.' };
    }

    // An undisclosed amount is acceptable — proprietary blends exist — but it
    // has to be a deliberate note rather than an empty field.
    const undocumented = active.filter((entry) => entry.amount === null && !entry.notes?.trim());
    if (undocumented.length > 0) {
      const names = undocumented
        .map((entry) => entry.ingredient.name)
        .slice(0, 3)
        .join(', ');
      return {
        state: 'FAIL' as const,
        detail: `No amount and no explanatory note for: ${names}.`,
      };
    }

    const missingUnit = active.filter((entry) => entry.amount !== null && !entry.unit?.trim());
    if (missingUnit.length > 0) {
      return {
        state: 'FAIL' as const,
        detail: `An amount with no unit is meaningless: ${missingUnit
          .map((entry) => entry.ingredient.name)
          .slice(0, 3)
          .join(', ')}.`,
      };
    }

    return { state: 'PASS' as const };
  }

  /**
   * Allergen disclosure.
   *
   * Ingredient warnings are *inherited* by the listing rather than copied, so
   * they need no per-product action and there is nothing to verify about them
   * — adding one to an ingredient surfaces it everywhere that ingredient is
   * used.
   *
   * Allergens are different. Under FALCPA (extended by the FASTER Act to
   * include sesame) a major allergen must be declared, and a declaration
   * generated purely by inference is not something to publish unreviewed. So
   * the check is: if any ingredient is flagged as an allergen, the listing must
   * carry an allergen disclaimer or a warning that actually names it.
   *
   * The system will not write that text itself. Naming an allergen is a
   * labelling statement, and inventing one is exactly the kind of plausible
   * fabrication that must never reach a customer.
   */
  private checkWarnings(product: ProductForChecklist) {
    const allergens = product.ingredients
      .filter((entry) => entry.ingredient.isAllergen)
      .map((entry) => ({
        name: entry.ingredient.name,
        allergen: entry.ingredient.allergen ?? entry.ingredient.name,
      }));

    if (allergens.length === 0) {
      // Nothing to declare. Requiring an invented warning here would be worse
      // than having none.
      return { state: 'PASS' as const };
    }

    const hasAllergenDisclaimer = product.disclaimers.some((entry) => entry.kind === 'ALLERGEN');
    const declaredText = product.warnings
      .filter((entry) => entry.audience === 'ALLERGY' || entry.severity === 'WARNING')
      .map((entry) => entry.text.toLowerCase())
      .join(' ');

    const undeclared = allergens.filter(
      (entry) => !declaredText.includes(entry.allergen.toLowerCase()),
    );

    if (hasAllergenDisclaimer || undeclared.length === 0) {
      return { state: 'PASS' as const };
    }

    return {
      state: 'FAIL' as const,
      detail:
        `Contains allergen ingredient(s) (${undeclared.map((e) => e.name).join(', ')}) ` +
        'with no allergen disclaimer and no warning naming them.',
    };
  }

  private checkDisclaimers(product: ProductForChecklist, type: ProductType) {
    const present = new Set(product.disclaimers.map((entry) => entry.kind));
    const missing: string[] = [];

    if (DSHEA_REQUIRED_TYPES.includes(type) && !present.has('DSHEA')) {
      missing.push('the DSHEA statement');
    }
    if (!present.has('GENERAL_HEALTH')) {
      missing.push('the general health disclaimer');
    }

    return missing.length === 0
      ? { state: 'PASS' as const }
      : { state: 'FAIL' as const, detail: `Missing ${missing.join(' and ')}.` };
  }

  private checkSeo(seo: SeoForChecklist) {
    if (!seo?.title?.trim() || !seo?.description?.trim()) {
      return { state: 'FAIL' as const, detail: 'No SEO title or description.' };
    }
    if (seo.title.length > SEO_TITLE_MAX || seo.description.length > SEO_DESCRIPTION_MAX) {
      return {
        state: 'FAIL' as const,
        detail: `Title must be ${SEO_TITLE_MAX} characters or fewer and description ${SEO_DESCRIPTION_MAX} or fewer.`,
      };
    }
    return { state: 'PASS' as const };
  }

  private checkCategory(product: ProductForChecklist) {
    if (product.categories.length === 0) {
      return { state: 'FAIL' as const, detail: 'Not assigned to a category.' };
    }
    if (!product.categories.some((entry) => entry.isPrimary)) {
      return { state: 'FAIL' as const, detail: 'No primary category, so no canonical URL.' };
    }
    return { state: 'PASS' as const };
  }

  /**
   * Whether the warehouse could actually fill an order for this product.
   *
   * Publishing something that cannot be allocated produces orders nobody can
   * fulfil, which is a worse customer experience than the listing simply not
   * being there yet.
   */
  private async checkInventory(
    productId: string,
  ): Promise<{ state: 'PASS' | 'FAIL'; detail?: string }> {
    const result = await this.warehouses.isConfiguredForSale(productId);

    if (result.variantCount === 0) {
      return {
        state: 'FAIL',
        detail: 'The product has no active variant, so there is nothing to stock or sell.',
      };
    }
    if (!result.ok) {
      return {
        state: 'FAIL',
        detail: `No stock record in an active warehouse for: ${result.missing.slice(0, 3).join(', ')}.`,
      };
    }
    return { state: 'PASS' };
  }

  /**
   * Whether every recorded claim on this listing has been approved.
   *
   * **Be clear about what this does and does not verify.** It checks the claims
   * someone recorded as claims. It does not read the product description and
   * decide whether it contains an unrecorded claim — that inference about
   * regulated speech is not one software should make, and a system that made it
   * would fail in the direction nobody notices: the claim it missed is exactly
   * the one that goes out unreviewed.
   *
   * So the honest division of labour is: this check guarantees no *recorded*
   * claim reaches a customer unapproved, and the human compliance review is
   * where someone attests that the copy makes no claims beyond those recorded.
   * The detail text says so, rather than letting a green tick imply more.
   */
  private async checkClaims(
    productId: string,
  ): Promise<{ state: 'PASS' | 'FAIL'; detail?: string }> {
    const claims = await this.prisma.productClaim.findMany({
      where: { productId, status: { notIn: ['WITHDRAWN', 'REJECTED'] } },
      select: {
        id: true,
        status: true,
        type: true,
        reviewDueAt: true,
        approvedVersionId: true,
        currentVersionId: true,
      },
    });

    if (claims.length === 0) {
      return {
        state: 'PASS',
        detail:
          'No claims are recorded against this listing. The compliance reviewer confirms separately that the copy makes none.',
      };
    }

    const unapproved = claims.filter((claim) => claim.status !== 'APPROVED');
    if (unapproved.length > 0) {
      const states = [
        ...new Set(unapproved.map((claim) => claim.status.toLowerCase().replace(/_/g, ' '))),
      ];
      return {
        state: 'FAIL',
        detail: `${unapproved.length} of ${claims.length} claim(s) are not approved (${states.join(', ')}).`,
      };
    }

    const now = this.clock.timestamp();
    const lapsed = claims.filter(
      (claim) => claim.reviewDueAt !== null && claim.reviewDueAt.getTime() <= now,
    );
    if (lapsed.length > 0) {
      return {
        state: 'FAIL',
        detail: `${lapsed.length} claim approval(s) have lapsed and need re-reviewing.`,
      };
    }

    // An approved claim whose wording has since been edited. The listing would
    // still show the approved text, but publishing in that state means shipping
    // a page the admin screen does not match.
    const edited = claims.filter(
      (claim) =>
        claim.approvedVersionId !== null && claim.approvedVersionId !== claim.currentVersionId,
    );
    if (edited.length > 0) {
      return {
        state: 'FAIL',
        detail: `${edited.length} claim(s) have been reworded since approval and need re-reviewing.`,
      };
    }

    return {
      state: 'PASS',
      detail: `${claims.length} recorded claim(s), all approved. Claims not recorded here are not checked by this gate.`,
    };
  }

  /**
   * Whether each approved claim that needs substantiation has any.
   *
   * Counts accepted sources marked as direct or indirect support. There is no
   * scoring and no threshold beyond "at least one", because weighing whether a
   * study actually supports a sentence is the reviewer's judgement and the
   * whole substance of their job — a confidence number here would look like the
   * software had formed a view, and people would rely on it.
   */
  private async checkEvidence(
    productId: string,
  ): Promise<{ state: 'PASS' | 'FAIL'; detail?: string }> {
    const claims = await this.prisma.productClaim.findMany({
      where: { productId, status: 'APPROVED' },
      select: {
        id: true,
        type: true,
        evidenceLinks: {
          select: { relevance: true, evidence: { select: { status: true } } },
        },
      },
    });

    const needing = claims.filter((claim) =>
      EVIDENCE_REQUIRED_CLAIM_TYPES.includes(claim.type as never),
    );
    if (needing.length === 0) {
      return {
        state: 'PASS',
        detail: 'No approved claim on this listing requires study evidence.',
      };
    }

    const unsupported = needing.filter(
      (claim) =>
        claim.evidenceLinks.filter(
          (link) =>
            link.evidence.status === 'ACCEPTED' &&
            SUBSTANTIATING_RELEVANCE.includes(link.relevance as never),
        ).length === 0,
    );

    if (unsupported.length > 0) {
      return {
        state: 'FAIL',
        detail: `${unsupported.length} approved claim(s) have no accepted supporting evidence.`,
      };
    }

    return {
      state: 'PASS',
      detail: `${needing.length} claim(s) requiring substantiation each have accepted evidence.`,
    };
  }

  private checkCompliance(product: ProductForChecklist) {
    if (product.complianceStatus !== 'APPROVED') {
      return {
        state: 'FAIL' as const,
        detail: `Compliance status is ${product.complianceStatus.toLowerCase().replace(/_/g, ' ')}.`,
      };
    }
    if (
      product.complianceReviewDueAt !== null &&
      product.complianceReviewDueAt.getTime() <= this.clock.timestamp()
    ) {
      // An approval granted against evidence that has since been superseded is
      // not an approval. Lapsing is the point of the review interval.
      return {
        state: 'FAIL' as const,
        detail: 'The compliance approval has expired and the listing needs re-reviewing.',
      };
    }
    return { state: 'PASS' as const };
  }
}

// Shapes the checklist reads. Declared locally so a change to the Prisma
// include shows up here as a type error rather than at runtime.
interface ProductForChecklist {
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  brand: string | null;
  manufacturer: string | null;
  countryOfOrigin: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  complianceStatus: string;
  complianceReviewDueAt: Date | null;
  images: Array<{ role: string; altText: string }>;
  categories: Array<{ isPrimary: boolean }>;
  ingredients: Array<{
    isActive: boolean;
    amount: unknown;
    unit: string | null;
    notes: string | null;
    ingredient: {
      name: string;
      isAllergen: boolean;
      allergen: string | null;
      warnings: Array<{ id: string; text: string }>;
    };
  }>;
  warnings: Array<{ text: string; audience: string; severity: string }>;
  disclaimers: Array<{ kind: string }>;
}

type SeoForChecklist = { title: string | null; description: string | null } | null;
