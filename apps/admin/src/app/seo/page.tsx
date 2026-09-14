import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { fetchSeoAudit } from '@/lib/growth';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';

export const metadata: Metadata = { title: 'SEO audit' };

const TONE: Record<string, 'danger' | 'warning' | 'info'> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
};

/**
 * The SEO audit.
 *
 * Every row is a report. Nothing on this page fixes anything, and in particular
 * nothing writes a title or a description — that line is the point of the page
 * and it is stated on the page.
 */
export default async function SeoPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'SEO_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="SEO_READ" />
      </ConsoleShell>
    );
  }

  const report = await fetchSeoAudit();

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="SEO audit"
          description="Problems found across published products, categories, pages and posts."
        />

        <Alert tone="info" title="This reports; it does not write">
          <p>
            Sitemaps, canonical URLs, redirects and structured data are automated. Copy is not: a
            meta description for a supplement is a public statement about a health product, and a
            generated one is exactly the fluent, plausible sentence that ends up claiming something
            nobody reviewed and no evidence supports.
          </p>
          <p className="mt-2">
            So this page tells you a description is missing. A person writes it.
          </p>
        </Alert>

        <div className="grid gap-4 sm:grid-cols-3">
          <Count label="Errors" value={report.counts.error} tone="danger" />
          <Count label="Warnings" value={report.counts.warning} tone="warning" />
          <Count label="Suggestions" value={report.counts.info} tone="info" />
        </div>

        <Card>
          {report.issues.length === 0 ? (
            <EmptyState
              title="Nothing to fix"
              description="Every published page has a title and a description, and no images are missing alternative text."
            />
          ) : (
            <TableShell caption="Issues, most serious first">
              <thead>
                <tr>
                  <Th>Severity</Th>
                  <Th>Page</Th>
                  <Th>Problem</Th>
                </tr>
              </thead>
              <tbody>
                {report.issues.map((issue, index) => (
                  <tr key={`${issue.entityId}-${issue.code}-${index}`}>
                    <Td>
                      <Badge tone={TONE[issue.severity] ?? 'info'}>{issue.severity}</Badge>
                    </Td>
                    <Td>
                      <span className="text-sm text-slate-900">{issue.label}</span>
                      {issue.path ? (
                        <span className="block font-mono text-xs text-slate-500">{issue.path}</span>
                      ) : null}
                    </Td>
                    <Td className="text-sm text-slate-700">{issue.message}</Td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'danger' | 'warning' | 'info';
}) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">{label}</p>
        <Badge tone={tone}>{value}</Badge>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
    </Card>
  );
}
