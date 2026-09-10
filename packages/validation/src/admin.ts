import { z } from 'zod';
import { PERMISSION_KEYS, STAFF_ROLE_KEYS } from '@health/types';
import { emailSchema, personNameSchema, paginationSchema, uuidSchema } from './primitives.js';

const permissionKeySchema = z
  .string()
  .refine((v) => (PERMISSION_KEYS as readonly string[]).includes(v), {
    message: 'Unknown permission.',
  });

const roleKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, numbers and underscores.');

export const inviteStaffUserSchema = z.object({
  email: emailSchema,
  firstName: personNameSchema,
  lastName: personNameSchema,
  roleKeys: z
    .array(z.string())
    .min(1, 'Assign at least one role.')
    .max(10)
    .refine((keys) => keys.every((k) => (STAFF_ROLE_KEYS as readonly string[]).includes(k)), {
      message: 'Only staff roles can be assigned to a staff user.',
    }),
});
export type InviteStaffUserInput = z.infer<typeof inviteStaffUserSchema>;

export const acceptStaffInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(12).max(256),
});
export type AcceptStaffInviteInput = z.infer<typeof acceptStaffInviteSchema>;

export const updateStaffUserSchema = z.object({
  firstName: personNameSchema.optional(),
  lastName: personNameSchema.optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
});
export type UpdateStaffUserInput = z.infer<typeof updateStaffUserSchema>;

export const setUserRolesSchema = z.object({
  roleKeys: z.array(z.string().min(1)).max(10),
  /** Required so the audit trail records why privileges changed. */
  reason: z.string().trim().min(5, 'Record why this change is being made.').max(500),
});
export type SetUserRolesInput = z.infer<typeof setUserRolesSchema>;

export const createRoleSchema = z.object({
  key: roleKeySchema,
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  permissionKeys: z.array(permissionKeySchema).max(PERMISSION_KEYS.length),
  requiresMfa: z.boolean().default(false),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  permissionKeys: z.array(permissionKeySchema).max(PERMISSION_KEYS.length).optional(),
  requiresMfa: z.boolean().optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const listUsersQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
  type: z.enum(['STAFF', 'CUSTOMER']).optional(),
  roleKey: z.string().trim().max(64).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const listAuditLogsQuerySchema = paginationSchema.extend({
  actorId: uuidSchema.optional(),
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional(),
  entityId: z.string().trim().max(100).optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export const upsertFeatureFlagSchema = z.object({
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean(),
  rolloutPercentage: z.number().int().min(0).max(100).default(0),
  enabledForSubjects: z.array(z.string().trim().min(1).max(128)).max(1000).default([]),
});
export type UpsertFeatureFlagInput = z.infer<typeof upsertFeatureFlagSchema>;

export const updateSystemSettingSchema = z.object({
  value: z.unknown(),
  reason: z.string().trim().min(5).max(500),
});
export type UpdateSystemSettingInput = z.infer<typeof updateSystemSettingSchema>;
