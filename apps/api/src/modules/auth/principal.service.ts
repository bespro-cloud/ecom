import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey } from '@health/types';
import type { DbClient } from '@health/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import type { Clock } from '@health/config';

export interface UserAuthorizationProfile {
  userId: string;
  email: string;
  type: 'STAFF' | 'CUSTOMER';
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  roles: string[];
  permissions: PermissionKey[];
  /** True when any held role is marked as requiring MFA. */
  requiresMfa: boolean;
  mfaEnabled: boolean;
}

/**
 * Resolves a user's effective roles and permissions.
 *
 * Permissions are always derived from roles at read time — never stored on the
 * user — so revoking a permission from a role takes effect for everyone at the
 * next token issue, with no back-fill.
 */
@Injectable()
export class PrincipalService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async loadProfile(userId: string, client?: DbClient): Promise<UserAuthorizationProfile | null> {
    const db = client ?? this.prisma;
    const user = await db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        type: true,
        status: true,
        roles: {
          where: { OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }] },
          select: {
            role: {
              select: {
                key: true,
                requiresMfa: true,
                permissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
        mfaFactors: { where: { status: 'ACTIVE' }, select: { id: true } },
      },
    });

    if (!user) return null;

    const roles = user.roles.map((assignment) => assignment.role);
    const permissions = new Set<string>();
    for (const role of roles) {
      for (const grant of role.permissions) {
        permissions.add(grant.permission.key);
      }
    }

    return {
      userId: user.id,
      email: user.email,
      type: user.type,
      status: user.status,
      roles: roles.map((r) => r.key),
      permissions: [...permissions].sort() as PermissionKey[],
      requiresMfa: roles.some((r) => r.requiresMfa),
      mfaEnabled: user.mfaFactors.length > 0,
    };
  }
}
