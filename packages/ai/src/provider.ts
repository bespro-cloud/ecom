/**
 * The AI provider contract.
 *
 * Deliberately small. A language model is a text-in, text-out service, and
 * every capability beyond that — tool calling, function execution, autonomous
 * agents — is a way for a model to take an action. This application never lets
 * a model take an action, so the interface offers no way to express one.
 *
 * There is no `tools`, no `functions`, no `executeCode`. Not "we don't use
 * them" — there is nothing to pass. A model here can produce words, and words
 * become a suggestion a person accepts.
 *
 * `isRealModel` mirrors `isRealMoney` on the payment provider, and for the same
 * reason: downstream code and the admin console need to know whether they are
 * looking at output from a real model or from a stand-in, and a boolean that
 * cannot be missed is the way to tell them.
 */

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  /**
   * The system instruction. Composed by the gateway from a fixed template per
   * purpose — never assembled from user input, which is how a prompt-injection
   * becomes an instruction.
   */
  system: string;
  messages: AiMessage[];
  /**
   * A ceiling on the response. Bounded because an unbounded response is an
   * unbounded bill and an unbounded wait.
   */
  maxOutputTokens: number;
  /**
   * Low by default. This system wants the same answer twice from the same
   * evidence; creativity is not a virtue when summarising a clinical trial.
   */
  temperature: number;
  /** Abort signal, so a slow provider cannot hold a request open forever. */
  signal?: AbortSignal;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiCompletion {
  text: string;
  usage: AiUsage;
  /** The model that actually answered, which may differ from the one asked for. */
  model: string;
  /** Why generation stopped. `length` means the answer was cut off. */
  stopReason: 'end' | 'length' | 'refusal' | 'other';
}

export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  readonly name: string;
  /** The model identifier this provider is configured to call. */
  readonly model: string;
  /**
   * False for the development stand-in.
   *
   * Nothing downstream may treat a stand-in's output as a real model's, and the
   * production configuration guard refuses to start with one selected.
   */
  readonly isRealModel: boolean;
  /** Per-million-token prices, in hundredths of a cent, for cost accounting. */
  readonly pricing: { inputPerMillionMicros: number; outputPerMillionMicros: number };

  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}
