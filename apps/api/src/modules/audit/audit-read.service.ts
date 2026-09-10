import { Injectable } from '@nestjs/common';
import type { Paginated } from '@health/types';
import type { Prisma } from '@health/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { ListAuditLogsQuery } from '@health/validation';
import { decodeCursor, encodeCursor } from '../../common/pagination.js';

export interface AuditLogView {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  outcome: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  correlationId: string | null;
  createdAt: string;
}

@Injectable()
export class AuditReadService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAuditLogsQuery): Promise<Paginated<AuditLogView>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const cursor = decodeCursor(query.cursor);
    // One extra row tells us whether another page exists without a COUNT.
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? encodeCursor(page[page.length - 1]?.id) : null;

    return {
      data: page.map((row) => ({
        id: row.id,
        actorType: row.actorType,
        actorId: row.actorId,
        actorLabel: row.actorLabel,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        outcome: row.outcome,
        reason: row.reason,
        before: row.beforeState,
        after: row.afterState,
        ipAddress: row.ipAddress,
        correlationId: row.correlationId,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: { nextCursor, count: page.length, limit: query.limit },
    };
  }
}
