import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import {
  evaluatePassword,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  PASSWORD_ALGORITHM_ID,
} from '@health/auth';
import { DOMAIN_EVENTS, STAFF_ROLE_KEYS, type Paginated } from '@health/types';
import { normalizeEmail } from '@health/validation';
import type {
  InviteStaffUserInput,
  ListUsersQuery,
  SetUserRolesInput,
  UpdateStaffUserInput,
} from '@health/validation';
import { isUniqueConstraintError, type Prisma } from '@health/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { OutboxService } from '../../infrastructure/outbox/outbox.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import { decodeCursor, encodeCursor } from '../../common/pagination.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';
import { SessionService } from '../auth/session.service.js';
import type { ActorContext } from '../rbac/roles.service.js';

export interface UserView {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  type: string;
  status: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * Staff user administration.
 *
 * Staff accounts are never created with a password by an administrator — that
 * would mean one person knowing another's credentials. They are invited, and
 * the invitee sets their own password through a single-use token.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(UsersService.name);
  }

  async list(query: ListUsersQuery): Promise<Paginated<UserView>> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.roleKey ? { roles: { some: { role: { key: query.roleKey } } } } : {}),
      ...(query.search
        ? {
            OR: [
              { emailNormalized: { contains: normalizeEmail(query.search) } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        roles: { include: { role: { select: { key: true } } } },
        mfaFactors: { where: { status: 'ACTIVE' }, select: { id: true } },
      },
    });

    const page = rows.slice(0, query.limit);
    return {
      data: page.map((row) => this.toView(row)),
      meta: {
        nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]?.id) : null,
        count: page.length,
        limit: query.limit,
      },
    };
  }

  async findById(id: string): Promise<UserView> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: {
        roles: { include: { role: { select: { key: true } } } },
        mfaFactors: { where: { status: 'ACTIVE' }, select: { id: true } },
      },
    });
    if (!user) throw AppException.notFound('User');
    return this.toView(user);
  }

  async invite(input: InviteStaffUserInput, actor: ActorContext): Promise<UserView> {
    const roles = await this.prisma.role.findMany({ where: { key: { in: input.roleKeys } } });
    if (roles.length !== input.roleKeys.length) {
      const found = new Set(roles.map((r) => r.key));
      throw AppException.validation(
        input.roleKeys
          .filter((key) => !found.has(key))
          .map((key) => ({ path: 'roleKeys', message: `Unknown role: ${key}` })),
      );
    }
    this.assertStaffRoles(input.roleKeys);

    const inviteToken = generateOpaqueToken();
    const now = this.clock.now();

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email.trim(),
            emailNormalized: normalizeEmail(input.email),
            firstName: input.firstName,
            lastName: input.lastName,
            type: 'STAFF',
            // No password is set: INVITED accounts cannot sign in until the
            // invitee sets one.
            status: 'INVITED',
          },
        });

        await tx.userRole.createMany({
          data: roles.map((role) => ({
            userId: created.id,
            roleId: role.id,
            grantedBy: actor.actorId,
          })),
        });

        await tx.userToken.create({
          data: {
            userId: created.id,
            type: 'STAFF_INVITE',
            tokenHash: hashToken(inviteToken),
            expiresAt: addSeconds(now, this.config.env.STAFF_INVITE_TTL_SECONDS),
          },
        });

        await this.outbox.publish(tx, {
          aggregateType: 'user',
          aggregateId: created.id,
          eventType: DOMAIN_EVENTS.STAFF_INVITED,
          payload: { userId: created.id, token: inviteToken, roles: input.roleKeys },
          correlationId: actor.correlationId,
        });

        await this.audit.recordIn(tx, {
          action: AUDIT_ACTIONS.USER_INVITED,
          entityType: 'user',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { email: created.email, roles: input.roleKeys },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return this.findById(user.id);
    } catch (error) {
      if (isUniqueConstraintError(error, 'email')) {
        throw AppException.conflict('An account already exists for that email address.');
      }
      throw error;
    }
  }

  async acceptInvite(token: string, password: string, correlationId: string): Promise<void> {
    const now = this.clock.now();
    const record = await this.prisma.userToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (
      !record ||
      record.type !== 'STAFF_INVITE' ||
      record.consumedAt !== null ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      throw AppException.unauthorized(
        undefined,
        'This invitation link is no longer valid. Ask an administrator to send a new one.',
      );
    }

    const policy = evaluatePassword(password, {
      email: record.user.email,
      firstName: record.user.firstName,
      lastName: record.user.lastName,
    });
    if (!policy.ok) {
      throw AppException.validation(
        policy.problems.map((message) => ({ path: 'password', message })),
      );
    }

    const passwordHash = await hashPassword(password);

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.userToken.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count === 0) {
        throw AppException.unauthorized(undefined, 'This invitation has already been used.');
      }

      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          passwordAlgorithm: PASSWORD_ALGORITHM_ID,
          passwordUpdatedAt: now,
          status: 'ACTIVE',
          // Following the emailed link proves control of the mailbox.
          emailVerifiedAt: now,
        },
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.USER_INVITE_ACCEPTED,
        entityType: 'user',
        entityId: record.userId,
        actorId: record.userId,
        actorLabel: record.user.email,
        correlationId,
      });
    });
  }

  async update(id: string, input: UpdateStaffUserInput, actor: ActorContext): Promise<UserView> {
    const existing = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppException.notFound('User');

    if (input.status && input.status !== existing.status && id === actor.actorId) {
      throw AppException.conflict('You cannot change your own account status.');
    }

    const before = {
      firstName: existing.firstName,
      lastName: existing.lastName,
      status: existing.status,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });

      // Suspending or deactivating must take effect immediately, not when the
      // current access token happens to expire.
      if (input.status && input.status !== 'ACTIVE') {
        const revoked = await this.sessions.revokeAllForUser(tx, id, 'ADMIN_REVOKED');
        this.logger.info({ userId: id, revoked }, 'sessions revoked after status change');
      }

      await this.audit.recordIn(tx, {
        action:
          input.status && input.status !== existing.status
            ? AUDIT_ACTIONS.USER_STATUS_CHANGED
            : AUDIT_ACTIONS.USER_UPDATED,
        entityType: 'user',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before,
        after: { ...before, ...input },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  /**
   * Replaces a user's role set.
   *
   * Privilege changes are the highest-value target in the system, so this runs
   * in a transaction with the audit record, requires a written reason, refuses
   * self-modification, and revokes the affected user's sessions so the new
   * permission set is picked up immediately.
   */
  async setRoles(id: string, input: SetUserRolesInput, actor: ActorContext): Promise<UserView> {
    if (id === actor.actorId) {
      throw AppException.conflict(
        'You cannot change your own roles. Ask another administrator to make this change.',
      );
    }

    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { roles: { include: { role: { select: { key: true } } } } },
    });
    if (!user) throw AppException.notFound('User');

    if (user.type === 'STAFF') this.assertStaffRoles(input.roleKeys);

    const roles = await this.prisma.role.findMany({ where: { key: { in: input.roleKeys } } });
    if (roles.length !== new Set(input.roleKeys).size) {
      const found = new Set(roles.map((r) => r.key));
      throw AppException.validation(
        input.roleKeys
          .filter((key) => !found.has(key))
          .map((key) => ({ path: 'roleKeys', message: `Unknown role: ${key}` })),
      );
    }

    const before = user.roles.map((r) => r.role.key).sort();
    await this.assertNotLastSuperAdmin(id, before, input.roleKeys);

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id } });
      if (roles.length > 0) {
        await tx.userRole.createMany({
          data: roles.map((role) => ({ userId: id, roleId: role.id, grantedBy: actor.actorId })),
        });
      }

      await this.sessions.revokeAllForUser(tx, id, 'ADMIN_REVOKED');

      await this.outbox.publish(tx, {
        aggregateType: 'user',
        aggregateId: id,
        eventType: DOMAIN_EVENTS.STAFF_ROLES_CHANGED,
        payload: { userId: id, before, after: input.roleKeys },
        correlationId: actor.correlationId,
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.USER_ROLES_CHANGED,
        entityType: 'user',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason,
        before: { roles: before },
        after: { roles: [...input.roleKeys].sort() },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findById(id);
  }

  async revokeSessions(id: string, actor: ActorContext): Promise<{ revokedSessions: number }> {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw AppException.notFound('User');

    const revoked = await this.sessions.revokeAllForUser(this.prisma, id, 'ADMIN_REVOKED');
    await this.audit.record({
      action: AUDIT_ACTIONS.USER_SESSIONS_REVOKED,
      entityType: 'user',
      entityId: id,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      after: { revokedSessions: revoked },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      correlationId: actor.correlationId,
    });
    return { revokedSessions: revoked };
  }

  private assertStaffRoles(roleKeys: string[]): void {
    const invalid = roleKeys.filter((key) => !(STAFF_ROLE_KEYS as readonly string[]).includes(key));
    if (invalid.length > 0) {
      throw AppException.validation(
        invalid.map((key) => ({
          path: 'roleKeys',
          message: `${key} is not a staff role and cannot be assigned here.`,
        })),
      );
    }
  }

  /**
   * Prevents the system from being locked out of its own administration by
   * removing the last account that can grant roles.
   */
  private async assertNotLastSuperAdmin(
    userId: string,
    currentRoles: string[],
    nextRoles: string[],
  ): Promise<void> {
    if (!currentRoles.includes('SUPER_ADMIN') || nextRoles.includes('SUPER_ADMIN')) return;

    const remaining = await this.prisma.user.count({
      where: {
        id: { not: userId },
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { key: 'SUPER_ADMIN' } } },
      },
    });
    if (remaining === 0) {
      throw AppException.conflict(
        'This is the last active super administrator. Promote another account before removing this role.',
      );
    }
  }

  private toView(row: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    type: string;
    status: string;
    emailVerifiedAt: Date | null;
    lastLoginAt: Date | null;
    createdAt: Date;
    roles: Array<{ role: { key: string } }>;
    mfaFactors: Array<{ id: string }>;
  }): UserView {
    return {
      id: row.id,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      type: row.type,
      status: row.status,
      emailVerified: row.emailVerifiedAt !== null,
      mfaEnabled: row.mfaFactors.length > 0,
      roles: row.roles.map((r) => r.role.key).sort(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
