/**
 * Domain event names written to the transactional outbox and consumed by the
 * worker. Keep them past-tense and versioned by name, never by payload shape
 * changes.
 */
export const DOMAIN_EVENTS = {
  USER_REGISTERED: 'user.registered.v1',
  USER_EMAIL_VERIFICATION_REQUESTED: 'user.email_verification_requested.v1',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested.v1',
  USER_PASSWORD_CHANGED: 'user.password_changed.v1',
  USER_MFA_ENROLLED: 'user.mfa_enrolled.v1',
  USER_MFA_DISABLED: 'user.mfa_disabled.v1',
  USER_LOCKED_OUT: 'user.locked_out.v1',
  STAFF_INVITED: 'staff.invited.v1',
  STAFF_ROLES_CHANGED: 'staff.roles_changed.v1',
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export const QUEUE_NAMES = [
  'email',
  'sms',
  'orders',
  'payments',
  'fulfillment',
  'inventory',
  'search',
  'analytics',
  'seo',
  'ai',
  'subscriptions',
  'reviews',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Suffix appended to a queue name to form its dead-letter queue. */
/** BullMQ reserves ':' in queue names — it is the Redis key separator. */
export const DEAD_LETTER_SUFFIX = '-dlq';

export function deadLetterQueueName(queue: QueueName): string {
  return `${queue}${DEAD_LETTER_SUFFIX}`;
}
