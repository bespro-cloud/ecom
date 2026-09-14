import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import {
  EVIDENCE_REQUIRED_CLAIM_TYPES,
  SUBSTANTIATING_RELEVANCE,
  canTransitionClaim,
  type ClaimStatus,
  type ClaimType,
} from '@health/types';
import { expireLapsedClaims } from '@health/database';
import type {
  ClaimDecisionInput,
  ClaimQuery,
  CreateClaimInput,
  ReviseClaimInput,
  SubmitClaimInput,
  WithdrawClaimInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { COMPLIANCE_AUDIT_ACTIONS } from '../compliance.audit.js';

/**
 * Product claims.
 *
 * A claim is a specific statement made about a product — "supports healthy
 * sleep" — and this service governs how one comes to be shown to a customer.
 *
 * Four properties do the work, and all four are structural rather than
 * procedural:
 *
 * **1. A claim exists because a person wrote it.** Nothing here reads marketing
 * copy and decides it contains a claim. That inference is exactly the kind of
 * judgement about regulated speech that software must not make on its own, and
 * a system that made it would be wrong in the direction nobody notices — the
 * claim it failed to spot is the one that goes out unreviewed. What the gate
 * can honestly enforce is that every claim *someone recorded* has been
 * reviewed, and the checklist says so in those words.
 *
 * **2. Approved wording is never edited.** Revising a claim writes a new
 * version; the approved version stays byte-for-byte as it was signed off,
 * enforced by an append-only trigger. The listing renders the approved version,
 * not the current one, so an edit in progress cannot leak onto a live page.
 *
 * **3. Approval is a named person with a second factor.** `CLAIM_APPROVE` is
 * held by the compliance reviewer role and deliberately not by `ADMIN` or
 * `PRODUCT_MANAGER`: the people who run the store and write the copy are not
 * the people who sign off whether it is lawful.
 *
 * **4. Approvals lapse.** A claim approved against evidence that has since been
 * superseded should not stay live because nobody revisited it.
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(ClaimsService.name);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(query: ClaimQuery) {
    const now = this.clock.now();
    const rows = await this.prisma.productClaim.findMany({
      where: {
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.status ? { status: query.status as ClaimStatus } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.dueWithinDays !== undefined
          ? {
              status: 'APPROVED' as const,
              reviewDueAt: { lte: addSeconds(now, query.dueWithinDays * 24 * 60 * 60) },
            }
          : {}),
      },
      orderBy: [{ productId: 'asc' }, { position: 'asc' }],
      take: query.limit + 1,
      include: {
        product: { select: { id: true, sku: true, name: true, status: true } },
        currentVersion: true,
        approvedVersion: true,
        _count: { select: { evidenceLinks: true } },
      },
    });

    return {
      data: rows.slice(0, query.limit).map((row) => toClaimSummary(row, now)),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  /** One claim with everything a reviewer needs: versions, evidence, decisions. */
  async findById(claimId: string) {
    const claim = await this.prisma.productClaim.findUnique({
      where: { id: claimId },
      include: {
        product: { select: { id: true, sku: true, name: true, type: true, status: true } },
        currentVersion: true,
        approvedVersion: true,
        versions: { orderBy: { version: 'desc' } },
        reviews: { orderBy: { decidedAt: 'desc' } },
        evidenceLinks: { include: { evidence: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!claim) throw AppException.notFound('Claim');

    return {
      ...toClaimSummary(claim, this.clock.now()),
      product: claim.product,
      versions: claim.versions,
      reviews: claim.reviews,
      evidence: claim.evidenceLinks.map((link) => ({
        linkId: link.id,
        relevance: link.relevance,
        notes: link.notes,
        linkedByLabel: link.linkedByLabel,
        linkedAt: link.createdAt,
        ...link.evidence,
      })),
      substantiation: this.assessSubstantiation(
        claim.type as ClaimType,
        claim.evidenceLinks.map((link) => ({
          relevance: link.relevance,
          status: link.evidence.status,
        })),
      ),
    };
  }

  /** The approved claims a public listing may show. Nothing else, ever. */
  async publishedFor(productId: string) {
    const claims = await this.prisma.productClaim.findMany({
      where: { productId, status: 'APPROVED' },
      orderBy: { position: 'asc' },
      include: { approvedVersion: true },
    });

    return claims
      .filter((claim) => claim.approvedVersion !== null)
      .map((claim) => ({
        id: claim.id,
        type: claim.type,
        // The approved version, not the current one. A revision in progress
        // must never appear on a live page.
        text: claim.approvedVersion!.text,
        approvedAt: claim.approvedAt,
      }));
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(productId: string, input: CreateClaimInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw AppException.notFound('Product');

    const claim = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productClaim.create({
        data: {
          productId,
          type: input.type,
          // A new claim starts needing evidence when its category requires it,
          // so the next step is obvious rather than something to remember.
          status: EVIDENCE_REQUIRED_CLAIM_TYPES.includes(input.type)
            ? 'EVIDENCE_REQUIRED'
            : 'DRAFT',
          position: input.position ?? 0,
        },
      });

      const version = await tx.productClaimVersion.create({
        data: {
          claimId: created.id,
          version: 1,
          text: input.text,
          context: input.context ?? null,
          authorId: actor.actorId,
          authorLabel: actor.actorLabel,
        },
      });

      const withVersion = await tx.productClaim.update({
        where: { id: created.id },
        data: { currentVersionId: version.id },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.CLAIM_CREATED,
        entityType: 'claim',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { productId, type: input.type, text: input.text },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return withVersion;
    });

    return this.findById(claim.id);
  }

  /**
   * Records a new wording.
   *
   * Never touches the approved version. If the claim was approved, revising it
   * moves it back into review — the approval belonged to the previous words,
   * and carrying it forward would mean a reviewer's signature applied to text
   * they never read. Until the new version is approved the listing keeps
   * showing the old, approved one.
   */
  async revise(claimId: string, input: ReviseClaimInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const claim = await this.prisma.productClaim.findUnique({
      where: { id: claimId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!claim) throw AppException.notFound('Claim');

    if (claim.status === 'REJECTED' || claim.status === 'WITHDRAWN') {
      throw AppException.conflict(
        `A ${claim.status.toLowerCase()} claim cannot be revised. Create a new claim instead.`,
      );
    }

    const nextVersion = (claim.versions[0]?.version ?? 0) + 1;

    await this.prisma.$transaction(async (tx) => {
      const version = await tx.productClaimVersion.create({
        data: {
          claimId,
          version: nextVersion,
          text: input.text,
          context: input.context ?? null,
          changeReason: input.changeReason,
          authorId: actor.actorId,
          authorLabel: actor.actorLabel,
        },
      });

      await tx.productClaim.update({
        where: { id: claimId },
        data: {
          currentVersionId: version.id,
          // The approved version pointer is deliberately left alone.
          status: EVIDENCE_REQUIRED_CLAIM_TYPES.includes(claim.type as ClaimType)
            ? 'EVIDENCE_REQUIRED'
            : 'DRAFT',
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.CLAIM_REVISED,
        entityType: 'claim',
        entityId: claimId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.changeReason,
        before: { version: claim.versions[0]?.version ?? null, status: claim.status },
        after: { version: nextVersion, text: input.text },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(claimId);
  }

  /**
   * Sends a claim for review.
   *
   * Refuses a claim whose category requires substantiation and has none. That
   * refusal is not bureaucracy: putting an unsupported claim in front of a
   * reviewer invites an approval based on the reviewer assuming the evidence
   * exists somewhere.
   */
  async submit(claimId: string, _input: SubmitClaimInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const claim = await this.prisma.productClaim.findUnique({
      where: { id: claimId },
      include: { evidenceLinks: { include: { evidence: true } } },
    });
    if (!claim) throw AppException.notFound('Claim');

    this.assertTransition(claim.status as ClaimStatus, 'UNDER_REVIEW');

    const substantiation = this.assessSubstantiation(
      claim.type as ClaimType,
      claim.evidenceLinks.map((link) => ({
        relevance: link.relevance,
        status: link.evidence.status,
      })),
    );
    if (!substantiation.sufficient) {
      throw AppException.preconditionFailed(substantiation.detail);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.productClaim.update({ where: { id: claimId }, data: { status: 'UNDER_REVIEW' } });
      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.CLAIM_SUBMITTED,
        entityType: 'claim',
        entityId: claimId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { status: claim.status },
        after: { status: 'UNDER_REVIEW', evidenceCount: claim.evidenceLinks.length },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(claimId);
  }

  /**
   * A reviewer's decision.
   *
   * The decision names the version it applies to, and is refused if the wording
   * moved underneath — the same problem the checkout pricing fingerprint
   * solves, with worse consequences. An approval that silently attached to a
   * later edit would be a signature on text the signatory never saw.
   *
   * A disease claim is refused on category alone. No amount of evidence makes
   * one lawful on a supplement listing, and the refusal is recorded rather than
   * left to a reviewer's memory of which categories are permitted.
   */
  async decide(claimId: string, input: ClaimDecisionInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const claim = await this.prisma.productClaim.findUnique({
      where: { id: claimId },
      include: {
        evidenceLinks: { include: { evidence: true } },
        product: { select: { id: true, status: true } },
      },
    });
    if (!claim) throw AppException.notFound('Claim');

    if (claim.currentVersionId !== input.versionId) {
      throw AppException.conflict(
        'The claim was edited after this review was opened. Re-read the current wording before deciding.',
      );
    }

    const target: ClaimStatus =
      input.decision === 'APPROVED'
        ? 'APPROVED'
        : input.decision === 'REJECTED'
          ? 'REJECTED'
          : 'EVIDENCE_REQUIRED';
    this.assertTransition(claim.status as ClaimStatus, target);

    if (input.decision === 'APPROVED') {
      if (claim.type === 'DISEASE') {
        throw AppException.preconditionFailed(
          'A disease claim cannot be approved for a supplement listing. Rejecting it is the only available outcome.',
        );
      }

      const substantiation = this.assessSubstantiation(
        claim.type as ClaimType,
        claim.evidenceLinks.map((link) => ({
          relevance: link.relevance,
          status: link.evidence.status,
        })),
      );
      if (!substantiation.sufficient) {
        throw AppException.preconditionFailed(substantiation.detail);
      }
    }

    const now = this.clock.now();
    const intervalDays =
      (await this.settings.get<number>('compliance.claims_review_interval_days')) ?? 365;
    const reviewDueAt =
      input.decision === 'APPROVED' ? addSeconds(now, intervalDays * 24 * 60 * 60) : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.claimReview.create({
        data: {
          claimId,
          versionId: input.versionId,
          decision: input.decision,
          notes: input.notes,
          reviewerId: actor.actorId,
          reviewerLabel: actor.actorLabel,
          decidedAt: now,
          reviewDueAt,
          // What the reviewer had in front of them. Without it, "what was this
          // approved on?" has no answer once the evidence file grows.
          evidenceSnapshot: claim.evidenceLinks.map((link) => ({
            evidenceId: link.evidenceId,
            title: link.evidence.title,
            citation: link.evidence.citation,
            sourceType: link.evidence.sourceType,
            status: link.evidence.status,
            relevance: link.relevance,
          })),
        },
      });

      await tx.productClaim.update({
        where: { id: claimId },
        data: {
          status: target,
          ...(input.decision === 'APPROVED'
            ? {
                approvedVersionId: input.versionId,
                approvedAt: now,
                reviewDueAt,
              }
            : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action:
          input.decision === 'APPROVED'
            ? COMPLIANCE_AUDIT_ACTIONS.CLAIM_APPROVED
            : input.decision === 'REJECTED'
              ? COMPLIANCE_AUDIT_ACTIONS.CLAIM_REJECTED
              : COMPLIANCE_AUDIT_ACTIONS.CLAIM_CHANGES_REQUESTED,
        entityType: 'claim',
        entityId: claimId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        before: { status: claim.status },
        after: {
          status: target,
          versionId: input.versionId,
          reviewDueAt: reviewDueAt?.toISOString() ?? null,
          evidenceCount: claim.evidenceLinks.length,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.logger.info(
      { claimId, decision: input.decision, reviewerId: actor.actorId },
      'claim decision recorded',
    );

    return this.findById(claimId);
  }

  /** Takes a claim off the listing. Distinct from rejection, which is an outcome. */
  async withdraw(claimId: string, input: WithdrawClaimInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const claim = await this.prisma.productClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw AppException.notFound('Claim');
    this.assertTransition(claim.status as ClaimStatus, 'WITHDRAWN');

    await this.prisma.$transaction(async (tx) => {
      await tx.productClaim.update({
        where: { id: claimId },
        data: { status: 'WITHDRAWN', withdrawnAt: this.clock.now() },
      });
      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.CLAIM_WITHDRAWN,
        entityType: 'claim',
        entityId: claimId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        before: { status: claim.status },
        after: { status: 'WITHDRAWN' },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(claimId);
  }

  /**
   * Expires approvals whose interval has elapsed.
   *
   * Run on a schedule. An expired claim stops being publishable immediately —
   * the listing loses the claim rather than the whole product, because pulling
   * a page down for a lapsed sentence is a bigger customer impact than the risk
   * the lapse represents. The publishing gate separately refuses to *re*-publish
   * a listing carrying one.
   */
  async expireLapsed(limit = 500): Promise<number> {
    const expired = await expireLapsedClaims(
      {
        prisma: this.prisma,
        now: () => this.clock.now(),
        onError: (error, context) =>
          this.logger.warn({ err: error, ...context }, 'failed to expire a claim approval'),
      },
      limit,
    );

    if (expired > 0) this.logger.warn({ expired }, 'claim approvals expired');
    return expired;
  }

  // -------------------------------------------------------------------------

  /**
   * Whether the evidence attached to a claim can support approving it.
   *
   * Deliberately a count of *accepted, substantiating* links rather than a
   * score. There is no weighting, no confidence figure and no threshold beyond
   * "at least one", because anything more would be the software forming a view
   * on whether a study supports a claim — which is the reviewer's judgement and
   * the entire substance of their job.
   */
  private assessSubstantiation(
    type: ClaimType,
    links: Array<{ relevance: string; status: string }>,
  ): { sufficient: boolean; detail: string; accepted: number; contradictory: number } {
    const accepted = links.filter(
      (link) =>
        link.status === 'ACCEPTED' && SUBSTANTIATING_RELEVANCE.includes(link.relevance as never),
    ).length;
    const contradictory = links.filter((link) => link.relevance === 'CONTRADICTORY').length;

    if (!EVIDENCE_REQUIRED_CLAIM_TYPES.includes(type)) {
      return {
        sufficient: true,
        detail: 'This claim type is not substantiated by study evidence.',
        accepted,
        contradictory,
      };
    }

    if (accepted === 0) {
      return {
        sufficient: false,
        detail:
          'This claim needs at least one accepted piece of evidence marked as direct or indirect support. Attach and review the evidence first.',
        accepted,
        contradictory,
      };
    }

    return {
      sufficient: true,
      detail: `${accepted} accepted source(s) support this claim.`,
      accepted,
      contradictory,
    };
  }

  private assertTransition(from: ClaimStatus, to: ClaimStatus): void {
    if (!canTransitionClaim(from, to)) {
      throw AppException.conflict(
        `A claim cannot move from ${from.toLowerCase().replace(/_/g, ' ')} to ${to
          .toLowerCase()
          .replace(/_/g, ' ')}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

interface ClaimRow {
  id: string;
  productId: string;
  type: string;
  status: string;
  position: number;
  approvedAt: Date | null;
  reviewDueAt: Date | null;
  withdrawnAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  currentVersion: { id: string; version: number; text: string; context: string | null } | null;
  approvedVersion: { id: string; version: number; text: string } | null;
  _count?: { evidenceLinks: number };
}

function toClaimSummary(claim: ClaimRow, now: Date) {
  return {
    id: claim.id,
    productId: claim.productId,
    type: claim.type,
    status: claim.status,
    position: claim.position,
    currentText: claim.currentVersion?.text ?? null,
    currentVersionId: claim.currentVersion?.id ?? null,
    currentVersionNumber: claim.currentVersion?.version ?? null,
    /** What a customer would see. Null unless a reviewer approved wording. */
    approvedText: claim.approvedVersion?.text ?? null,
    approvedVersionNumber: claim.approvedVersion?.version ?? null,
    /**
     * True when the current wording differs from what was approved — the state
     * in which a listing is showing older text than the admin screen does.
     */
    hasUnapprovedChanges:
      claim.approvedVersion !== null &&
      claim.currentVersion !== null &&
      claim.approvedVersion.id !== claim.currentVersion.id,
    approvedAt: claim.approvedAt,
    reviewDueAt: claim.reviewDueAt,
    reviewOverdue:
      claim.status === 'APPROVED' && claim.reviewDueAt !== null && claim.reviewDueAt <= now,
    evidenceCount: claim._count?.evidenceLinks ?? 0,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}
