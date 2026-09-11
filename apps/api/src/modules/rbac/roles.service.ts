import { Injectable } from '@nestjs/common';
import { PERMISSIONS, type PermissionKey } from '@health/types';
import { isUniqueConstraintError } from '@health/database';
import type { CreateRoleInput, UpdateRoleInput } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';
import { PrivilegedRoleService } from './privileged-role.service.js';

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  requiresMfa: boolean;
  permissions: string[];
  userCount: number;
}

export interface ActorContext {
  /**
   * Null for a guest.
   *
   * Not every action is taken by a signed-in user: a guest checkout is a real
   * actor with a real audit trail and no user record. The audit log has always
   * modelled this (`actorId` is nullable there); this type now says so too,
   * rather than forcing call sites to invent an id.
   */
  actorId: string | null;
  actorLabel: string;
  correlationId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** An actor that is definitely a signed-in person. */
export interface NamedActorContext extends ActorContext {
  actorId: string;
}

/**
 * Asserts that an action is being taken by a signed-in person.
 *
 * Some records require a named human by design — a compliance decision, a
 * refund — and their columns are non-nullable to enforce it. Rather than
 * casting the guest case away at each call site, this makes the requirement
 * explicit and fails loudly if a route that should be authenticated ever
 * becomes reachable without a session.
 */
export function requireNamedActor(actor: ActorContext): NamedActorContext {
  if (!actor.actorId) {
    throw new Error('This action requires a signed-in user, but the actor has no user id.');
  }
  return actor as NamedActorContext;
}

/**
 * Role administration.
 *
 * System roles are defined in code and synced by `syncRbac`; the API can read
 * them but never edit or delete them. That is what stops a compromised admin
 * session from quietly widening SUPER_ADMIN or narrowing COMPLIANCE_REVIEWER.
 * Custom roles created here are fully editable.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly privilegedRoles: PrivilegedRoleService,
  ) {}

  async list(): Promise<RoleView[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
      include: {
        permissions: { include: { permission: { select: { key: true } } } },
        _count: { select: { users: true } },
      },
    });

    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      requiresMfa: role.requiresMfa,
      permissions: role.permissions.map((p) => p.permission.key).sort(),
      userCount: role._count.users,
    }));
  }

  listPermissionCatalogue(): Array<{
    key: string;
    resource: string;
    action: string;
    description: string;
  }> {
    return PERMISSIONS.map((p) => ({ ...p }));
  }

  async create(input: CreateRoleInput, actor: ActorContext): Promise<RoleView> {
    const permissionIds = await this.resolvePermissionIds(input.permissionKeys);

    try {
      const role = await this.prisma.$transaction(async (tx) => {
        const created = await tx.role.create({
          data: {
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            isSystem: false,
            requiresMfa: input.requiresMfa,
          },
        });

        if (permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permissionIds.map((permissionId) => ({ roleId: created.id, permissionId })),
          });
        }

        await this.audit.recordIn(tx, {
          action: AUDIT_ACTIONS.ROLE_CREATED,
          entityType: 'role',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: {
            key: created.key,
            name: created.name,
            requiresMfa: created.requiresMfa,
            permissions: input.permissionKeys,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      this.privilegedRoles.invalidate();
      return this.findViewOrThrow(role.id);
    } catch (error) {
      if (isUniqueConstraintError(error, 'key')) {
        throw AppException.conflict(`A role with the key "${input.key}" already exists.`);
      }
      throw error;
    }
  }

  async update(roleId: string, input: UpdateRoleInput, actor: ActorContext): Promise<RoleView> {
    const existing = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: { select: { key: true } } } } },
    });
    if (!existing) throw AppException.notFound('Role');

    if (existing.isSystem) {
      throw AppException.forbidden(
        undefined,
        'System roles are defined in code and cannot be edited here. Change the role definition and redeploy.',
      );
    }

    const before = {
      name: existing.name,
      description: existing.description,
      requiresMfa: existing.requiresMfa,
      permissions: existing.permissions.map((p) => p.permission.key).sort(),
    };

    const permissionIds =
      input.permissionKeys !== undefined
        ? await this.resolvePermissionIds(input.permissionKeys)
        : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { id: roleId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.requiresMfa !== undefined ? { requiresMfa: input.requiresMfa } : {}),
        },
      });

      if (permissionIds !== null) {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        if (permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
          });
        }
      }

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.ROLE_UPDATED,
        entityType: 'role',
        entityId: roleId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before,
        after: {
          name: input.name ?? before.name,
          description: input.description ?? before.description,
          requiresMfa: input.requiresMfa ?? before.requiresMfa,
          permissions: input.permissionKeys ?? before.permissions,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.privilegedRoles.invalidate();
    return this.findViewOrThrow(roleId);
  }

  async remove(roleId: string, actor: ActorContext): Promise<void> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { users: true } } },
    });
    if (!role) throw AppException.notFound('Role');

    if (role.isSystem) {
      throw AppException.forbidden(undefined, 'System roles cannot be deleted.');
    }
    if (role._count.users > 0) {
      throw AppException.conflict(
        `This role is still assigned to ${role._count.users} user(s). Reassign them before deleting it.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id: roleId } });
      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.ROLE_DELETED,
        entityType: 'role',
        entityId: roleId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { key: role.key, name: role.name },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.privilegedRoles.invalidate();
  }

  private async resolvePermissionIds(keys: PermissionKey[] | string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const permissions = await this.prisma.permission.findMany({
      where: { key: { in: keys as string[] } },
      select: { id: true, key: true },
    });
    if (permissions.length !== new Set(keys).size) {
      const found = new Set(permissions.map((p) => p.key));
      const missing = [...new Set(keys)].filter((key) => !found.has(key));
      throw AppException.validation(
        missing.map((key) => ({ path: 'permissionKeys', message: `Unknown permission: ${key}` })),
      );
    }
    return permissions.map((p) => p.id);
  }

  private async findViewOrThrow(roleId: string): Promise<RoleView> {
    const roles = await this.list();
    const role = roles.find((r) => r.id === roleId);
    if (!role) throw AppException.notFound('Role');
    return role;
  }
}
