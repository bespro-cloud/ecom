import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listPages } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { formatRelative } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { NewPageForm } from '@/components/new-page-form';

export const metadata: Metadata = { title: 'Pages' };

export default async function ContentPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'CONTENT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="CONTENT_READ" />
      </ConsoleShell>
    );
  }

  const pages = await listPages();

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Pages"
          description="Shipping policy, returns, about — the pages customers read when they want to know how this works. Editing a live page writes a draft; the live version does not change until you publish."
        />

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <Card>
            {pages.length === 0 ? (
              <EmptyState title="No pages yet" description="Create the first one." />
            ) : (
              <TableShell caption="Content pages">
                <thead>
                  <tr>
                    <Th>Page</Th>
                    <Th>Status</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {pages.map((page) => (
                    <tr key={page.id}>
                      <Td>
                        <Link
                          href={`/content/${page.id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {page.title}
                        </Link>
                        <code className="block font-mono text-xs text-slate-500">/{page.slug}</code>
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={page.status === 'PUBLISHED' ? 'success' : 'neutral'}>
                            {page.status.toLowerCase()}
                          </Badge>
                          {page.hasUnpublishedChanges ? (
                            <Badge tone="warning">unpublished edits</Badge>
                          ) : null}
                        </div>
                      </Td>
                      <Td>{formatRelative(page.updatedAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          {hasPermission(user, 'CONTENT_WRITE') ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">New page</h2>
              <div className="mt-4">
                <NewPageForm />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </ConsoleShell>
  );
}
