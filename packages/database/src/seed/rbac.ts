import { PERMISSIONS, resolveRolePermissions, SYSTEM_ROLES } from '@health/types';
import type { PrismaClient } from '../client.js';

export interface RbacSyncResult {
  permissionsCreated: number;
  permissionsUpdated: number;
  rolesCreated: number;
  rolesUpdated: number;
  grantsAdded: number;
  grantsRemoved: number;
}

/**
 * Reconciles the database with the permission and role catalogues in
 * `@health/types`.
 *
 * Code is the source of truth for system roles. Running this is idempotent and
 * safe on every deploy: it adds new permissions, updates descriptions, and —
 * importantly — *removes* grants that are no longer in the catalogue, so
 * deleting a permission from a role in code actually revokes it in production
 * rather than leaving a stale grant behind.
 *
 * Roles created by administrators through the admin API are left untouched.
 */
export async function syncRbac(prisma: PrismaClient): Promise<RbacSyncResult> {
  const result: RbacSyncResult = {
    permissionsCreated: 0,
    permissionsUpdated: 0,
    rolesCreated: 0,
    rolesUpdated: 0,
    grantsAdded: 0,
    grantsRemoved: 0,
  };

  await prisma.$transaction(async (tx) => {
    for (const permission of PERMISSIONS) {
      const existing = await tx.permission.findUnique({ where: { key: permission.key } });
      if (!existing) {
        await tx.permission.create({
          data: {
            key: permission.key,
            resource: permission.resource,
            action: permission.action,
            description: permission.description,
          },
        });
        result.permissionsCreated += 1;
      } else if (
        existing.description !== permission.description ||
        existing.resource !== permission.resource ||
        existing.action !== permission.action
      ) {
        await tx.permission.update({
          where: { key: permission.key },
          data: {
            resource: permission.resource,
            action: permission.action,
            description: permission.description,
          },
        });
        result.permissionsUpdated += 1;
      }
    }

    const permissionIdByKey = new Map(
      (await tx.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]),
    );

    for (const roleDefinition of SYSTEM_ROLES) {
      const existing = await tx.role.findUnique({ where: { key: roleDefinition.key } });
      const role = existing
        ? await maybeUpdateRole(tx, existing, roleDefinition, result)
        : await createRole(tx, roleDefinition, result);

      const desiredKeys = new Set(resolveRolePermissions(roleDefinition));
      const currentGrants = await tx.rolePermission.findMany({
        where: { roleId: role.id },
        include: { permission: { select: { key: true } } },
      });
      const currentKeys = new Set(currentGrants.map((g) => g.permission.key));

      const toAdd = [...desiredKeys].filter((key) => !currentKeys.has(key));
      const toRemove = currentGrants.filter((g) => !desiredKeys.has(g.permission.key));

      if (toAdd.length > 0) {
        await tx.rolePermission.createMany({
          data: toAdd.map((key) => {
            const permissionId = permissionIdByKey.get(key);
            if (!permissionId) {
              throw new Error(`Permission ${key} referenced by role ${role.key} does not exist.`);
            }
            return { roleId: role.id, permissionId };
          }),
          skipDuplicates: true,
        });
        result.grantsAdded += toAdd.length;
      }

      if (toRemove.length > 0) {
        await tx.rolePermission.deleteMany({
          where: {
            roleId: role.id,
            permissionId: { in: toRemove.map((g) => g.permissionId) },
          },
        });
        result.grantsRemoved += toRemove.length;
      }
    }
  });

  return result;
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function createRole(
  tx: Tx,
  definition: (typeof SYSTEM_ROLES)[number],
  result: RbacSyncResult,
) {
  result.rolesCreated += 1;
  return tx.role.create({
    data: {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      isSystem: true,
      requiresMfa: definition.requiresMfa,
    },
  });
}

async function maybeUpdateRole(
  tx: Tx,
  existing: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    requiresMfa: boolean;
  },
  definition: (typeof SYSTEM_ROLES)[number],
  result: RbacSyncResult,
) {
  const changed =
    existing.name !== definition.name ||
    existing.description !== definition.description ||
    existing.requiresMfa !== definition.requiresMfa ||
    !existing.isSystem;
  if (!changed) return existing;

  result.rolesUpdated += 1;
  return tx.role.update({
    where: { id: existing.id },
    data: {
      name: definition.name,
      description: definition.description,
      isSystem: true,
      requiresMfa: definition.requiresMfa,
    },
  });
}
