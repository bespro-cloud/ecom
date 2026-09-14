import { DOMAIN_EVENTS } from '@health/types';
import { queueForEvent } from './outbox-dispatcher.service.js';

describe('queueForEvent', () => {
  it('routes account and staff events to the email queue', () => {
    const emailEvents = [
      DOMAIN_EVENTS.USER_REGISTERED,
      DOMAIN_EVENTS.USER_EMAIL_VERIFICATION_REQUESTED,
      DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED,
      DOMAIN_EVENTS.USER_PASSWORD_CHANGED,
      DOMAIN_EVENTS.USER_LOCKED_OUT,
      DOMAIN_EVENTS.USER_MFA_ENROLLED,
      DOMAIN_EVENTS.USER_MFA_DISABLED,
      DOMAIN_EVENTS.STAFF_INVITED,
      DOMAIN_EVENTS.STAFF_ROLES_CHANGED,
    ];
    for (const event of emailEvents) {
      expect(queueForEvent(event)).toBe('email');
    }
  });

  it('routes the transactional commerce and lifecycle events to the email queue', () => {
    // Each of these has a renderer in EmailProcessor. Routing an event here
    // that the processor cannot render dead-letters the job, so this list and
    // that switch have to stay in step — which is what this test is for.
    const emailEvents = [
      DOMAIN_EVENTS.ORDER_PLACED,
      DOMAIN_EVENTS.ORDER_CANCELLED,
      DOMAIN_EVENTS.PAYMENT_FAILED,
      DOMAIN_EVENTS.REFUND_ISSUED,
      DOMAIN_EVENTS.SUBSCRIPTION_RENEWAL_FAILED,
      DOMAIN_EVENTS.SUBSCRIPTION_UNPAID,
      DOMAIN_EVENTS.SUPPORT_REPLIED,
    ];
    for (const event of emailEvents) {
      expect(queueForEvent(event)).toBe('email');
    }
  });

  it('sends an unrecognised event to analytics rather than dropping it', () => {
    // An event nobody consumes yet is still evidence that something happened.
    expect(queueForEvent('something.entirely.new')).toBe('analytics');
    expect(queueForEvent('')).toBe('analytics');
  });
});
