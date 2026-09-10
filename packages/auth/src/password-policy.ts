import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.js';

/**
 * Password policy.
 *
 * Length-first, following NIST SP 800-63B: no forced composition rules and no
 * forced rotation, but a block-list of trivially guessable values and a check
 * that the password is not simply the user's own identifiers.
 */

export interface PasswordPolicyContext {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Base words that appear at the top of every breach corpus.
 *
 * Matching is done against a *normalised* form of the candidate — leet
 * substitutions undone, then non-letters removed — so `P@ssw0rd!`,
 * `password1234` and `Password2026` are all caught by the single entry
 * `password`. Checking exact strings alone would let a trivially guessable
 * password through simply because the user appended enough digits to clear the
 * length rule.
 *
 * This is a cheap first line of defence, not a substitute for a breach-corpus
 * lookup (e.g. Have I Been Pwned's k-anonymity range API), which is planned as
 * an asynchronous check once outbound network policy for it is agreed.
 */
const COMMON_BASE_WORDS = new Set([
  'password',
  'passwd',
  'pass',
  'welcome',
  'qwerty',
  'qwertyuiop',
  'asdfgh',
  'zxcvbn',
  'letmein',
  'iloveyou',
  'admin',
  'administrator',
  'root',
  'guest',
  'test',
  'testing',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'basketball',
  'superman',
  'batman',
  'trustno',
  'trustnoone',
  'changeme',
  'secret',
  'master',
  'shadow',
  'michael',
  'jordan',
  'hunter',
  'freedom',
  'whatever',
  'ninja',
  'azerty',
  'starwars',
  'computer',
  'internet',
  'login',
  'access',
  'default',
  'temporary',
  'healthcommerce',
  'health',
  'commerce',
  'supplement',
  'vitamin',
  'wellness',
]);

/** Full-string matches that normalisation would not reduce to a base word. */
const COMMON_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  '111111111111',
  'aaaaaaaaaaaa',
  'qazwsxedcrfv',
  'zaq12wsxcde3',
]);

const LEET_SUBSTITUTIONS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '+': 't',
};

function deLeet(value: string): string {
  return value.replace(/[01345789@$!+]/g, (char) => LEET_SUBSTITUTIONS[char] ?? char);
}

/** Removes padding characters from both ends, leaving the word in the middle. */
function trimPadding(value: string): string {
  return value.replace(/^[^a-z]+/, '').replace(/[^a-z]+$/, '');
}

/**
 * Candidate forms a weak password could be hiding behind.
 *
 * Order matters for the leet forms: padding is trimmed *before* substitution,
 * otherwise the trailing `1234` in `P@ssw0rd1234` would itself be rewritten
 * into letters and the base word would no longer match.
 */
function normalisedForms(password: string): string[] {
  const lowered = password.toLowerCase();
  const trimmed = trimPadding(lowered);
  return [
    ...new Set([
      lowered,
      lowered.replace(/[^a-z]/g, ''),
      deLeet(lowered).replace(/[^a-z]/g, ''),
      deLeet(trimmed).replace(/[^a-z]/g, ''),
    ]),
  ].filter((form) => form.length > 0);
}

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

/** True when most of the password is one straight walk along a keyboard row. */
function isKeyboardWalk(lowered: string): boolean {
  const stripped = lowered.replace(/[^a-z0-9]/g, '');
  if (stripped.length < 8) return false;
  return KEYBOARD_ROWS.some((row) => {
    const reversed = [...row].reverse().join('');
    return row.includes(stripped) || reversed.includes(stripped);
  });
}

export function evaluatePassword(
  password: string,
  context: PasswordPolicyContext = {},
): PasswordPolicyResult {
  const problems: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }

  const lowered = password.toLowerCase();
  const forms = normalisedForms(password);

  if (COMMON_PASSWORDS.has(lowered) || forms.some((form) => COMMON_BASE_WORDS.has(form))) {
    problems.push(
      'This is too close to a password that appears on well-known breach lists. ' +
        'Adding numbers to a common word does not make it stronger.',
    );
  }

  if (isKeyboardWalk(lowered)) {
    problems.push('Must not be a straight run of keys along the keyboard.');
  }

  if (/^(.)\1+$/.test(password)) {
    problems.push('Must not be a single repeated character.');
  }

  if (isSequential(lowered)) {
    problems.push('Must not be a simple sequence of characters.');
  }

  const identifiers = [
    context.email?.split('@')[0],
    context.email,
    context.firstName,
    context.lastName,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length >= 4)
    .map((value) => value.toLowerCase());

  if (identifiers.some((identifier) => lowered.includes(identifier))) {
    problems.push('Must not contain your name or email address.');
  }

  return { ok: problems.length === 0, problems };
}

function isSequential(value: string): boolean {
  if (value.length < 6) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < value.length; i += 1) {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}
