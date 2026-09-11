import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseServerEnv } from './env.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

const baseEnv = {
  API_PUBLIC_URL: 'http://localhost:4000',
  STOREFRONT_PUBLIC_URL: 'http://localhost:3000',
  ADMIN_PUBLIC_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: KEY,
  ENCRYPTION_KEY: KEY,
};

describe('parseServerEnv', () => {
  it('applies documented defaults in development', () => {
    const env = parseServerEnv({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.DEFAULT_CURRENCY).toBe('USD');
    expect(env.PAYMENT_PROVIDER).toBe('mock');
  });

  it('rejects signing keys shorter than 32 bytes', () => {
    expect(() =>
      parseServerEnv({
        ...baseEnv,
        SESSION_SECRET: Buffer.alloc(16).toString('hex'),
      } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('rejects non key-material secrets', () => {
    expect(() =>
      parseServerEnv({ ...baseEnv, ENCRYPTION_KEY: 'change me please!!!' } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });

  it('parses comma separated CORS origins', () => {
    const env = parseServerEnv({
      ...baseEnv,
      CORS_ALLOWED_ORIGINS: 'https://a.test, https://b.test ,',
    } as NodeJS.ProcessEnv);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
  });

  it('defaults to the filesystem storage provider in development', () => {
    const env = parseServerEnv({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(env.STORAGE_PROVIDER).toBe('filesystem');
    expect(env.MEDIA_MAX_UPLOAD_BYTES).toBe(15 * 1024 * 1024);
  });

  it('refuses the filesystem storage provider in production', () => {
    // Local disk is not shared between instances and is not backed up.
    try {
      parseServerEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'https://api.test',
        STOREFRONT_PUBLIC_URL: 'https://shop.test',
        ADMIN_PUBLIC_URL: 'https://admin.test',
        CORS_ALLOWED_ORIGINS: 'https://shop.test',
        PAYMENT_PROVIDER: 'stripe',
        PAYMENT_WEBHOOK_SECRET: 'whsec_x',
        EMAIL_PROVIDER: 'ses',
        FULFILLMENT_PROVIDER: 'shipbob',
        STORAGE_PROVIDER: 'filesystem',
      } as NodeJS.ProcessEnv);
      throw new Error('expected parse to fail');
    } catch (error) {
      expect((error as EnvValidationError).issues.map((i) => i.path)).toContain('STORAGE_PROVIDER');
    }
  });

  it('requires a bucket when S3 storage is configured in production', () => {
    try {
      parseServerEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'https://api.test',
        STOREFRONT_PUBLIC_URL: 'https://shop.test',
        ADMIN_PUBLIC_URL: 'https://admin.test',
        CORS_ALLOWED_ORIGINS: 'https://shop.test',
        PAYMENT_PROVIDER: 'stripe',
        PAYMENT_WEBHOOK_SECRET: 'whsec_x',
        EMAIL_PROVIDER: 'ses',
        FULFILLMENT_PROVIDER: 'shipbob',
        STORAGE_PROVIDER: 's3',
      } as NodeJS.ProcessEnv);
      throw new Error('expected parse to fail');
    } catch (error) {
      expect((error as EnvValidationError).issues.map((i) => i.path)).toContain('S3_BUCKET');
    }
  });

  it('refuses to boot production with the mock payment provider', () => {
    const call = () =>
      parseServerEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'https://api.test',
        STOREFRONT_PUBLIC_URL: 'https://shop.test',
        ADMIN_PUBLIC_URL: 'https://admin.test',
        CORS_ALLOWED_ORIGINS: 'https://shop.test',
        EMAIL_PROVIDER: 'ses',
        FULFILLMENT_PROVIDER: 'shipbob',
      } as NodeJS.ProcessEnv);
    expect(call).toThrow(/PAYMENT_PROVIDER/);
  });

  it('refuses wildcard CORS and plaintext URLs in production', () => {
    try {
      parseServerEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: '*',
        PAYMENT_PROVIDER: 'stripe',
        PAYMENT_WEBHOOK_SECRET: 'whsec_x',
        EMAIL_PROVIDER: 'ses',
        FULFILLMENT_PROVIDER: 'shipbob',
      } as NodeJS.ProcessEnv);
      throw new Error('expected parse to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const paths = (error as EnvValidationError).issues.map((i) => i.path);
      expect(paths).toContain('CORS_ALLOWED_ORIGINS');
      expect(paths).toContain('API_PUBLIC_URL');
    }
  });

  it('requires a webhook secret when a real payment provider is configured', () => {
    try {
      parseServerEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        API_PUBLIC_URL: 'https://api.test',
        STOREFRONT_PUBLIC_URL: 'https://shop.test',
        ADMIN_PUBLIC_URL: 'https://admin.test',
        CORS_ALLOWED_ORIGINS: 'https://shop.test',
        PAYMENT_PROVIDER: 'stripe',
        EMAIL_PROVIDER: 'ses',
        FULFILLMENT_PROVIDER: 'shipbob',
      } as NodeJS.ProcessEnv);
      throw new Error('expected parse to fail');
    } catch (error) {
      expect((error as EnvValidationError).issues.map((i) => i.path)).toContain(
        'PAYMENT_WEBHOOK_SECRET',
      );
    }
  });
});
