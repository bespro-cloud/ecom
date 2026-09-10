import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

/**
 * Time-based one-time passwords (RFC 6238).
 *
 * A ±1 step window absorbs clock drift. Replay is prevented by the caller
 * persisting the accepted counter — see `UserMfaFactor.lastUsedCounter` — so a
 * code that is still inside the window cannot be presented twice.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = 'SHA1';
export const TOTP_WINDOW = 1;

export interface TotpEnrollment {
  /** Base32 shared secret. Store encrypted; show once during enrolment. */
  secret: string;
  /** otpauth:// URI for QR rendering. Contains the secret — never log it. */
  uri: string;
}

export function generateTotpSecret(issuer: string, accountLabel: string): TotpEnrollment {
  const secret = new Secret({ buffer: randomBytes(20) });
  const totp = buildTotp(secret.base32, issuer, accountLabel);
  return { secret: secret.base32, uri: totp.toString() };
}

function buildTotp(secret: string, issuer = 'Health Commerce', label = 'account'): TOTP {
  return new TOTP({
    issuer,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

export interface TotpVerification {
  valid: boolean;
  /** Time step the code belongs to. Persist it to block replay. */
  counter: number | null;
}

/**
 * @param lastUsedCounter the highest counter previously accepted for this
 *   factor. Codes at or below it are rejected even when otherwise valid.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { at: Date; lastUsedCounter?: bigint | number | null } = { at: new Date() },
): TotpVerification {
  const normalised = code.replace(/\s|-/g, '');
  if (!/^\d{6}$/.test(normalised)) return { valid: false, counter: null };

  let totp: TOTP;
  try {
    totp = buildTotp(secret);
  } catch {
    return { valid: false, counter: null };
  }

  const delta = totp.validate({
    token: normalised,
    timestamp: options.at.getTime(),
    window: TOTP_WINDOW,
  });
  if (delta === null) return { valid: false, counter: null };

  const currentStep = Math.floor(options.at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
  const counter = currentStep + delta;

  const last = options.lastUsedCounter;
  if (last !== null && last !== undefined && counter <= Number(last)) {
    // Valid code, but already spent. Treated as invalid to stop replay.
    return { valid: false, counter: null };
  }
  return { valid: true, counter };
}

/** Test/support helper: derive the code for a moment in time. */
export function generateTotpCode(secret: string, at: Date): string {
  return buildTotp(secret).generate({ timestamp: at.getTime() });
}
