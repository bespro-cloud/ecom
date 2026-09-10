import type { EmailMessage } from './types.js';

/**
 * Transactional email templates.
 *
 * Deliberately plain and factual. Nothing here makes a health claim, and none
 * of it is generated: every word is written and reviewed like any other
 * user-facing copy. Marketing content lives elsewhere and is subject to
 * consent checks before it is sent.
 */

export interface TemplateContext {
  storeName: string;
  supportEmail: string;
  storefrontUrl: string;
  adminUrl: string;
}

function footer(context: TemplateContext): string {
  return [
    '',
    '—',
    `${context.storeName}`,
    `Questions? Reply to this email or write to ${context.supportEmail}.`,
  ].join('\n');
}

export function welcomeEmail(
  context: TemplateContext,
  input: { firstName: string | null; verificationToken: string; to: string },
): EmailMessage {
  const link = `${context.storefrontUrl}/verify-email?token=${encodeURIComponent(input.verificationToken)}`;
  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `Confirm your ${context.storeName} account`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `Thanks for creating an account with ${context.storeName}.`,
      '',
      'Please confirm your email address by opening this link:',
      link,
      '',
      'The link is valid for three days. If you did not create this account you can ignore this message.',
      footer(context),
    ].join('\n'),
  };
}

export function emailVerificationEmail(
  context: TemplateContext,
  input: { to: string; verificationToken: string },
): EmailMessage {
  const link = `${context.storefrontUrl}/verify-email?token=${encodeURIComponent(input.verificationToken)}`;
  return {
    to: { email: input.to },
    subject: `Confirm your email address`,
    text: [
      'Please confirm your email address by opening this link:',
      link,
      '',
      'The link is valid for three days.',
      footer(context),
    ].join('\n'),
  };
}

export function passwordResetEmail(
  context: TemplateContext,
  input: { to: string; token: string },
): EmailMessage {
  const link = `${context.storefrontUrl}/reset-password?token=${encodeURIComponent(input.token)}`;
  return {
    to: { email: input.to },
    subject: `Reset your ${context.storeName} password`,
    text: [
      'We received a request to reset the password for your account.',
      '',
      'Open this link to choose a new password:',
      link,
      '',
      'The link is valid for one hour and can be used once.',
      '',
      'If you did not request this, no action is needed — your password has not changed.',
      footer(context),
    ].join('\n'),
  };
}

export function passwordChangedEmail(
  context: TemplateContext,
  input: { to: string },
): EmailMessage {
  return {
    to: { email: input.to },
    subject: `Your ${context.storeName} password was changed`,
    text: [
      'The password on your account was just changed, and every other signed-in session was ended.',
      '',
      `If this was not you, contact us immediately at ${context.supportEmail}.`,
      footer(context),
    ].join('\n'),
  };
}

export function accountLockedEmail(
  context: TemplateContext,
  input: { to: string; attempts: number },
): EmailMessage {
  return {
    to: { email: input.to },
    subject: `Your ${context.storeName} account is temporarily locked`,
    text: [
      `After ${input.attempts} unsuccessful sign-in attempts, your account has been locked for a short period.`,
      '',
      'It will unlock automatically. If you have forgotten your password you can reset it here:',
      `${context.storefrontUrl}/forgot-password`,
      '',
      'If these attempts were not made by you, we recommend resetting your password once the lock expires.',
      footer(context),
    ].join('\n'),
  };
}

export function mfaEnrolledEmail(context: TemplateContext, input: { to: string }): EmailMessage {
  return {
    to: { email: input.to },
    subject: `Two-factor authentication was turned on`,
    text: [
      'Two-factor authentication is now active on your account, and other signed-in sessions were ended.',
      '',
      `If you did not do this, contact us immediately at ${context.supportEmail}.`,
      footer(context),
    ].join('\n'),
  };
}

export function mfaDisabledEmail(context: TemplateContext, input: { to: string }): EmailMessage {
  return {
    to: { email: input.to },
    subject: `Two-factor authentication was turned off`,
    text: [
      'Two-factor authentication has been removed from your account.',
      '',
      `If you did not do this, contact us immediately at ${context.supportEmail}.`,
      footer(context),
    ].join('\n'),
  };
}

export function staffInviteEmail(
  context: TemplateContext,
  input: { to: string; token: string; roles: string[] },
): EmailMessage {
  const link = `${context.adminUrl}/accept-invite?token=${encodeURIComponent(input.token)}`;
  return {
    to: { email: input.to },
    subject: `You have been invited to the ${context.storeName} admin console`,
    text: [
      `You have been given access to the ${context.storeName} admin console with the following role(s):`,
      input.roles.map((role) => `  • ${role}`).join('\n'),
      '',
      'Set your password to activate the account:',
      link,
      '',
      'The invitation is valid for seven days and can be used once.',
      'If your role requires two-factor authentication you will be asked to set it up on first sign-in.',
      footer(context),
    ].join('\n'),
  };
}

export function staffRolesChangedEmail(
  context: TemplateContext,
  input: { to: string; roles: string[] },
): EmailMessage {
  return {
    to: { email: input.to },
    subject: `Your ${context.storeName} access has changed`,
    text: [
      'An administrator has changed the roles on your account. You now hold:',
      input.roles.length > 0 ? input.roles.map((role) => `  • ${role}`).join('\n') : '  (no roles)',
      '',
      'You have been signed out of the admin console and will need to sign in again.',
      footer(context),
    ].join('\n'),
  };
}
