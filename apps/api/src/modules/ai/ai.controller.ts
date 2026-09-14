import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  aiAnalyticsSummarySchema,
  aiBlogOutlineSchema,
  aiClaimDigestSchema,
  aiInteractionQuerySchema,
  aiProductCopySchema,
  aiQuestionSchema,
  aiSeoDraftSchema,
  aiSuggestionQuerySchema,
  aiSupportDraftSchema,
  decideAiSuggestionSchema,
  uuidSchema,
  type AiAnalyticsSummaryInput,
  type AiBlogOutlineInput,
  type AiClaimDigestInput,
  type AiInteractionQuery,
  type AiProductCopyInput,
  type AiQuestionInput,
  type AiSeoDraftInput,
  type AiSuggestionQuery,
  type AiSupportDraftInput,
  type DecideAiSuggestionInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { PROHIBITED_OF_AI } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { AiAssistService } from './ai-assist.service.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiInteractionsService } from './ai-interactions.service.js';
import { AnalyticsReportingService } from '../growth/analytics/reporting.service.js';

/**
 * AI assistance, for staff.
 *
 * **There is no customer-facing AI in this platform, and that is a decision
 * rather than an omission.** A storefront assistant asked "will this help my
 * anxiety?" would retrieve approved structure/function claims and assemble them
 * into an answer tailored to a stated condition — which is a health claim made
 * to a specific person about their specific symptom, and is the single most
 * dangerous thing that could be built here. It would also be a support channel
 * collecting health information the business has no lawful basis to hold.
 *
 * So every route below requires `AI_USE` and a staff session. Nothing here can
 * be reached by a customer, and the support draft route produces text for an
 * agent to read and edit rather than anything that gets sent.
 *
 * Every route returns a *suggestion*. None of them changes anything.
 */
@ApiTags('AI')
@Controller({ path: 'admin/ai', version: '1' })
export class AiController {
  constructor(
    private readonly assist: AiAssistService,
    private readonly gateway: AiGatewayService,
    private readonly interactions: AiInteractionsService,
    private readonly analytics: AnalyticsReportingService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  @Get('status')
  @RequirePermissions('AI_USE')
  @ApiOperation({
    summary: 'Whether AI assistance is available, and what it may do',
    description:
      'Screens ask this before offering anything. A deployment with AI disabled is normal, and the prohibited list is returned so the interface can state the boundary rather than implying there is not one.',
  })
  status() {
    return {
      enabled: this.gateway.enabled,
      provider: this.gateway.providerName,
      /** False for the development stand-in. Screens label its output. */
      isRealModel: this.gateway.isRealModel,
      prohibited: PROHIBITED_OF_AI,
    };
  }

  // --- assistance ----------------------------------------------------------

  @Post('evidence-digest')
  @RequirePermissions('AI_USE', 'EVIDENCE_READ')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Summarise the evidence accepted against a claim',
    description:
      'A neutral digest for a reviewer who will read the studies themselves. It will not say whether the evidence substantiates the claim — that judgement is the reviewer’s and is why the role exists. Nothing is generated when no evidence has been accepted.',
  })
  async evidenceDigest(
    @Body(zodBody(aiClaimDigestSchema)) input: AiClaimDigestInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.assist.digestEvidenceForClaim(
      input.claimId,
      principal.permissions,
      this.actor(principal, request),
    );
  }

  @Post('ask')
  @RequirePermissions('AI_USE')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Ask a question of approved records',
    description:
      'Retrieval is scoped to what the asking staff member could read directly, so an answer cannot become an authorisation bypass. When nothing approved matches, no model is called and the answer says so.',
  })
  async ask(
    @Body(zodBody(aiQuestionSchema)) input: AiQuestionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.assist.answerFromKnowledge(
      input.question,
      principal.permissions,
      this.actor(principal, request),
    );
  }

  @Post('product-copy')
  @RequirePermissions('AI_USE', 'PRODUCT_WRITE')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Draft descriptive copy for a product',
    description:
      'Describes what the product is, not what it does to a person. Any effect claim in the output blocks the suggestion outright rather than arriving as a tempting draft.',
  })
  async productCopy(
    @Body(zodBody(aiProductCopySchema)) input: AiProductCopyInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.assist.draftProductCopy(
      input.productId,
      principal.permissions,
      this.actor(principal, request),
    );
  }

  @Post('seo-metadata')
  @RequirePermissions('AI_USE', 'SEO_WRITE')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Draft a page title and meta description',
    description:
      'Phase 6 established that nothing generates copy for a health product automatically. This does not: it drafts, a named person accepts, and accepting is what puts the words on the page.',
  })
  async seoMetadata(
    @Body(zodBody(aiSeoDraftSchema)) input: AiSeoDraftInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.assist.draftSeoMetadata(
      input,
      principal.permissions,
      this.actor(principal, request),
    );
  }

  @Post('blog-outline')
  @RequirePermissions('AI_USE', 'BLOG_WRITE')
  @RateLimit('sensitive')
  @ApiOperation({ summary: 'Draft a section outline for an article' })
  async blogOutline(
    @Body(zodBody(aiBlogOutlineSchema)) input: AiBlogOutlineInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.assist.draftBlogOutline(
      input.topic,
      principal.permissions,
      this.actor(principal, request),
    );
  }

  @Post('support-reply')
  @RequirePermissions('AI_USE', 'SUPPORT_WRITE')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Draft a reply to a support conversation',
    description:
      'For an agent to read, edit and send. The conversation is redacted before it leaves for the provider, and clinical advice in the output is blocked — a draft is one click from being sent.',
  })
  async supportReply(
    @Body(zodBody(aiSupportDraftSchema)) input: AiSupportDraftInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.assist.draftSupportReply(input.threadId, this.actor(principal, request));
  }

  @Post('analytics-summary')
  @RequirePermissions('AI_USE', 'ANALYTICS_READ')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Narrate figures that have already been computed',
    description:
      'The numbers are supplied in the prompt and the model is told not to compute any or explain why anything changed — a plausible causal story is the most expensive kind of wrong on a dashboard.',
  })
  async analyticsSummary(
    @Body(zodBody(aiAnalyticsSummarySchema)) input: AiAnalyticsSummaryInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const overview = await this.analytics.overview(input);
    return this.assist.summariseAnalytics(
      {
        from: overview.from,
        to: overview.to,
        sessions: overview.totals.sessions,
        orders: overview.totals.orders,
        revenue: `${(overview.totals.revenueCents / 100).toFixed(2)}`,
        conversionRate: overview.totals.conversionRate,
        funnel: overview.funnel.map((stage) => ({ step: stage.step, sessions: stage.sessions })),
      },
      this.actor(principal, request),
    );
  }

  // --- the suggestion queue ------------------------------------------------

  @Get('suggestions')
  @RequirePermissions('AI_USE')
  @ApiOperation({ summary: 'Suggestions awaiting a person' })
  async suggestions(@Query(zodBody(aiSuggestionQuerySchema)) query: AiSuggestionQuery) {
    return this.assist.listSuggestions(query.status, query.limit);
  }

  @Get('suggestions/:id')
  @RequirePermissions('AI_USE')
  @ApiOperation({ summary: 'One suggestion, with what it was grounded in' })
  async suggestion(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.assist.findSuggestion(id);
  }

  @Post('suggestions/:id/decision')
  @RequirePermissions('AI_USE')
  @ApiOperation({
    summary: 'Accept or reject a suggestion',
    description:
      'Accepting is the moment the words stop being a machine’s and start being a person’s: the accepting staff member is recorded, and applying writes to a draft. It publishes nothing and approves nothing. A suggestion the guardrails blocked can never be accepted — the API refuses it and a database trigger refuses it regardless.',
  })
  async decide(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(decideAiSuggestionSchema)) input: DecideAiSuggestionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.assist.decideSuggestion(id, input, this.actor(principal, request));
  }

  // --- the audit trail -----------------------------------------------------

  @Get('interactions')
  @RequirePermissions('AI_CONFIGURE')
  @ApiOperation({
    summary: 'Every call made to a model, and every decision not to make one',
    description:
      'Append-only. Includes calls that were blocked, refused before they happened, or had nothing to ground them — a subsystem whose audit trail contains only its successes is worse than none, because it looks complete.',
  })
  async interactionLog(@Query(zodBody(aiInteractionQuerySchema)) query: AiInteractionQuery) {
    return this.interactions.list(query);
  }

  @Get('usage')
  @RequirePermissions('AI_CONFIGURE')
  @ApiOperation({ summary: 'Spend and call counts against the daily budget' })
  async usage() {
    return this.interactions.usage();
  }
}
