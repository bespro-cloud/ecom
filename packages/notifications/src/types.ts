/**
 * Provider-agnostic notification contracts.
 *
 * The commerce domain never talks to a mail or SMS vendor directly: it hands a
 * `EmailMessage` to whichever adapter is configured. Swapping vendors is a
 * configuration change, not a code change.
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailMessage {
  to: EmailAddress;
  subject: string;
  /** Plain-text body. Always required — never send HTML-only mail. */
  text: string;
  html?: string;
  replyTo?: EmailAddress;
  /**
   * Deduplication key. Providers that support it use this to collapse
   * redelivery of the same logical message; adapters that do not are still
   * given it so it can be logged and correlated.
   */
  idempotencyKey?: string;
  tags?: Record<string, string>;
}

export interface SmsMessage {
  to: string;
  body: string;
  idempotencyKey?: string;
}

export interface DeliveryResult {
  /** Provider-assigned id, when the provider returns one. */
  providerMessageId: string | null;
  provider: string;
  acceptedAt: Date;
}

export class NotificationDeliveryError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    /**
     * Whether another attempt could plausibly succeed. A rejected recipient is
     * permanent; a timeout is not. The worker uses this to decide between
     * retrying and dead-lettering.
     */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'NotificationDeliveryError';
    if (options?.cause) this.cause = options.cause;
  }
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<DeliveryResult>;
  verifyConfiguration(): Promise<void>;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<DeliveryResult>;
  verifyConfiguration(): Promise<void>;
}
