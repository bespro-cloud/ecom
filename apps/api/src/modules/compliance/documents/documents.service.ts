import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import type { CreateDocumentInput, DocumentQuery } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { COMPLIANCE_AUDIT_ACTIONS } from '../compliance.audit.js';

/**
 * Regulatory and quality documents.
 *
 * This service records that someone uploaded a file and said what it is. That
 * is the entire scope, and the limit is deliberate: the system does not verify
 * an issuer, does not check a certificate against a registry, and must never be
 * read as evidence that a certification is genuine or current. What it can
 * honestly say is "a document asserting X was uploaded by this person on this
 * date", and every read path is shaped to say exactly that.
 *
 * Expiry is computed from the date the uploader entered, and a lapsed document
 * is reported as lapsed rather than quietly ignored — a certificate that
 * expired eight months ago is a finding, not an absence.
 *
 * Superseding is a link, not an edit. The document that was current when a
 * particular lot shipped stays identifiable afterwards, which is the question
 * an investigation actually asks.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(DocumentsService.name);
  }

  async list(query: DocumentQuery) {
    const now = this.clock.now();
    const rows = await this.prisma.productDocument.findMany({
      where: {
        archivedAt: null,
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.batchId ? { batchId: query.batchId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.expiringWithinDays !== undefined
          ? { expiresAt: { lte: addSeconds(now, query.expiringWithinDays * 24 * 60 * 60) } }
          : {}),
      },
      orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
      take: query.limit + 1,
      include: {
        media: { select: { id: true, originalFilename: true, mimeType: true, sizeBytes: true } },
        product: { select: { id: true, sku: true, name: true } },
        batch: { select: { id: true, lotCode: true } },
      },
    });

    return {
      data: rows.slice(0, query.limit).map((row) => this.toView(row, now)),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async create(input: CreateDocumentInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    // Every reference is checked. A document attached to a product that does
    // not exist is a file nobody will ever find again.
    const media = await this.prisma.media.findUnique({
      where: { id: input.mediaId },
      select: { id: true },
    });
    if (!media) throw AppException.notFound('Media');

    if (input.productId) {
      const product = await this.prisma.product.findFirst({
        where: { id: input.productId, deletedAt: null },
        select: { id: true },
      });
      if (!product) throw AppException.notFound('Product');
    }
    if (input.batchId) {
      const batch = await this.prisma.inventoryBatch.findUnique({
        where: { id: input.batchId },
        select: { id: true },
      });
      if (!batch) throw AppException.notFound('Lot');
    }

    if (input.supersedesId) {
      const superseded = await this.prisma.productDocument.findUnique({
        where: { id: input.supersedesId },
        select: { id: true, supersededBy: { select: { id: true } } },
      });
      if (!superseded) throw AppException.notFound('Superseded document');
      if (superseded.supersededBy) {
        throw AppException.conflict('That document has already been superseded.');
      }
    }

    const now = this.clock.now();

    const document = await this.prisma.$transaction(async (tx) => {
      const created = await tx.productDocument.create({
        data: {
          productId: input.productId ?? null,
          batchId: input.batchId ?? null,
          type: input.type,
          title: input.title,
          issuer: input.issuer ?? null,
          reference: input.reference ?? null,
          issuedAt: input.issuedAt ?? null,
          expiresAt: input.expiresAt ?? null,
          mediaId: input.mediaId,
          notes: input.notes ?? null,
          supersedesId: input.supersedesId ?? null,
          uploadedById: actor.actorId,
          uploadedByLabel: actor.actorLabel,
        },
      });

      if (input.supersedesId) {
        // The superseded document is kept and archived, never deleted: it is
        // what was current when earlier stock shipped.
        await tx.productDocument.update({
          where: { id: input.supersedesId },
          data: { archivedAt: now },
        });
        await this.audit.recordIn(tx, {
          action: COMPLIANCE_AUDIT_ACTIONS.DOCUMENT_SUPERSEDED,
          entityType: 'document',
          entityId: input.supersedesId,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { supersededById: created.id },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });
      }

      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.DOCUMENT_UPLOADED,
        entityType: 'document',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: {
          type: input.type,
          title: input.title,
          productId: input.productId ?? null,
          batchId: input.batchId ?? null,
          // Recorded as stated, and labelled that way, so a later reader does
          // not mistake the audit entry for verification.
          issuerAsStated: input.issuer ?? null,
          expiresAt: input.expiresAt?.toISOString() ?? null,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    return this.findById(document.id);
  }

  async findById(documentId: string) {
    const document = await this.prisma.productDocument.findUnique({
      where: { id: documentId },
      include: {
        media: { select: { id: true, originalFilename: true, mimeType: true, sizeBytes: true } },
        product: { select: { id: true, sku: true, name: true } },
        batch: { select: { id: true, lotCode: true } },
      },
    });
    if (!document) throw AppException.notFound('Document');
    return this.toView(document, this.clock.now());
  }

  async archive(documentId: string, reason: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const existing = await this.prisma.productDocument.findUnique({ where: { id: documentId } });
    if (!existing) throw AppException.notFound('Document');

    await this.prisma.$transaction(async (tx) => {
      await tx.productDocument.update({
        where: { id: documentId },
        data: { archivedAt: this.clock.now() },
      });
      await this.audit.recordIn(tx, {
        action: COMPLIANCE_AUDIT_ACTIONS.DOCUMENT_ARCHIVED,
        entityType: 'document',
        entityId: documentId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason,
        before: { type: existing.type, title: existing.title },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  /**
   * Documents held against a product, for the compliance review packet.
   *
   * Returns the lapsed ones too, flagged. A reviewer needs to see that the GMP
   * certificate expired rather than see nothing where it used to be.
   */
  async summaryForProduct(productId: string) {
    const now = this.clock.now();
    const documents = await this.prisma.productDocument.findMany({
      where: { productId, archivedAt: null },
      orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
      include: { media: { select: { id: true, originalFilename: true } } },
    });

    const views = documents.map((document) => this.toView(document, now));
    return {
      documents: views,
      expired: views.filter((view) => view.expired).map((view) => view.title),
    };
  }

  // -------------------------------------------------------------------------

  private toView(
    document: {
      id: string;
      type: string;
      title: string;
      issuer: string | null;
      reference: string | null;
      issuedAt: Date | null;
      expiresAt: Date | null;
      notes: string | null;
      uploadedByLabel: string;
      createdAt: Date;
      archivedAt: Date | null;
      productId: string | null;
      batchId: string | null;
      supersedesId: string | null;
      media?: unknown;
      product?: unknown;
      batch?: unknown;
    },
    now: Date,
  ) {
    return {
      id: document.id,
      type: document.type,
      title: document.title,
      /**
       * Named `issuerAsStated` rather than `issuer` all the way to the client.
       * The system has not verified who issued this, and a field called
       * `issuer` reads like it has.
       */
      issuerAsStated: document.issuer,
      reference: document.reference,
      issuedAt: document.issuedAt,
      expiresAt: document.expiresAt,
      expired: document.expiresAt !== null && document.expiresAt <= now,
      notes: document.notes,
      uploadedByLabel: document.uploadedByLabel,
      createdAt: document.createdAt,
      archivedAt: document.archivedAt,
      productId: document.productId,
      batchId: document.batchId,
      supersedesId: document.supersedesId,
      media: document.media,
      product: document.product,
      batch: document.batch,
      /**
       * Stated on every document the API returns. The presence of a row here is
       * evidence that a file was uploaded, not that a certification is valid.
       */
      verification: 'NOT_VERIFIED_BY_THIS_SYSTEM' as const,
    };
  }
}
