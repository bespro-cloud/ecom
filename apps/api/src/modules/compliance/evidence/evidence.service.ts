import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { isUniqueConstraintError } from '@health/database';
import type {
  CreateEvidenceInput,
  EvidenceDecisionInput,
  EvidenceQuery,
  LinkEvidenceInput,
  UpdateEvidenceInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { COMPLIANCE_AUDIT_ACTIONS } from '../compliance.audit.js';

/**
 * Evidence.
 *
 * Every field on an evidence record is typed by a person who read the source.
 * Nothing is fetched from a DOI, nothing is summarised, and there is no route
 * that populates `outcome` or `limitations` from anything. That restraint is
 * the point: a system that generated the finding a health claim rests on would
 * be manufacturing substantiation, and it would do it in the most convincing
 * possible format.
 *
 * `limitations` is required with a real minimum length, in Zod and again as a
 * database CHECK. Evidence recorded without stated limitations is evidence
 * being oversold, and it is the field that gets left blank first.
 *
 * Evidence is a shared library rather than a child of one claim. A single trial
 * commonly supports several claims across several products; copying it per
 * claim means a correction has to be made in several places, which is how
 * substantiation files quietly go stale.
 */
@Injectable()
export class EvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(EvidenceService.name);
  }

  async list(query: EvidenceQuery) {
    const rows = await this.prisma.evidenceRecord.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        ...(query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: 'insensitive' as const } },
                { citation: { contains: query.search, mode: 'insensitive' as const } },
                { identifier: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      include: { _count: { select: { links: true } } },
    });

    return {
      data: rows.slice(0, query.limit).map((row) => ({
        ...row,
        claimCount: row._count.links,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async findById(evidenceId: string) {
    const evidence = await this.prisma.evidenceRecord.findUnique({
      where: { id: evidenceId },
      include: {
        media: { select: { id: true, originalFilename: true, mimeType: true } },
        links: {
          include: {
            claim: {
              select: {
                id: true,
                type: true,
                status: true,
                productId: true,
                product: { select: { id: true, name: true, sku: true } },
                approvedVersion: { select: { text: true } },
                currentVersion: { select: { text: true } },
              },
            },
          },
        },
      },
    });
    if (!evidence) throw AppException.notFound('Evidence');
    return evidence;
  }

  async create(input: CreateEvidenceInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const evidence = await this.prisma.$transaction(async (tx) => {
      const created = await tx.evidenceRecord.create({
        data: {
          sourceType: input.sourceType,
          title: input.title,
          citation: input.citation,
          identifier: input.identifier ?? null,
          publishedYear: input.publishedYear ?? null,
          population: input.population,
          dosage: input.dosage,
          duration: input.duration,
          outcome: input.outcome,
          limitations: input.limitations,
          mediaId: input.mediaId ?? null,
          addedById: actor.actorId,
          addedByLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.EVIDENCE_CREATED,
        entityType: 'evidence',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { title: input.title, sourceType: input.sourceType, citation: input.citation },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    return this.findById(evidence.id);
  }

  /**
   * Corrects a record.
   *
   * Refused once the evidence has been reviewed. An accepted source is part of
   * the basis on which claims were approved, and editing it afterwards would
   * silently change what those approvals rest on. A correction to reviewed
   * evidence is a new record, which is the honest shape: the claim then has to
   * be re-reviewed against it.
   */
  async update(evidenceId: string, input: UpdateEvidenceInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const existing = await this.prisma.evidenceRecord.findUnique({ where: { id: evidenceId } });
    if (!existing) throw AppException.notFound('Evidence');

    if (existing.status === 'ACCEPTED' || existing.status === 'REJECTED') {
      throw AppException.conflict(
        'Reviewed evidence cannot be edited, because approvals rest on what it said. Record a new source instead.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.evidenceRecord.update({
        where: { id: evidenceId },
        data: {
          ...(input.sourceType !== undefined ? { sourceType: input.sourceType } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.citation !== undefined ? { citation: input.citation } : {}),
          ...(input.identifier !== undefined ? { identifier: input.identifier } : {}),
          ...(input.publishedYear !== undefined ? { publishedYear: input.publishedYear } : {}),
          ...(input.population !== undefined ? { population: input.population } : {}),
          ...(input.dosage !== undefined ? { dosage: input.dosage } : {}),
          ...(input.duration !== undefined ? { duration: input.duration } : {}),
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          ...(input.limitations !== undefined ? { limitations: input.limitations } : {}),
          ...(input.mediaId !== undefined ? { mediaId: input.mediaId } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.EVIDENCE_UPDATED,
        entityType: 'evidence',
        entityId: evidenceId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: {
          title: existing.title,
          outcome: existing.outcome,
          limitations: existing.limitations,
        },
        after: { ...input },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(evidenceId);
  }

  /**
   * A reviewer's judgement on the source itself.
   *
   * Separate from deciding a claim, because the two questions are different:
   * "is this a sound study?" and "does it support this sentence?". The same
   * study can be sound and still not support the claim it was attached to.
   */
  async decide(evidenceId: string, input: EvidenceDecisionInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const existing = await this.prisma.evidenceRecord.findUnique({ where: { id: evidenceId } });
    if (!existing) throw AppException.notFound('Evidence');

    await this.prisma.$transaction(async (tx) => {
      await tx.evidenceRecord.update({
        where: { id: evidenceId },
        data: {
          status: input.decision,
          reviewedById: actor.actorId,
          reviewedByLabel: actor.actorLabel,
          reviewedAt: this.clock.now(),
          reviewNotes: input.notes,
        },
      });

      await this.audit.recordIn(tx, {
        action:
          input.decision === 'ACCEPTED'
            ? COMPLIANCE_AUDIT_ACTIONS.EVIDENCE_ACCEPTED
            : COMPLIANCE_AUDIT_ACTIONS.EVIDENCE_REJECTED,
        entityType: 'evidence',
        entityId: evidenceId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        before: { status: existing.status },
        after: { status: input.decision, title: existing.title },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.logger.info(
      { evidenceId, decision: input.decision, reviewerId: actor.actorId },
      'evidence decision recorded',
    );

    return this.findById(evidenceId);
  }

  /** Attaches a source to a claim, with the reviewer's view of how it bears on it. */
  async link(claimId: string, input: LinkEvidenceInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const [claim, evidence] = await Promise.all([
      this.prisma.productClaim.findUnique({
        where: { id: claimId },
        select: { id: true, status: true },
      }),
      this.prisma.evidenceRecord.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, title: true },
      }),
    ]);
    if (!claim) throw AppException.notFound('Claim');
    if (!evidence) throw AppException.notFound('Evidence');

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.claimEvidence.create({
          data: {
            claimId,
            evidenceId: input.evidenceId,
            relevance: input.relevance,
            notes: input.notes ?? null,
            linkedById: actor.actorId,
            linkedByLabel: actor.actorLabel,
          },
        });

        await this.audit.recordIn(tx, {
          action: COMPLIANCE_AUDIT_ACTIONS.EVIDENCE_LINKED,
          entityType: 'claim',
          entityId: claimId,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: {
            evidenceId: input.evidenceId,
            title: evidence.title,
            relevance: input.relevance,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppException.conflict('That source is already attached to this claim.');
      }
      throw error;
    }
  }

  /**
   * Detaches a source from a claim.
   *
   * Refused once the claim is approved. The approval rests on the evidence that
   * was attached at the time — a snapshot of which is stored on the review — and
   * quietly removing a source afterwards leaves an approval standing on a file
   * that no longer contains what it was granted against.
   */
  async unlink(claimId: string, evidenceId: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const claim = await this.prisma.productClaim.findUnique({
      where: { id: claimId },
      select: { status: true },
    });
    if (!claim) throw AppException.notFound('Claim');

    if (claim.status === 'APPROVED') {
      throw AppException.conflict(
        'Evidence cannot be detached from an approved claim. Revise the claim first, which re-opens it for review.',
      );
    }

    const link = await this.prisma.claimEvidence.findUnique({
      where: { claimId_evidenceId: { claimId, evidenceId } },
    });
    if (!link) throw AppException.notFound('Evidence link');

    await this.prisma.$transaction(async (tx) => {
      await tx.claimEvidence.delete({ where: { id: link.id } });
      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.EVIDENCE_UNLINKED,
        entityType: 'claim',
        entityId: claimId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { evidenceId, relevance: link.relevance },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }
}
