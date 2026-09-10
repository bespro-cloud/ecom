import type { Metadata } from 'next';
import { Alert, Card, PageHeader } from '@health/ui';
import { apiRequestOrSignIn } from '@/lib/guards';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { SettingEditor } from '@/components/setting-editor';
import { FeatureFlagEditor } from '@/components/feature-flag-editor';

export const metadata: Metadata = { title: 'Settings & flags' };

export interface SystemSetting {
  key: string;
  value: unknown;
  valueType: string;
  description: string | null;
  updatedAt: string;
}

export interface FeatureFlag {
  key: string;
  description: string | null;
  enabled: boolean;
  rolloutPercentage: number;
  enabledForSubjects: string[];
  updatedAt: string;
}

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'SYSTEM_SETTINGS')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="SYSTEM_SETTINGS" />
      </ConsoleShell>
    );
  }

  const [{ data: settings }, { data: flags }] = await Promise.all([
    apiRequestOrSignIn<{ data: SystemSetting[] }>('/api/v1/system/settings'),
    apiRequestOrSignIn<{ data: FeatureFlag[] }>('/api/v1/system/feature-flags'),
  ]);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Settings & flags"
          description="Business configuration that changes without a deploy. Credentials are not here — those live in the secret manager and are read from the environment."
        />

        <Alert tone="warning">
          Every change here requires a written reason and is recorded in the audit log with the
          previous and new value.
        </Alert>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">System settings</h2>
          <ul className="mt-4 divide-y divide-slate-100">
            {settings.map((setting) => (
              <li key={setting.key} className="py-4 first:pt-0 last:pb-0">
                <SettingEditor setting={setting} />
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Feature flags</h2>
          <p className="mt-1 text-sm text-slate-600">
            Rollout is deterministic per subject: a given customer stays on one side of the split
            rather than flipping between requests.
          </p>
          <ul className="mt-4 divide-y divide-slate-100">
            {flags.map((flag) => (
              <li key={flag.key} className="py-4 first:pt-0 last:pb-0">
                <FeatureFlagEditor flag={flag} />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </ConsoleShell>
  );
}
