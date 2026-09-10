import { Alert } from '@health/ui';
import type { PermissionKey, PublicUser } from '@health/types';

/**
 * Renders an explanation instead of a blank page when a user opens a section
 * their role does not cover.
 *
 * The API would refuse the underlying request regardless; this exists so the
 * refusal reads as a deliberate policy rather than a broken page.
 */
export function PermissionNotice({
  user,
  permission,
}: {
  user: PublicUser;
  permission: PermissionKey;
}) {
  return (
    <Alert tone="warning" title="You do not have access to this section">
      <p>
        This area needs the <code className="font-mono">{permission}</code> permission. Your roles (
        {user.roles.join(', ') || 'none'}) do not include it.
      </p>
      <p className="mt-2">
        If you need access, ask an administrator to review your role assignment — permissions are
        granted through roles, not individually.
      </p>
    </Alert>
  );
}

export function hasPermission(user: PublicUser, permission: PermissionKey): boolean {
  return user.permissions.includes(permission);
}
