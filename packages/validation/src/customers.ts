import { z } from 'zod';
import {
  countrySchema,
  personNameSchema,
  phoneSchema,
  usPostalCodeSchema,
  usStateSchema,
} from './primitives.js';

export const updateProfileSchema = z.object({
  firstName: personNameSchema.optional(),
  lastName: personNameSchema.optional(),
  phone: phoneSchema.nullish(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updateMarketingPreferencesSchema = z.object({
  acceptsMarketingEmail: z.boolean(),
  acceptsMarketingSms: z.boolean(),
});
export type UpdateMarketingPreferencesInput = z.infer<typeof updateMarketingPreferencesSchema>;

/**
 * Only US addresses are serviceable today. The country field is still explicit
 * so the schema does not have to change when another market opens — only this
 * refinement does.
 */
export const addressSchema = z.object({
  type: z.enum(['SHIPPING', 'BILLING']).default('SHIPPING'),
  label: z.string().trim().max(60).optional(),
  firstName: personNameSchema,
  lastName: personNameSchema,
  company: z.string().trim().max(100).optional(),
  line1: z.string().trim().min(1, 'Enter a street address.').max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1, 'Enter a city.').max(100),
  region: usStateSchema,
  postalCode: usPostalCodeSchema,
  country: countrySchema.default('US').refine((v) => v === 'US', {
    message: 'We currently ship within the United States only.',
  }),
  phone: phoneSchema.optional(),
  isDefaultShipping: z.boolean().default(false),
  isDefaultBilling: z.boolean().default(false),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const updateAddressSchema = addressSchema.partial().extend({
  country: addressSchema.shape.country.optional(),
});
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;
