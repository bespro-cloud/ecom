import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { isUniqueConstraintError, Prisma } from '@health/database';
import { healthClaimPromptTerms } from '@health/types';
import type {
  BlogQuery,
  CreateBlogCategoryInput,
  CreateBlogPostInput,
  ReviewBlogPostInput,
  UpdateBlogPostInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { RedirectsService } from '../redirects/redirects.service.js';
import { MediaUrlService } from '../../media/media-url.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { GROWTH_AUDIT_ACTIONS } from '../growth.audit.js';

/**
 * The blog.
 *
 * Editorial content on a site that sells regulated products is marketing copy,
 * whatever the writer calls it. An article headlined "How magnesium helps you
 * sleep" that links to a magnesium product is making a claim about that
 * product; the fact that it is prose in a blog rather than a bullet on a
 * listing is a distinction a regulator does not draw.
 *
 * So the gate: **a post that names a product cannot be published by its author
 * alone.** It goes to compliance, a named reviewer reads the actual text, and
 * the decision is recorded with the text snapshotted into it. A post that names
 * no product is ordinary content and publishes on the editor's own authority —
 * this is a gate on claims about products, not a bureaucracy for every page.
 *
 * Three consequences worth stating.
 *
 * **The product list is declared, not detected.** A regex over prose deciding
 * whether an article is "about" a product would fail in the direction nobody
 * notices: the post it missed is the one that publishes unreviewed claims. A
 * writer says what the post is about, and the reviewer reads the text anyway.
 *
 * **Approval is of a specific text.** Editing the body or changing the product
 * list clears the approval, because the approval was of what the reviewer read.
 * Anything else lets a post be approved as a recipe and published as a claim.
 *
 * **The database enforces it too.** A CHECK refuses a published post that names
 * a product and has no approval, so a direct UPDATE, a data fix or a future
 * code path cannot put unreviewed product claims on a public page.
 */
@Injectable()
export class BlogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redirects: RedirectsService,
    private readonly media: MediaUrlService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(BlogService.name);
  }

  // -------------------------------------------------------------------------
  // Public reads
  // -------------------------------------------------------------------------

  /** Published posts, newest first. The only state a visitor can see. */
  async listPublished(limit = 20, cursor?: string) {
    const posts = await this.prisma.blogPost.findMany({
      where: { status: 'PUBLISHED', deletedAt: null, publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        category: { select: { slug: true, name: true } },
        heroMedia: { select: { storageKey: true, width: true, height: true } },
      },
    });

    return {
      data: posts.slice(0, limit).map((post) => this.toPublicSummary(post)),
      meta: {
        hasMore: posts.length > limit,
        nextCursor: posts.length > limit ? posts[limit - 1]!.id : null,
      },
    };
  }

  async findPublishedBySlug(slug: string) {
    const post = await this.prisma.blogPost.findFirst({
      where: { slug, status: 'PUBLISHED', deletedAt: null },
      include: {
        category: { select: { slug: true, name: true } },
        heroMedia: { select: { storageKey: true, width: true, height: true } },
      },
    });
    if (!post) throw AppException.notFound('Post');

    // Products are resolved to published listings only. A post approved while a
    // product was live must not keep linking to it after it was withdrawn — a
    // withdrawn listing is usually withdrawn for a reason, and a blog post is
    // not a back door to it.
    const products =
      post.productIds.length === 0
        ? []
        : await this.prisma.product.findMany({
            where: { id: { in: post.productIds }, status: 'PUBLISHED', deletedAt: null },
            select: { id: true, slug: true, name: true, priceCents: true },
          });

    return { ...this.toPublicSummary(post), blocks: post.blocks, products };
  }

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  async create(input: CreateBlogPostInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    try {
      const post = await this.prisma.$transaction(async (tx) => {
        const created = await tx.blogPost.create({
          data: {
            slug: input.slug,
            title: input.title,
            excerpt: input.excerpt ?? null,
            blocks: (input.blocks ?? []) as Prisma.InputJsonValue,
            categoryId: input.categoryId ?? null,
            heroMediaId: input.heroMediaId ?? null,
            heroAltText: input.heroAltText ?? null,
            productIds: input.productIds ?? [],
            authorId: actor.actorId,
            authorName: actor.actorLabel,
            lastEditedBy: actor.actorId,
            status: 'DRAFT',
          },
        });

        await this.audit.recordIn(tx, {
          action: GROWTH_AUDIT_ACTIONS.BLOG_POST_CREATED,
          entityType: 'blog_post',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { slug: created.slug, title: created.title, products: created.productIds.length },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return this.findById(post.id);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppException.conflict(`A post with the slug "${input.slug}" already exists.`);
      }
      throw error;
    }
  }

  /**
   * Edits a post.
   *
   * A live post's edits go to the draft columns, so saving a half-finished
   * paragraph does not change what readers are reading — the same separation
   * CMS pages use.
   *
   * Any edit to the body, the title or the product list **clears an existing
   * compliance approval**, because the approval was of a specific text. That is
   * the whole reason approvals are attached to a snapshot rather than to a row.
   */
  async update(id: string, input: UpdateBlogPostInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    const existing = await this.requirePost(id);

    const live = existing.status === 'PUBLISHED';

    await this.prisma.$transaction(async (tx) => {
      // A slug change on a live post leaves an indexed URL behind. Writing the
      // redirect here rather than asking the editor to remember is the point of
      // having redirects at all.
      if (input.slug && input.slug !== existing.slug && live) {
        await this.redirects.recordSlugChange(tx, `/blog/${existing.slug}`, `/blog/${input.slug}`, {
          reason: 'blog_post',
          actor,
        });
      }

      await tx.blogPost.update({
        where: { id },
        data: {
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.heroMediaId !== undefined ? { heroMediaId: input.heroMediaId } : {}),
          ...(input.heroAltText !== undefined ? { heroAltText: input.heroAltText } : {}),
          ...(input.productIds !== undefined ? { productIds: input.productIds } : {}),

          // Live posts write to the draft columns; drafts write straight
          // through, because there is nothing to protect.
          ...(live
            ? {
                ...(input.title !== undefined ? { draftTitle: input.title } : {}),
                ...(input.excerpt !== undefined ? { draftExcerpt: input.excerpt } : {}),
                ...(input.blocks !== undefined
                  ? { draftBlocks: input.blocks as Prisma.InputJsonValue }
                  : {}),
              }
            : {
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
                ...(input.blocks !== undefined
                  ? { blocks: input.blocks as Prisma.InputJsonValue }
                  : {}),
              }),

          // The approval record is NOT cleared by an edit, and that is
          // deliberate. It records which text a named person approved, and
          // editing does not change what they read. What it changes is whether
          // the *new* text matches — and that is decided by comparing the
          // approved content hash, in the database, at the moment of
          // publishing. A live post therefore keeps serving its approved text
          // while an unapproved edit waits in the draft, and publishing that
          // edit needs a fresh review.
          lastEditedBy: actor.actorId,
        },
      });

      await this.audit.recordIn(tx, {
        action: GROWTH_AUDIT_ACTIONS.BLOG_POST_UPDATED,
        entityType: 'blog_post',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { approvedAt: existing.complianceApprovedAt?.toISOString() ?? null },
        after: { slug: input.slug ?? existing.slug, editedLiveAsDraft: live },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  /**
   * Sends a post to compliance.
   *
   * Only meaningful for a post that names a product. One that names none has
   * nothing for compliance to rule on, and sending it would train reviewers to
   * approve things without reading them.
   */
  async submitForReview(id: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    const post = await this.requirePost(id);

    if (post.productIds.length === 0) {
      throw AppException.preconditionFailed(
        'This post references no products, so it needs no compliance review. Publish it directly.',
      );
    }
    if (post.status === 'PUBLISHED') {
      throw AppException.conflict('This post is already published.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.blogPost.update({ where: { id }, data: { status: 'IN_REVIEW' } });
      await this.audit.recordIn(tx, {
        action: GROWTH_AUDIT_ACTIONS.BLOG_POST_SUBMITTED,
        entityType: 'blog_post',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { products: post.productIds.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  /**
   * A compliance decision.
   *
   * The reviewed text is snapshotted into the decision, so "what did they
   * actually approve?" is answerable after the post has been edited fifty
   * times. The decision row is append-only — a database trigger refuses
   * `UPDATE` and `DELETE` on it regardless of what the application asks.
   */
  async review(id: string, input: ReviewBlogPostInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    const post = await this.requirePost(id);

    if (post.productIds.length === 0) {
      throw AppException.preconditionFailed(
        'This post references no products. There is nothing here for compliance to decide.',
      );
    }

    const now = this.clock.now();
    const approved = input.decision === 'APPROVED';

    // What the reviewer is ruling on: the draft when there is one, otherwise
    // the live text. Approving the live text while a draft sits unreviewed
    // would be approving the wrong thing.
    const reviewedTitle = post.draftTitle ?? post.title;
    const reviewedBlocks = (post.draftBlocks ?? post.blocks) as Prisma.InputJsonValue;

    await this.prisma.$transaction(async (tx) => {
      await tx.blogPostReview.create({
        data: {
          postId: id,
          decision: input.decision,
          notes: input.notes,
          reviewedTitle,
          reviewedBlocks,
          reviewedProductIds: post.productIds,
          reviewerId: actor.actorId,
          reviewerLabel: actor.actorLabel,
          decidedAt: now,
        },
      });

      if (approved) {
        await tx.blogPost.update({
          where: { id },
          data: {
            complianceApprovedAt: now,
            complianceApprovedById: actor.actorId,
            complianceApprovedByLabel: actor.actorLabel,
            complianceNotes: input.notes,
          },
        });

        // The hash is computed by the database, over the text that will
        // actually go live — the draft when there is one. Computing it here in
        // TypeScript would risk disagreeing with the CHECK that recomputes it
        // at publication over JSON key order or whitespace; letting Postgres
        // do both ends makes them the same expression by construction.
        await tx.$executeRaw`
          UPDATE blog_posts
             SET compliance_approved_content_hash = blog_post_content_hash(
                   coalesce(draft_title, title),
                   coalesce(draft_blocks, blocks),
                   product_ids
                 )
           WHERE id = ${id}::uuid
        `;
      } else {
        await tx.blogPost.update({
          where: { id },
          data: {
            status: 'DRAFT',
            complianceApprovedAt: null,
            complianceApprovedById: null,
            complianceApprovedByLabel: null,
            complianceApprovedContentHash: null,
            complianceNotes: null,
          },
        });
      }

      await this.audit.recordIn(tx, {
        action: approved
          ? GROWTH_AUDIT_ACTIONS.BLOG_POST_APPROVED
          : GROWTH_AUDIT_ACTIONS.BLOG_POST_REJECTED,
        entityType: 'blog_post',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        after: { decision: input.decision, products: post.productIds.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  /**
   * Publishes.
   *
   * The gate, stated once and enforced twice. A post naming a product needs a
   * live compliance approval; the check here produces a readable refusal, and
   * the database CHECK behind it makes the rule true regardless of the code
   * path.
   */
  async publish(id: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    const post = await this.requirePost(id);

    if (post.productIds.length > 0) {
      if (post.complianceApprovedAt === null) {
        throw AppException.preconditionFailed(
          'This post references a product, so it needs compliance approval before it can be published.',
        );
      }

      // An approval is of a specific text. Asking the database whether the text
      // about to be published is the text that was approved means the answer
      // comes from the same expression the CHECK will apply, rather than from a
      // second implementation that could drift from it.
      const [match] = await this.prisma.$queryRaw<Array<{ matches: boolean }>>`
        SELECT compliance_approved_content_hash = blog_post_content_hash(
                 coalesce(draft_title, title),
                 coalesce(draft_blocks, blocks),
                 product_ids
               ) AS matches
          FROM blog_posts
         WHERE id = ${id}::uuid
      `;

      if (match?.matches !== true) {
        throw AppException.preconditionFailed(
          'This post has changed since it was approved. Send it back to compliance before publishing.',
        );
      }
    }

    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.blogPost.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          // Promote the draft: what was reviewed is what goes live.
          ...(post.draftTitle !== null ? { title: post.draftTitle } : {}),
          ...(post.draftExcerpt !== null ? { excerpt: post.draftExcerpt } : {}),
          ...(post.draftBlocks !== null
            ? { blocks: post.draftBlocks as Prisma.InputJsonValue }
            : {}),
          draftTitle: null,
          draftExcerpt: null,
          draftBlocks: Prisma.DbNull,
          publishedAt: post.publishedAt ?? now,
          publishedBy: actor.actorId,
        },
      });

      await this.audit.recordIn(tx, {
        action: GROWTH_AUDIT_ACTIONS.BLOG_POST_PUBLISHED,
        entityType: 'blog_post',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: {
          slug: post.slug,
          products: post.productIds.length,
          complianceApprovedBy: post.complianceApprovedByLabel,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  async unpublish(id: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    await this.requirePost(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.blogPost.update({ where: { id }, data: { status: 'ARCHIVED' } });
      await this.audit.recordIn(tx, {
        action: GROWTH_AUDIT_ACTIONS.BLOG_POST_UNPUBLISHED,
        entityType: 'blog_post',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  // -------------------------------------------------------------------------
  // Staff reads
  // -------------------------------------------------------------------------

  async list(query: BlogQuery) {
    const rows = await this.prisma.blogPost.findMany({
      where: {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.search
          ? { title: { contains: query.search, mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: query.limit + 1,
      include: { category: { select: { slug: true, name: true } } },
    });

    return {
      data: rows.slice(0, query.limit).map((post) => this.toStaffSummary(post)),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async findById(id: string) {
    const post = await this.prisma.blogPost.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: { select: { id: true, slug: true, name: true } },
        heroMedia: { select: { id: true, storageKey: true, width: true, height: true } },
        reviews: { orderBy: { decidedAt: 'desc' }, take: 50 },
      },
    });
    if (!post) throw AppException.notFound('Post');

    const products =
      post.productIds.length === 0
        ? []
        : await this.prisma.product.findMany({
            where: { id: { in: post.productIds } },
            select: { id: true, slug: true, name: true, sku: true, status: true },
          });

    // Asked of the database, with the same expression the publish CHECK uses,
    // so the screen and the endpoint cannot disagree about whether this post
    // is ready to go live.
    const [match] = await this.prisma.$queryRaw<Array<{ matches: boolean | null }>>`
      SELECT compliance_approved_content_hash = blog_post_content_hash(
               coalesce(draft_title, title),
               coalesce(draft_blocks, blocks),
               product_ids
             ) AS matches
        FROM blog_posts
       WHERE id = ${id}::uuid
    `;
    const approvalMatchesCurrentText = match?.matches === true;

    return {
      ...this.toStaffSummary(post),
      /**
       * Whether publishing would succeed right now.
       *
       * A post with no products needs no approval. One with products needs an
       * approval *of the text it currently holds* — an approval that has been
       * overtaken by an edit does not count.
       */
      publishable: post.productIds.length === 0 || approvalMatchesCurrentText,
      approvalMatchesCurrentText,
      blocks: post.blocks,
      draft:
        post.draftBlocks !== null || post.draftTitle !== null
          ? {
              title: post.draftTitle ?? post.title,
              excerpt: post.draftExcerpt ?? post.excerpt,
              blocks: post.draftBlocks ?? post.blocks,
            }
          : null,
      products,
      heroMedia: post.heroMedia
        ? {
            id: post.heroMedia.id,
            url: this.media.publicUrl(post.heroMedia.storageKey),
            altText: post.heroAltText ?? '',
          }
        : null,
      reviews: post.reviews,
      /**
       * Wording worth a second pair of eyes, surfaced for the reviewer.
       *
       * The same advisory prompt reviews use, and advisory in exactly the same
       * way: nothing branches on it, nothing is blocked by it, and a post with
       * no matches is not thereby approved. It puts a banner on the screen of
       * the person who is going to read the text anyway.
       */
      claimPromptTerms: healthClaimPromptTerms(
        [post.draftTitle ?? post.title, blockText(post.draftBlocks ?? post.blocks)].join(' '),
      ),
    };
  }

  async listCategories() {
    return this.prisma.blogCategory.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }] });
  }

  async createCategory(input: CreateBlogCategoryInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.blogCategory.create({
          data: {
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            position: input.position,
          },
        });

        await this.audit.recordIn(tx, {
          action: GROWTH_AUDIT_ACTIONS.BLOG_CATEGORY_CREATED,
          entityType: 'blog_category',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { slug: created.slug, name: created.name },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppException.conflict(`A category with the slug "${input.slug}" already exists.`);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------

  private async requirePost(id: string) {
    const post = await this.prisma.blogPost.findFirst({ where: { id, deletedAt: null } });
    if (!post) throw AppException.notFound('Post');
    return post;
  }

  private toPublicSummary(post: {
    id: string;
    slug: string;
    title: string;
    excerpt: string | null;
    publishedAt: Date | null;
    authorName: string;
    category?: { slug: string; name: string } | null;
    heroAltText?: string | null;
    heroMedia?: { storageKey: string; width: number | null; height: number | null } | null;
  }) {
    return {
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      publishedAt: post.publishedAt,
      // The author is shown. An article about a health product with nobody's
      // name on it is the kind of thing nobody stands behind.
      author: post.authorName,
      category: post.category ?? null,
      heroImage: post.heroMedia
        ? {
            url: this.media.publicUrl(post.heroMedia.storageKey),
            // Alt text belongs to this use of the image, not to the file.
            altText: post.heroAltText ?? '',
            width: post.heroMedia.width,
            height: post.heroMedia.height,
          }
        : null,
    };
  }

  private toStaffSummary(post: {
    id: string;
    slug: string;
    title: string;
    excerpt: string | null;
    status: string;
    productIds: string[];
    authorName: string;
    complianceApprovedAt: Date | null;
    complianceApprovedByLabel: string | null;
    complianceApprovedContentHash: string | null;
    complianceNotes: string | null;
    draftBlocks: unknown;
    draftTitle: string | null;
    publishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    category?: { slug: string; name: string } | null;
  }) {
    const needsCompliance = post.productIds.length > 0;

    return {
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt,
      status: post.status,
      author: post.authorName,
      category: post.category ?? null,
      productIds: post.productIds,
      /** Whether this post is the kind that needs compliance sign-off at all. */
      needsCompliance,
      complianceApprovedAt: post.complianceApprovedAt,
      complianceApprovedBy: post.complianceApprovedByLabel,
      complianceNotes: post.complianceNotes,
      /**
       * Whether an approval exists at all.
       *
       * Not the same as "can be published": an approval is of a specific text,
       * and the text may have moved since. `findById` answers that question
       * accurately with `publishable`; a list is not the place to run a hash
       * comparison per row, and claiming one here would be a screen promising
       * something the publish endpoint then refuses.
       */
      hasComplianceApproval: post.complianceApprovedAt !== null,
      hasUnpublishedChanges: post.draftBlocks !== null || post.draftTitle !== null,
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    };
  }
}

/**
 * The readable text inside a block array.
 *
 * Used only to feed the advisory claim prompt. Best-effort by design: missing a
 * phrase here costs a banner, not a decision, because the reviewer reads the
 * post regardless.
 */
function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };

  walk(blocks);
  return parts.join(' ');
}
