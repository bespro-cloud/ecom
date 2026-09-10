import nodemailer, { type Transporter } from 'nodemailer';
import {
  NotificationDeliveryError,
  type DeliveryResult,
  type EmailMessage,
  type EmailProvider,
} from './types.js';

/**
 * SMTP adapter.
 *
 * Real delivery over a real connection — used for staging and for deployments
 * that relay through their own MTA. Transient failures (4xx, timeouts) are
 * marked retryable; permanent rejections (5xx) are not, so the worker
 * dead-letters them instead of hammering the server.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;

  constructor(private readonly options: { url: string; from: string }) {
    // The connection URL carries host, port, credentials and TLS mode; pooling
    // keeps a handful of connections warm so a burst of order mail does not
    // reconnect for every message.
    this.transport = nodemailer.createTransport({
      url: options.url,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    } as nodemailer.TransportOptions);
  }

  async send(message: EmailMessage): Promise<DeliveryResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.options.from,
        to: message.to.name ? `${message.to.name} <${message.to.email}>` : message.to.email,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo.email } : {}),
        ...(message.idempotencyKey
          ? { headers: { 'X-Idempotency-Key': message.idempotencyKey } }
          : {}),
      });

      return {
        providerMessageId: info.messageId ?? null,
        provider: this.name,
        acceptedAt: new Date(),
      };
    } catch (error) {
      throw new NotificationDeliveryError('SMTP delivery failed', this.name, isRetryable(error), {
        cause: error,
      });
    }
  }

  async verifyConfiguration(): Promise<void> {
    await this.transport.verify();
  }
}

function isRetryable(error: unknown): boolean {
  const code = (error as { responseCode?: number; code?: string } | null)?.responseCode;
  if (typeof code === 'number') {
    // 4xx is a temporary refusal; 5xx means the message will never be accepted.
    return code >= 400 && code < 500;
  }
  const errno = (error as { code?: string } | null)?.code;
  return (
    errno === 'ETIMEDOUT' ||
    errno === 'ECONNRESET' ||
    errno === 'ECONNREFUSED' ||
    errno === 'EAI_AGAIN' ||
    errno === 'ESOCKET'
  );
}
