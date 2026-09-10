#!/usr/bin/env node
/**
 * Asserts that the production environment contract still refuses unsafe
 * configurations.
 *
 * These guards are the difference between "a mock payment provider cannot reach
 * customers" and "a mock payment provider did not reach customers, so far". If
 * one is ever removed, this fails the build rather than letting it through
 * silently.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseServerEnv, EnvValidationError } = require('../packages/config/dist/index.js');

const KEY = Buffer.alloc(32, 1).toString('base64');

const productionBase = {
  NODE_ENV: 'production',
  API_PUBLIC_URL: 'https://api.example.test',
  STOREFRONT_PUBLIC_URL: 'https://shop.example.test',
  ADMIN_PUBLIC_URL: 'https://admin.example.test',
  DATABASE_URL: 'postgresql://user:pass@db:5432/app',
  REDIS_URL: 'redis://cache:6379',
  SESSION_SECRET: KEY,
  ENCRYPTION_KEY: KEY,
  CORS_ALLOWED_ORIGINS: 'https://shop.example.test',
  PAYMENT_PROVIDER: 'stripe',
  PAYMENT_WEBHOOK_SECRET: 'whsec_example',
  EMAIL_PROVIDER: 'ses',
  FULFILLMENT_PROVIDER: 'shipbob',
};

/** Each case must be REFUSED by the environment contract. */
const mustBeRejected = [
  ['the mock payment provider', { PAYMENT_PROVIDER: 'mock' }],
  ['the mock fulfilment provider', { FULFILLMENT_PROVIDER: 'mock' }],
  ['the console email provider', { EMAIL_PROVIDER: 'console' }],
  ['a wildcard CORS origin', { CORS_ALLOWED_ORIGINS: '*' }],
  ['an empty CORS allow-list', { CORS_ALLOWED_ORIGINS: '' }],
  ['insecure cookies', { COOKIE_SECURE: 'false' }],
  ['a plaintext public URL', { STOREFRONT_PUBLIC_URL: 'http://shop.example.test' }],
  ['a short signing key', { SESSION_SECRET: Buffer.alloc(16).toString('base64') }],
  ['a short encryption key', { ENCRYPTION_KEY: Buffer.alloc(8).toString('hex') }],
  ['a payment provider with no webhook secret', { PAYMENT_WEBHOOK_SECRET: undefined }],
];

let failures = 0;

for (const [description, overrides] of mustBeRejected) {
  const env = { ...productionBase, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }

  try {
    parseServerEnv(env);
    console.error(`FAIL  production configuration accepted ${description}`);
    failures += 1;
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.log(`ok    refused ${description}`);
    } else {
      console.error(`FAIL  unexpected error while testing ${description}: ${error.message}`);
      failures += 1;
    }
  }
}

// The known-good configuration must still be accepted, otherwise the guards are
// simply rejecting everything.
try {
  parseServerEnv(productionBase);
  console.log('ok    accepted a correctly configured production environment');
} catch (error) {
  console.error(`FAIL  a valid production configuration was refused: ${error.message}`);
  failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} production guard rail(s) are not working.`);
  process.exit(1);
}
console.log('\nAll production guard rails are in place.');
