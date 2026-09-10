/**
 * Log redaction rules.
 *
 * Section 60 of the platform brief: passwords, tokens, payment credentials and
 * customer identifiers must never reach a log sink in clear text.
 */

/** Paths passed to pino's built-in redaction engine. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-api-key"]',
  'req.headers["stripe-signature"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'challengeToken',
  '*.challengeToken',
  'secret',
  '*.secret',
  'secretCiphertext',
  '*.secretCiphertext',
  'totpCode',
  '*.totpCode',
  'recoveryCode',
  '*.recoveryCode',
  'cardNumber',
  '*.cardNumber',
  'cvv',
  '*.cvv',
  'ssn',
  '*.ssn',
] as const;

/** `a***@example.com` — enough to correlate a support ticket, not enough to harvest. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** Keeps the last four digits only. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * IPv4 is truncated to /24 and IPv6 to /48 before storage. That is enough for
 * abuse detection and "where was this session used" without retaining a
 * precise location trail.
 */
export function truncateIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const value = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (value.includes('.')) {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (value.includes(':')) {
    const parts = value.split(':');
    return `${parts.slice(0, 3).join(':')}::`;
  }
  return null;
}

const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|authorization|cookie|cvv|card|ssn|apikey|api_key|private_key)/i;

/**
 * Deep-redacts an object before it is written to an audit log or error report.
 * Structure is preserved so diffs stay readable.
 */
export function redactObject<T>(input: T, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((item) => redactObject(item, depth + 1));
  if (input instanceof Date) return input.toISOString();
  if (typeof input !== 'object') return input;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = '[Redacted]';
    } else if (key === 'email' && typeof value === 'string') {
      output[key] = maskEmail(value);
    } else if ((key === 'phone' || key === 'phoneNumber') && typeof value === 'string') {
      output[key] = maskPhone(value);
    } else {
      output[key] = redactObject(value, depth + 1);
    }
  }
  return output;
}
