import { z } from 'zod';

/**
 * Environment contract for every server-side process.
 *
 * The process refuses to boot when this fails to parse. That is deliberate:
 * a missing signing key or an unset database URL must never degrade into a
 * silently insecure default.
 */

const nodeEnv = z.enum(['development', 'test', 'production']);

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const port = z.coerce.number().int().min(1).max(65535);

const durationSeconds = z.coerce.number().int().positive();

/** 32 bytes, base64 or hex encoded. Anything shorter is rejected. */
const secretKey = z
  .string()
  .min(1, 'must be set')
  .superRefine((value, ctx) => {
    const bytes = decodeKeyMaterial(value);
    if (bytes === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be base64 or hex encoded key material',
      });
      return;
    }
    if (bytes.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must decode to at least 32 bytes (got ${bytes.length})`,
      });
    }
  });

export function decodeKeyMaterial(value: string): Buffer | null {
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, 'hex');
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    const buf = Buffer.from(value, 'base64');
    return buf.length > 0 ? buf : null;
  }
  return null;
}

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

export const serverEnvSchema = z
  .object({
    NODE_ENV: nodeEnv.default('development'),
    APP_NAME: z.string().default('health-commerce'),
    /** Public origin of the API, used to build absolute links in email. */
    API_PUBLIC_URL: z.string().url(),
    STOREFRONT_PUBLIC_URL: z.string().url(),
    ADMIN_PUBLIC_URL: z.string().url(),

    API_PORT: port.default(4000),
    WORKER_PORT: port.default(4100),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: booleanish.default(false),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15000),

    REDIS_URL: z.string().url(),
    REDIS_KEY_PREFIX: z.string().default('hc'),

    /** HMAC key for short-lived access tokens and challenge tokens. */
    SESSION_SECRET: secretKey,
    /** AES-256-GCM key protecting TOTP secrets at rest. */
    ENCRYPTION_KEY: secretKey,

    ACCESS_TOKEN_TTL_SECONDS: durationSeconds.default(900),
    REFRESH_TOKEN_TTL_SECONDS: durationSeconds.default(60 * 60 * 24 * 30),
    MFA_CHALLENGE_TTL_SECONDS: durationSeconds.default(300),
    PASSWORD_RESET_TTL_SECONDS: durationSeconds.default(3600),
    EMAIL_VERIFICATION_TTL_SECONDS: durationSeconds.default(60 * 60 * 24 * 3),
    STAFF_INVITE_TTL_SECONDS: durationSeconds.default(60 * 60 * 24 * 7),

    /** Cookie domain shared by storefront, admin and API. Unset = host-only. */
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: booleanish.optional(),

    CORS_ALLOWED_ORIGINS: csvList,

    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(8),
    LOGIN_LOCKOUT_SECONDS: durationSeconds.default(900),

    DEFAULT_CURRENCY: z.string().length(3).default('USD'),
    DEFAULT_COUNTRY: z.string().length(2).default('US'),
    DEFAULT_TIMEZONE: z.string().default('America/New_York'),

    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanish.default(true),

    EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend', 'ses']).default('console'),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('no-reply@example.test'),
    SMTP_URL: z.string().optional(),

    SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
    SMS_API_KEY: z.string().optional(),
    SMS_FROM: z.string().optional(),

    PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
    PAYMENT_SECRET_KEY: z.string().optional(),
    PAYMENT_WEBHOOK_SECRET: z.string().optional(),

    FULFILLMENT_PROVIDER: z.enum(['mock', 'shipbob']).default('mock'),
    THREEPL_API_KEY: z.string().optional(),
    THREEPL_API_SECRET: z.string().optional(),

    AI_PROVIDER: z.enum(['disabled', 'anthropic']).default('disabled'),
    AI_API_KEY: z.string().optional(),

    SENTRY_DSN: z.string().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    METRICS_ENABLED: booleanish.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Production guard rails. These exist because "it worked in dev" is the
    // most common way an insecure default reaches customers.
    if (env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'cannot be disabled in production',
      });
    }
    if (env.CORS_ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'must list at least one explicit origin in production',
      });
    }
    if (env.CORS_ALLOWED_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'wildcard origins are not permitted in production',
      });
    }
    for (const url of [env.API_PUBLIC_URL, env.STOREFRONT_PUBLIC_URL, env.ADMIN_PUBLIC_URL]) {
      if (!url.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['API_PUBLIC_URL'],
          message: 'public URLs must use https in production',
        });
        break;
      }
    }
    if (env.PAYMENT_PROVIDER === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER'],
        message: 'the mock payment provider must never run in production',
      });
    }
    if (env.FULFILLMENT_PROVIDER === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FULFILLMENT_PROVIDER'],
        message: 'the mock fulfilment provider must never run in production',
      });
    }
    if (env.PAYMENT_PROVIDER === 'stripe' && !env.PAYMENT_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_WEBHOOK_SECRET'],
        message: 'required so payment webhook signatures can be verified',
      });
    }
    if (env.EMAIL_PROVIDER === 'console') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message: 'the console email provider must never run in production',
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: Array<{ path: string; message: string }>) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.path}: ${i.message}`)
        .join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

export function parseServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      })),
    );
  }
  return result.data;
}
