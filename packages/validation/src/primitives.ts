import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@health/types';

/**
 * Reusable field-level validators.
 *
 * These live in a shared package so the storefront, the admin console and the
 * API validate identically. The API never trusts client-side validation — it
 * re-runs the same schema on every request — but sharing the definition keeps
 * error messages consistent.
 */

export const uuidSchema = z.string().uuid('Must be a valid identifier.');

/**
 * Email addresses are stored twice: `email` as typed, and `emailNormalized`
 * (trimmed + lower-cased) which carries the uniqueness constraint. That stops
 * `Alice@x.com` and `alice@x.com` becoming two accounts.
 */
export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter an email address.')
  .max(254, 'Email address is too long.')
  .email('Enter a valid email address.');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(256, 'Use at most 256 characters.');

/** E.164, which is what every US SMS provider expects. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Enter a phone number in international format, e.g. +12125550123.');

export const personNameSchema = z
  .string()
  .trim()
  .min(1, 'This field is required.')
  .max(100, 'Must be 100 characters or fewer.');

export const totpCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'));

export const recoveryCodeSchema = z
  .string()
  .trim()
  .min(10, 'Enter a recovery code.')
  .max(32, 'Enter a recovery code.');

/** USPS two-letter state and territory codes. */
export const US_STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'AS',
  'GU',
  'MP',
  'PR',
  'VI',
  'AA',
  'AE',
  'AP',
] as const;

export const usStateSchema = z.enum(US_STATE_CODES, {
  errorMap: () => ({ message: 'Select a US state or territory.' }),
});

export const usPostalCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{5}(-\d{4})?$/, 'Enter a ZIP code, e.g. 10001 or 10001-1234.');

export const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, 'Use a two-letter country code.');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case letters, numbers and hyphens.');

/** Cursor pagination. Offsets are avoided: they drift and scan badly at depth. */
export const paginationSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('desc');
