import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import type { UpsertFeatureFlagInput } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { RequestAuditContext } from '../../common/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';

export interface FeatureFlagView {
  key: string;
  description: string | null;
  enabled: boolean;
  rolloutPercentage: number;
  enabledForSubjects: string[];
  updatedAt: string;
}

/**
 * Server-controlled feature flags.
 *
 * Evaluation is deterministic: the same subject always lands in the same
 * bucket for a given flag, so a customer does not see the new checkout on one
 * request and the old one on the next. Bucketing hashes `flagKey:subject` so a
 * subject is not correlated across flags.
 *
 * The flag set is cached briefly; changing a flag must not require a deploy but
 * also must not mean a database read on every request.
 */
@Injectable()
export class FeatureFlagsService {
  private static readonly TTL_MS = 15_000;

  private cache = new Map<string, FeatureFlagView>();
  private expiresAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FeatureFlagsService.name);
  }

  async isEnabled(key: string, subject?: string | null): Promise<boolean> {
    const flags = await this.load();
    const flag = flags.get(key);
    if (!flag) return false;
    if (!flag.enabled) return false;
    if (subject && flag.enabledForSubjects.includes(subject)) return true;
    if (flag.rolloutPercentage >= 100) return true;
    if (flag.rolloutPercentage <= 0) return false;
    if (!subject) return false;
    return bucketOf(key, subject) < flag.rolloutPercentage;
  }

  async list(): Promise<FeatureFlagView[]> {
    const flags = await this.load(true);
    return [...flags.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async upsert(
    key: string,
    input: UpsertFeatureFlagInput,
    actor: { actorId: string; actorLabel: string } & RequestAuditContext,
  ): Promise<FeatureFlagView> {
    const existing = await this.prisma.featureFlag.findUnique({ where: { key } });

    const flag = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.featureFlag.upsert({
        where: { key },
        update: {
          description: input.description ?? existing?.description ?? null,
          enabled: input.enabled,
          rolloutPercentage: input.rolloutPercentage,
          enabledForSubjects: input.enabledForSubjects,
          updatedBy: actor.actorId,
        },
        create: {
          key,
          description: input.description ?? null,
          enabled: input.enabled,
          rolloutPercentage: input.rolloutPercentage,
          enabledForSubjects: input.enabledForSubjects,
          updatedBy: actor.actorId,
        },
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.FEATURE_FLAG_UPDATED,
        entityType: 'feature_flag',
        entityId: saved.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: existing
          ? {
              enabled: existing.enabled,
              rolloutPercentage: existing.rolloutPercentage,
              subjects: existing.enabledForSubjects.length,
            }
          : null,
        after: {
          key,
          enabled: saved.enabled,
          rolloutPercentage: saved.rolloutPercentage,
          subjects: saved.enabledForSubjects.length,
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        correlationId: actor.correlationId,
      });

      return saved;
    });

    this.expiresAt = 0;
    this.logger.info({ key, enabled: flag.enabled }, 'feature flag updated');
    return toView(flag);
  }

  private async load(force = false): Promise<Map<string, FeatureFlagView>> {
    if (!force && Date.now() < this.expiresAt) return this.cache;
    const rows = await this.prisma.featureFlag.findMany();
    this.cache = new Map(rows.map((row) => [row.key, toView(row)]));
    this.expiresAt = Date.now() + FeatureFlagsService.TTL_MS;
    return this.cache;
  }
}

/**
 * Deterministic 0-99 bucket. Salting with the flag key means a subject that is
 * in the first 5% for one flag is not systematically in the first 5% for every
 * other flag.
 */
export function bucketOf(flagKey: string, subject: string): number {
  const digest = createHash('sha256').update(`${flagKey}:${subject}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function toView(row: {
  key: string;
  description: string | null;
  enabled: boolean;
  rolloutPercentage: number;
  enabledForSubjects: string[];
  updatedAt: Date;
}): FeatureFlagView {
  return {
    key: row.key,
    description: row.description,
    enabled: row.enabled,
    rolloutPercentage: row.rolloutPercentage,
    enabledForSubjects: row.enabledForSubjects,
    updatedAt: row.updatedAt.toISOString(),
  };
}
