import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import {
  canTransitionProduct,
  type AuditAction,
  type Paginated,
  type ProductStatus,
  type PublishReadiness,
} from '@health/types';
import type {
  AdminProductQuery,
  ChangeProductStatusInput,
  CreateProductInput,
  SetProductCategoriesInput,
  SetProductDisclaimersInput,
  SetProductImagesInput,
  SetProductIngredientsInput,
  SetProductWarningsInput,
  UpdateProductInput,
} from '@health/validation';
import { isUniqueConstraintError, Prisma } from '@health/database';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { decodeCursor, encodeCursor } from '../../../common/pagination.js';
import { AuditService } from '../../audit/audit.service.js';
import { CATALOGUE_AUDIT_ACTIONS } from '../catalogue.audit.js';
import type { ActorContext } from '../../rbac/roles.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { PublishChecklistService } from '../publishing/publish-checklist.service.js';
import { SEARCH_PROVIDER, type SearchProvider } from '../search/search.types.js';
import {
  PRODUCT_ADMIN_INCLUDE,
  toAdminProductView,
  type AdminProductView,
} from './product.view.js';
import { RedirectsService } from '../../growth/redirects/redirects.service.js';

/**
 * Product administration.
 *
 * The rule that shapes this service: **publication is a gated transition, not a
 * field update.** Everything else — descriptions, images, ingredients — can be
 * edited freely on a draft. Making a listing publicly visible goes through the
 * checklist, every time, evaluated at the moment of the transition rather than
 * when the admin screen was rendered.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly checklist: PublishChecklistService,
    private readonly settings: SettingsService,
    private readonly redirects: RedirectsService,
    private readonly logger: PinoLogger,
    @Inject(SEARCH_PROVIDER) private readonly search: SearchProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(ProductsService.name);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(query: AdminProductQuery): Promise<Paginated<AdminProductView>> {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.complianceStatus ? { complianceStatus: query.complianceStatus } : {}),
      ...(query.brand ? { brand: query.brand } : {}),
      ...(query.categoryId ? { categories: { some: { categoryId: query.categoryId } } } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { sku: { contains: query.search.toUpperCase() } },
              { slug: { contains: query.search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.product.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: PRODUCT_ADMIN_INCLUDE,
    });

    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toAdminProductView),
      meta: {
        nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]?.id) : null,
        count: page.length,
        limit: query.limit,
      },
    };
  }

  async findById(id: string): Promise<AdminProductView> {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: PRODUCT_ADMIN_INCLUDE,
    });
    if (!product) throw AppException.notFound('Product');
    return toAdminProductView(product);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(input: CreateProductInput, actor: ActorContext): Promise<AdminProductView> {
    try {
      const product = await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            sku: input.sku,
            slug: input.slug,
            name: input.name,
            shortDescription: input.shortDescription ?? null,
            longDescription: input.longDescription ?? null,
            type: input.type,
            brand: input.brand ?? null,
            manufacturer: input.manufacturer ?? null,
            countryOfOrigin: input.countryOfOrigin ?? null,
            priceCents: input.priceCents,
            compareAtPriceCents: input.compareAtPriceCents ?? null,
            costCents: input.costCents ?? null,
            currency: input.currency,
            taxable: input.taxable,
            taxCode: input.taxCode ?? null,
            weightGrams: input.weightGrams ?? null,
            lengthMm: input.lengthMm ?? null,
            widthMm: input.widthMm ?? null,
            heightMm: input.heightMm ?? null,
            requiresShipping: input.requiresShipping,
            subscriptionEligible: input.subscriptionEligible,
            // A new product is always a draft. There is no path that creates a
            // publicly visible listing in one step.
            status: 'DRAFT',
          },
        });

        await this.audit.recordIn(tx, {
          action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_CREATED,
          entityType: 'product',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { sku: created.sku, name: created.name, type: created.type },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      await this.applyDefaultDisclaimers(product.id, product.type, actor);
      await this.search.reindexProduct(product.id);
      return this.findById(product.id);
    } catch (error) {
      throw this.translateUniqueViolation(error, input.sku, input.slug);
    }
  }

  async update(
    id: string,
    input: UpdateProductInput,
    actor: ActorContext,
  ): Promise<AdminProductView> {
    const existing = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Product');

    // Re-check the compare-at rule against the merged record: a request that
    // lowers only the price would otherwise slip past the per-field schema.
    const price = input.priceCents ?? existing.priceCents;
    const compareAt =
      input.compareAtPriceCents === undefined
        ? existing.compareAtPriceCents
        : input.compareAtPriceCents;
    if (compareAt !== null && compareAt !== undefined && compareAt <= price) {
      throw AppException.validation([
        {
          path: 'compareAtPriceCents',
          message: 'The compare-at price must be higher than the price, or left empty.',
        },
      ]);
    }

    const before = {
      name: existing.name,
      slug: existing.slug,
      priceCents: existing.priceCents,
      type: existing.type,
      status: existing.status,
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        // A renamed listing leaves its indexed URL behind. Writing the redirect
        // in the same transaction as the rename is the point: a rename that
        // committed without its redirect is a silent 404 on a page that has
        // been ranking for two years, and nobody notices until the traffic has
        // already gone.
        if (input.slug && input.slug !== existing.slug && existing.status === 'PUBLISHED') {
          await this.redirects.recordSlugChange(
            tx,
            `/products/${existing.slug}`,
            `/products/${input.slug}`,
            { reason: 'product', actor },
          );
        }

        const updated = await tx.product.update({
          where: { id },
          data: {
            ...pick(input, [
              'slug',
              'name',
              'shortDescription',
              'longDescription',
              'type',
              'brand',
              'manufacturer',
              'countryOfOrigin',
              'priceCents',
              'compareAtPriceCents',
              'costCents',
              'currency',
              'taxable',
              'taxCode',
              'weightGrams',
              'lengthMm',
              'widthMm',
              'heightMm',
              'requiresShipping',
              'subscriptionEligible',
            ]),
          },
        });

        // Editing a published listing is allowed, but a material change to what
        // the reviewer approved invalidates that approval. Losing the approval
        // silently would be worse than blocking the edit.
        if (this.isMaterialChange(input) && existing.complianceStatus === 'APPROVED') {
          await tx.product.update({
            where: { id },
            data: {
              complianceStatus: 'NOT_REVIEWED',
              complianceApprovedAt: null,
              complianceApprovedBy: null,
              complianceReviewDueAt: null,
              // A published product whose approval just lapsed must come down.
              ...(existing.status === 'PUBLISHED' ? { status: 'DRAFT', publishedAt: null } : {}),
            },
          });

          await this.audit.recordIn(tx, {
            action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_COMPLIANCE_INVALIDATED,
            entityType: 'product',
            entityId: id,
            actorId: actor.actorId,
            actorLabel: actor.actorLabel,
            reason: 'Compliance-relevant fields changed after approval.',
            before: { complianceStatus: 'APPROVED', status: existing.status },
            after: { complianceStatus: 'NOT_REVIEWED', status: 'DRAFT' },
            ipAddress: actor.ipAddress ?? null,
            userAgent: actor.userAgent ?? null,
            correlationId: actor.correlationId,
          });
        }

        await this.audit.recordIn(tx, {
          action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_UPDATED,
          entityType: 'product',
          entityId: id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          before,
          after: {
            name: updated.name,
            slug: updated.slug,
            priceCents: updated.priceCents,
            type: updated.type,
            status: updated.status,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });
      });
    } catch (error) {
      throw this.translateUniqueViolation(error, existing.sku, input.slug ?? existing.slug);
    }

    await this.search.reindexProduct(id);
    return this.findById(id);
  }

  /**
   * Fields whose change invalidates a compliance approval.
   *
   * A typo fix in the long description does not; changing the product type, the
   * manufacturer or the name does, because those are what a reviewer signed off
   * on. Erring towards re-review is the safe direction.
   */
  private isMaterialChange(input: UpdateProductInput): boolean {
    return (
      input.type !== undefined ||
      input.name !== undefined ||
      input.manufacturer !== undefined ||
      input.countryOfOrigin !== undefined ||
      input.brand !== undefined
    );
  }

  // -------------------------------------------------------------------------
  // Status transitions — the gate
  // -------------------------------------------------------------------------

  async changeStatus(
    id: string,
    input: ChangeProductStatusInput,
    actor: ActorContext,
  ): Promise<{ product: AdminProductView; readiness: PublishReadiness | null }> {
    const existing = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Product');

    const from = existing.status as ProductStatus;
    const to = input.status;

    if (from === to) {
      return { product: await this.findById(id), readiness: null };
    }

    if (!canTransitionProduct(from, to)) {
      throw AppException.conflict(
        `A product cannot move from ${from} to ${to}.`,
        'STATE_TRANSITION_INVALID',
        { internalDetail: `invalid product transition ${from} -> ${to}` },
      );
    }

    // The gate. Evaluated here, at the transition, against current data.
    //
    // It runs on the way into READY as well as PUBLISHED, minus the compliance
    // signature: READY is a claim that the listing is finished and waiting for
    // a reviewer, and letting an empty draft carry that label would be a piece
    // of false assurance in the one workflow where it matters most. The
    // publication gate is unchanged — it still re-evaluates everything,
    // compliance approval included.
    let readiness: PublishReadiness | null = null;
    if (to === 'PUBLISHED' || to === 'READY') {
      readiness = await this.checklist.evaluate(id);
      const blocking =
        to === 'PUBLISHED'
          ? readiness.blockedBy
          : readiness.blockedBy.filter((key) => key !== 'COMPLIANCE_APPROVED');

      if (blocking.length > 0) {
        await this.audit.record({
          action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_PUBLISH_BLOCKED,
          entityType: 'product',
          entityId: id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          outcome: 'FAILURE',
          reason: `Blocked by: ${blocking.join(', ')}`,
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        throw new AppException(
          'PRECONDITION_FAILED',
          422,
          to === 'PUBLISHED'
            ? 'This product is not ready to publish. Resolve the outstanding checks first.'
            : 'This product is not ready for review. Resolve the outstanding checks first.',
          {
            details: readiness.checks
              .filter((check) => check.state === 'FAIL' && blocking.includes(check.key))
              .map((check) => ({ path: check.key, message: check.detail ?? check.label })),
          },
        );
      }
    }

    // Taking a live listing down is a decision worth explaining.
    if (from === 'PUBLISHED' && !input.reason?.trim()) {
      throw AppException.validation([
        { path: 'reason', message: 'Record why this listing is being taken out of sale.' },
      ]);
    }

    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          status: to,
          ...(to === 'PUBLISHED' ? { publishedAt: existing.publishedAt ?? now } : {}),
          ...(from === 'PUBLISHED' ? { publishedAt: null } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action:
          to === 'PUBLISHED'
            ? CATALOGUE_AUDIT_ACTIONS.PRODUCT_PUBLISHED
            : from === 'PUBLISHED'
              ? CATALOGUE_AUDIT_ACTIONS.PRODUCT_UNPUBLISHED
              : CATALOGUE_AUDIT_ACTIONS.PRODUCT_STATUS_CHANGED,
        entityType: 'product',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason ?? null,
        before: { status: from },
        after: {
          status: to,
          // What the reviewer's gate actually saw, kept with the decision.
          ...(readiness ? { checklist: summariseChecklist(readiness) } : {}),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    await this.search.reindexProduct(id);
    this.logger.info({ productId: id, from, to }, 'product status changed');

    return { product: await this.findById(id), readiness };
  }

  async evaluateReadiness(id: string): Promise<PublishReadiness> {
    const exists = await this.prisma.product.count({ where: { id, deletedAt: null } });
    if (exists === 0) throw AppException.notFound('Product');
    return this.checklist.evaluate(id);
  }

  // -------------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------------

  async setIngredients(
    id: string,
    input: SetProductIngredientsInput,
    actor: ActorContext,
  ): Promise<AdminProductView> {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw AppException.notFound('Product');

    const ids = input.ingredients.map((entry) => entry.ingredientId);
    if (new Set(ids).size !== ids.length) {
      throw AppException.validation([
        { path: 'ingredients', message: 'The same ingredient is listed more than once.' },
      ]);
    }

    const known = await this.prisma.ingredient.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true },
    });
    if (known.length !== ids.length) {
      throw AppException.validation([
        { path: 'ingredients', message: 'One or more ingredients do not exist.' },
      ]);
    }

    const before = await this.prisma.productIngredient.findMany({
      where: { productId: id },
      select: { ingredientId: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.productIngredient.deleteMany({ where: { productId: id } });
      if (input.ingredients.length > 0) {
        await tx.productIngredient.createMany({
          data: input.ingredients.map((entry) => ({
            productId: id,
            ingredientId: entry.ingredientId,
            amount: entry.amount ?? null,
            unit: entry.unit ?? null,
            dailyValuePercent: entry.dailyValuePercent ?? null,
            isActive: entry.isActive,
            position: entry.position,
            notes: entry.notes ?? null,
          })),
        });
      }

      // The formulation is what a compliance reviewer signed off on. Changing
      // it invalidates the approval, and takes a live listing down.
      if (product.complianceStatus === 'APPROVED') {
        await tx.product.update({
          where: { id },
          data: {
            complianceStatus: 'NOT_REVIEWED',
            complianceApprovedAt: null,
            complianceApprovedBy: null,
            complianceReviewDueAt: null,
            ...(product.status === 'PUBLISHED' ? { status: 'DRAFT', publishedAt: null } : {}),
          },
        });
      }

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_INGREDIENTS_CHANGED,
        entityType: 'product',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { ingredientIds: before.map((entry) => entry.ingredientId).sort() },
        after: { ingredientIds: [...ids].sort() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    await this.search.reindexProduct(id);
    return this.findById(id);
  }

  async setCategories(
    id: string,
    input: SetProductCategoriesInput,
    actor: ActorContext,
  ): Promise<AdminProductView> {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw AppException.notFound('Product');

    const known = await this.prisma.category.findMany({
      where: { id: { in: input.categoryIds }, deletedAt: null },
      select: { id: true },
    });
    if (known.length !== new Set(input.categoryIds).size) {
      throw AppException.validation([
        { path: 'categoryIds', message: 'One or more categories do not exist.' },
      ]);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productCategory.deleteMany({ where: { productId: id } });
      if (input.categoryIds.length > 0) {
        await tx.productCategory.createMany({
          data: input.categoryIds.map((categoryId, index) => ({
            productId: id,
            categoryId,
            isPrimary: categoryId === input.primaryCategoryId,
            position: index,
          })),
        });
      }

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_CATEGORIES_CHANGED,
        entityType: 'product',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { categoryIds: input.categoryIds, primary: input.primaryCategoryId ?? null },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    await this.search.reindexProduct(id);
    return this.findById(id);
  }

  /**
   * Replaces the image set.
   *
   * Label and facts-panel photographs are not decoration: they are what a
   * compliance reviewer read when they approved the listing, and what a
   * customer checks a dosage or an allergen against. So changing *which* media
   * fills those roles re-opens the approval, while re-ordering the gallery or
   * correcting alternative text does not.
   */
  async setImages(
    id: string,
    input: SetProductImagesInput,
    actor: ActorContext,
  ): Promise<AdminProductView> {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw AppException.notFound('Product');

    const mediaIds = input.images.map((image) => image.mediaId);
    const known = await this.prisma.media.findMany({
      where: { id: { in: mediaIds }, deletedAt: null },
      select: { id: true, kind: true },
    });
    if (known.length !== new Set(mediaIds).size) {
      throw AppException.validation([
        { path: 'images', message: 'One or more images do not exist.' },
      ]);
    }
    const nonImage = known.filter((media) => media.kind !== 'IMAGE');
    if (nonImage.length > 0) {
      throw AppException.validation([
        { path: 'images', message: 'One or more of those files is not an image.' },
      ]);
    }

    const variantIds = input.images
      .map((image) => image.variantId)
      .filter((variantId): variantId is string => typeof variantId === 'string');
    if (variantIds.length > 0) {
      const variants = await this.prisma.productVariant.findMany({
        where: { id: { in: variantIds }, productId: id },
        select: { id: true },
      });
      if (variants.length !== new Set(variantIds).size) {
        // Attaching an image to another product's variant would leak it onto
        // a listing nobody intended.
        throw AppException.validation([
          { path: 'images', message: 'One or more variants do not belong to this product.' },
        ]);
      }
    }

    const before = await this.prisma.productImage.findMany({
      where: { productId: id },
      select: { mediaId: true, role: true, altText: true },
    });

    const regulatoryBefore = regulatoryImageKey(before);
    const regulatoryAfter = regulatoryImageKey(input.images);
    const materialChange = regulatoryBefore !== regulatoryAfter;

    await this.prisma.$transaction(async (tx) => {
      await tx.productImage.deleteMany({ where: { productId: id } });
      if (input.images.length > 0) {
        await tx.productImage.createMany({
          data: input.images.map((image) => ({
            productId: id,
            mediaId: image.mediaId,
            variantId: image.variantId ?? null,
            role: image.role,
            altText: image.altText,
            position: image.position,
          })),
        });
      }

      if (materialChange) {
        await this.invalidateComplianceIn(
          tx,
          id,
          product,
          actor,
          'the product label imagery changed',
        );
      }

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_IMAGES_CHANGED,
        entityType: 'product',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { images: before.map((image) => ({ mediaId: image.mediaId, role: image.role })) },
        after: {
          images: input.images.map((image) => ({ mediaId: image.mediaId, role: image.role })),
          reopenedComplianceReview: materialChange,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  /**
   * Replaces the warnings shown on the listing.
   *
   * Always treated as a material change. Warning text is a safety statement,
   * and deciding which edits to it are "minor enough" is not a judgement this
   * code is entitled to make.
   */
  async setWarnings(
    id: string,
    input: SetProductWarningsInput,
    actor: ActorContext,
  ): Promise<AdminProductView> {
    return this.replaceComplianceText(
      id,
      actor,
      CATALOGUE_AUDIT_ACTIONS.PRODUCT_WARNINGS_CHANGED,
      'the product warnings changed',
      async (tx, product) => {
        const before = await tx.productWarning.findMany({
          where: { productId: id },
          select: { severity: true, audience: true, text: true },
        });
        await tx.productWarning.deleteMany({ where: { productId: id } });
        if (input.warnings.length > 0) {
          await tx.productWarning.createMany({
            data: input.warnings.map((warning) => ({
              productId: product.id,
              severity: warning.severity,
              audience: warning.audience,
              text: warning.text,
              position: warning.position,
            })),
          });
        }
        return {
          before: { count: before.length },
          after: { count: input.warnings.length },
        };
      },
    );
  }

  /**
   * Replaces the disclaimers shown on the listing.
   *
   * The text is stored on the product rather than referenced, so a listing
   * always shows the wording that was current when it was approved.
   */
  async setDisclaimers(
    id: string,
    input: SetProductDisclaimersInput,
    actor: ActorContext,
  ): Promise<AdminProductView> {
    return this.replaceComplianceText(
      id,
      actor,
      CATALOGUE_AUDIT_ACTIONS.PRODUCT_DISCLAIMERS_CHANGED,
      'the product disclaimers changed',
      async (tx, product) => {
        const before = await tx.productDisclaimer.findMany({
          where: { productId: id },
          select: { kind: true },
        });
        await tx.productDisclaimer.deleteMany({ where: { productId: id } });
        if (input.disclaimers.length > 0) {
          await tx.productDisclaimer.createMany({
            data: input.disclaimers.map((entry) => ({
              productId: product.id,
              kind: entry.kind,
              text: entry.text,
              position: entry.position,
            })),
          });
        }
        return {
          before: { kinds: before.map((entry) => entry.kind).sort() },
          after: { kinds: input.disclaimers.map((entry) => entry.kind).sort() },
        };
      },
    );
  }

  /**
   * Shared shape for the two compliance-text replacements: swap the rows,
   * re-open the approval, record what changed — all in one transaction, so a
   * listing can never end up live with warnings its approval did not cover.
   */
  private async replaceComplianceText(
    id: string,
    actor: ActorContext,
    action: AuditAction,
    reason: string,
    apply: (
      tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
      product: { id: string; status: string; complianceStatus: string },
    ) => Promise<{ before: unknown; after: unknown }>,
  ): Promise<AdminProductView> {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw AppException.notFound('Product');

    await this.prisma.$transaction(async (tx) => {
      const changed = await apply(tx, product);
      await this.invalidateComplianceIn(tx, id, product, actor, reason);

      await this.audit.recordIn(tx, {
        action,
        entityType: 'product',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: changed.before as Record<string, unknown>,
        after: changed.after as Record<string, unknown>,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  /**
   * Re-opens a compliance approval, and takes a live listing down with it.
   *
   * Leaving a listing published while its approval is void would make the gate
   * a one-off check rather than a standing condition.
   */
  private async invalidateComplianceIn(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    id: string,
    product: { status: string; complianceStatus: string },
    actor: ActorContext,
    reason: string,
  ): Promise<void> {
    if (product.complianceStatus !== 'APPROVED') return;

    const withdrawn = product.status === 'PUBLISHED';
    await tx.product.update({
      where: { id },
      data: {
        complianceStatus: 'NOT_REVIEWED',
        complianceApprovedAt: null,
        complianceApprovedBy: null,
        complianceReviewDueAt: null,
        ...(withdrawn ? { status: 'DRAFT', publishedAt: null } : {}),
      },
    });

    await this.audit.recordIn(tx, {
      action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_COMPLIANCE_INVALIDATED,
      entityType: 'product',
      entityId: id,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      reason,
      before: { complianceStatus: product.complianceStatus, status: product.status },
      after: { complianceStatus: 'NOT_REVIEWED', withdrawnFromSale: withdrawn },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      correlationId: actor.correlationId,
    });
  }

  /**
   * Soft delete.
   *
   * Never a hard delete: a product appears on historical orders, and removing
   * the row would make those records unreadable. A published product must be
   * withdrawn first, so "delete" can never be a way of skipping the reason that
   * unpublishing requires.
   */
  async remove(id: string, actor: ActorContext): Promise<void> {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw AppException.notFound('Product');

    if (product.status === 'PUBLISHED') {
      throw AppException.conflict(
        'Take the listing out of sale before deleting it, so the reason is recorded.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: { deletedAt: this.clock.now(), status: 'ARCHIVED' },
      });
      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_DELETED,
        entityType: 'product',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { sku: product.sku, name: product.name, status: product.status },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    await this.search.removeProduct(id);
  }

  // -------------------------------------------------------------------------

  /**
   * Applies the disclaimers this product type requires.
   *
   * The wording comes from system settings, so counsel can change it without a
   * deploy, and it is copied onto the product rather than referenced — a
   * listing must show the text that was current when it was approved, not text
   * that changed underneath it afterwards.
   */
  private async applyDefaultDisclaimers(
    productId: string,
    type: string,
    actor: ActorContext,
  ): Promise<void> {
    const entries: Array<{ kind: 'DSHEA' | 'GENERAL_HEALTH'; text: string }> = [];

    if (type === 'SUPPLEMENT') {
      const text = await this.settings.get<string>('compliance.disclaimer_supplement');
      if (text) entries.push({ kind: 'DSHEA', text });
    }
    const general = await this.settings.get<string>('compliance.disclaimer_general_health');
    if (general) entries.push({ kind: 'GENERAL_HEALTH', text: general });

    if (entries.length === 0) {
      this.logger.warn(
        { productId, type },
        'no default disclaimer text configured; the publishing checklist will block this product',
      );
      return;
    }

    await this.prisma.productDisclaimer.createMany({
      data: entries.map((entry, index) => ({
        productId,
        kind: entry.kind,
        text: entry.text,
        position: index,
      })),
      skipDuplicates: true,
    });

    this.logger.debug(
      { productId, kinds: entries.map((entry) => entry.kind), actor: actor.actorId },
      'default disclaimers applied',
    );
  }

  private translateUniqueViolation(error: unknown, sku: string, slug: string): unknown {
    if (isUniqueConstraintError(error, 'sku')) {
      return AppException.conflict(
        `SKU "${sku}" is already in use. SKUs are never reused, because they appear on historical orders.`,
      );
    }
    if (isUniqueConstraintError(error, 'slug')) {
      return AppException.conflict(`The URL slug "${slug}" is already in use.`);
    }
    return error;
  }
}

/**
 * A stable fingerprint of the images that carry regulatory information.
 *
 * Used to tell "the label photo was replaced" (which voids an approval) from
 * "the gallery was re-ordered" (which does not).
 */
function regulatoryImageKey(images: Array<{ mediaId: string; role: string }>): string {
  return images
    .filter((image) => image.role === 'LABEL' || image.role === 'FACTS_PANEL')
    .map((image) => `${image.role}:${image.mediaId}`)
    .sort()
    .join('|');
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function summariseChecklist(readiness: PublishReadiness) {
  return {
    ready: readiness.ready,
    passed: readiness.checks.filter((check) => check.state === 'PASS').map((c) => c.key),
    notYetEnforced: readiness.notYetEnforced,
  };
}
