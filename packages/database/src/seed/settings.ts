import type { PrismaClient } from '../client.js';

/**
 * Baseline system settings and feature flags.
 *
 * These are *configuration*, not secrets. Anything with a credential in it
 * belongs in the secret manager and is read from the environment — see
 * docs/security/SECURITY.md.
 */

interface SettingSeed {
  key: string;
  value: unknown;
  valueType: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON';
  description: string;
}

export const BASELINE_SETTINGS: SettingSeed[] = [
  {
    key: 'store.name',
    value: 'Health Commerce',
    valueType: 'STRING',
    description: 'Store name shown in the storefront header and transactional email.',
  },
  {
    key: 'store.support_email',
    value: 'support@example.test',
    valueType: 'STRING',
    description: 'Reply-to address on customer email.',
  },
  {
    key: 'store.default_currency',
    value: 'USD',
    valueType: 'STRING',
    description: 'ISO 4217 currency for pricing. Changing this does not convert existing prices.',
  },
  {
    key: 'store.serviceable_countries',
    value: ['US'],
    valueType: 'JSON',
    description: 'ISO 3166-1 alpha-2 codes we will ship to.',
  },
  {
    key: 'security.session_idle_timeout_minutes',
    value: 60,
    valueType: 'NUMBER',
    description: 'Admin console idle timeout before re-authentication is required.',
  },
  {
    key: 'security.staff_mfa_grace_period_days',
    value: 7,
    valueType: 'NUMBER',
    description:
      'How long a newly invited privileged staff member may sign in before MFA enrolment is mandatory.',
  },
  {
    key: 'compliance.disclaimer_supplement',
    value:
      'These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.',
    valueType: 'STRING',
    description:
      'DSHEA disclaimer applied to dietary supplement listings. Wording must be reviewed by counsel before launch.',
  },
  {
    key: 'compliance.claims_review_interval_days',
    value: 365,
    valueType: 'NUMBER',
    description: 'How often an approved product claim must be re-reviewed before it expires.',
  },
];

export const BASELINE_FEATURE_FLAGS = [
  {
    key: 'checkout.v2',
    description: 'New checkout flow (Phase 3). Off until the payment integration is verified.',
  },
  {
    key: 'payments.secondary_provider',
    description: 'Route a percentage of payments to the secondary provider.',
  },
  { key: 'subscriptions.enabled', description: 'Customer-facing subscription plans (Phase 5).' },
  { key: 'ai.support_assistant', description: 'AI-assisted customer support replies (Phase 7).' },
  {
    key: 'search.opensearch',
    description: 'Serve catalogue search from OpenSearch instead of PostgreSQL.',
  },
  { key: 'fulfillment.secondary_provider', description: 'Enable the secondary 3PL adapter.' },
  { key: 'marketing.replenishment_reminders', description: 'Replenishment reminder campaign.' },
];

export async function seedSettings(prisma: PrismaClient): Promise<void> {
  for (const setting of BASELINE_SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      // Only the description is refreshed: an operator may legitimately have
      // changed the value in the admin console, and a deploy must not silently
      // revert that.
      update: { description: setting.description },
      create: {
        key: setting.key,
        value: setting.value as never,
        valueType: setting.valueType,
        description: setting.description,
      },
    });
  }

  for (const flag of BASELINE_FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      update: { description: flag.description },
      create: {
        key: flag.key,
        description: flag.description,
        enabled: false,
        rolloutPercentage: 0,
      },
    });
  }
}
