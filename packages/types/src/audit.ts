/**
 * Canonical audit action names.
 *
 * `<domain>.<verb>`, past tense once the action has completed. Keeping them in
 * one place means the admin log viewer can offer a filter list that is
 * guaranteed to match what is actually written — a hardcoded list drifts the
 * first time someone adds an action.
 *
 * This lives in the leaf types package so the API, the worker and both front
 * ends can all name the same action without depending on each other.
 */
export const AUDIT_ACTIONS = {
  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGIN_BLOCKED: 'auth.login.blocked',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_LOGOUT_ALL: 'auth.logout_all',
  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',
  AUTH_TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',
  AUTH_REGISTERED: 'auth.registered',
  AUTH_PASSWORD_CHANGED: 'auth.password.changed',
  AUTH_PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  AUTH_PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  AUTH_EMAIL_VERIFIED: 'auth.email.verified',
  MFA_ENROLLMENT_STARTED: 'mfa.enrollment.started',
  MFA_ENROLLED: 'mfa.enrolled',
  MFA_DISABLED: 'mfa.disabled',
  MFA_CHALLENGE_SUCCEEDED: 'mfa.challenge.succeeded',
  MFA_CHALLENGE_FAILED: 'mfa.challenge.failed',
  MFA_RECOVERY_CODE_USED: 'mfa.recovery_code.used',
  MFA_RECOVERY_CODES_REGENERATED: 'mfa.recovery_codes.regenerated',
  USER_INVITED: 'user.invited',
  USER_INVITE_ACCEPTED: 'user.invite.accepted',
  USER_UPDATED: 'user.updated',
  USER_STATUS_CHANGED: 'user.status.changed',
  USER_ROLES_CHANGED: 'user.roles.changed',
  USER_SESSIONS_REVOKED: 'user.sessions.revoked',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  CUSTOMER_PROFILE_UPDATED: 'customer.profile.updated',
  CUSTOMER_ADDRESS_CREATED: 'customer.address.created',
  CUSTOMER_ADDRESS_UPDATED: 'customer.address.updated',
  CUSTOMER_ADDRESS_DELETED: 'customer.address.deleted',
  CUSTOMER_CONSENT_RECORDED: 'customer.consent.recorded',
  SETTING_UPDATED: 'system.setting.updated',
  FEATURE_FLAG_UPDATED: 'system.feature_flag.updated',
} as const;

export const CATALOGUE_AUDIT_ACTIONS = {
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_DELETED: 'product.deleted',
  PRODUCT_STATUS_CHANGED: 'product.status.changed',
  PRODUCT_PUBLISHED: 'product.published',
  PRODUCT_UNPUBLISHED: 'product.unpublished',
  PRODUCT_PUBLISH_BLOCKED: 'product.publish.blocked',
  PRODUCT_INGREDIENTS_CHANGED: 'product.ingredients.changed',
  PRODUCT_CATEGORIES_CHANGED: 'product.categories.changed',
  PRODUCT_IMAGES_CHANGED: 'product.images.changed',
  PRODUCT_WARNINGS_CHANGED: 'product.warnings.changed',
  PRODUCT_DISCLAIMERS_CHANGED: 'product.disclaimers.changed',
  PRODUCT_COMPLIANCE_INVALIDATED: 'product.compliance.invalidated',

  CATEGORY_CREATED: 'category.created',
  CATEGORY_UPDATED: 'category.updated',
  CATEGORY_DELETED: 'category.deleted',

  INGREDIENT_CREATED: 'ingredient.created',
  INGREDIENT_UPDATED: 'ingredient.updated',
  INGREDIENT_DELETED: 'ingredient.deleted',
  INGREDIENT_WARNING_ADDED: 'ingredient.warning.added',
  INGREDIENT_WARNING_REMOVED: 'ingredient.warning.removed',

  MEDIA_UPLOADED: 'media.uploaded',
  MEDIA_DELETED: 'media.deleted',

  PAGE_CREATED: 'content.page.created',
  PAGE_UPDATED: 'content.page.updated',
  PAGE_PUBLISHED: 'content.page.published',
  PAGE_UNPUBLISHED: 'content.page.unpublished',
  PAGE_DELETED: 'content.page.deleted',

  SEO_UPDATED: 'seo.updated',

  COMPLIANCE_REVIEW_RECORDED: 'compliance.review.recorded',
} as const;

export const COMMERCE_AUDIT_ACTIONS = {
  CART_MERGED: 'cart.merged',

  CHECKOUT_STARTED: 'checkout.started',
  CHECKOUT_CONFIRMED: 'checkout.confirmed',
  CHECKOUT_REPRICED: 'checkout.repriced',

  ORDER_PLACED: 'order.placed',
  ORDER_STATUS_CHANGED: 'order.status.changed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_NOTE_ADDED: 'order.note.added',

  PAYMENT_INTENT_CREATED: 'payment.intent.created',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_WEBHOOK_REJECTED: 'payment.webhook.rejected',

  REFUND_ISSUED: 'refund.issued',
  REFUND_FAILED: 'refund.failed',

  INVENTORY_ADJUSTED: 'inventory.adjusted',
  WAREHOUSE_CREATED: 'warehouse.created',
  WAREHOUSE_UPDATED: 'warehouse.updated',
  INVENTORY_CONFIGURED: 'inventory.configured',

  SHIPPING_RATE_CREATED: 'shipping.rate.created',
  SHIPPING_RATE_UPDATED: 'shipping.rate.updated',
  SHIPMENT_CREATED: 'shipment.created',
  SHIPMENT_UPDATED: 'shipment.updated',
} as const;

export const ALL_AUDIT_ACTIONS = {
  ...AUDIT_ACTIONS,
  ...CATALOGUE_AUDIT_ACTIONS,
  ...COMMERCE_AUDIT_ACTIONS,
} as const;

export type AuditAction = (typeof ALL_AUDIT_ACTIONS)[keyof typeof ALL_AUDIT_ACTIONS];

/** Every action name, for building a filter list in the admin console. */
export const AUDIT_ACTION_KEYS: readonly AuditAction[] = Object.values(
  ALL_AUDIT_ACTIONS,
) as AuditAction[];

/**
 * Actions worth surfacing by default in the admin log viewer: privilege
 * changes, compliance decisions and anything that alters what customers see.
 */
export const NOTABLE_AUDIT_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
  AUDIT_ACTIONS.AUTH_TOKEN_REUSE_DETECTED,
  AUDIT_ACTIONS.USER_ROLES_CHANGED,
  AUDIT_ACTIONS.USER_STATUS_CHANGED,
  AUDIT_ACTIONS.MFA_DISABLED,
  AUDIT_ACTIONS.SETTING_UPDATED,
  AUDIT_ACTIONS.FEATURE_FLAG_UPDATED,
  CATALOGUE_AUDIT_ACTIONS.PRODUCT_PUBLISHED,
  CATALOGUE_AUDIT_ACTIONS.PRODUCT_UNPUBLISHED,
  CATALOGUE_AUDIT_ACTIONS.PRODUCT_PUBLISH_BLOCKED,
  CATALOGUE_AUDIT_ACTIONS.PRODUCT_WARNINGS_CHANGED,
  CATALOGUE_AUDIT_ACTIONS.PRODUCT_DISCLAIMERS_CHANGED,
  CATALOGUE_AUDIT_ACTIONS.PRODUCT_COMPLIANCE_INVALIDATED,
  CATALOGUE_AUDIT_ACTIONS.COMPLIANCE_REVIEW_RECORDED,
  CATALOGUE_AUDIT_ACTIONS.PAGE_PUBLISHED,
  // Money and stock: the actions an operator most needs to see unprompted.
  COMMERCE_AUDIT_ACTIONS.PAYMENT_FAILED,
  COMMERCE_AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
  COMMERCE_AUDIT_ACTIONS.REFUND_ISSUED,
  COMMERCE_AUDIT_ACTIONS.REFUND_FAILED,
  COMMERCE_AUDIT_ACTIONS.ORDER_CANCELLED,
  COMMERCE_AUDIT_ACTIONS.INVENTORY_ADJUSTED,
];
