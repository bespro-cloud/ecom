import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@health/config';
import { isUniqueConstraintError } from '@health/database';
import type { Paginated } from '@health/types';
import type {
  CreateIngredientInput,
  IngredientSourceInput,
  IngredientWarningInput,
  UpdateIngredientInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { decodeCursor, encodeCursor } from '../../../common/pagination.js';
import { AuditService } from '../../audit/audit.service.js';
import { CATALOGUE_AUDIT_ACTIONS } from '../catalogue.audit.js';
import type { ActorContext } from '../../rbac/roles.service.js';
import { SEARCH_PROVIDER, type SearchProvider } from '../search/search.types.js';

export interface IngredientView {
  id: string;
  slug: string;
  name: string;
  scientificName: string | null;
  commonNames: string[];
  description: string | null;
  casNumber: string | null;
  allergen: string | null;
  isAllergen: boolean;
  sources: Array<{
    id: string;
    type: string;
    description: string | null;
    originCountry: string | null;
    supplier: string | null;
    isVegan: boolean;
    isVegetarian: boolean;
  }>;
  warnings: Array<{ id: string; severity: string; audience: string; text: string }>;
  productCount: number;
  createdAt: string;
}

const INGREDIENT_INCLUDE = {
  sources: { orderBy: { createdAt: 'asc' } },
  warnings: { orderBy: { severity: 'desc' } },
  _count: { select: { products: true } },
} as const;

/**
 * Ingredient administration.
 *
 * Ingredients are shared entities, not free text on a product, and that is the
 * whole point: when a supplier changes, an interaction is identified, or a lot
 * is recalled, the question "which products contain this?" has to be
 * answerable. It only is if the relationship is modelled.
 *
 * A warning added here appears on every product containing the ingredient
 * without anyone editing those listings — which is also why changing one
 * invalidates the compliance approval of every product that uses it.
 */
@Injectable()
export class IngredientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(SEARCH_PROVIDER) private readonly search: SearchProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(query: {
    cursor?: string;
    limit: number;
    search?: string;
    allergensOnly?: boolean;
  }): Promise<Paginated<IngredientView>> {
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.ingredient.findMany({
      where: {
        deletedAt: null,
        ...(query.allergensOnly ? { isAllergen: true } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { scientificName: { contains: query.search, mode: 'insensitive' } },
                { commonNames: { has: query.search.toLowerCase() } },
              ],
            }
          : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: INGREDIENT_INCLUDE,
    });

    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toView),
      meta: {
        nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]?.id) : null,
        count: page.length,
        limit: query.limit,
      },
    };
  }

  async findById(id: string): Promise<IngredientView> {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id, deletedAt: null },
      include: INGREDIENT_INCLUDE,
    });
    if (!ingredient) throw AppException.notFound('Ingredient');
    return toView(ingredient);
  }

  async findBySlug(slug: string): Promise<IngredientView> {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { slug, deletedAt: null },
      include: INGREDIENT_INCLUDE,
    });
    if (!ingredient) throw AppException.notFound('Ingredient');
    return toView(ingredient);
  }

  async create(input: CreateIngredientInput, actor: ActorContext): Promise<IngredientView> {
    try {
      const ingredient = await this.prisma.$transaction(async (tx) => {
        const created = await tx.ingredient.create({
          data: {
            slug: input.slug,
            name: input.name,
            scientificName: input.scientificName ?? null,
            commonNames: input.commonNames,
            description: input.description ?? null,
            casNumber: input.casNumber ?? null,
            allergen: input.allergen ?? null,
            isAllergen: input.isAllergen,
          },
        });

        await this.audit.recordIn(tx, {
          action: CATALOGUE_AUDIT_ACTIONS.INGREDIENT_CREATED,
          entityType: 'ingredient',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { slug: created.slug, name: created.name, isAllergen: created.isAllergen },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return this.findById(ingredient.id);
    } catch (error) {
      if (isUniqueConstraintError(error, 'slug')) {
        throw AppException.conflict(`The slug "${input.slug}" is already in use.`);
      }
      throw error;
    }
  }

  async update(
    id: string,
    input: UpdateIngredientInput,
    actor: ActorContext,
  ): Promise<IngredientView> {
    const existing = await this.prisma.ingredient.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Ingredient');

    // The allergen flag drives the publishing checklist's disclosure check, so
    // changing it has to re-open every affected listing for review.
    const allergenChanged =
      input.isAllergen !== undefined && input.isAllergen !== existing.isAllergen;

    await this.prisma.$transaction(async (tx) => {
      await tx.ingredient.update({
        where: { id },
        data: {
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.scientificName !== undefined ? { scientificName: input.scientificName } : {}),
          ...(input.commonNames !== undefined ? { commonNames: input.commonNames } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.casNumber !== undefined ? { casNumber: input.casNumber } : {}),
          ...(input.allergen !== undefined ? { allergen: input.allergen } : {}),
          ...(input.isAllergen !== undefined ? { isAllergen: input.isAllergen } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.INGREDIENT_UPDATED,
        entityType: 'ingredient',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { name: existing.name, isAllergen: existing.isAllergen },
        after: {
          name: input.name ?? existing.name,
          isAllergen: input.isAllergen ?? existing.isAllergen,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      if (allergenChanged) {
        await this.invalidateDependentApprovals(tx, id, actor, 'allergen status changed');
      }
    });

    await this.reindexDependents(id);
    return this.findById(id);
  }

  async addSource(
    id: string,
    input: IngredientSourceInput,
    actor: ActorContext,
  ): Promise<IngredientView> {
    await this.assertExists(id);
    await this.prisma.ingredientSource.create({
      data: {
        ingredientId: id,
        type: input.type,
        description: input.description ?? null,
        originCountry: input.originCountry ?? null,
        supplier: input.supplier ?? null,
        isVegan: input.isVegan,
        isVegetarian: input.isVegetarian,
      },
    });
    await this.audit.record({
      action: CATALOGUE_AUDIT_ACTIONS.INGREDIENT_UPDATED,
      entityType: 'ingredient',
      entityId: id,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      after: { sourceAdded: input.type, supplier: input.supplier ?? null },
      correlationId: actor.correlationId,
    });
    return this.findById(id);
  }

  /**
   * Adds a warning.
   *
   * This is the operation with the widest blast radius in the catalogue: it
   * changes what every product containing the ingredient says to a customer.
   * So it re-opens their compliance approvals, and takes published ones down —
   * a listing that now carries a warning a reviewer never saw should not stay
   * live.
   */
  async addWarning(
    id: string,
    input: IngredientWarningInput,
    actor: ActorContext,
  ): Promise<IngredientView> {
    await this.assertExists(id);

    await this.prisma.$transaction(async (tx) => {
      const warning = await tx.ingredientWarning.create({
        data: {
          ingredientId: id,
          severity: input.severity,
          audience: input.audience,
          text: input.text,
        },
      });

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.INGREDIENT_WARNING_ADDED,
        entityType: 'ingredient',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { warningId: warning.id, severity: warning.severity, text: warning.text },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      await this.invalidateDependentApprovals(tx, id, actor, 'a new ingredient warning was added');
    });

    return this.findById(id);
  }

  async removeWarning(id: string, warningId: string, actor: ActorContext): Promise<IngredientView> {
    const warning = await this.prisma.ingredientWarning.findFirst({
      where: { id: warningId, ingredientId: id },
    });
    if (!warning) throw AppException.notFound('Warning');

    await this.prisma.$transaction(async (tx) => {
      await tx.ingredientWarning.delete({ where: { id: warningId } });
      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.INGREDIENT_WARNING_REMOVED,
        entityType: 'ingredient',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        // Removing a safety warning is exactly the kind of change that must
        // remain readable afterwards, so the text goes into the record.
        before: { warningId, severity: warning.severity, text: warning.text },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
      await this.invalidateDependentApprovals(tx, id, actor, 'an ingredient warning was removed');
    });

    return this.findById(id);
  }

  async remove(id: string, actor: ActorContext): Promise<void> {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { products: true } } },
    });
    if (!ingredient) throw AppException.notFound('Ingredient');

    if (ingredient._count.products > 0) {
      throw AppException.conflict(
        `${ingredient._count.products} product(s) contain this ingredient. Remove it from them first.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.ingredient.update({ where: { id }, data: { deletedAt: this.clock.now() } });
      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.INGREDIENT_DELETED,
        entityType: 'ingredient',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { slug: ingredient.slug, name: ingredient.name },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  // -------------------------------------------------------------------------

  private async assertExists(id: string): Promise<void> {
    const count = await this.prisma.ingredient.count({ where: { id, deletedAt: null } });
    if (count === 0) throw AppException.notFound('Ingredient');
  }

  /**
   * Re-opens the compliance approval of every product containing this
   * ingredient, and withdraws the published ones.
   *
   * Blunt on purpose. The alternative — deciding which changes are material
   * enough to matter — is a judgement this code is not entitled to make about
   * safety information.
   */
  private async invalidateDependentApprovals(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    ingredientId: string,
    actor: ActorContext,
    reason: string,
  ): Promise<void> {
    const affected = await tx.product.findMany({
      where: {
        deletedAt: null,
        complianceStatus: 'APPROVED',
        ingredients: { some: { ingredientId } },
      },
      select: { id: true, status: true },
    });
    if (affected.length === 0) return;

    await tx.product.updateMany({
      where: { id: { in: affected.map((product) => product.id) } },
      data: {
        complianceStatus: 'NOT_REVIEWED',
        complianceApprovedAt: null,
        complianceApprovedBy: null,
        complianceReviewDueAt: null,
      },
    });

    const published = affected.filter((product) => product.status === 'PUBLISHED');
    if (published.length > 0) {
      await tx.product.updateMany({
        where: { id: { in: published.map((product) => product.id) } },
        data: { status: 'DRAFT', publishedAt: null },
      });
    }

    await this.audit.recordIn(tx, {
      action: CATALOGUE_AUDIT_ACTIONS.PRODUCT_COMPLIANCE_INVALIDATED,
      entityType: 'ingredient',
      entityId: ingredientId,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      reason,
      after: {
        productsReopened: affected.length,
        productsWithdrawn: published.length,
      },
      correlationId: actor.correlationId,
    });
  }

  /** Ingredient names feed the product search vector, so dependents need a refresh. */
  private async reindexDependents(ingredientId: string): Promise<void> {
    const products = await this.prisma.productIngredient.findMany({
      where: { ingredientId },
      select: { productId: true },
    });
    for (const entry of products) {
      await this.search.reindexProduct(entry.productId);
    }
  }
}

function toView(ingredient: {
  id: string;
  slug: string;
  name: string;
  scientificName: string | null;
  commonNames: string[];
  description: string | null;
  casNumber: string | null;
  allergen: string | null;
  isAllergen: boolean;
  createdAt: Date;
  sources: Array<{
    id: string;
    type: string;
    description: string | null;
    originCountry: string | null;
    supplier: string | null;
    isVegan: boolean;
    isVegetarian: boolean;
  }>;
  warnings: Array<{ id: string; severity: string; audience: string; text: string }>;
  _count: { products: number };
}): IngredientView {
  return {
    id: ingredient.id,
    slug: ingredient.slug,
    name: ingredient.name,
    scientificName: ingredient.scientificName,
    commonNames: ingredient.commonNames,
    description: ingredient.description,
    casNumber: ingredient.casNumber,
    allergen: ingredient.allergen,
    isAllergen: ingredient.isAllergen,
    sources: ingredient.sources.map((source) => ({
      id: source.id,
      type: source.type,
      description: source.description,
      originCountry: source.originCountry,
      supplier: source.supplier,
      isVegan: source.isVegan,
      isVegetarian: source.isVegetarian,
    })),
    warnings: ingredient.warnings.map((warning) => ({
      id: warning.id,
      severity: warning.severity,
      audience: warning.audience,
      text: warning.text,
    })),
    productCount: ingredient._count.products,
    createdAt: ingredient.createdAt.toISOString(),
  };
}
