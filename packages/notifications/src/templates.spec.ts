import { describe, expect, it } from 'vitest';
import {
  accountLockedEmail,
  passwordResetEmail,
  staffInviteEmail,
  welcomeEmail,
  type TemplateContext,
} from './templates.js';

const context: TemplateContext = {
  storeName: 'Health Commerce',
  supportEmail: 'support@example.test',
  storefrontUrl: 'https://shop.example.test',
  adminUrl: 'https://admin.example.test',
};

describe('transactional templates', () => {
  it('builds a welcome email with a usable verification link', () => {
    const message = welcomeEmail(context, {
      firstName: 'Ada',
      to: 'ada@example.test',
      verificationToken: 'tok en/with+chars',
    });

    expect(message.to.email).toBe('ada@example.test');
    expect(message.subject).toContain('Health Commerce');
    // The token must survive as a query parameter.
    expect(message.text).toContain('token=tok%20en%2Fwith%2Bchars');
    expect(message.text).toContain('Ada');
  });

  it('always provides a plain-text body', () => {
    const messages = [
      welcomeEmail(context, { firstName: null, to: 'a@b.test', verificationToken: 't' }),
      passwordResetEmail(context, { to: 'a@b.test', token: 't' }),
      accountLockedEmail(context, { to: 'a@b.test', attempts: 8 }),
      staffInviteEmail(context, { to: 'a@b.test', token: 't', roles: ['ANALYST'] }),
    ];
    for (const message of messages) {
      expect(message.text.length).toBeGreaterThan(20);
      expect(message.subject.length).toBeGreaterThan(5);
    }
  });

  it('makes no health claim in any transactional message', () => {
    const bodies = [
      welcomeEmail(context, { firstName: 'Ada', to: 'a@b.test', verificationToken: 't' }),
      passwordResetEmail(context, { to: 'a@b.test', token: 't' }),
      accountLockedEmail(context, { to: 'a@b.test', attempts: 8 }),
    ].map((m) => `${m.subject} ${m.text}`.toLowerCase());

    // Transactional mail is exempt from claim review precisely because it says
    // nothing about a product; this test keeps it that way.
    const forbidden = ['cure', 'treat', 'prevent disease', 'fda approved', 'clinically proven'];
    for (const body of bodies) {
      for (const phrase of forbidden) {
        expect(body).not.toContain(phrase);
      }
    }
  });

  it('tells a locked-out user how to recover without confirming an attack', () => {
    const message = accountLockedEmail(context, { to: 'a@b.test', attempts: 8 });
    expect(message.text).toContain('unlock automatically');
    expect(message.text).toContain('/forgot-password');
  });

  it('lists the granted roles in a staff invitation', () => {
    const message = staffInviteEmail(context, {
      to: 'ops@example.test',
      token: 't',
      roles: ['ORDER_MANAGER', 'ANALYST'],
    });
    expect(message.text).toContain('ORDER_MANAGER');
    expect(message.text).toContain('ANALYST');
    expect(message.text).toContain('valid for seven days');
  });
});
