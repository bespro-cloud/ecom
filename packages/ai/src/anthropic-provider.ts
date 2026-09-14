import {
  AiProviderError,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
} from './provider.js';

/**
 * The Anthropic Messages API.
 *
 * A thin adapter over `fetch`, deliberately. An SDK would bring a dependency
 * whose surface includes tool use, streaming and agent loops — capabilities
 * this application refuses to offer — and the request this makes is small
 * enough that the indirection would hide more than it saves.
 *
 * Two things are enforced here rather than upstream:
 *
 * **No tools are ever sent.** The request body has no `tools` key, so there is
 * no configuration mistake that could let a model call one.
 *
 * **The request is bounded.** An explicit timeout and a token ceiling, because
 * a provider that hangs would hold a staff member's request open indefinitely
 * and an unbounded response is an unbounded bill.
 *
 * Errors are classified into retryable and not: a 429 or a 5xx is worth another
 * attempt with backoff, a 400 is a bug and retrying it just costs time.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Hard ceiling on a single call, in milliseconds. */
  timeoutMs?: number;
  /** Per-million-token prices in hundredths of a cent, from configuration. */
  pricing?: { inputPerMillionMicros: number; outputPerMillionMicros: number };
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly isRealModel = true;
  readonly pricing: { inputPerMillionMicros: number; outputPerMillionMicros: number };

  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: AnthropicOptions) {
    if (!options.apiKey) {
      throw new Error('AnthropicProvider requires an API key.');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // Prices come from configuration rather than being hard-coded, because a
    // stale price table silently makes every cost report wrong.
    this.pricing = options.pricing ?? {
      inputPerMillionMicros: 300_000,
      outputPerMillionMicros: 1_500_000,
    };
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // The caller's signal and our timeout both abort the same request.
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          system: request.system,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          // Note what is absent: no `tools`, no `tool_choice`. There is no key
          // here a model could use to act on the world.
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new AiProviderError(
          `http_${response.status}`,
          `The AI provider returned ${response.status}.`,
          response.status === 429 || response.status >= 500,
          // The body is not logged: a provider error can echo the prompt back,
          // and the prompt is redacted but not guaranteed to be uninteresting.
          body.slice(0, 200),
        );
      }

      const payload = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
        stop_reason?: string;
      };

      const text = (payload.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      return {
        text,
        usage: {
          inputTokens: payload.usage?.input_tokens ?? 0,
          outputTokens: payload.usage?.output_tokens ?? 0,
        },
        model: payload.model ?? this.model,
        stopReason: mapStopReason(payload.stop_reason),
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiProviderError(
          'timeout',
          'The AI provider did not respond in time.',
          true,
          error,
        );
      }
      throw new AiProviderError('network', 'Could not reach the AI provider.', true, error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function mapStopReason(reason: string | undefined): AiCompletion['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}
