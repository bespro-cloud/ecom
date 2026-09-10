import { describe, expect, it } from 'vitest';
import { createRoleSchema, inviteStaffUserSchema, setUserRolesSchema } from './admin.js';

describe('inviteStaffUserSchema', () => {
  it('accepts a staff role', () => {
    const parsed = inviteStaffUserSchema.parse({
      email: 'ops@example.com',
      firstName: 'Sam',
      lastName: 'Ortiz',
      roleKeys: ['ORDER_MANAGER'],
    });
    expect(parsed.roleKeys).toEqual(['ORDER_MANAGER']);
  });

  it('refuses to assign the CUSTOMER role to a staff user', () => {
    const result = inviteStaffUserSchema.safeParse({
      email: 'ops@example.com',
      firstName: 'Sam',
      lastName: 'Ortiz',
      roleKeys: ['CUSTOMER'],
    });
    expect(result.success).toBe(false);
  });

  it('requires at least one role', () => {
    const result = inviteStaffUserSchema.safeParse({
      email: 'ops@example.com',
      firstName: 'Sam',
      lastName: 'Ortiz',
      roleKeys: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('createRoleSchema', () => {
  it('rejects unknown permission keys', () => {
    const result = createRoleSchema.safeParse({
      key: 'CUSTOM_ROLE',
      name: 'Custom role',
      permissionKeys: ['ORDER_READ', 'NOT_A_REAL_PERMISSION'],
    });
    expect(result.success).toBe(false);
  });

  it('normalises the role key', () => {
    const parsed = createRoleSchema.parse({
      key: 'custom_role',
      name: 'Custom role',
      permissionKeys: ['ORDER_READ'],
    });
    expect(parsed.key).toBe('CUSTOM_ROLE');
    expect(parsed.requiresMfa).toBe(false);
  });
});

describe('setUserRolesSchema', () => {
  it('requires a reason so the audit trail is meaningful', () => {
    expect(setUserRolesSchema.safeParse({ roleKeys: ['ANALYST'] }).success).toBe(false);
    expect(
      setUserRolesSchema.safeParse({ roleKeys: ['ANALYST'], reason: 'Joined the data team' })
        .success,
    ).toBe(true);
  });
});
