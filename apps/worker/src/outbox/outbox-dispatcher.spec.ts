import { DOMAIN_EVENTS } from '@health/types';
import { queueForEvent } from './outbox-dispatcher.service.js';

describe('queueForEvent', () => {
  it('routes account and staff events to the email queue', () => {
    const emailEvents = [
      DOMAIN_EVENTS.USER_REGISTERED,
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

  it('sends an unrecognised event to analytics rather than dropping it', () => {
    // An event nobody consumes yet is still evidence that something happened.
    expect(queueForEvent('order.placed.v1')).toBe('analytics');
    expect(queueForEvent('something.entirely.new')).toBe('analytics');
  });
});
