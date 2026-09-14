import {
  AiProviderError,
  type AiCompletion,
  type AiCompletionRequest,
  type AiProvider,
} from './provider.js';

/**
 * A development AI provider.
 *
 * **This is not a language model.** It exists so the gateway, the guardrails,
 * the audit trail, the suggestion queue and the admin screens can be built and
 * tested without an API key or a bill. It is a stand-in, and `isRealModel` is
 * false so nothing can mistake one for the other:
 *
 *  - the production configuration guard refuses to start with it selected;
 *  - the admin console labels every suggestion it produced;
 *  - the audit record stores the provider name on every interaction.
 *
 * What it faithfully reproduces is the *shape* of the real thing: token usage,
 * stop reasons, latency, retryable and non-retryable failures. And critically,
 * it can be asked to produce the dangerous outputs on demand — a disease claim,
 * an FDA assertion, a fabricated citation — so the guardrails are tested
 * against the failures that matter rather than against hopeful text.
 *
 * That last point is the reason this file is worth reading. A stand-in that
 * only ever returns safe output would let every guardrail rot untested.
 */

/**
 * Trigger phrases.
 *
 * Putting one of these in a prompt makes this provider return a specific kind
 * of bad output. They exist for tests and for exercising the admin screens; a
 * real provider ignores them completely, which is fine, because what is being
 * tested is the code that handles the output.
 */
export const DEV_TRIGGER_DISEASE_CLAIM = '__dev_disease_claim__';
export const DEV_TRIGGER_FDA_CLAIM = '__dev_fda_claim__';
export const DEV_TRIGGER_FABRICATED_CITATION = '__dev_fabricated_citation__';
export const DEV_TRIGGER_UNCITED = '__dev_uncited__';
export const DEV_TRIGGER_CLINICAL_ADVICE = '__dev_clinical_advice__';
export const DEV_TRIGGER_RETRYABLE_ERROR = '__dev_retryable_error__';
export const DEV_TRIGGER_FATAL_ERROR = '__dev_fatal_error__';
export const DEV_TRIGGER_LONG_OUTPUT = '__dev_long_output__';

export class DevelopmentAiProvider implements AiProvider {
  readonly name = 'development';
  readonly model = 'development-stand-in';
  readonly isRealModel = false;
  /**
   * Priced as though it were a real model, so budget accounting is exercised
   * rather than trivially passing with zeroes.
   */
  readonly pricing = { inputPerMillionMicros: 300_000, outputPerMillionMicros: 1_500_000 };

  private calls = 0;

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    this.calls += 1;
    const prompt = request.messages.map((message) => message.content).join('\n');

    if (prompt.includes(DEV_TRIGGER_RETRYABLE_ERROR)) {
      throw new AiProviderError('rate_limited', 'The provider is rate limiting.', true);
    }
    if (prompt.includes(DEV_TRIGGER_FATAL_ERROR)) {
      throw new AiProviderError('invalid_request', 'The provider rejected the request.', false);
    }

    const text = this.textFor(prompt);
    const outputTokens = Math.ceil(text.length / 4) + 1;

    return {
      text,
      usage: { inputTokens: Math.ceil(prompt.length / 4) + 1, outputTokens },
      model: this.model,
      stopReason: prompt.includes(DEV_TRIGGER_LONG_OUTPUT) ? 'length' : 'end',
    };
  }

  /** Calls made since start. Used by tests asserting a model was *not* called. */
  get callCount(): number {
    return this.calls;
  }

  private textFor(prompt: string): string {
    if (prompt.includes(DEV_TRIGGER_DISEASE_CLAIM)) {
      return 'This supplement cures insomnia and prevents anxiety in most people.';
    }
    if (prompt.includes(DEV_TRIGGER_FDA_CLAIM)) {
      return 'This FDA approved formula is clinically proven and third-party tested.';
    }
    if (prompt.includes(DEV_TRIGGER_CLINICAL_ADVICE)) {
      return 'You should take two capsules each evening for your condition.';
    }
    if (prompt.includes(DEV_TRIGGER_FABRICATED_CITATION)) {
      // The dangerous failure, reproduced faithfully: a citation in exactly the
      // right format, referring to something that was never retrieved.
      return 'Magnesium glycinate is well absorbed [[ev-does-not-exist]].';
    }
    if (prompt.includes(DEV_TRIGGER_UNCITED)) {
      return 'Magnesium is widely regarded as helpful for relaxation and general wellbeing.';
    }

    // The ordinary case: cite whatever sources the gateway put in the prompt,
    // so a grounded answer looks like a grounded answer.
    const ids = [...prompt.matchAll(/\[\[([A-Za-z0-9_:-]{1,64})\]\]/g)].map((match) => match[1]!);
    const citation = ids.length > 0 ? ` [[${ids[0]}]]` : '';

    return (
      'A development stand-in produced this text. It is not model output and says nothing ' +
      `about the product beyond what the recorded sources contain.${citation}`
    );
  }
}
