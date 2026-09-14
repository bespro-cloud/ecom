import { Provider } from '@nestjs/common';
import { createAiProvider, type AiProvider } from '@health/ai';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';

/** Injection token for the configured AI provider, or null when AI is off. */
export const AI_PROVIDER = Symbol('AI_PROVIDER');

/**
 * Binds the AI provider into Nest's container.
 *
 * Injected in exactly one place — `AiGatewayService` — so there is no second
 * route to a model. A service that wanted to call one directly would have to
 * add this token to its constructor, and that is a line a reviewer sees.
 *
 * Resolves to `null` when `AI_PROVIDER=disabled`, which is a normal and
 * arguably the default production configuration. Every AI code path copes with
 * there being no model at all.
 */
export const aiProviderFactory: Provider = {
  provide: AI_PROVIDER,
  inject: [AppConfigService],
  useFactory: (configService: AppConfigService): AiProvider | null =>
    createAiProvider(configService.env),
};
