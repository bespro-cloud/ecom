import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { GrowthModule } from '../growth/growth.module.js';
import { aiProviderFactory } from './ai.provider.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiAssistService } from './ai-assist.service.js';
import { AiInteractionsService } from './ai-interactions.service.js';
import { KnowledgeService } from './knowledge.service.js';
import { AiController } from './ai.controller.js';

/**
 * AI.
 *
 * The provider token is bound here and injected in exactly one place —
 * `AiGatewayService`. Nothing else in the application can reach a model, so
 * every call passes the redaction, grounding, budget, guardrail and audit steps
 * whether its author remembered them or not.
 *
 * `GrowthModule` is imported for the analytics reporting service: the summary
 * feature narrates figures that have already been computed, and computing them
 * is not AI's job.
 *
 * Nothing is exported. Other modules do not get to call a model — if a feature
 * needs assistance, it gets a route here, where a reviewer can see it.
 */
@Module({
  imports: [AuditModule, GrowthModule],
  controllers: [AiController],
  providers: [
    aiProviderFactory,
    AiGatewayService,
    AiAssistService,
    AiInteractionsService,
    KnowledgeService,
  ],
})
export class AiModule {}
