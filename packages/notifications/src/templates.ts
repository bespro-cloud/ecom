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

// ---------------------------------------------------------------------------
// Commerce lifecycle
// ---------------------------------------------------------------------------

/**
 * Money, formatted from integer minor units.
 *
 * Local to the templates so no email ever receives a pre-formatted string: a
 * number formatted by the caller is a number formatted inconsistently, and on
 * an order confirmation that is the one figure the customer checks.
 */
function money(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export interface OrderEmailLine {
  productName: string;
  variantName?: string | null;
  quantity: number;
  lineTotalCents: number;
}

/**
 * Order confirmation.
 *
 * States what was bought and what was charged, and nothing about what the
 * products do. A transactional email is the one message a customer is certain
 * to open, which makes it the most tempting place to put a health claim and the
 * worst place to have an unreviewed one.
 */
export function orderPlacedEmail(
  context: TemplateContext,
  input: {
    to: string;
    firstName: string | null;
    reference: string;
    currency: string;
    lines: OrderEmailLine[];
    subtotalCents: number;
    discountCents: number;
    shippingCents: number;
    taxCents: number;
    totalCents: number;
    orderUrl: string;
  },
): EmailMessage {
  const items = input.lines.map(
    (line) =>
      `  ${line.quantity} × ${line.productName}${line.variantName ? ` (${line.variantName})` : ''} — ${money(line.lineTotalCents, input.currency)}`,
  );

  const totals = [
    `  Subtotal: ${money(input.subtotalCents, input.currency)}`,
    ...(input.discountCents > 0
      ? [`  Discount: −${money(input.discountCents, input.currency)}`]
      : []),
    `  Shipping: ${money(input.shippingCents, input.currency)}`,
    `  Tax: ${money(input.taxCents, input.currency)}`,
    `  Total: ${money(input.totalCents, input.currency)}`,
  ];

  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `Your ${context.storeName} order ${input.reference}`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `Thanks for your order. Your reference is ${input.reference}.`,
      '',
      'What you ordered:',
      ...items,
      '',
      ...totals,
      '',
      'You can see the order here:',
      input.orderUrl,
      '',
      'We will email you again when it ships.',
      footer(context),
    ].join('\n'),
  };
}

/**
 * A payment that did not settle.
 *
 * Says what happened and what to do. Deliberately does not include a decline
 * code: the customer cannot act on "do_not_honor", and their bank is the only
 * party that can explain it.
 */
export function paymentFailedEmail(
  context: TemplateContext,
  input: { to: string; firstName: string | null; reference: string; checkoutUrl: string },
): EmailMessage {
  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `We could not take payment for ${input.reference}`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `Your payment for order ${input.reference} did not go through, so the order has not been placed.`,
      '',
      'Nothing has been charged. You can try again here:',
      input.checkoutUrl,
      '',
      'If it keeps failing, your bank will be able to tell you why — we only see that the payment was declined.',
      footer(context),
    ].join('\n'),
  };
}

/** A refund, stating the amount and where it goes. */
export function refundIssuedEmail(
  context: TemplateContext,
  input: {
    to: string;
    firstName: string | null;
    reference: string;
    currency: string;
    amountCents: number;
  },
): EmailMessage {
  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `Refund for order ${input.reference}`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `We have refunded ${money(input.amountCents, input.currency)} against order ${input.reference}.`,
      '',
      'It goes back to the card you paid with. Banks usually take a few working days to show it.',
      footer(context),
    ].join('\n'),
  };
}

export function orderCancelledEmail(
  context: TemplateContext,
  input: { to: string; firstName: string | null; reference: string; refunded: boolean },
): EmailMessage {
  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `Order ${input.reference} has been cancelled`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `Order ${input.reference} has been cancelled.`,
      '',
      input.refunded
        ? 'Anything you paid is being refunded to the card you used. Banks usually take a few working days to show it.'
        : 'If you were charged and have not had a refund, reply to this email and we will sort it out.',
      footer(context),
    ].join('\n'),
  };
}

/**
 * A renewal that failed.
 *
 * The most important sentence is the one saying nothing will ship. A customer
 * who thinks their order is on its way will not act, and the goods will not
 * arrive.
 */
export function subscriptionRenewalFailedEmail(
  context: TemplateContext,
  input: {
    to: string;
    firstName: string | null;
    reference: string;
    nextAttemptAt: Date | null;
    manageUrl: string;
  },
): EmailMessage {
  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `We could not take payment for your subscription`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `The payment for subscription ${input.reference} was declined, so this delivery is on hold. Nothing will be sent until it is paid.`,
      '',
      input.nextAttemptAt
        ? `We will try again on ${input.nextAttemptAt.toISOString().slice(0, 10)}.`
        : 'We will not try again automatically.',
      '',
      'You can update your card here:',
      input.manageUrl,
      footer(context),
    ].join('\n'),
  };
}

/** A subscription that has run out of retries. */
export function subscriptionUnpaidEmail(
  context: TemplateContext,
  input: { to: string; firstName: string | null; reference: string; manageUrl: string },
): EmailMessage {
  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `Your subscription is on hold`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `We tried a few times to take payment for subscription ${input.reference} and could not, so we have stopped trying. Nothing is being sent, and you have not been charged.`,
      '',
      'Your subscription is still here if you want it — update your card and it will start again:',
      input.manageUrl,
      '',
      'If you would rather cancel, you can do that on the same page. No need to contact us.',
      footer(context),
    ].join('\n'),
  };
}

/**
 * A reply on a support conversation.
 *
 * Carries no message body. A support reply can contain anything the agent
 * typed, and email is the least controlled channel in the system — the customer
 * comes back to the site to read it.
 */
export function supportRepliedEmail(
  context: TemplateContext,
  input: { to: string; firstName: string | null; reference: string; threadUrl: string },
): EmailMessage {
  return {
    to: { email: input.to, ...(input.firstName ? { name: input.firstName } : {}) },
    subject: `We have replied to ${input.reference}`,
    text: [
      `Hello${input.firstName ? ` ${input.firstName}` : ''},`,
      '',
      `There is a reply waiting on your conversation ${input.reference}.`,
      '',
      'Read it here:',
      input.threadUrl,
      footer(context),
    ].join('\n'),
  };
}
