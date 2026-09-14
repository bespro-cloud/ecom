import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@health/config';
import { utcDayKey } from '@health/types';
import type { AiInteractionQuery } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';

/**
 * Reading the AI audit trail.
 *
 * Separate from the gateway that writes it, so the reading path holds no
 * provider and cannot call a model. The trail is append-only in the database;
 * this service has no method that could change a row even if one were asked
 * for.
 *
 * The prompts stored are the redacted ones, exactly as sent. That is what makes
 * this table safe to keep forever and safe to show to whoever needs to review
 * how the feature behaves.
 */
@Injectable()
export class AiInteractionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(query: AiInteractionQuery) {
    const rows = await this.prisma.aiInteraction.findMany({
      where: {
        ...(query.purpose ? { purpose: query.purpose } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        purpose: true,
        outcome: true,
        provider: true,
        model: true,
        isRealModel: true,
        systemPrompt: true,
        userPrompt: true,
        wasRedacted: true,
        responseText: true,
        retrievedIds: true,
        guardrailFindings: true,
        blockedReason: true,
        inputTokens: true,
        outputTokens: true,
        costMicros: true,
        latencyMs: true,
        actorLabel: true,
        createdAt: true,
      },
    });

    return {
      data: rows.slice(0, query.limit),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  /**
   * Today's spend against the budget, and the shape of what has been asked.
   *
   * Computed from the append-only log rather than a counter, so it cannot drift
   * and a restart cannot reset it. The blocked and ungrounded counts are the
   * interesting ones: a rising block rate means the prompts or the retrieval
   * need work, and it is the number nobody thinks to build a view for.
   */
  async usage() {
    const day = utcDayKey(this.clock.now());

    const [spend, byOutcome, byPurpose] = await Promise.all([
      this.prisma.aiInteraction.aggregate({
        where: { day },
        _sum: { costMicros: true, inputTokens: true, outputTokens: true },
        _count: { _all: true },
      }),
      this.prisma.aiInteraction.groupBy({
        by: ['outcome'],
        where: { day },
        _count: { _all: true },
      }),
      this.prisma.aiInteraction.groupBy({
        by: ['purpose'],
        where: { day },
        _count: { _all: true },
        _sum: { costMicros: true },
      }),
    ]);

    const limitMicros = this.config.env.AI_DAILY_BUDGET_MICROS;
    const spentMicros = spend._sum.costMicros ?? 0;

    return {
      day,
      calls: spend._count._all,
      spentMicros,
      limitMicros,
      remainingMicros: Math.max(limitMicros - spentMicros, 0),
      inputTokens: spend._sum.inputTokens ?? 0,
      outputTokens: spend._sum.outputTokens ?? 0,
      byOutcome: byOutcome.map((row) => ({ outcome: row.outcome, calls: row._count._all })),
      byPurpose: byPurpose.map((row) => ({
        purpose: row.purpose,
        calls: row._count._all,
        costMicros: row._sum.costMicros ?? 0,
      })),
    };
  }
}
