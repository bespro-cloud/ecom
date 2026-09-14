import type { ServerEnv } from '@health/config';
import { AnthropicProvider } from './anthropic-provider.js';
import { DevelopmentAiProvider } from './development-provider.js';
import type { AiProvider } from './provider.js';

/**
 * Selects the AI provider from configuration.
 *
 * Three values, and the distinction between two of them matters:
 *
 * `disabled` means the platform has no AI features. It is a legitimate
 * production configuration — arguably the default one — and `createAiProvider`
 * returns null rather than throwing, so every AI code path is written to cope
 * with there being no model at all.
 *
 * `development` is the stand-in. `packages/config` refuses it in production,
 * with `scripts/verify-production-guards.mjs` asserting the refusal.
 *
 * `anthropic` is a real model and requires a key.
 */
export function createAiProvider(env: ServerEnv): AiProvider | null {
  switch (env.AI_PROVIDER) {
    case 'disabled':
      return null;

    case 'development':
      return new DevelopmentAiProvider();

    case 'anthropic':
      if (!env.AI_API_KEY) {
        throw new Error('AI_PROVIDER=anthropic requires AI_API_KEY.');
      }
      return new AnthropicProvider({
        apiKey: env.AI_API_KEY,
        model: env.AI_MODEL,
        timeoutMs: env.AI_TIMEOUT_MS,
        pricing: {
          inputPerMillionMicros: env.AI_INPUT_PRICE_MICROS,
          outputPerMillionMicros: env.AI_OUTPUT_PRICE_MICROS,
        },
      });

    default:
      // Not a silent fallback to the stand-in. A provider named in
      // configuration but not implemented must stop the process, or a
      // deployment could run AI features through an adapter nobody wrote.
      throw new Error(
        `AI_PROVIDER="${String(env.AI_PROVIDER)}" is declared in configuration but no adapter is implemented. ` +
          'Implement it in @health/ai before enabling it.',
      );
  }
}
