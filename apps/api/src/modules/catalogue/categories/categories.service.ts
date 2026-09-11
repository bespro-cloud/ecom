import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@health/config';
import { isUniqueConstraintError } from '@health/database';
import type { CreateCategoryInput, UpdateCategoryInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { CATALOGUE_AUDIT_ACTIONS } from '../catalogue.audit.js';
import type { ActorContext } from '../../rbac/roles.service.js';

export interface CategoryView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  depth: number;
  position: number;
  isActive: boolean;
  productCount: number;
}

export interface CategoryTreeNode extends CategoryView {
  children: CategoryTreeNode[];
}

/**
 * Category administration.
 *
 * The tree is stored with a materialised `path` — the ancestor ids, root first
 * — rather than walked recursively at read time. "Everything under Vitamins"
 * then becomes one indexed query instead of a recursive CTE per request, which
 * matters because the storefront asks it on every category page.
 *
 * The cost is that moving a subtree has to rewrite its descendants' paths. That
 * happens in a transaction, and is rare.
 */
@Injectable()
export class CategoriesService {
  private static readonly MAX_DEPTH = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(includeInactive = false): Promise<CategoryView[]> {
    const categories = await this.prisma.category.findMany({
      where: { deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    return categories.map(toView);
  }

  /** The same set, nested. Built in memory — one query, not one per level. */
  async tree(includeInactive = false): Promise<CategoryTreeNode[]> {
    const flat = await this.list(includeInactive);
    const nodes = new Map<string, CategoryTreeNode>(
      flat.map((category) => [category.id, { ...category, children: [] }]),
    );

    const roots: CategoryTreeNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentId) {
        const parent = nodes.get(node.parentId);
        // A child whose parent is filtered out (inactive) is promoted rather
        // than dropped, so deactivating a parent does not hide its children.
        if (parent) parent.children.push(node);
        else roots.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async findById(id: string): Promise<CategoryView> {
    const category = await this.prisma.category.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { products: true } } },
    });
    if (!category) throw AppException.notFound('Category');
    return toView(category);
  }

  async create(input: CreateCategoryInput, actor: ActorContext): Promise<CategoryView> {
    const { path, depth } = await this.resolvePlacement(input.parentId ?? null);

    try {
      const category = await this.prisma.$transaction(async (tx) => {
        const created = await tx.category.create({
          data: {
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            parentId: input.parentId ?? null,
            path,
            depth,
            position: input.position,
            isActive: input.isActive,
          },
        });

        await this.audit.recordIn(tx, {
          action: CATALOGUE_AUDIT_ACTIONS.CATEGORY_CREATED,
          entityType: 'category',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { slug: created.slug, name: created.name, parentId: created.parentId },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return this.findById(category.id);
    } catch (error) {
      if (isUniqueConstraintError(error, 'slug')) {
        throw AppException.conflict(`The slug "${input.slug}" is already in use.`);
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateCategoryInput, actor: ActorContext): Promise<CategoryView> {
    const existing = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Category');

    const movingParent =
      input.parentId !== undefined && (input.parentId ?? null) !== existing.parentId;

    let placement: { path: string[]; depth: number } | null = null;
    if (movingParent) {
      const nextParent = input.parentId ?? null;
      if (nextParent === id) {
        throw AppException.validation([
          { path: 'parentId', message: 'A category cannot be its own parent.' },
        ]);
      }
      // Moving a category under one of its own descendants would detach the
      // whole subtree from the root and create a cycle.
      if (nextParent) {
        const target = await this.prisma.category.findFirst({
          where: { id: nextParent, deletedAt: null },
          select: { path: true },
        });
        if (target?.path.includes(id)) {
          throw AppException.validation([
            { path: 'parentId', message: 'A category cannot be moved beneath itself.' },
          ]);
        }
      }
      placement = await this.resolvePlacement(nextParent);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.category.update({
        where: { id },
        data: {
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(placement
            ? { parentId: input.parentId ?? null, path: placement.path, depth: placement.depth }
            : {}),
        },
      });

      if (placement) await this.rewriteDescendantPaths(tx, id, existing.path, placement.path);

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.CATEGORY_UPDATED,
        entityType: 'category',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { slug: existing.slug, name: existing.name, parentId: existing.parentId },
        after: {
          slug: input.slug ?? existing.slug,
          name: input.name ?? existing.name,
          parentId: input.parentId ?? existing.parentId,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  /**
   * Soft delete, refused while the category is still in use.
   *
   * Deleting a category with products would orphan them from navigation
   * silently; deleting one with children would detach a whole subtree. Both are
   * the kind of thing noticed a week later.
   */
  async remove(id: string, actor: ActorContext): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { products: true, children: true } } },
    });
    if (!category) throw AppException.notFound('Category');

    if (category._count.products > 0) {
      throw AppException.conflict(
        `${category._count.products} product(s) are in this category. Move them first.`,
      );
    }
    if (category._count.children > 0) {
      throw AppException.conflict('This category has sub-categories. Remove or move them first.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.category.update({
        where: { id },
        data: { deletedAt: this.clock.now(), isActive: false },
      });
      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.CATEGORY_DELETED,
        entityType: 'category',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { slug: category.slug, name: category.name },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  // -------------------------------------------------------------------------

  private async resolvePlacement(
    parentId: string | null,
  ): Promise<{ path: string[]; depth: number }> {
    if (!parentId) return { path: [], depth: 0 };

    const parent = await this.prisma.category.findFirst({
      where: { id: parentId, deletedAt: null },
      select: { id: true, path: true, depth: true },
    });
    if (!parent) {
      throw AppException.validation([
        { path: 'parentId', message: 'That parent category does not exist.' },
      ]);
    }

    const depth = parent.depth + 1;
    if (depth >= CategoriesService.MAX_DEPTH) {
      // Navigation deeper than this stops being usable, and every level
      // multiplies the breadcrumb and facet work.
      throw AppException.validation([
        {
          path: 'parentId',
          message: `Categories can be nested at most ${CategoriesService.MAX_DEPTH} levels deep.`,
        },
      ]);
    }

    return { path: [...parent.path, parent.id], depth };
  }

  /**
   * Rewrites descendant paths after a move.
   *
   * A descendant's path looks like `[...oldPath, movedId, ...betweenThem]`.
   * Only the part up to and including the moved node changes, so the suffix is
   * kept and re-prefixed — which is what preserves the relative structure of
   * the subtree rather than flattening it.
   */
  private async rewriteDescendantPaths(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    movedId: string,
    oldPath: string[],
    newPath: string[],
  ): Promise<void> {
    const descendants = await tx.category.findMany({
      where: { path: { has: movedId }, deletedAt: null },
      select: { id: true, path: true },
    });

    const oldPrefixLength = oldPath.length + 1; // the ancestors, plus the moved node

    for (const descendant of descendants) {
      const suffix = descendant.path.slice(oldPrefixLength);
      const nextPath = [...newPath, movedId, ...suffix];
      await tx.category.update({
        where: { id: descendant.id },
        data: { path: nextPath, depth: nextPath.length },
      });
    }
  }
}

function toView(category: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  depth: number;
  position: number;
  isActive: boolean;
  _count: { products: number };
}): CategoryView {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    description: category.description,
    parentId: category.parentId,
    depth: category.depth,
    position: category.position,
    isActive: category.isActive,
    productCount: category._count.products,
  };
}
