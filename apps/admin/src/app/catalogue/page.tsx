import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader, TableShell, Td, Th } from '@health/ui';
import { listProducts, type AdminProductSummary } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { formatMoney, formatRelative } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { ProductFilters } from '@/components/product-filters';

export const metadata: Metadata = { title: 'Catalogue' };

const STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'info',
  READY: 'warning',
  PUBLISHED: 'success',
  ARCHIVED: 'neutral',
};

const COMPLIANCE_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  NOT_REVIEWED: 'neutral',
  IN_REVIEW: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};

function label(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

export default async function CataloguePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'PRODUCT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="PRODUCT_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['search', 'status', 'type', 'complianceStatus', 'cursor']) {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (single) query.set(key, single);
  }

  const { data, meta } = await listProducts(query.toString());

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Catalogue"
          description="Every product, including drafts. A listing only becomes publicly visible by passing the publishing checklist — there is no way to set it live from this table."
          actions={
            hasPermission(user, 'PRODUCT_WRITE') ? (
              <Link
                href="/catalogue/new"
                className="inline-flex items-center rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
              >
                New product
              </Link>
            ) : undefined
          }
        />

        <Card>
          <ProductFilters params={params} />

          {data.length === 0 ? (
            <EmptyState
              title="No products match"
              description="Adjust the filters, or create the first product."
            />
          ) : (
            <div className="mt-4">
              <TableShell caption="Products, newest first">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Status</Th>
                    <Th>Compliance</Th>
                    <Th>Price</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((product) => (
                    <ProductRow key={product.id} product={product} />
                  ))}
                </tbody>
              </TableShell>

              {meta.hasMore && meta.nextCursor ? (
                <p className="mt-4">
                  <Link
                    href={`/catalogue?${new URLSearchParams({
                      ...Object.fromEntries(query),
                      cursor: meta.nextCursor,
                    }).toString()}`}
                    className="text-sm font-medium text-brand-700 hover:underline"
                  >
                    Load more
                  </Link>
                </p>
              ) : null}
            </div>
          )}
        </Card>
      </div>
    </ConsoleShell>
  );
}

function ProductRow({ product }: { product: AdminProductSummary }) {
  const reviewOverdue =
    product.complianceStatus === 'APPROVED' &&
    product.complianceReviewDueAt !== null &&
    new Date(product.complianceReviewDueAt).getTime() <= Date.now();

  return (
    <tr>
      <Td>
        <Link
          href={`/catalogue/${product.id}`}
          className="font-medium text-slate-900 hover:underline"
        >
          {product.name}
        </Link>
        <span className="block font-mono text-xs text-slate-500">{product.sku}</span>
      </Td>
      <Td>
        <Badge tone={STATUS_TONES[product.status] ?? 'neutral'}>{label(product.status)}</Badge>
      </Td>
      <Td>
        <Badge
          tone={
            reviewOverdue ? 'warning' : (COMPLIANCE_TONES[product.complianceStatus] ?? 'neutral')
          }
        >
          {reviewOverdue ? 'review overdue' : label(product.complianceStatus)}
        </Badge>
      </Td>
      <Td>{formatMoney(product.priceCents, product.currency)}</Td>
      <Td>{formatRelative(product.updatedAt)}</Td>
    </tr>
  );
}
