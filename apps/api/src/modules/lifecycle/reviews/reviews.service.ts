import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { isUniqueConstraintError } from '@health/database';
import {
  adverseEventPromptTerms,
  canTransitionReview,
  healthClaimPromptTerms,
  type ReviewStatus,
} from '@health/types';
import type { CreateReviewInput, ModerateReviewInput, ReviewQuery } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { LIFECYCLE_AUDIT_ACTIONS } from '../lifecycle.audit.js';

/**
 * Product reviews.
 *
 * A review is customer-written text about a regulated product, which makes it
 * the same regulatory object as marketing copy however it got there. "This
 * cured my insomnia" on a supplement listing is an unapproved disease claim,
 * and a regulator does not care that a customer typed it.
 *
 * So three things hold:
 *
 * **Nothing publishes itself.** There is no timer, no score, no default and no
 * "auto-approve five stars". The only route to visibility is a person deciding,
 * and the state machine has no edge that bypasses one.
 *
 * **The system prompts, it never judges.** Wording that often signals a health
 * claim puts a banner on the moderation screen. It does not reject, does not
 * publish, and does not change the review's state. A word list cannot tell
 * whether "it cured my headache" is a disease claim in context, and code that
 * acted on one would be making a regulatory decision by substring match.
 *
 * **Verified purchase is derived, never asserted.** The badge comes from an
 * order line belonging to the reviewer, looked up here. There is no field on
 * the request that sets it.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(ReviewsService.name);
  }

  // -------------------------------------------------------------------------
  // Public reads
  // -------------------------------------------------------------------------

  /**
   * The reviews a listing may show, and the rating summary over them.
   *
   * The status filter is in the query rather than in a `.filter()` afterwards,
   * so a later refactor cannot drop it, and the aggregate is computed over the
   * same set — a rating averaged over unmoderated reviews would let rejected
   * text influence the number on the page even while its words stayed hidden.
   */
  async publishedFor(productId: string, limit = 20) {
    const [reviews, grouped] = await Promise.all([
      this.prisma.productReview.findMany({
        where: { productId, status: 'PUBLISHED' },
        orderBy: [{ createdAt: 'desc' }],
        take: limit,
        select: {
          id: true,
          rating: true,
          title: true,
          body: true,
          authorDisplayName: true,
          verifiedPurchase: true,
          publishedAt: true,
        },
      }),
      this.prisma.productReview.groupBy({
        by: ['rating'],
        where: { productId, status: 'PUBLISHED' },
        _count: { rating: true },
      }),
    ]);

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let total = 0;
    let sum = 0;
    for (const row of grouped) {
      distribution[row.rating] = row._count.rating;
      total += row._count.rating;
      sum += row.rating * row._count.rating;
    }

    return {
      reviews,
      summary: {
        count: total,
        // Null rather than zero: "no reviews yet" and "averages zero stars" are
        // different things, and zero is not even a rating anyone can give.
        average: total === 0 ? null : Math.round((sum / total) * 10) / 10,
        distribution,
      },
    };
  }

  /**
   * The same thing, for a listing the storefront knows only by slug.
   *
   * The product lookup repeats the catalogue's own visibility rule — published,
   * not deleted — so this route cannot become a way to read the reviews of a
   * draft or withdrawn listing by guessing its slug. An unknown or unpublished
   * slug returns an empty summary rather than a 404, because whether a slug
   * exists in the catalogue is not something an unauthenticated caller needs
   * confirmed.
   */
  async publishedForSlug(slug: string, limit = 20) {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: 'PUBLISHED', deletedAt: null },
      select: { id: true },
    });
    if (!product) {
      return {
        reviews: [],
        summary: { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
      };
    }
    return this.publishedFor(product.id, limit);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Records a review. It is not visible, and saying so is part of the contract.
   *
   * The verified badge is settled here from the caller's own order lines. A
   * request naming somebody else's purchase does not produce a badge; it
   * produces a refusal.
   */
  async create(customerId: string, input: CreateReviewInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const product = await this.prisma.product.findFirst({
      where: { id: input.productId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!product) throw AppException.notFound('Product');

    let verifiedPurchase = false;
    if (input.orderItemId) {
      // Scoped by the caller's own customer id, so an order line belonging to
      // somebody else is simply not found. The product must match too: a badge
      // earned on one purchase must not vouch for a review of another product.
      const line = await this.prisma.orderItem.findFirst({
        where: {
          id: input.orderItemId,
          productId: input.productId,
          order: { customerId, status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] } },
        },
        select: { id: true },
      });
      if (!line) {
        throw AppException.preconditionFailed(
          'That purchase is not one of yours, or the order has not completed.',
        );
      }
      verifiedPurchase = true;
    }

    const text = `${input.title ?? ''} ${input.body}`;
    const claimTerms = healthClaimPromptTerms(text);
    const adverseTerms = adverseEventPromptTerms(text);

    try {
      const review = await this.prisma.$transaction(async (tx) => {
        const created = await tx.productReview.create({
          data: {
            productId: input.productId,
            customerId,
            orderItemId: input.orderItemId ?? null,
            rating: input.rating,
            title: input.title ?? null,
            body: input.body,
            authorDisplayName: input.authorDisplayName,
            // Always. There is no branch here that starts a review anywhere
            // else, and that is the point.
            status: 'PENDING',
            verifiedPurchase,
            claimPromptTerms: claimTerms,
            adverseEventPromptTerms: adverseTerms,
          },
        });

        await this.audit.recordIn(tx, {
          action: LIFECYCLE_AUDIT_ACTIONS.REVIEW_SUBMITTED,
          entityType: 'review',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: {
            productId: input.productId,
            rating: input.rating,
            verifiedPurchase,
            // Recorded so a later reader can see the banner the moderator saw.
            claimPromptTerms: claimTerms,
            adverseEventPromptTerms: adverseTerms,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      if (adverseTerms.length > 0) {
        // Logged at warn so it surfaces without waiting for someone to open the
        // moderation queue. A possible adverse event is a safety signal.
        this.logger.warn(
          { reviewId: review.id, productId: input.productId, terms: adverseTerms },
          'review may describe an adverse event',
        );
      }

      return this.toCustomerView(review);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppException.conflict('You have already reviewed this.');
      }
      throw error;
    }
  }

  /** A customer's own reviews, including the ones nobody has published. */
  async listForCustomer(customerId: string, limit = 50) {
    const reviews = await this.prisma.productReview.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { product: { select: { id: true, name: true, slug: true } } },
    });
    return reviews.map((review) => ({
      ...this.toCustomerView(review),
      product: review.product,
    }));
  }

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  async listForModeration(query: ReviewQuery) {
    const rows = await this.prisma.productReview.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.promptedOnly ? { NOT: { claimPromptTerms: { isEmpty: true } } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: query.limit + 1,
      include: {
        product: { select: { id: true, name: true, sku: true, type: true } },
        customer: { select: { id: true, reference: true } },
      },
    });

    return {
      data: rows.slice(0, query.limit).map((review) => ({
        id: review.id,
        productId: review.productId,
        product: review.product,
        customerReference: review.customer.reference,
        rating: review.rating,
        title: review.title,
        body: review.body,
        authorDisplayName: review.authorDisplayName,
        status: review.status,
        verifiedPurchase: review.verifiedPurchase,
        /**
         * Surfaced so the screen can put a banner at the top. Advisory: no code
         * anywhere branches on this to decide an outcome.
         */
        claimPromptTerms: review.claimPromptTerms,
        adverseEventPromptTerms: review.adverseEventPromptTerms,
        adverseEventFlaggedAt: review.adverseEventFlaggedAt,
        createdAt: review.createdAt,
        publishedAt: review.publishedAt,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async findById(reviewId: string) {
    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
      include: {
        product: { select: { id: true, name: true, sku: true, type: true } },
        customer: { select: { id: true, reference: true } },
        decisions: { orderBy: { decidedAt: 'desc' } },
      },
    });
    if (!review) throw AppException.notFound('Review');
    return review;
  }

  /**
   * A moderator's decision.
   *
   * Every outcome requires written reasoning, publication included. "Why is
   * this live?" is as worth answering as "why was this rejected?", and on a
   * health product it is the more important of the two.
   *
   * An adverse-event flag is recorded independently of the outcome, because a
   * customer describing harm is a safety signal whether or not their words go
   * on the site.
   */
  async moderate(reviewId: string, input: ModerateReviewInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const review = await this.prisma.productReview.findUnique({
      where: { id: reviewId },
      select: { id: true, status: true, productId: true, body: true, adverseEventFlaggedAt: true },
    });
    if (!review) throw AppException.notFound('Review');

    const from = review.status as ReviewStatus;
    const to = input.decision as ReviewStatus;
    if (!canTransitionReview(from, to)) {
      throw AppException.conflict(
        `A ${from.toLowerCase()} review cannot be ${to.toLowerCase().replace(/_/g, ' ')}.`,
      );
    }

    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.productReview.update({
        where: { id: reviewId },
        data: {
          status: to,
          publishedAt: to === 'PUBLISHED' ? now : null,
          ...(input.flagAdverseEvent && !review.adverseEventFlaggedAt
            ? { adverseEventFlaggedAt: now }
            : {}),
        },
      });

      await tx.reviewModeration.create({
        data: {
          reviewId,
          fromStatus: from,
          toStatus: to,
          reason: input.reason ?? null,
          notes: input.notes,
          moderatorId: actor.actorId,
          moderatorLabel: actor.actorLabel,
          decidedAt: now,
        },
      });

      await this.audit.recordIn(tx, {
        action:
          to === 'PUBLISHED'
            ? LIFECYCLE_AUDIT_ACTIONS.REVIEW_PUBLISHED
            : to === 'REJECTED'
              ? LIFECYCLE_AUDIT_ACTIONS.REVIEW_REJECTED
              : to === 'ESCALATED'
                ? LIFECYCLE_AUDIT_ACTIONS.REVIEW_ESCALATED
                : LIFECYCLE_AUDIT_ACTIONS.REVIEW_WITHDRAWN,
        entityType: 'review',
        entityId: reviewId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        before: { status: from },
        after: { status: to, productId: review.productId, reason: input.reason ?? null },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      if (input.flagAdverseEvent && !review.adverseEventFlaggedAt) {
        await this.audit.recordIn(tx, {
          action: LIFECYCLE_AUDIT_ACTIONS.REVIEW_ADVERSE_EVENT_FLAGGED,
          entityType: 'review',
          entityId: reviewId,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          reason: input.notes,
          after: { productId: review.productId },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });
      }
    });

    if (input.flagAdverseEvent) {
      this.logger.warn(
        { reviewId, productId: review.productId, moderatorId: actor.actorId },
        'review flagged as a possible adverse event',
      );
    }

    return this.findById(reviewId);
  }

  // -------------------------------------------------------------------------

  private toCustomerView(review: {
    id: string;
    productId: string;
    rating: number;
    title: string | null;
    body: string;
    authorDisplayName: string;
    status: string;
    verifiedPurchase: boolean;
    createdAt: Date;
    publishedAt: Date | null;
  }) {
    return {
      id: review.id,
      productId: review.productId,
      rating: review.rating,
      title: review.title,
      body: review.body,
      authorDisplayName: review.authorDisplayName,
      status: review.status,
      verifiedPurchase: review.verifiedPurchase,
      createdAt: review.createdAt,
      publishedAt: review.publishedAt,
      /**
       * Said plainly to the customer, because a review that silently never
       * appears reads as a bug — and on a regulated product the moderation is
       * not something to be coy about.
       */
      visibility:
        review.status === 'PUBLISHED'
          ? 'Published on the product page.'
          : review.status === 'PENDING'
            ? 'Waiting to be read by our team before it appears. We check every review.'
            : review.status === 'ESCALATED'
              ? 'Being checked by our compliance team before it appears.'
              : 'Not published.',
    };
  }
}
