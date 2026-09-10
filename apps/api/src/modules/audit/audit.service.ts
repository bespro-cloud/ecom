import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { redactObject } from '@health/config';
import { Prisma, type DbClient } from '@health/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { MetricsService } from '../../infrastructure/metrics/metrics.service.js';
import type { AuditWrite } from './audit.types.js';

/**
 * Writes the audit trail.
 *
 * Two entry points, on purpose:
 *
 *  - `recordIn(tx, ...)` writes inside a caller's transaction. Use it whenever
 *    the audit record must be atomic with the change it describes — a role
 *    grant, a refund, a compliance approval. If the change rolls back, so does
 *    the record.
 *
 *  - `record(...)` writes on its own connection and never throws. Use it for
 *    events that are *not* part of a transaction and must be captured even when
 *    the surrounding operation failed — a rejected login, for instance. Losing
 *    the request because the audit insert failed would be worse than the gap,
 *    so failures are logged loudly instead of propagated.
 *
 * Before/after snapshots are redacted; secrets must never reach this table.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.logger.setContext(AuditService.name);
  }

  async recordIn(tx: DbClient, entry: AuditWrite): Promise<void> {
    await tx.auditLog.create({ data: this.toRow(entry) });
    this.metrics.auditWrites.inc({ action: entry.action, outcome: entry.outcome ?? 'SUCCESS' });
  }

  async record(entry: AuditWrite): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toRow(entry) });
      this.metrics.auditWrites.inc({ action: entry.action, outcome: entry.outcome ?? 'SUCCESS' });
    } catch (error) {
      // An unwritable audit trail is an operational incident: alert on this.
      this.logger.error(
        { err: error, action: entry.action, entityType: entry.entityType },
        'failed to write audit record',
      );
      this.metrics.auditWrites.inc({ action: entry.action, outcome: 'WRITE_FAILED' });
    }
  }

  private toRow(entry: AuditWrite) {
    return {
      actorType: entry.actorType ?? 'USER',
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      outcome: entry.outcome ?? 'SUCCESS',
      reason: entry.reason ?? null,
      // Prisma distinguishes "no value" from "SQL NULL" for Json columns;
      // DbNull is the latter.
      beforeState:
        entry.before === undefined || entry.before === null
          ? Prisma.DbNull
          : (redactObject(entry.before) as Prisma.InputJsonValue),
      afterState:
        entry.after === undefined || entry.after === null
          ? Prisma.DbNull
          : (redactObject(entry.after) as Prisma.InputJsonValue),
      ipAddress: entry.ipAddress ?? null,
      userAgent: truncate(entry.userAgent, 512),
      correlationId: entry.correlationId ?? null,
    };
  }
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}
