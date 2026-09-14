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

/**
 * Compliance actions.
 *
 * Nearly all of these are worth surfacing unprompted, because the questions
 * they answer — who approved this claim, who released that stock, who decided
 * customers should be told — are the questions asked after something has gone
 * wrong, by people who were not in the room.
 */
export const COMPLIANCE_AUDIT_ACTIONS = {
  CLAIM_CREATED: 'claim.created',
  CLAIM_REVISED: 'claim.revised',
  CLAIM_SUBMITTED: 'claim.submitted',
  CLAIM_APPROVED: 'claim.approved',
  CLAIM_REJECTED: 'claim.rejected',
  CLAIM_CHANGES_REQUESTED: 'claim.changes_requested',
  CLAIM_WITHDRAWN: 'claim.withdrawn',
  CLAIM_EXPIRED: 'claim.expired',

  EVIDENCE_CREATED: 'evidence.created',
  EVIDENCE_UPDATED: 'evidence.updated',
  EVIDENCE_ACCEPTED: 'evidence.accepted',
  EVIDENCE_REJECTED: 'evidence.rejected',
  EVIDENCE_LINKED: 'evidence.linked',
  EVIDENCE_UNLINKED: 'evidence.unlinked',

  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_SUPERSEDED: 'document.superseded',
  DOCUMENT_ARCHIVED: 'document.archived',

  BATCH_RECEIVED: 'batch.received',
  BATCH_QUARANTINED: 'batch.quarantined',
  BATCH_RELEASED: 'batch.released',
  BATCH_DISPOSED: 'batch.disposed',
  BATCH_EXPIRED: 'batch.expired',
  LOT_TRACKING_CHANGED: 'batch.tracking.changed',

  RECALL_CREATED: 'recall.created',
  RECALL_OPENED: 'recall.opened',
  RECALL_LOTS_ADDED: 'recall.lots.added',
  RECALL_IMPACT_ASSESSED: 'recall.impact.assessed',
  RECALL_NOTIFICATION_APPROVED: 'recall.notification.approved',
  RECALL_NOTIFICATION_EXPORTED: 'recall.notification.exported',
  RECALL_REGULATOR_NOTIFIED: 'recall.regulator.notified',
  RECALL_CLOSED: 'recall.closed',
  RECALL_CANCELLED: 'recall.cancelled',
} as const;

/**
 * Customer-lifecycle actions.
 *
 * Review moderation is the one worth surfacing unprompted: publishing a review
 * puts customer-written text about a health product on a public listing, and
 * that is a decision someone may need to account for later.
 */
export const LIFECYCLE_AUDIT_ACTIONS = {
  REVIEW_SUBMITTED: 'review.submitted',
  REVIEW_PUBLISHED: 'review.published',
  REVIEW_REJECTED: 'review.rejected',
  REVIEW_ESCALATED: 'review.escalated',
  REVIEW_WITHDRAWN: 'review.withdrawn',
  REVIEW_ADVERSE_EVENT_FLAGGED: 'review.adverse_event.flagged',

  COUPON_CREATED: 'coupon.created',
  COUPON_UPDATED: 'coupon.updated',
  COUPON_REDEEMED: 'coupon.redeemed',

  PAYMENT_METHOD_ATTACHED: 'payment_method.attached',
  PAYMENT_METHOD_DETACHED: 'payment_method.detached',

  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_RENEWED: 'subscription.renewed',
  SUBSCRIPTION_RENEWAL_FAILED: 'subscription.renewal.failed',
  SUBSCRIPTION_PAUSED: 'subscription.paused',
  SUBSCRIPTION_RESUMED: 'subscription.resumed',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_UNPAID: 'subscription.unpaid',

  SUPPORT_THREAD_OPENED: 'support.thread.opened',
  SUPPORT_REPLIED: 'support.replied',
  SUPPORT_STATUS_CHANGED: 'support.status.changed',

  MARKETING_PREFERENCES_CHANGED: 'account.marketing.changed',
  DATA_EXPORTED: 'account.data.exported',
  ERASURE_REQUESTED: 'account.erasure.requested',
  ERASURE_COMPLETED: 'account.erasure.completed',
  ERASURE_REFUSED: 'account.erasure.refused',
} as const;

/**
 * Phase 6 — growth.
 *
 * Blog publication is here for the same reason review publication is: a post
 * that names a product is marketing copy about a regulated product, and "who
 * put this live and on whose approval?" is a question that gets asked later.
 *
 * Analytics collection is deliberately NOT audited per event. An audit row per
 * page view would be a per-visitor browsing log written into the one table the
 * business keeps forever — the exact record the analytics design exists to
 * prevent. Configuration changes to analytics are audited; the measurements
 * themselves are not.
 */
export const GROWTH_AUDIT_ACTIONS = {
  BLOG_POST_CREATED: 'blog.post.created',
  BLOG_POST_UPDATED: 'blog.post.updated',
  BLOG_POST_SUBMITTED: 'blog.post.submitted_for_review',
  BLOG_POST_APPROVED: 'blog.post.compliance_approved',
  BLOG_POST_REJECTED: 'blog.post.compliance_rejected',
  BLOG_POST_PUBLISHED: 'blog.post.published',
  BLOG_POST_UNPUBLISHED: 'blog.post.unpublished',
  BLOG_CATEGORY_CREATED: 'blog.category.created',

  REDIRECT_CREATED: 'redirect.created',
  REDIRECT_UPDATED: 'redirect.updated',
  REDIRECT_DELETED: 'redirect.deleted',

  ANALYTICS_RETENTION_PRUNED: 'analytics.retention.pruned',
} as const;

/**
 * Phase 7 — AI.
 *
 * Accepting a suggestion is the audited act, not generating one. Generating is
 * recorded in `ai_interactions`, which is append-only and holds the prompt, the
 * response and the guardrail findings; duplicating that into the audit log
 * would be noise. Acceptance is different: it is the moment a machine's words
 * become a person's, and "who put their name to this?" is the question that
 * gets asked later.
 */
export const AI_AUDIT_ACTIONS = {
  SUGGESTION_ACCEPTED: 'ai.suggestion.accepted',
  SUGGESTION_REJECTED: 'ai.suggestion.rejected',
  SETTINGS_CHANGED: 'ai.settings.changed',
} as const;

export const ALL_AUDIT_ACTIONS = {
  ...AUDIT_ACTIONS,
  ...CATALOGUE_AUDIT_ACTIONS,
  ...COMMERCE_AUDIT_ACTIONS,
  ...COMPLIANCE_AUDIT_ACTIONS,
  ...LIFECYCLE_AUDIT_ACTIONS,
  ...GROWTH_AUDIT_ACTIONS,
  ...AI_AUDIT_ACTIONS,
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
  // Compliance: what customers were told, and what shipped to them.
  COMPLIANCE_AUDIT_ACTIONS.CLAIM_APPROVED,
  COMPLIANCE_AUDIT_ACTIONS.CLAIM_REJECTED,
  COMPLIANCE_AUDIT_ACTIONS.CLAIM_WITHDRAWN,
  COMPLIANCE_AUDIT_ACTIONS.EVIDENCE_ACCEPTED,
  COMPLIANCE_AUDIT_ACTIONS.BATCH_QUARANTINED,
  COMPLIANCE_AUDIT_ACTIONS.BATCH_RELEASED,
  COMPLIANCE_AUDIT_ACTIONS.RECALL_OPENED,
  // The one action in the system that authorises contacting customers about a
  // product they consumed. It should never be something anyone has to go
  // looking for.
  COMPLIANCE_AUDIT_ACTIONS.RECALL_NOTIFICATION_APPROVED,
  COMPLIANCE_AUDIT_ACTIONS.RECALL_REGULATOR_NOTIFIED,
  // Publishing a review puts customer-written text about a health product on a
  // public listing. Escalation and adverse-event flags are safety signals.
  LIFECYCLE_AUDIT_ACTIONS.REVIEW_PUBLISHED,
  LIFECYCLE_AUDIT_ACTIONS.REVIEW_ESCALATED,
  LIFECYCLE_AUDIT_ACTIONS.REVIEW_ADVERSE_EVENT_FLAGGED,
  LIFECYCLE_AUDIT_ACTIONS.SUBSCRIPTION_RENEWAL_FAILED,
  LIFECYCLE_AUDIT_ACTIONS.ERASURE_COMPLETED,
  // Publishing a blog post that names a product puts marketing copy about a
  // regulated product on a public page, on somebody's named approval.
  GROWTH_AUDIT_ACTIONS.BLOG_POST_PUBLISHED,
  GROWTH_AUDIT_ACTIONS.BLOG_POST_APPROVED,
  // Somebody put their name to text a model produced. On a site selling
  // regulated products that is worth being able to find later.
  AI_AUDIT_ACTIONS.SUGGESTION_ACCEPTED,
];
