import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@health/ui';
import { getProduct, getReadiness, getSeo, type AdminProduct } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { formatDateTime, formatMoney } from '@/lib/format';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { PublishChecklist } from '@/components/publish-checklist';
import { ProductStatusControl } from '@/components/product-status-control';
import { ProductEditor } from '@/components/product-editor';
import { SeoEditor } from '@/components/seo-editor';

export const metadata: Metadata = { title: 'Product' };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'PRODUCT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="PRODUCT_READ" />
      </ConsoleShell>
    );
  }

  const { id } = await params;
  const [product, readiness, seo] = await Promise.all([
    getProduct(id),
    getReadiness(id),
    hasPermission(user, 'SEO_READ') ? getSeo('PRODUCT', id) : Promise.resolve(null),
  ]);

  const canWrite = hasPermission(user, 'PRODUCT_WRITE');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title={product.name}
          description={`${product.sku} · ${product.type.toLowerCase()}`}
          actions={
            <Link
              href="/catalogue"
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to catalogue
            </Link>
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={product.status === 'PUBLISHED' ? 'success' : 'neutral'}>
            {product.status.toLowerCase().replace(/_/g, ' ')}
          </Badge>
          <Badge tone={product.complianceStatus === 'APPROVED' ? 'success' : 'warning'}>
            compliance: {product.complianceStatus.toLowerCase().replace(/_/g, ' ')}
          </Badge>
          {product.complianceReviewDueAt ? (
            <span className="text-sm text-slate-600">
              Approval due for re-review {formatDateTime(product.complianceReviewDueAt)}
            </span>
          ) : null}
        </div>

        <ApprovalNotice product={product} />

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-6">
            <Card>
              <ProductEditor product={product} canWrite={canWrite} />
            </Card>

            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Composition</h2>
              <p className="mt-1 text-sm text-slate-600">
                Changing the formulation, the warnings or the label photograph re-opens the
                compliance approval and takes a live listing down. That is deliberate: the previous
                approval did not cover the new version.
              </p>

              <Section title="Ingredients">
                {product.ingredients.length === 0 ? (
                  <p className="text-sm text-slate-500">None recorded.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {product.ingredients.map((entry) => (
                      <li key={entry.ingredientId} className="flex flex-wrap gap-2">
                        <Link
                          href={`/catalogue/ingredients/${entry.ingredientId}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {entry.name}
                        </Link>
                        <span className="text-slate-600">
                          {entry.amount !== null
                            ? `${entry.amount} ${entry.unit ?? ''}`.trim()
                            : (entry.notes ?? 'amount not recorded')}
                        </span>
                        {entry.isActive ? null : <Badge>other ingredient</Badge>}
                        {entry.isAllergen ? <Badge tone="warning">allergen</Badge> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Warnings">
                {product.warnings.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    None on the listing. Warnings inherited from ingredients are shown to customers
                    automatically and are not listed here.
                  </p>
                ) : (
                  <ul className="space-y-1 text-sm text-slate-700">
                    {product.warnings.map((warning) => (
                      <li key={warning.id}>
                        <span className="font-medium">
                          {warning.audience.toLowerCase().replace(/_/g, ' ')}:
                        </span>{' '}
                        {warning.text}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Disclaimers">
                {product.disclaimers.length === 0 ? (
                  <p className="text-sm text-slate-500">None.</p>
                ) : (
                  <ul className="space-y-2 text-sm text-slate-700">
                    {product.disclaimers.map((disclaimer) => (
                      <li key={disclaimer.id}>
                        <span className="font-medium">{disclaimer.kind}</span>
                        <span className="block text-slate-600">{disclaimer.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Categories">
                {product.categories.length === 0 ? (
                  <p className="text-sm text-slate-500">Not categorised.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2 text-sm">
                    {product.categories.map((category) => (
                      <li key={category.id}>
                        <Badge tone={category.isPrimary ? 'info' : 'neutral'}>
                          {category.name}
                          {category.isPrimary ? ' (primary)' : ''}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Images">
                {product.images.length === 0 ? (
                  <p className="text-sm text-slate-500">None.</p>
                ) : (
                  <ul className="flex flex-wrap gap-3">
                    {product.images.map((image) => (
                      <li key={image.id} className="w-28">
                        {image.url ? (
                          // A plain <img>: media is served from a configurable
                          // object-storage origin.
                          <img
                            src={image.url}
                            alt={image.altText}
                            className="h-28 w-28 rounded-lg object-cover ring-1 ring-slate-200"
                          />
                        ) : (
                          <div className="flex h-28 w-28 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-500">
                            unavailable
                          </div>
                        )}
                        <span className="mt-1 block text-xs text-slate-500">
                          {image.role.toLowerCase().replace(/_/g, ' ')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </Card>

            {hasPermission(user, 'SEO_READ') ? (
              <Card>
                <SeoEditor
                  entityType="PRODUCT"
                  entityId={product.id}
                  initial={seo}
                  canWrite={hasPermission(user, 'SEO_WRITE')}
                />
              </Card>
            ) : null}
          </div>

          <div className="space-y-6">
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Status</h2>
              <p className="mt-1 text-sm text-slate-600">
                Pricing: {formatMoney(product.priceCents, product.currency)}
                {product.compareAtPriceCents
                  ? ` (was ${formatMoney(product.compareAtPriceCents, product.currency)})`
                  : ''}
              </p>
              <div className="mt-4">
                <ProductStatusControl
                  productId={product.id}
                  status={product.status}
                  canPublish={hasPermission(user, 'PRODUCT_PUBLISH')}
                />
              </div>
            </Card>

            <Card>
              <PublishChecklist readiness={readiness} />
            </Card>

            {hasPermission(user, 'COMPLIANCE_READ') ? (
              <Card>
                <h2 className="text-base font-semibold text-slate-900">Compliance review</h2>
                <p className="mt-1 text-sm text-slate-600">
                  A named reviewer records the decision and the reasoning. It is kept permanently
                  and cannot be edited afterwards.
                </p>
                <Link
                  href={`/compliance/${product.id}`}
                  className="mt-3 inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Open review
                </Link>
              </Card>
            ) : null}
          </div>
        </div>
      </div>
    </ConsoleShell>
  );
}

function ApprovalNotice({ product }: { product: AdminProduct }) {
  if (product.complianceStatus === 'REJECTED') {
    return (
      <Alert tone="error" title="A compliance reviewer rejected this listing">
        It was taken out of sale when the decision was recorded. Resolve what the reviewer raised,
        then ask for another review.
      </Alert>
    );
  }

  if (
    product.complianceStatus === 'APPROVED' &&
    product.complianceReviewDueAt !== null &&
    new Date(product.complianceReviewDueAt).getTime() <= Date.now()
  ) {
    return (
      <Alert tone="warning" title="The compliance approval has expired">
        An approval granted against evidence that has since been superseded is not an approval. This
        listing needs re-reviewing before it can be published again.
      </Alert>
    );
  }

  return null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 border-t border-slate-100 pt-4">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}
