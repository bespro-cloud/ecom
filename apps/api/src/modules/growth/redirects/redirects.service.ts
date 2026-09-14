import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { isUniqueConstraintError, type DbClient } from '@health/database';
import { normalisePath } from '@health/types';
import type { CreateRedirectInput, RedirectQuery, UpdateRedirectInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { GROWTH_AUDIT_ACTIONS } from '../growth.audit.js';

/**
 * Redirects.
 *
 * A product that has been indexed for two years and silently starts returning
 * 404 loses its ranking and the customers who bookmarked it, and nobody notices
 * until the traffic has already gone. So a slug change writes a redirect
 * automatically rather than relying on an editor to remember — this is the one
 * piece of "SEO automation" in the phase that genuinely should be automatic,
 * because it is mechanical and the failure is silent.
 *
 * Two hazards get explicit handling.
 *
 * **Loops.** A → B followed by B → A is an infinite redirect that takes the
 * page down entirely. The database refuses a self-loop; this service refuses a
 * cycle of any length before writing.
 *
 * **Chains.** Rename twice and you get A → B → C, which costs a round trip and
 * which search engines stop following after a few hops. When a new redirect
 * would extend a chain, the existing links are repointed at the final
 * destination instead.
 */

const MAX_CHAIN_DEPTH = 10;

export interface ResolvedRedirect {
  toPath: string;
  statusCode: number;
}

@Injectable()
export class RedirectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(RedirectsService.name);
  }

  /**
   * Resolves a path for the storefront's middleware.
   *
   * Returns the *final* destination, following any chain that exists, so the
   * visitor makes one hop. Returns null when there is nothing to do, which is
   * the overwhelmingly common case and must stay cheap.
   *
   * The hit counter is a count with no visitor attached to it. It exists so
   * dead redirects can be retired and live ones are obviously worth keeping.
   */
  async resolve(rawPath: string): Promise<ResolvedRedirect | null> {
    const path = normalisePath(rawPath);
    if (path === null) return null;

    let current = path;
    let statusCode = 301;
    const seen = new Set<string>([current]);

    for (let hop = 0; hop < MAX_CHAIN_DEPTH; hop += 1) {
      const redirect = await this.prisma.redirect.findFirst({
        where: { fromPath: current, isActive: true },
        select: { id: true, toPath: true, statusCode: true },
      });
      if (!redirect) break;

      // A redirect that is permanent anywhere in the chain makes the whole hop
      // permanent only if every link is; one temporary link makes the result
      // temporary, because the destination is expected to change.
      if (redirect.statusCode === 302) statusCode = 302;

      if (seen.has(redirect.toPath)) {
        // A cycle that got past the write-time checks — a manual database edit,
        // or two redirects created concurrently. Serving it would take the page
        // down, so serve nothing and make the problem loud.
        this.logger.error(
          { path, cycleAt: redirect.toPath },
          'redirect cycle detected while resolving; refusing to redirect',
        );
        return null;
      }

      seen.add(redirect.toPath);
      current = redirect.toPath;

      // Counting happens on the first hop only, so a chain does not inflate the
      // numbers. Fire-and-forget: a redirect must not fail because a counter
      // did.
      if (hop === 0) {
        void this.prisma.redirect
          .update({
            where: { id: redirect.id },
            data: { hitCount: { increment: 1 }, lastHitAt: this.clock.now() },
          })
          .catch(() => undefined);
      }

      // An absolute destination ends the chain: it is off this site.
      if (current.startsWith('https://')) break;
    }

    return current === path ? null : { toPath: current, statusCode };
  }

  /**
   * Records a redirect because a slug changed.
   *
   * Runs inside the caller's transaction, so a rename and its redirect either
   * both land or neither does. A rename that committed without its redirect
   * would be exactly the silent 404 this exists to prevent.
   *
   * A conflict is swallowed rather than raised: if the old path already
   * redirects somewhere, the rename is still legitimate and failing it would be
   * worse than leaving the older rule in place. It is logged so it can be
   * reviewed.
   */
  async recordSlugChange(
    tx: DbClient,
    fromPath: string,
    toPath: string,
    options: { reason: string; actor: ActorContext },
  ): Promise<void> {
    // A rename is always somebody's act. Narrowing here rather than at each
    // call site means an unattributed redirect cannot be written by accident —
    // "who moved this URL?" has an answer or the rename fails.
    const actor = requireNamedActor(options.actor);

    const from = normalisePath(fromPath);
    const to = normalisePath(toPath);
    if (from === null || to === null || from === to) return;

    try {
      // Anything that pointed at the old path now points at the new one, so a
      // second rename produces A → C rather than A → B → C.
      await tx.redirect.updateMany({
        where: { toPath: from },
        data: { toPath: to },
      });

      await tx.redirect.create({
        data: {
          fromPath: from,
          toPath: to,
          statusCode: 301,
          isAutomatic: true,
          reason: options.reason,
          createdById: actor.actorId,
          createdByLabel: actor.actorLabel,
        },
      });

      await this.audit.recordIn(tx, {
        action: GROWTH_AUDIT_ACTIONS.REDIRECT_CREATED,
        entityType: 'redirect',
        entityId: from,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: `Automatic: ${options.reason} slug changed.`,
        after: { fromPath: from, toPath: to, automatic: true },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        this.logger.warn(
          { fromPath: from, toPath: to },
          'a redirect already exists for this path; the rename kept the existing rule',
        );
        return;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------------

  async create(input: CreateRedirectInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    await this.assertNoCycle(input.fromPath, input.toPath);

    try {
      const redirect = await this.prisma.$transaction(async (tx) => {
        const created = await tx.redirect.create({
          data: {
            fromPath: input.fromPath,
            toPath: input.toPath,
            statusCode: input.statusCode,
            reason: input.reason ?? null,
            isAutomatic: false,
            createdById: actor.actorId,
            createdByLabel: actor.actorLabel,
          },
        });

        await this.audit.recordIn(tx, {
          action: GROWTH_AUDIT_ACTIONS.REDIRECT_CREATED,
          entityType: 'redirect',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { fromPath: created.fromPath, toPath: created.toPath },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return redirect;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppException.conflict(`${input.fromPath} already redirects somewhere.`);
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateRedirectInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);
    const existing = await this.prisma.redirect.findUnique({ where: { id } });
    if (!existing) throw AppException.notFound('Redirect');

    if (input.toPath && input.toPath !== existing.toPath) {
      await this.assertNoCycle(existing.fromPath, input.toPath);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.redirect.update({
        where: { id },
        data: {
          ...(input.toPath !== undefined ? { toPath: input.toPath } : {}),
          ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: GROWTH_AUDIT_ACTIONS.REDIRECT_UPDATED,
        entityType: 'redirect',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { toPath: existing.toPath, isActive: existing.isActive },
        after: { toPath: saved.toPath, isActive: saved.isActive },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return saved;
    });

    return updated;
  }

  async remove(id: string, rawActor: ActorContext): Promise<void> {
    const actor = requireNamedActor(rawActor);
    const existing = await this.prisma.redirect.findUnique({ where: { id } });
    if (!existing) throw AppException.notFound('Redirect');

    await this.prisma.$transaction(async (tx) => {
      await tx.redirect.delete({ where: { id } });
      await this.audit.recordIn(tx, {
        action: GROWTH_AUDIT_ACTIONS.REDIRECT_DELETED,
        entityType: 'redirect',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { fromPath: existing.fromPath, toPath: existing.toPath },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  async list(query: RedirectQuery) {
    const rows = await this.prisma.redirect.findMany({
      where: {
        ...(query.activeOnly ? { isActive: true } : {}),
        ...(query.search
          ? {
              OR: [
                { fromPath: { contains: query.search, mode: 'insensitive' as const } },
                { toPath: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ hitCount: 'desc' }, { createdAt: 'desc' }],
      take: query.limit + 1,
    });

    return {
      data: rows.slice(0, query.limit),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Refuses a redirect that would create a cycle.
   *
   * Walks forward from the proposed destination: if following existing rules
   * leads back to the source, adding this one closes a loop. A loop is not a
   * degraded experience — it is the page becoming unreachable.
   */
  private async assertNoCycle(fromPath: string, toPath: string): Promise<void> {
    if (fromPath === toPath) {
      throw AppException.conflict('A redirect to itself is a loop.');
    }

    let current = toPath;
    for (let hop = 0; hop < MAX_CHAIN_DEPTH; hop += 1) {
      if (current.startsWith('https://')) return;

      const next = await this.prisma.redirect.findFirst({
        where: { fromPath: current, isActive: true },
        select: { toPath: true },
      });
      if (!next) return;

      if (next.toPath === fromPath) {
        throw AppException.conflict(
          `That would create a redirect loop: ${fromPath} → ${toPath} → … → ${fromPath}.`,
        );
      }
      current = next.toPath;
    }

    throw AppException.conflict(
      'That redirect chain is too long. Point the old path straight at its final destination.',
    );
  }
}
