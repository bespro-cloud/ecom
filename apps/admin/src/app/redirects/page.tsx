import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listRedirects } from '@/lib/growth';
import { currentUser } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { RedirectForm } from '@/components/redirect-form';
import { RedirectToggle } from '@/components/redirect-toggle';

export const metadata: Metadata = { title: 'Redirects' };

export default async function RedirectsPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'SEO_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="SEO_READ" />
      </ConsoleShell>
    );
  }

  const { data } = await listRedirects('limit=200');
  const automatic = data.filter((row) => row.isAutomatic).length;

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Redirects"
          description="Most of these write themselves. Renaming a published product, page or post records a permanent redirect automatically, in the same transaction as the rename."
        />

        {automatic > 0 ? (
          <Alert tone="info" title={`${automatic} of these were created automatically`}>
            A listing that has been indexed for two years and silently starts returning 404 loses
            its ranking and the people who bookmarked it, and nobody notices until the traffic has
            gone. That is why renames write these rather than relying on someone to remember.
          </Alert>
        ) : null}

        <Card>
          {data.length === 0 ? (
            <EmptyState
              title="No redirects"
              description="One will appear here the first time a published URL is renamed."
            />
          ) : (
            <TableShell caption="Redirects, most-used first">
              <thead>
                <tr>
                  <Th>From</Th>
                  <Th>To</Th>
                  <Th className="text-right">Hits</Th>
                  <Th>Source</Th>
                  <Th>State</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id}>
                    <Td>
                      <span className="font-mono text-sm text-slate-900">{row.fromPath}</span>
                    </Td>
                    <Td>
                      <span className="font-mono text-sm text-slate-700">{row.toPath}</span>
                      {row.statusCode !== 301 ? (
                        <Badge tone="info" className="ml-2">
                          {row.statusCode}
                        </Badge>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {row.hitCount.toLocaleString()}
                      {row.lastHitAt ? (
                        <span className="block text-xs text-slate-500">
                          {formatDate(row.lastHitAt)}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-sm text-slate-600">
                      {row.isAutomatic
                        ? `Automatic (${row.reason ?? 'rename'})`
                        : (row.createdByLabel ?? 'Manual')}
                    </Td>
                    <Td>
                      <Badge tone={row.isActive ? 'success' : 'neutral'}>
                        {row.isActive ? 'On' : 'Off'}
                      </Badge>
                    </Td>
                    <Td>
                      {hasPermission(user, 'SEO_WRITE') ? (
                        <RedirectToggle redirectId={row.id} isActive={row.isActive} />
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        {hasPermission(user, 'SEO_WRITE') ? (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Add a redirect</h2>
            <p className="mt-1 max-w-prose text-sm text-slate-600">
              A rule that would close a loop is refused, at any chain length — a loop is not a
              degraded experience, it is the page becoming unreachable.
            </p>
            <div className="mt-4">
              <RedirectForm />
            </div>
          </Card>
        ) : null}
      </div>
    </ConsoleShell>
  );
}
