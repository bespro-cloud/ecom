import type { ServerEnv } from '@health/config';
import { ConsoleEmailProvider, ConsoleSmsProvider } from './console-provider.js';
import { SmtpEmailProvider } from './smtp-provider.js';
import type { EmailProvider, SmsProvider } from './types.js';

/**
 * Selects the configured adapter.
 *
 * Providers that are declared but not implemented fail loudly at construction
 * rather than silently falling back to the console adapter — a silent fallback
 * would mean customer mail vanishing into a log file.
 */
export function createEmailProvider(env: ServerEnv): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'console':
      return new ConsoleEmailProvider();
    case 'smtp':
      if (!env.SMTP_URL) {
        throw new Error('EMAIL_PROVIDER=smtp requires SMTP_URL to be set.');
      }
      return new SmtpEmailProvider({ url: env.SMTP_URL, from: env.EMAIL_FROM });
    default:
      throw new Error(
        `EMAIL_PROVIDER="${env.EMAIL_PROVIDER}" is declared in configuration but no adapter is implemented. ` +
          'Implement it in @health/notifications before enabling it.',
      );
  }
}

export function createSmsProvider(env: ServerEnv): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case 'console':
      return new ConsoleSmsProvider();
    default:
      throw new Error(
        `SMS_PROVIDER="${env.SMS_PROVIDER}" is declared in configuration but no adapter is implemented. ` +
          'Implement it in @health/notifications before enabling it.',
      );
  }
}
