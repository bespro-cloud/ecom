import type {
  DeliveryResult,
  EmailMessage,
  EmailProvider,
  SmsMessage,
  SmsProvider,
} from './types.js';

/**
 * Development adapter.
 *
 * Writes the message to the log instead of sending it. This is NOT a stand-in
 * for a real provider: `parseServerEnv` refuses to boot a production process
 * configured to use it, so it cannot reach customers by accident.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  constructor(private readonly sink: (line: string) => void = console.warn) {}

  async send(message: EmailMessage): Promise<DeliveryResult> {
    this.sink(
      [
        '',
        '─── DEVELOPMENT EMAIL (not sent) ───',
        `To:      ${message.to.email}`,
        `Subject: ${message.subject}`,
        message.idempotencyKey ? `Key:     ${message.idempotencyKey}` : '',
        '',
        message.text,
        '────────────────────────────────────',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return { providerMessageId: null, provider: this.name, acceptedAt: new Date() };
  }

  async verifyConfiguration(): Promise<void> {
    // Nothing to verify: there is no remote service.
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';

  constructor(private readonly sink: (line: string) => void = console.warn) {}

  async send(message: SmsMessage): Promise<DeliveryResult> {
    this.sink(`─── DEVELOPMENT SMS (not sent) ─── to ${message.to}: ${message.body}`);
    return { providerMessageId: null, provider: this.name, acceptedAt: new Date() };
  }

  async verifyConfiguration(): Promise<void> {
    // Nothing to verify.
  }
}
