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
    key: 'cart.lifetime_days',
    value: 30,
    valueType: 'NUMBER',
    description: 'How long an untouched basket survives before it is swept.',
  },
  {
    key: 'inventory.reservation_minutes',
    value: 30,
    valueType: 'NUMBER',
    description:
      'How long a basket may hold stock before the reservation expires. Too long keeps stock out of circulation; too short loses baskets mid-checkout.',
  },
  {
    key: 'checkout.hold_minutes',
    value: 30,
    valueType: 'NUMBER',
    description: 'How long a checkout stays open before its stock is released.',
  },
  {
    key: 'tax.rates_by_region',
    value: {},
    valueType: 'JSON',
    description:
      'Sales tax rate per US state, as a fraction. EMPTY BY DEFAULT AND DELIBERATELY SO: US sales tax is jurisdiction- and product-specific, and a real implementation is a tax-engine integration rather than a lookup table. While this is empty, orders are priced with no tax and the API reports that no rate was applied, so "not calculated" is never mistaken for "not taxable". Do not launch without advice from a tax professional.',
  },
  {
    key: 'tax.shipping_taxable',
    value: false,
    valueType: 'BOOLEAN',
    description: 'Whether delivery is taxable. Varies by state; confirm before relying on it.',
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
    key: 'compliance.disclaimer_general_health',
    value:
      'This information is provided for general educational purposes and is not medical advice. Talk to a qualified healthcare professional before starting any supplement, particularly if you are pregnant, nursing, taking medication or managing a health condition.',
    valueType: 'STRING',
    description:
      'General health disclaimer required on every listing by the publishing checklist. Wording must be reviewed by counsel before launch.',
  },
  {
    key: 'catalog.publish_checklist_relaxed',
    value: [],
    valueType: 'JSON',
    description:
      'Publishing checks an operator has deliberately relaxed. Every implemented check blocks publication unless its key is listed here; a relaxed check is still evaluated and still reported, it simply does not block. Empty by default, and it is the safe default: which checks are legally required is a question for counsel, and silence should never be read as "not required".',
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
