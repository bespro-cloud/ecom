import { describe, expect, it } from 'vitest';
import { evaluatePassword } from './password-policy.js';

describe('evaluatePassword', () => {
  it('accepts a long passphrase', () => {
    expect(evaluatePassword('salted caramel harbour lantern').ok).toBe(true);
  });

  it('rejects short passwords', () => {
    const result = evaluatePassword('short1!');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('at least 12');
  });

  it('rejects well-known passwords', () => {
    expect(evaluatePassword('password123').ok).toBe(false);
    expect(evaluatePassword('ChangeMe1234').ok).toBe(false);
  });

  it('rejects a common word padded out to the length minimum', () => {
    // Regression: `password1234` cleared the length rule and slipped past an
    // exact-match block list.
    expect(evaluatePassword('password1234').ok).toBe(false);
    expect(evaluatePassword('Welcome202666').ok).toBe(false);
    expect(evaluatePassword('iloveyou!!!!!').ok).toBe(false);
  });

  it('sees through leetspeak substitutions', () => {
    expect(evaluatePassword('P@ssw0rd1234').ok).toBe(false);
    expect(evaluatePassword('L3tm31n12345').ok).toBe(false);
  });

  it('rejects keyboard walks', () => {
    expect(evaluatePassword('qwertyuiop').ok).toBe(false);
    expect(evaluatePassword('poiuytrewq').ok).toBe(false);
  });

  it('still accepts a strong passphrase that merely contains a common word', () => {
    expect(evaluatePassword('my password lives in a vault').ok).toBe(true);
  });

  it('rejects repeated characters and sequences', () => {
    expect(evaluatePassword('aaaaaaaaaaaaaa').ok).toBe(false);
    expect(evaluatePassword('abcdefghijklm').ok).toBe(false);
  });

  it('rejects passwords containing the user identifiers', () => {
    const result = evaluatePassword('kowalski-is-here-now', {
      email: 'anna@example.com',
      lastName: 'Kowalski',
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('name or email');
  });

  it('ignores identifiers too short to be meaningful', () => {
    expect(evaluatePassword('a memorable long passphrase', { firstName: 'Al' }).ok).toBe(true);
  });
});
