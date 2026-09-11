import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import type { PublishReadiness } from '@health/types';
import type { ComplianceDecisionInput } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { CATALOGUE_AUDIT_ACTIONS } from '../catalogue/catalogue.audit.js';
import { SettingsService } from '../settings/settings.service.js';
import { PublishChecklistService } from '../catalogue/publishing/publish-checklist.service.js';
import type { ActorContext } from '../rbac/roles.service.js';

export interface ComplianceReviewView {
  id: string;
  productId: string;
  decision: string;
  notes: string;
  reviewerId: string;
  reviewerLabel: string;
  decidedAt: string;
  reviewDueAt: string | null;
  checklistSnapshot: unknown;
}

/**
 * Product compliance review.
 *
 * The narrow but load-bearing part of the compliance model that Phase 2
 * delivers: a named human with the `COMPLIANCE_APPROVE` permission records a
 * decision, with reasoning, and that decision is what the publishing gate
 * consults. Phase 4 attaches claims and evidence to the same record; the
 * decision itself does not change shape.
 *
 * Three properties make it worth anything:
 *
 *  - **Only a compliance reviewer can do it.** `ADMIN` deliberately lacks the
 *    permission. Someone administering the store cannot approve a health claim.
 *  - **The record is append-only**, enforced by a database trigger. A decision
 *    that could have been edited afterwards is not evidence of anything.
 *  - **The checklist is snapshotted** with the decision, so it is possible to
 *    say later what the reviewer was actually looking at.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly checklist: PublishChecklistService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(ComplianceService.name);
  }

  /** Everything a reviewer needs on one screen before deciding. */
  async reviewPacket(productId: string): Promise<{
    product: {
      id: string;
      sku: string;
      name: string;
      type: string;
      status: string;
      complianceStatus: string;
    };
    readiness: PublishReadiness;
    history: ComplianceReviewView[];
  }> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: {
        id: true,
        sku: true,
        name: true,
        type: true,
        status: true,
        complianceStatus: true,
      },
    });
    if (!product) throw AppException.notFound('Product');

    const [readiness, history] = await Promise.all([
      this.checklist.evaluate(productId),
      this.history(productId),
    ]);

    return { product, readiness, history };
  }

  async history(productId: string): Promise<ComplianceReviewView[]> {
    const reviews = await this.prisma.complianceReview.findMany({
      where: { productId },
      orderBy: { decidedAt: 'desc' },
      take: 100,
    });
    return reviews.map(toView);
  }

  /**
   * Records a decision.
   *
   * An approval is *not* a publication: it satisfies one check on the gate. A
   * product manager still has to publish, and the gate re-evaluates everything
   * at that moment — so an approval granted while the listing was missing a
   * label does not become a licence to publish once the label is still missing.
   */
  async decide(
    productId: string,
    input: ComplianceDecisionInput,
    actor: ActorContext,
  ): Promise<{ review: ComplianceReviewView; readiness: PublishReadiness }> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
    });
    if (!product) throw AppException.notFound('Product');

    const readiness = await this.checklist.evaluate(productId);
    const now = this.clock.now();

    // An approval lapses, so a listing reviewed against since-superseded
    // evidence does not stay live indefinitely.
    const intervalDays =
      (await this.settings.get<number>('compliance.claims_review_interval_days')) ?? 365;
    const reviewDueAt =
      input.decision === 'APPROVED' ? addSeconds(now, intervalDays * 24 * 60 * 60) : null;

    const review = await this.prisma.$transaction(async (tx) => {
      const created = await tx.complianceReview.create({
        data: {
          productId,
          decision: input.decision,
          notes: input.notes,
          reviewerId: actor.actorId,
          reviewerLabel: actor.actorLabel,
          decidedAt: now,
          reviewDueAt,
          // What the reviewer actually saw. Without this, a later question
          // about why something was approved has no answer.
          checklistSnapshot: {
            ready: readiness.ready,
            checks: readiness.checks.map((check) => ({
              key: check.key,
              state: check.state,
              detail: check.detail ?? null,
            })),
          },
        },
      });

      await tx.product.update({
        where: { id: productId },
        data: {
          complianceStatus:
            input.decision === 'APPROVED'
              ? 'APPROVED'
              : input.decision === 'REJECTED'
                ? 'REJECTED'
                : 'IN_REVIEW',
          complianceApprovedAt: input.decision === 'APPROVED' ? now : null,
          complianceApprovedBy: input.decision === 'APPROVED' ? actor.actorId : null,
          complianceReviewDueAt: reviewDueAt,
          // A rejection takes a live listing down immediately. Leaving it up
          // pending someone noticing would defeat the purpose of the rejection.
          ...(input.decision !== 'APPROVED' && product.status === 'PUBLISHED'
            ? { status: 'DRAFT', publishedAt: null }
            : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.COMPLIANCE_REVIEW_RECORDED,
        entityType: 'product',
        entityId: productId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        before: { complianceStatus: product.complianceStatus, status: product.status },
        after: {
          decision: input.decision,
          reviewDueAt: reviewDueAt?.toISOString() ?? null,
          checklistReady: readiness.ready,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    this.logger.info(
      { productId, decision: input.decision, reviewerId: actor.actorId },
      'compliance decision recorded',
    );

    return { review: toView(review), readiness: await this.checklist.evaluate(productId) };
  }

  /**
   * Listings whose approval has lapsed or is about to.
   *
   * Read by the admin console so an expiry is noticed before a customer is
   * looking at a listing nobody has reviewed for a year.
   */
  async expiringApprovals(
    withinDays: number,
  ): Promise<
    Array<{ id: string; sku: string; name: string; status: string; reviewDueAt: string }>
  > {
    const cutoff = addSeconds(this.clock.now(), withinDays * 24 * 60 * 60);
    const products = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        complianceStatus: 'APPROVED',
        complianceReviewDueAt: { lte: cutoff },
      },
      select: {
        id: true,
        sku: true,
        name: true,
        status: true,
        complianceReviewDueAt: true,
      },
      orderBy: { complianceReviewDueAt: 'asc' },
      take: 200,
    });

    return products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      status: product.status,
      reviewDueAt: product.complianceReviewDueAt!.toISOString(),
    }));
  }
}

function toView(review: {
  id: string;
  productId: string;
  decision: string;
  notes: string;
  reviewerId: string;
  reviewerLabel: string;
  decidedAt: Date;
  reviewDueAt: Date | null;
  checklistSnapshot: unknown;
}): ComplianceReviewView {
  return {
    id: review.id,
    productId: review.productId,
    decision: review.decision,
    notes: review.notes,
    reviewerId: review.reviewerId,
    reviewerLabel: review.reviewerLabel,
    decidedAt: review.decidedAt.toISOString(),
    reviewDueAt: review.reviewDueAt?.toISOString() ?? null,
    checklistSnapshot: review.checklistSnapshot,
  };
}
