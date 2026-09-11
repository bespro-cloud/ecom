import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, PageHeader } from '@health/ui';
import { getPage, getSeo } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { formatDateTime } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { PageEditor } from '@/components/page-editor';
import { SeoEditor } from '@/components/seo-editor';

export const metadata: Metadata = { title: 'Edit page' };

export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'CONTENT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="CONTENT_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;
  const [page, seo] = await Promise.all([
    getPage(id),
    hasPermission(user, 'SEO_READ') ? getSeo('PAGE', id) : Promise.resolve(null),
  ]);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={page.title}
          description={`/pages/${page.slug}`}
          actions={
            <Link
              href="/content"
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              All pages
            </Link>
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={page.status === 'PUBLISHED' ? 'success' : 'neutral'}>
            {page.status.toLowerCase()}
          </Badge>
          {page.hasUnpublishedChanges ? <Badge tone="warning">unpublished edits</Badge> : null}
          {page.publishedAt ? (
            <span className="text-sm text-slate-600">
              Published {formatDateTime(page.publishedAt)}
            </span>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <Card>
            <PageEditor
              page={page}
              canWrite={hasPermission(user, 'CONTENT_WRITE')}
              canPublish={hasPermission(user, 'CONTENT_PUBLISH')}
            />
          </Card>

          <div className="space-y-6">
            {hasPermission(user, 'SEO_READ') ? (
              <Card>
                <SeoEditor
                  entityType="PAGE"
                  entityId={page.id}
                  initial={seo}
                  canWrite={hasPermission(user, 'SEO_WRITE')}
                />
              </Card>
            ) : null}
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
}
