import { describe, expect, it } from 'vitest';
import { AccessTokenService, TokenVerificationError } from './access-token.js';

const SECRET = Buffer.alloc(32, 5).toString('base64');
const OTHER_SECRET = Buffer.alloc(32, 6).toString('base64');
const NOW = new Date('2026-03-01T12:00:00.000Z');

const claims = {
  sub: '11111111-1111-4111-8111-111111111111',
  sid: '22222222-2222-4222-8222-222222222222',
  email: 'admin@example.com',
  type: 'STAFF' as const,
  roles: ['ADMIN'],
  permissions: ['ORDER_READ' as const],
  mfa: true,
};

describe('AccessTokenService', () => {
  const service = new AccessTokenService(SECRET);

  it('round-trips access token claims', async () => {
    const token = await service.signAccessToken(claims, { issuedAt: NOW, ttlSeconds: 900 });
    const decoded = await service.verifyAccessToken(token, NOW);
    expect(decoded).toEqual(claims);
  });

  it('rejects an expired token', async () => {
    const token = await service.signAccessToken(claims, { issuedAt: NOW, ttlSeconds: 60 });
    const later = new Date(NOW.getTime() + 120_000);
    await expect(service.verifyAccessToken(token, later)).rejects.toMatchObject({
      reason: 'EXPIRED',
    });
  });

  it('rejects a token signed with another key', async () => {
    const token = await service.signAccessToken(claims, { issuedAt: NOW, ttlSeconds: 900 });
    const other = new AccessTokenService(OTHER_SECRET);
    await expect(other.verifyAccessToken(token, NOW)).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('rejects a tampered payload', async () => {
    const token = await service.signAccessToken(claims, { issuedAt: NOW, ttlSeconds: 900 });
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.permissions = ['REFUND_ISSUE'];
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
    await expect(service.verifyAccessToken(forged, NOW)).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('will not accept an MFA challenge token as an access token', async () => {
    const challenge = await service.signMfaChallenge(
      { sub: claims.sub, jti: 'nonce-1', methods: ['TOTP'] },
      { issuedAt: NOW, ttlSeconds: 300 },
    );
    await expect(service.verifyAccessToken(challenge, NOW)).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('will not accept an access token as an MFA challenge', async () => {
    const token = await service.signAccessToken(claims, { issuedAt: NOW, ttlSeconds: 900 });
    await expect(service.verifyMfaChallenge(token, NOW)).rejects.toBeInstanceOf(
      TokenVerificationError,
    );
  });

  it('round-trips MFA challenge claims', async () => {
    const challenge = await service.signMfaChallenge(
      { sub: claims.sub, jti: 'nonce-1', methods: ['TOTP', 'RECOVERY_CODE'] },
      { issuedAt: NOW, ttlSeconds: 300 },
    );
    const decoded = await service.verifyMfaChallenge(challenge, NOW);
    expect(decoded.sub).toBe(claims.sub);
    expect(decoded.jti).toBe('nonce-1');
    expect(decoded.methods).toEqual(['TOTP', 'RECOVERY_CODE']);
  });

  it('refuses to construct with a weak secret', () => {
    expect(() => new AccessTokenService('c2hvcnQ=')).toThrow(/at least 32 bytes/);
  });
});
