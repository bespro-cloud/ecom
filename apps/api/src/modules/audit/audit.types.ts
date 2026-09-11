import type { AuditActorType, AuditOutcome } from '@health/database';
import type { AuditAction } from '@health/types';

export {
  ALL_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  AUDIT_ACTION_KEYS,
  CATALOGUE_AUDIT_ACTIONS,
  NOTABLE_AUDIT_ACTIONS,
} from '@health/types';
export type { AuditAction } from '@health/types';

export interface AuditWrite {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  actorType?: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  outcome?: AuditOutcome;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}
