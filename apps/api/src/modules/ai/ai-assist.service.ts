import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import {
  suggestionKindFor,
  type AiPurpose,
  type AiSuggestionKind,
  type GuardrailFinding,
} from '@health/types';
import type { PermissionKey } from '@health/types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../rbac/roles.service.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { KnowledgeService, type KnowledgeChunk } from './knowledge.service.js';
import { systemPromptFor } from './prompts.js';
import { AI_AUDIT_ACTIONS } from './ai.audit.js';

/**
 * AI assistance.
 *
 * Each method here is one of the declared purposes, and each ends the same way:
 * a **suggestion** somebody has to accept. Nothing in this file writes to a
 * product, a claim, a page, an order or a compliance record, and none of them
 * could — the suggestion kinds do not reach those tables.
 *
 * What each method actually contributes is the *grounding*: which approved
 * records go into the prompt, and what the model is asked to do with them. The
 * safety comes from the gateway and the guardrails; the usefulness comes from
 * here.
 */

export interface AssistResult {
  suggestionId: string | null;
  interactionId: string;
  status: 'PENDING' | 'BLOCKED' | 'UNAVAILABLE';
  content: unknown;
  findings: GuardrailFinding[];
  sources: Array<{ id: string; title: string; reference: string }>;
  isRealModel: boolean;
  message?: string;
}

@Injectable()
export class AiAssistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly knowledge: KnowledgeService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(AiAssistService.name);
  }

  get enabled(): boolean {
    return this.gateway.enabled;
  }

  /**
   * A digest of the evidence accepted against a claim.
   *
   * For a reviewer who is going to read the studies anyway. The prompt forbids
   * an opinion on substantiation, and the reason is worth stating: an AI saying
   * "the evidence appears to support this claim" would anchor a decision it is
   * not accountable for, made by a person who is. The digest saves reading
   * time; it does not save judgement.
   *
   * If nothing is accepted against the claim, no model is called at all.
   */
  async digestEvidenceForClaim(
    claimId: string,
    permissions: readonly PermissionKey[],
    rawActor: ActorContext,
  ): Promise<AssistResult> {
    const actor = requireNamedActor(rawActor);

    const claim = await this.prisma.productClaim.findUnique({
      where: { id: claimId },
      include: { currentVersion: { select: { text: true } } },
    });
    if (!claim) throw AppException.notFound('Claim');

    const sources = await this.knowledge.evidenceForClaim(claimId, permissions);

    return this.assist({
      purpose: 'EVIDENCE_DIGEST',
      prompt: [
        'Summarise the evidence records below for the reviewer of this claim.',
        `The claim under review reads: "${claim.currentVersion?.text ?? '(no text recorded)'}"`,
        '',
        'Give the reviewer a neutral digest of each record, including its',
        'limitations. Do not say whether the evidence substantiates the claim.',
      ].join('\n'),
      sources,
      targetType: 'product_claim',
      targetId: claimId,
      actor,
    });
  }

  /** Answers a staff question from approved records, with citations. */
  async answerFromKnowledge(
    question: string,
    permissions: readonly PermissionKey[],
    rawActor: ActorContext,
  ): Promise<AssistResult> {
    const actor = requireNamedActor(rawActor);
    const sources = await this.knowledge.retrieve(question, { permissions });

    return this.assist({
      purpose: 'KNOWLEDGE_ANSWER',
      prompt: question,
      sources,
      targetType: null,
      targetId: null,
      actor,
    });
  }

  /**
   * Drafts descriptive copy for a product.
   *
   * Grounded in the product's own recorded facts and its *approved* claims —
   * so if the draft does mention an effect, it is one somebody already approved
   * rather than one the model thought of. Any effect the model invents is
   * caught by the output scan, which blocks rather than flags for
   * customer-facing copy.
   */
  async draftProductCopy(
    productId: string,
    permissions: readonly PermissionKey[],
    rawActor: ActorContext,
  ): Promise<AssistResult> {
    const actor = requireNamedActor(rawActor);

    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, name: true, type: true, brand: true, countryOfOrigin: true },
    });
    if (!product) throw AppException.notFound('Product');

    const sources = await this.knowledge.retrieve(product.name, {
      permissions,
      productId,
      types: ['PRODUCT', 'CLAIM'],
    });

    return this.assist({
      purpose: 'PRODUCT_COPY_DRAFT',
      prompt: [
        `Draft descriptive copy for this product: ${product.name}.`,
        `Type: ${product.type}.`,
        product.brand ? `Brand: ${product.brand}.` : '',
        product.countryOfOrigin ? `Made in: ${product.countryOfOrigin}.` : '',
        '',
        'Describe what it is. Do not describe what it does to a person.',
      ]
        .filter(Boolean)
        .join('\n'),
      sources,
      targetType: 'product',
      targetId: productId,
      actor,
    });
  }

  /** Drafts a page title and meta description. */
  async draftSeoMetadata(
    input: { entityType: 'PRODUCT' | 'PAGE' | 'BLOG_POST'; entityId: string; subject: string },
    permissions: readonly PermissionKey[],
    rawActor: ActorContext,
  ): Promise<AssistResult> {
    const actor = requireNamedActor(rawActor);
    const sources = await this.knowledge.retrieve(input.subject, { permissions });

    return this.assist({
      purpose: 'SEO_METADATA_DRAFT',
      prompt: `Draft a page title and meta description for a page about: ${input.subject}`,
      sources,
      targetType: `seo:${input.entityType}`,
      targetId: input.entityId,
      actor,
      parse: parseSeoMetadata,
    });
  }

  /** Drafts an outline for an article. */
  async draftBlogOutline(
    topic: string,
    permissions: readonly PermissionKey[],
    rawActor: ActorContext,
  ): Promise<AssistResult> {
    const actor = requireNamedActor(rawActor);
    const sources = await this.knowledge.retrieve(topic, { permissions });

    return this.assist({
      purpose: 'BLOG_OUTLINE_DRAFT',
      prompt: `Draft a section outline for an article about: ${topic}`,
      sources,
      targetType: null,
      targetId: null,
      actor,
    });
  }

  /**
   * Narrates figures that have already been computed.
   *
   * The numbers are supplied in the prompt and the model is told not to compute
   * any. It cannot query anything — the gateway has no tools — so the worst
   * case is a misreading of numbers a person can check against the dashboard
   * they are standing on.
   */
  async summariseAnalytics(
    figures: Record<string, unknown>,
    rawActor: ActorContext,
  ): Promise<AssistResult> {
    const actor = requireNamedActor(rawActor);

    return this.assist({
      purpose: 'ANALYTICS_SUMMARY',
      prompt: [
        'Narrate these figures. Use only the numbers given.',
        '',
        JSON.stringify(figures, null, 2),
      ].join('\n'),
      sources: [],
      targetType: null,
      targetId: null,
      actor,
    });
  }

  /**
   * Drafts a reply to a support conversation.
   *
   * The conversation is redacted by the gateway before it leaves. The prompt
   * refuses health questions outright, and the output scan blocks clinical
   * advice everywhere — including in drafts, because a draft is one click from
   * being sent.
   */
  async draftSupportReply(threadId: string, rawActor: ActorContext): Promise<AssistResult> {
    const actor = requireNamedActor(rawActor);

    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, take: 20 },
        order: { select: { reference: true, status: true } },
      },
    });
    if (!thread) throw AppException.notFound('Conversation');

    const transcript = thread.messages
      .filter((message) => !message.isInternal)
      .map(
        (message) => `${message.authorType === 'STAFF' ? 'Support' : 'Customer'}: ${message.body}`,
      )
      .join('\n');

    return this.assist({
      purpose: 'SUPPORT_REPLY_DRAFT',
      prompt: [
        `Topic: ${thread.topic}. Subject: ${thread.subject}.`,
        thread.order ? `This is about an order with status ${thread.order.status}.` : '',
        '',
        'Conversation so far:',
        transcript,
        '',
        'Draft a reply for a support agent to review and send.',
      ]
        .filter(Boolean)
        .join('\n'),
      sources: [],
      targetType: 'support_thread',
      targetId: threadId,
      actor,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The shared path: call the gateway, then record a suggestion.
   *
   * A blocked output still produces a suggestion row, in `BLOCKED` state. That
   * is deliberate — the refusal is visible in the queue rather than vanishing,
   * so somebody reviewing how this system behaves sees the near-misses. A
   * database trigger makes that state final: a blocked suggestion can never be
   * accepted by any route.
   */
  private async assist(input: {
    purpose: AiPurpose;
    prompt: string;
    sources: KnowledgeChunk[];
    targetType: string | null;
    targetId: string | null;
    actor: { actorId: string; actorLabel: string };
    parse?: (text: string) => unknown;
  }): Promise<AssistResult> {
    const result = await this.gateway.run({
      purpose: input.purpose,
      system: systemPromptFor(input.purpose),
      userPrompt: input.prompt,
      sources: input.sources,
      actor: input.actor,
    });

    const sources = result.sources.map((source) => ({
      id: source.id,
      title: source.title,
      reference: source.reference,
    }));

    if (result.outcome === 'COMPLETED' || result.outcome === 'BLOCKED') {
      const content =
        result.outcome === 'COMPLETED' && result.text !== null
          ? (input.parse?.(result.text) ?? { text: result.text })
          : { text: null, refused: result.message ?? 'Refused by the guardrails.' };

      const suggestion = await this.prisma.aiSuggestion.create({
        data: {
          interactionId: result.interactionId,
          kind: suggestionKindFor(input.purpose),
          status: result.outcome === 'BLOCKED' ? 'BLOCKED' : 'PENDING',
          targetType: input.targetType,
          targetId: input.targetId,
          content: content as never,
          requestedById: input.actor.actorId,
          requestedByLabel: input.actor.actorLabel,
        },
        select: { id: true },
      });

      return {
        suggestionId: suggestion.id,
        interactionId: result.interactionId,
        status: result.outcome === 'BLOCKED' ? 'BLOCKED' : 'PENDING',
        content,
        findings: result.findings,
        sources,
        isRealModel: result.isRealModel,
        message: result.message,
      };
    }

    // NO_GROUNDING, REFUSED, FAILED: nothing usable, and no suggestion. The
    // interaction is recorded regardless, which is where these show up.
    return {
      suggestionId: null,
      interactionId: result.interactionId,
      status: 'UNAVAILABLE',
      content: null,
      findings: result.findings,
      sources,
      isRealModel: result.isRealModel,
      message: result.message,
    };
  }

  // -------------------------------------------------------------------------
  // The suggestion queue
  // -------------------------------------------------------------------------

  async listSuggestions(status?: string, limit = 50) {
    const rows = await this.prisma.aiSuggestion.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: {
        interaction: {
          select: {
            purpose: true,
            provider: true,
            model: true,
            isRealModel: true,
            retrievedIds: true,
            guardrailFindings: true,
            createdAt: true,
          },
        },
      },
    });

    return {
      data: rows.slice(0, limit).map((row) => this.toView(row)),
      meta: { hasMore: rows.length > limit },
    };
  }

  async findSuggestion(id: string) {
    const suggestion = await this.prisma.aiSuggestion.findUnique({
      where: { id },
      include: { interaction: true },
    });
    if (!suggestion) throw AppException.notFound('Suggestion');
    return this.toView(suggestion);
  }

  /**
   * Accepting.
   *
   * This is the moment the words stop being a machine's and start being a
   * person's. The accepting staff member is recorded as having decided, and for
   * kinds that write somewhere, the write is attributed to them.
   *
   * Accepting applies the text to a **draft**. It does not publish anything, it
   * does not approve anything, and for a product it writes the draft
   * description rather than the live one — which then goes through the normal
   * publishing and compliance path like any other edit.
   */
  async decideSuggestion(
    id: string,
    input: { decision: 'ACCEPTED' | 'REJECTED'; notes?: string },
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);

    const suggestion = await this.prisma.aiSuggestion.findUnique({
      where: { id },
      include: { interaction: { select: { purpose: true } } },
    });
    if (!suggestion) throw AppException.notFound('Suggestion');

    if (suggestion.status === 'BLOCKED') {
      throw AppException.conflict(
        'The guardrails refused this text, so it cannot be accepted. Generate it again if it is still wanted.',
      );
    }
    if (suggestion.status !== 'PENDING') {
      throw AppException.conflict('This suggestion has already been decided.');
    }

    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.aiSuggestion.update({
        where: { id },
        data: {
          status: input.decision,
          decidedById: actor.actorId,
          decidedByLabel: actor.actorLabel,
          decidedAt: now,
          decisionNotes: input.notes ?? null,
        },
      });

      if (input.decision === 'ACCEPTED') {
        await this.apply(tx, suggestion.kind as AiSuggestionKind, suggestion);
      }

      await this.audit.recordIn(tx, {
        action:
          input.decision === 'ACCEPTED'
            ? AI_AUDIT_ACTIONS.SUGGESTION_ACCEPTED
            : AI_AUDIT_ACTIONS.SUGGESTION_REJECTED,
        entityType: 'ai_suggestion',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes ?? null,
        after: {
          kind: suggestion.kind,
          purpose: suggestion.interaction.purpose,
          targetType: suggestion.targetType,
          targetId: suggestion.targetId,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return this.findSuggestion(id);
  }

  /**
   * Applies an accepted suggestion.
   *
   * Every branch writes descriptive text to a draft. There is no branch that
   * publishes, approves, refunds or adjusts anything — and the suggestion kind
   * enum has no member that could ask for one, in the application and in a
   * database CHECK.
   */
  private async apply(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    kind: AiSuggestionKind,
    suggestion: { targetType: string | null; targetId: string | null; content: unknown },
  ): Promise<void> {
    const content = suggestion.content as Record<string, unknown> | null;
    if (!content) return;

    switch (kind) {
      case 'PRODUCT_DESCRIPTION': {
        if (!suggestion.targetId || typeof content.text !== 'string') return;
        // The *short* description, and only on a product. Publishing it is a
        // separate act by somebody with PRODUCT_PUBLISH, and a compliance-
        // relevant change re-opens the compliance review as it always does.
        await tx.product.update({
          where: { id: suggestion.targetId },
          data: { shortDescription: content.text.slice(0, 500) },
        });
        return;
      }

      case 'SEO_METADATA': {
        if (!suggestion.targetId || !suggestion.targetType) return;
        const entityType = suggestion.targetType.replace('seo:', '');
        if (!['PRODUCT', 'PAGE', 'CATEGORY', 'INGREDIENT'].includes(entityType)) return;

        await tx.seoMetadata.upsert({
          where: {
            entityType_entityId: {
              entityType: entityType as never,
              entityId: suggestion.targetId,
            },
          },
          create: {
            entityType: entityType as never,
            entityId: suggestion.targetId,
            title: typeof content.title === 'string' ? content.title : null,
            description: typeof content.description === 'string' ? content.description : null,
          },
          update: {
            title: typeof content.title === 'string' ? content.title : undefined,
            description: typeof content.description === 'string' ? content.description : undefined,
          },
        });
        return;
      }

      case 'BLOG_OUTLINE':
      case 'SUPPORT_REPLY':
      case 'ADVISORY_NOTE':
        // Nothing to write. These are read by the person who asked: an outline
        // is pasted into an editor, a reply into a composer, a note is simply
        // read. Accepting records that somebody found it useful and puts their
        // name on having used it.
        return;
    }
  }

  private toView(row: {
    id: string;
    kind: string;
    status: string;
    targetType: string | null;
    targetId: string | null;
    content: unknown;
    requestedByLabel: string;
    decidedByLabel: string | null;
    decidedAt: Date | null;
    decisionNotes: string | null;
    createdAt: Date;
    interaction: {
      purpose: string;
      provider: string;
      model: string;
      isRealModel: boolean;
      retrievedIds: string[];
      guardrailFindings: unknown;
      createdAt: Date;
    };
  }) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      targetType: row.targetType,
      targetId: row.targetId,
      content: row.content,
      requestedBy: row.requestedByLabel,
      decidedBy: row.decidedByLabel,
      decidedAt: row.decidedAt,
      decisionNotes: row.decisionNotes,
      createdAt: row.createdAt,
      purpose: row.interaction.purpose,
      provider: row.interaction.provider,
      model: row.interaction.model,
      /**
       * False when a development stand-in produced this.
       *
       * Carried all the way to the screen so nothing can present stand-in prose
       * as model output, the same way an order paid through the development
       * payment provider is labelled.
       */
      isRealModel: row.interaction.isRealModel,
      sourceIds: row.interaction.retrievedIds,
      findings: row.interaction.guardrailFindings ?? [],
    };
  }
}

/**
 * Pulls a title and description out of the two-line format the prompt asks for.
 *
 * Tolerant of the model ignoring the format, because it sometimes will: an
 * unparseable response yields the raw text and a person reads it, rather than
 * an exception or a silently empty field.
 */
function parseSeoMetadata(text: string): unknown {
  const title = /^TITLE:\s*(.+)$/im.exec(text)?.[1]?.trim();
  const description = /^DESCRIPTION:\s*(.+)$/im.exec(text)?.[1]?.trim();
  if (!title && !description) return { text };
  return { title: title ?? null, description: description ?? null, text };
}
