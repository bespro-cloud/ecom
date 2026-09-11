import { Injectable } from '@nestjs/common';
import type { SeoMetadataInput } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CATALOGUE_AUDIT_ACTIONS } from '../catalogue/catalogue.audit.js';
import type { ActorContext } from '../rbac/roles.service.js';

export type SeoEntityType = 'PRODUCT' | 'CATEGORY' | 'PAGE' | 'INGREDIENT';

export interface SeoView {
  entityType: string;
  entityId: string;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageMediaId: string | null;
  noindex: boolean;
}

/**
 * SEO metadata.
 *
 * Polymorphic by (entityType, entityId) rather than a column on each domain
 * table, so adding a new kind of public page needs no schema change.
 *
 * Nothing here generates copy. A meta description is a public statement about a
 * health product, and one written by a machine is exactly the kind of plausible
 * text that ends up making a claim nobody reviewed.
 */
@Injectable()
export class SeoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(entityType: SeoEntityType, entityId: string): Promise<SeoView | null> {
    const record = await this.prisma.seoMetadata.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
    });
    return record ? toView(record) : null;
  }

  async upsert(
    entityType: SeoEntityType,
    entityId: string,
    input: SeoMetadataInput,
    actor: ActorContext,
  ): Promise<SeoView> {
    const before = await this.get(entityType, entityId);

    const record = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.seoMetadata.upsert({
        where: { entityType_entityId: { entityType, entityId } },
        update: {
          title: input.title ?? null,
          description: input.description ?? null,
          canonicalUrl: input.canonicalUrl ?? null,
          ogTitle: input.ogTitle ?? null,
          ogDescription: input.ogDescription ?? null,
          ogImageMediaId: input.ogImageMediaId ?? null,
          noindex: input.noindex,
        },
        create: {
          entityType,
          entityId,
          title: input.title ?? null,
          description: input.description ?? null,
          canonicalUrl: input.canonicalUrl ?? null,
          ogTitle: input.ogTitle ?? null,
          ogDescription: input.ogDescription ?? null,
          ogImageMediaId: input.ogImageMediaId ?? null,
          noindex: input.noindex,
        },
      });

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.SEO_UPDATED,
        entityType: entityType.toLowerCase(),
        entityId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: before ? { title: before.title, noindex: before.noindex } : null,
        after: { title: saved.title, noindex: saved.noindex },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return saved;
    });

    return toView(record);
  }
}

function toView(record: {
  entityType: string;
  entityId: string;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageMediaId: string | null;
  noindex: boolean;
}): SeoView {
  return {
    entityType: record.entityType,
    entityId: record.entityId,
    title: record.title,
    description: record.description,
    canonicalUrl: record.canonicalUrl,
    ogTitle: record.ogTitle,
    ogDescription: record.ogDescription,
    ogImageMediaId: record.ogImageMediaId,
    noindex: record.noindex,
  };
}
