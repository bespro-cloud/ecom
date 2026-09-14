import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@health/config';
import { isUniqueConstraintError, Prisma } from '@health/database';
import {
  pageBlocksSchema,
  type CreatePageInput,
  type PageBlock,
  type UpdatePageInput,
} from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { CATALOGUE_AUDIT_ACTIONS } from '../catalogue/catalogue.audit.js';
import type { ActorContext } from '../rbac/roles.service.js';
import { RedirectsService } from '../growth/redirects/redirects.service.js';

export interface PageView {
  id: string;
  slug: string;
  title: string;
  status: string;
  blocks: PageBlock[];
  /** Unpublished edits, when there are any. */
  draft: { title: string; blocks: PageBlock[] } | null;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
  updatedAt: string;
}

/**
 * CMS pages.
 *
 * The draft model is the part worth explaining. Editing a live page writes to
 * `draftBlocks`, leaving `blocks` — what visitors see — untouched until someone
 * publishes. Without that separation, saving a half-finished edit to the
 * shipping policy changes the shipping policy.
 *
 * Content is a fixed vocabulary of typed blocks rather than HTML. An admin form
 * that accepts HTML eventually stores a script tag, whether through a
 * compromised account or a well-meant paste, and rendering it would be stored
 * XSS. Blocks cannot express script at all.
 */
@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redirects: RedirectsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(): Promise<PageView[]> {
    const pages = await this.prisma.page.findMany({
      where: { deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }],
    });
    return pages.map(toView);
  }

  async findById(id: string): Promise<PageView> {
    const page = await this.prisma.page.findFirst({ where: { id, deletedAt: null } });
    if (!page) throw AppException.notFound('Page');
    return toView(page);
  }

  /**
   * The published version of a page, for the storefront.
   *
   * Draft content is not included: this is the only read path the public uses,
   * and it structurally cannot return unpublished copy.
   */
  async findPublishedBySlug(slug: string): Promise<{
    slug: string;
    title: string;
    blocks: PageBlock[];
    publishedAt: string | null;
    seo: {
      title: string;
      description: string | null;
      canonicalUrl: string | null;
      noindex: boolean;
    };
  }> {
    const page = await this.prisma.page.findFirst({
      where: { slug, status: 'PUBLISHED', deletedAt: null },
    });
    if (!page) throw AppException.notFound('Page');

    const seo = await this.prisma.seoMetadata.findUnique({
      where: { entityType_entityId: { entityType: 'PAGE', entityId: page.id } },
    });

    return {
      slug: page.slug,
      title: page.title,
      blocks: parseBlocks(page.blocks),
      publishedAt: page.publishedAt?.toISOString() ?? null,
      seo: {
        title: seo?.title ?? page.title,
        description: seo?.description ?? null,
        canonicalUrl: seo?.canonicalUrl ?? null,
        noindex: seo?.noindex ?? false,
      },
    };
  }

  async listPublishedForSitemap(): Promise<Array<{ slug: string; updatedAt: string }>> {
    const noindexIds = new Set(
      (
        await this.prisma.seoMetadata.findMany({
          where: { entityType: 'PAGE', noindex: true },
          select: { entityId: true },
        })
      ).map((entry) => entry.entityId),
    );

    const pages = await this.prisma.page.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      select: { id: true, slug: true, updatedAt: true },
    });

    return pages
      .filter((page) => !noindexIds.has(page.id))
      .map((page) => ({ slug: page.slug, updatedAt: page.updatedAt.toISOString() }));
  }

  async create(input: CreatePageInput, actor: ActorContext): Promise<PageView> {
    try {
      const page = await this.prisma.$transaction(async (tx) => {
        const created = await tx.page.create({
          data: {
            slug: input.slug,
            title: input.title,
            status: 'DRAFT',
            blocks: input.blocks as never,
            lastEditedBy: actor.actorId,
          },
        });

        await this.audit.recordIn(tx, {
          action: CATALOGUE_AUDIT_ACTIONS.PAGE_CREATED,
          entityType: 'page',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { slug: created.slug, title: created.title },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return this.findById(page.id);
    } catch (error) {
      if (isUniqueConstraintError(error, 'slug')) {
        throw AppException.conflict(`The slug "${input.slug}" is already in use.`);
      }
      throw error;
    }
  }

  /**
   * Saves an edit.
   *
   * For a published page this writes to the draft columns only. For a page that
   * has never been published there is no live version to protect, so the edit
   * goes straight to `blocks`.
   */
  async update(id: string, input: UpdatePageInput, actor: ActorContext): Promise<PageView> {
    const existing = await this.prisma.page.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('Page');

    const isLive = existing.status === 'PUBLISHED';

    try {
      await this.prisma.$transaction(async (tx) => {
        // Renaming a live page leaves its indexed URL behind, and a policy page
        // is often the one somebody linked to from an email two years ago.
        if (input.slug && input.slug !== existing.slug && isLive) {
          await this.redirects.recordSlugChange(
            tx,
            `/pages/${existing.slug}`,
            `/pages/${input.slug}`,
            { reason: 'page', actor },
          );
        }

        await tx.page.update({
          where: { id },
          data: {
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            lastEditedBy: actor.actorId,
            ...(isLive
              ? {
                  ...(input.title !== undefined ? { draftTitle: input.title } : {}),
                  ...(input.blocks !== undefined ? { draftBlocks: input.blocks as never } : {}),
                }
              : {
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  ...(input.blocks !== undefined ? { blocks: input.blocks as never } : {}),
                }),
          },
        });

        await this.audit.recordIn(tx, {
          action: CATALOGUE_AUDIT_ACTIONS.PAGE_UPDATED,
          entityType: 'page',
          entityId: id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: {
            slug: input.slug ?? existing.slug,
            savedToDraft: isLive,
            blockCount: input.blocks?.length ?? null,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error, 'slug')) {
        throw AppException.conflict(`The slug "${input.slug}" is already in use.`);
      }
      throw error;
    }

    return this.findById(id);
  }

  /** Promotes the draft to live. */
  async publish(id: string, actor: ActorContext): Promise<PageView> {
    const page = await this.prisma.page.findFirst({ where: { id, deletedAt: null } });
    if (!page) throw AppException.notFound('Page');

    const nextBlocks = page.draftBlocks ?? page.blocks;
    const nextTitle = page.draftTitle ?? page.title;

    if (parseBlocks(nextBlocks).length === 0) {
      throw AppException.preconditionFailed('An empty page cannot be published.');
    }

    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.page.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          title: nextTitle,
          blocks: nextBlocks as never,
          // Clearing the draft is what makes "has unpublished changes" mean
          // something afterwards. `DbNull` writes SQL NULL; a bare `null` on a
          // Json column means "leave it alone" to Prisma.
          draftBlocks: Prisma.DbNull,
          draftTitle: null,
          publishedAt: page.publishedAt ?? now,
          publishedBy: actor.actorId,
        },
      });

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.PAGE_PUBLISHED,
        entityType: 'page',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { status: page.status, title: page.title },
        after: { status: 'PUBLISHED', title: nextTitle },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  async unpublish(id: string, reason: string, actor: ActorContext): Promise<PageView> {
    const page = await this.prisma.page.findFirst({ where: { id, deletedAt: null } });
    if (!page) throw AppException.notFound('Page');
    if (page.status !== 'PUBLISHED') {
      throw AppException.conflict('That page is not published.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.page.update({ where: { id }, data: { status: 'DRAFT', publishedAt: null } });
      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.PAGE_UNPUBLISHED,
        entityType: 'page',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  async remove(id: string, actor: ActorContext): Promise<void> {
    const page = await this.prisma.page.findFirst({ where: { id, deletedAt: null } });
    if (!page) throw AppException.notFound('Page');
    if (page.status === 'PUBLISHED') {
      throw AppException.conflict('Unpublish the page before deleting it.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.page.update({ where: { id }, data: { deletedAt: this.clock.now() } });
      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.PAGE_DELETED,
        entityType: 'page',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { slug: page.slug, title: page.title },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }
}

/**
 * Blocks come back from PostgreSQL as `Json`.
 *
 * They are re-validated on read rather than cast: the column could hold
 * anything written by an older schema version, and rendering unvalidated
 * structure is how a "cannot read property of undefined" reaches a customer.
 */
function parseBlocks(value: unknown): PageBlock[] {
  const parsed = pageBlocksSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function toView(page: {
  id: string;
  slug: string;
  title: string;
  status: string;
  blocks: unknown;
  draftBlocks: unknown;
  draftTitle: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
}): PageView {
  const hasDraft = page.draftBlocks !== null || page.draftTitle !== null;
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    status: page.status,
    blocks: parseBlocks(page.blocks),
    draft: hasDraft
      ? {
          title: page.draftTitle ?? page.title,
          blocks: page.draftBlocks ? parseBlocks(page.draftBlocks) : parseBlocks(page.blocks),
        }
      : null,
    hasUnpublishedChanges: hasDraft,
    publishedAt: page.publishedAt?.toISOString() ?? null,
    updatedAt: page.updatedAt.toISOString(),
  };
}
