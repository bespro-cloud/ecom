import { PERMISSIONS, type PermissionKey } from './permissions.js';

/**
 * System roles. These are created by the RBAC sync and cannot be deleted or
 * renamed through the API; their permission sets can only be changed here (and
 * then re-synced), so a privileged role can never be silently widened at
 * runtime.
 */
export const SYSTEM_ROLE_KEYS = [
  'SUPER_ADMIN',
  'ADMIN',
  'PRODUCT_MANAGER',
  'ORDER_MANAGER',
  'CONTENT_MANAGER',
  'MARKETING_MANAGER',
  'SUPPORT_AGENT',
  'WAREHOUSE_MANAGER',
  'COMPLIANCE_REVIEWER',
  'ANALYST',
  'CUSTOMER',
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDefinition {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly description: string;
  /** `'*'` grants every permission in the catalogue. */
  readonly permissions: readonly PermissionKey[] | '*';
  /** Roles that must complete an MFA challenge before a session is privileged. */
  readonly requiresMfa: boolean;
}

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

function keys(...values: PermissionKey[]): readonly PermissionKey[] {
  const missing = values.filter((v) => !ALL_PERMISSION_KEYS.includes(v));
  if (missing.length > 0) {
    throw new Error(`Unknown permission keys in role definition: ${missing.join(', ')}`);
  }
  return values;
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super administrator',
    description: 'Unrestricted access. Reserved for platform owners; MFA required.',
    permissions: '*',
    requiresMfa: true,
  },
  {
    key: 'ADMIN',
    name: 'Administrator',
    description:
      'Broad operational access. Cannot approve compliance claims — that is deliberately separated.',
    permissions: keys(
      'USER_READ',
      'USER_WRITE',
      'USER_MANAGE',
      'ROLE_READ',
      'CUSTOMER_READ',
      'CUSTOMER_WRITE',
      'CUSTOMER_ERASE',
      'PRODUCT_READ',
      'PRODUCT_WRITE',
      'CATEGORY_READ',
      'CATEGORY_WRITE',
      'INGREDIENT_READ',
      'INGREDIENT_WRITE',
      'INVENTORY_READ',
      'INVENTORY_ADJUST',
      'BATCH_READ',
      'BATCH_WRITE',
      'ORDER_READ',
      'ORDER_WRITE',
      'ORDER_CANCEL',
      'REFUND_READ',
      'REFUND_ISSUE',
      'SHIPMENT_READ',
      'SHIPMENT_WRITE',
      'RETURN_READ',
      'RETURN_WRITE',
      'SUBSCRIPTION_READ',
      'SUBSCRIPTION_WRITE',
      'COUPON_READ',
      'COUPON_WRITE',
      'PROMOTION_READ',
      'PROMOTION_WRITE',
      'REVIEW_READ',
      'REVIEW_MODERATE',
      'CONTENT_READ',
      'CONTENT_WRITE',
      'CONTENT_PUBLISH',
      'BLOG_READ',
      'BLOG_WRITE',
      'BLOG_PUBLISH',
      'SEO_READ',
      'SEO_WRITE',
      'CLAIM_READ',
      'EVIDENCE_READ',
      'COMPLIANCE_READ',
      'RECALL_READ',
      'DOCUMENT_READ',
      'ANALYTICS_READ',
      'AUDIT_READ',
      'SYSTEM_SETTINGS',
      'AI_USE',
      'AI_CONFIGURE',
      'SUPPORT_READ',
      'SUPPORT_WRITE',
    ),
    requiresMfa: true,
  },
  {
    key: 'COMPLIANCE_REVIEWER',
    name: 'Compliance reviewer',
    description:
      'The only role that can approve claims, evidence and product compliance reviews. MFA required.',
    permissions: keys(
      'PRODUCT_READ',
      'INGREDIENT_READ',
      'CLAIM_READ',
      'CLAIM_WRITE',
      'CLAIM_APPROVE',
      'EVIDENCE_READ',
      'EVIDENCE_WRITE',
      'EVIDENCE_APPROVE',
      'COMPLIANCE_READ',
      'COMPLIANCE_APPROVE',
      // A blog post that names a product is marketing copy about a regulated
      // product, and this role signs it off. It needs to be able to read the
      // post it is ruling on — a reviewer who cannot see the text would be
      // approving a title.
      'BLOG_READ',
      'RECALL_READ',
      'RECALL_MANAGE',
      'RECALL_NOTIFY',
      'DOCUMENT_READ',
      'DOCUMENT_WRITE',
      'BATCH_READ',
      'BATCH_QUARANTINE',
      'AUDIT_READ',
      // Reads evidence digests. The digest saves reading time; it does not
      // save judgement, and it is forbidden from offering an opinion on
      // whether evidence substantiates anything.
      'AI_USE',
    ),
    requiresMfa: true,
  },
  {
    key: 'PRODUCT_MANAGER',
    name: 'Product manager',
    description: 'Owns the catalogue. Can request publication but not approve compliance.',
    permissions: keys(
      'PRODUCT_READ',
      'PRODUCT_WRITE',
      'PRODUCT_PUBLISH',
      'CATEGORY_READ',
      'CATEGORY_WRITE',
      'INGREDIENT_READ',
      'INGREDIENT_WRITE',
      'INVENTORY_READ',
      'BATCH_READ',
      'CLAIM_READ',
      'CLAIM_WRITE',
      'EVIDENCE_READ',
      'EVIDENCE_WRITE',
      'COMPLIANCE_READ',
      'DOCUMENT_READ',
      'DOCUMENT_WRITE',
      'SEO_READ',
      'SEO_WRITE',
      'ANALYTICS_READ',
      // Drafts product copy and SEO metadata. Drafting only: accepting a
      // suggestion writes to a draft, and publishing is still PRODUCT_PUBLISH.
      'AI_USE',
    ),
    requiresMfa: false,
  },
  {
    key: 'ORDER_MANAGER',
    name: 'Order manager',
    description: 'Handles orders, refunds, shipments and returns.',
    permissions: keys(
      'CUSTOMER_READ',
      'ORDER_READ',
      'ORDER_WRITE',
      'ORDER_CANCEL',
      'REFUND_READ',
      'REFUND_ISSUE',
      'SHIPMENT_READ',
      'SHIPMENT_WRITE',
      'RETURN_READ',
      'RETURN_WRITE',
      'SUBSCRIPTION_READ',
      'SUBSCRIPTION_WRITE',
      'INVENTORY_READ',
      'PRODUCT_READ',
      'ANALYTICS_READ',
    ),
    // Holds REFUND_ISSUE, so this role can move money out of the
    // business. That is the same bar that puts a second factor on
    // COMPLIANCE_REVIEWER, and it applies here for the same reason.
    requiresMfa: true,
  },
  {
    key: 'WAREHOUSE_MANAGER',
    name: 'Warehouse manager',
    description: 'Receives stock, manages batches and fulfils orders.',
    permissions: keys(
      'PRODUCT_READ',
      'INVENTORY_READ',
      'INVENTORY_ADJUST',
      'BATCH_READ',
      'BATCH_WRITE',
      'BATCH_QUARANTINE',
      'ORDER_READ',
      'SHIPMENT_READ',
      'SHIPMENT_WRITE',
      'RETURN_READ',
      'RETURN_WRITE',
      'RECALL_READ',
    ),
    requiresMfa: false,
  },
  {
    key: 'CONTENT_MANAGER',
    name: 'Content manager',
    description: 'Owns CMS pages and the blog. Cannot publish health claims.',
    permissions: keys(
      'CONTENT_READ',
      'CONTENT_WRITE',
      'CONTENT_PUBLISH',
      'BLOG_READ',
      'BLOG_WRITE',
      'BLOG_PUBLISH',
      'SEO_READ',
      'SEO_WRITE',
      'PRODUCT_READ',
      'CLAIM_READ',
      'AI_USE',
    ),
    requiresMfa: false,
  },
  {
    key: 'MARKETING_MANAGER',
    name: 'Marketing manager',
    description: 'Owns promotions, coupons and campaigns.',
    permissions: keys(
      'COUPON_READ',
      'COUPON_WRITE',
      'PROMOTION_READ',
      'PROMOTION_WRITE',
      'CONTENT_READ',
      'CONTENT_WRITE',
      'BLOG_READ',
      'BLOG_WRITE',
      'SEO_READ',
      'SEO_WRITE',
      'PRODUCT_READ',
      'CLAIM_READ',
      'ANALYTICS_READ',
      'AI_USE',
    ),
    requiresMfa: false,
  },
  {
    key: 'SUPPORT_AGENT',
    name: 'Support agent',
    description: 'Answers customers. Read-mostly access to commerce data.',
    permissions: keys(
      'CUSTOMER_READ',
      'ORDER_READ',
      'SHIPMENT_READ',
      'RETURN_READ',
      'SUBSCRIPTION_READ',
      'PRODUCT_READ',
      'REVIEW_READ',
      'SUPPORT_READ',
      'SUPPORT_WRITE',
      'AI_USE',
    ),
    requiresMfa: false,
  },
  {
    key: 'ANALYST',
    name: 'Analyst',
    description: 'Read-only analytics access. No customer PII write access.',
    permissions: keys(
      'ANALYTICS_READ',
      'PRODUCT_READ',
      'ORDER_READ',
      'INVENTORY_READ',
      // Narrates figures that have already been computed. It cannot compute
      // any: the gateway has no tools and the numbers go in the prompt.
      'AI_USE',
    ),
    requiresMfa: false,
  },
  {
    key: 'CUSTOMER',
    name: 'Customer',
    description:
      'Storefront account holder. Holds no admin permissions; storefront authorisation is ownership-based.',
    permissions: [],
    requiresMfa: false,
  },
];

export function resolveRolePermissions(role: SystemRoleDefinition): readonly PermissionKey[] {
  return role.permissions === '*' ? ALL_PERMISSION_KEYS : role.permissions;
}

/** Roles that must never be assignable to a storefront (customer) account. */
export const STAFF_ROLE_KEYS: readonly SystemRoleKey[] = SYSTEM_ROLE_KEYS.filter(
  (k) => k !== 'CUSTOMER',
);
