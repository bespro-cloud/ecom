/**
 * Canonical permission catalogue.
 *
 * Permissions are the only thing authorisation code ever checks — roles are a
 * grouping mechanism, never a check. Adding a permission here and running the
 * RBAC sync (see packages/database/src/seed/rbac.ts) makes it available to the
 * admin role editor.
 */

export const PERMISSION_RESOURCES = [
  'user',
  'role',
  'customer',
  'product',
  'category',
  'ingredient',
  'inventory',
  'batch',
  'order',
  'refund',
  'shipment',
  'return',
  'subscription',
  'coupon',
  'promotion',
  'review',
  'content',
  'blog',
  'seo',
  'claim',
  'evidence',
  'compliance',
  'recall',
  'document',
  'analytics',
  'audit',
  'system',
  'ai',
  'support',
] as const;

export type PermissionResource = (typeof PERMISSION_RESOURCES)[number];

export interface PermissionDefinition {
  readonly key: string;
  readonly resource: PermissionResource;
  readonly action: string;
  readonly description: string;
}

function define(
  resource: PermissionResource,
  action: string,
  description: string,
): PermissionDefinition {
  return {
    key: `${resource.toUpperCase()}_${action.toUpperCase()}`,
    resource,
    action,
    description,
  };
}

export const PERMISSIONS = [
  // Identity & access
  define('user', 'read', 'View staff users and their role assignments'),
  define('user', 'write', 'Create, invite, update and deactivate staff users'),
  define('user', 'manage', 'Assign roles and force credential resets for staff users'),
  define('role', 'read', 'View roles and their permissions'),
  define('role', 'manage', 'Create, update and delete non-system roles'),

  // Customers
  define('customer', 'read', 'View customer accounts'),
  define('customer', 'write', 'Update customer account details'),
  define('customer', 'impersonate', 'Open a scoped read-only support view of a customer account'),
  // Separate from CUSTOMER_WRITE on purpose. Correcting a misspelled name and
  // erasing somebody's data are not the same authority, and the second one is
  // not reversible.
  define('customer', 'erase', 'Decide a data deletion request'),

  // Catalogue (Phase 2)
  define('product', 'read', 'View products including unpublished drafts'),
  define('product', 'write', 'Create and edit products'),
  define('product', 'publish', 'Publish a product once the compliance gate passes'),
  define('category', 'read', 'View categories'),
  define('category', 'write', 'Create and edit categories'),
  define('ingredient', 'read', 'View ingredients'),
  define('ingredient', 'write', 'Create and edit ingredients'),

  // Inventory (Phase 3/4)
  define('inventory', 'read', 'View stock levels and reservations'),
  define('inventory', 'adjust', 'Record stock adjustments'),
  define('batch', 'read', 'View batches and lots'),
  define('batch', 'write', 'Receive and edit batches and lots'),
  define('batch', 'quarantine', 'Quarantine or release a batch'),

  // Commerce (Phase 3)
  define('order', 'read', 'View orders'),
  define('order', 'write', 'Edit order details prior to fulfilment'),
  define('order', 'cancel', 'Cancel an order'),
  define('refund', 'read', 'View refunds'),
  define('refund', 'issue', 'Issue a refund against a captured payment'),
  define('shipment', 'read', 'View shipments and tracking'),
  define('shipment', 'write', 'Create and cancel shipments'),
  define('return', 'read', 'View return requests'),
  define('return', 'write', 'Approve, reject and receive returns'),
  define('subscription', 'read', 'View subscriptions'),
  define('subscription', 'write', 'Pause, resume, skip and cancel subscriptions'),

  // Marketing (Phase 5/6)
  define('coupon', 'read', 'View coupons'),
  define('coupon', 'write', 'Create and edit coupons'),
  define('promotion', 'read', 'View promotions'),
  define('promotion', 'write', 'Create and edit promotions'),
  define('review', 'read', 'View product reviews including unmoderated ones'),
  define('review', 'moderate', 'Approve, reject and remove product reviews'),

  // Content (Phase 2/6)
  define('content', 'read', 'View CMS pages including drafts'),
  define('content', 'write', 'Create and edit CMS pages'),
  define('content', 'publish', 'Publish CMS pages'),
  define('blog', 'read', 'View blog posts including drafts'),
  define('blog', 'write', 'Create and edit blog posts'),
  define('blog', 'publish', 'Publish blog posts'),
  define('seo', 'read', 'View SEO metadata'),
  define('seo', 'write', 'Edit SEO metadata'),

  // Compliance (Phase 4)
  define('claim', 'read', 'View product claims'),
  define('claim', 'write', 'Draft and edit product claims'),
  define('claim', 'approve', 'Approve or reject a product claim'),
  define('evidence', 'read', 'View claim evidence'),
  define('evidence', 'write', 'Attach and edit claim evidence'),
  define('evidence', 'approve', 'Mark evidence as reviewed and acceptable'),
  define('compliance', 'read', 'View compliance reviews'),
  define('compliance', 'approve', 'Sign off a product compliance review'),
  define('recall', 'read', 'View recalls'),
  define('recall', 'manage', 'Open, progress and close a recall'),
  // Separate from RECALL_MANAGE on purpose. Blocking stock is an operational
  // act; telling customers their purchase is being recalled has legal
  // consequences, and the two should not be the same authority.
  define('recall', 'notify', 'Approve contacting customers about a recall'),
  define('document', 'read', 'View regulatory and product documents'),
  define('document', 'write', 'Upload and supersede regulatory documents'),

  // Platform
  define('analytics', 'read', 'View analytics dashboards and reports'),
  define('audit', 'read', 'Read the audit log'),
  define('system', 'settings', 'Read and change system settings and feature flags'),
  define('ai', 'use', 'Use AI assistance features in the admin console'),
  define('ai', 'configure', 'Configure AI providers, prompts and guardrails'),
  define('support', 'read', 'View support conversations'),
  define('support', 'write', 'Reply to support conversations'),
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}
