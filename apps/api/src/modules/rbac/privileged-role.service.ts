import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

/**
 * Which roles demand MFA.
 *
 * Consulted on every authorised request, so it is cached in memory with a
 * short TTL. The cache fails *closed*: if the database cannot be reached, the
 * last known set is kept, and on a cold start with no data every role is
 * treated as privileged rather than none.
 */
@Injectable()
export class PrivilegedRoleService implements OnModuleInit {
  private static readonly TTL_MS = 30_000;

  private cache: Set<string> | null = null;
  private expiresAt = 0;
  private inFlight: Promise<Set<string>> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrivilegedRoleService.name);
  }

  async onModuleInit(): Promise<void> {
    await this.load().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'could not preload privileged roles');
    });
  }

  async anyRequiresMfa(roleKeys: string[]): Promise<boolean> {
    if (roleKeys.length === 0) return false;
    const privileged = await this.resolve();
    return roleKeys.some((key) => privileged.has(key));
  }

  /** Forces a reload — called after a role's MFA requirement is changed. */
  invalidate(): void {
    this.expiresAt = 0;
  }

  private async resolve(): Promise<Set<string>> {
    if (this.cache && Date.now() < this.expiresAt) return this.cache;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.load()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'failed to refresh privileged role cache');
        // Keep serving the previous value rather than silently dropping the MFA
        // requirement for everyone.
        if (this.cache) return this.cache;
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async load(): Promise<Set<string>> {
    const roles = await this.prisma.role.findMany({
      where: { requiresMfa: true },
      select: { key: true },
    });
    this.cache = new Set(roles.map((r) => r.key));
    this.expiresAt = Date.now() + PrivilegedRoleService.TTL_MS;
    return this.cache;
  }
}
