import { z } from 'zod';
import {
  emailSchema,
  passwordSchema,
  personNameSchema,
  phoneSchema,
  recoveryCodeSchema,
  totpCodeSchema,
} from './primitives.js';

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: personNameSchema,
  lastName: personNameSchema,
  phone: phoneSchema.optional(),
  acceptsTerms: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms of service to create an account.' }),
  }),
  acceptsMarketingEmail: z.boolean().default(false),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Not passwordSchema: an existing account may predate a policy change, and
  // rejecting on length here would leak the policy to an attacker.
  password: z.string().min(1, 'Enter your password.').max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z
  .object({
    challengeToken: z.string().min(1),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Provide either an authenticator code or a recovery code.',
    path: ['code'],
  });
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const mfaEnrollConfirmSchema = z.object({
  factorId: z.string().uuid(),
  code: totpCodeSchema,
});
export type MfaEnrollConfirmInput = z.infer<typeof mfaEnrollConfirmSchema>;

export const mfaDisableSchema = z.object({
  password: z.string().min(1).max(256),
  code: totpCodeSchema,
});
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;

export const requestPasswordResetSchema = z.object({ email: emailSchema });
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const verifyEmailSchema = z.object({ token: z.string().min(1) });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
