import { Injectable } from '@nestjs/common';
import type { UpdateSystemSettingInput } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { RequestAuditContext } from '../../common/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';

export interface SystemSettingView {
  key: string;
  value: unknown;
  valueType: string;
  description: string | null;
  updatedAt: string;
}

/**
 * Business configuration held in the database rather than in environment
 * variables, so an operator can change it without a deploy.
 *
 * Secrets do NOT belong here. A setting marked `isSecret` is never returned by
 * the API at all — the flag exists so that a value which turns out to be
 * sensitive can be hidden without a schema change, not as a place to store
 * credentials.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<SystemSettingView[]> {
    const settings = await this.prisma.systemSetting.findMany({
      where: { isSecret: false },
      orderBy: { key: 'asc' },
    });
    return settings.map(toView);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    return setting ? (setting.value as T) : null;
  }

  async update(
    key: string,
    input: UpdateSystemSettingInput,
    actor: { actorId: string; actorLabel: string } & RequestAuditContext,
  ): Promise<SystemSettingView> {
    const existing = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!existing) throw AppException.notFound('Setting');
    if (existing.isSecret) {
      throw AppException.forbidden(
        undefined,
        'This setting is managed through the secret manager and cannot be changed here.',
      );
    }

    this.assertTypeMatches(existing.valueType, input.value);

    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.systemSetting.update({
        where: { key },
        data: { value: input.value as never, updatedBy: actor.actorId },
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.SETTING_UPDATED,
        entityType: 'system_setting',
        entityId: saved.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        before: { key, value: existing.value },
        after: { key, value: saved.value },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        correlationId: actor.correlationId,
      });

      return saved;
    });

    return toView(updated);
  }

  /**
   * A setting's type is fixed at creation. Allowing it to change would let a
   * number the code does arithmetic on silently become a string.
   */
  private assertTypeMatches(valueType: string, value: unknown): void {
    const actual =
      value === null
        ? 'null'
        : Array.isArray(value)
          ? 'JSON'
          : typeof value === 'object'
            ? 'JSON'
            : typeof value === 'number'
              ? 'NUMBER'
              : typeof value === 'boolean'
                ? 'BOOLEAN'
                : typeof value === 'string'
                  ? 'STRING'
                  : 'unknown';

    if (actual !== valueType) {
      throw AppException.validation([
        {
          path: 'value',
          message: `This setting expects a ${valueType.toLowerCase()} value, received ${actual.toLowerCase()}.`,
        },
      ]);
    }
  }
}

function toView(row: {
  key: string;
  value: unknown;
  valueType: string;
  description: string | null;
  updatedAt: Date;
}): SystemSettingView {
  return {
    key: row.key,
    value: row.value,
    valueType: row.valueType,
    description: row.description,
    updatedAt: row.updatedAt.toISOString(),
  };
}
