import Link from 'next/link';
import type { SearchFacets } from '@/lib/catalogue';
import { isFacetActive, toggleFacet, type SearchParams } from '@/lib/facet-links';
import { formatMoney } from '@/lib/format';

/**
 * Facet navigation.
 *
 * Rendered as links rather than a form, so every filtered view has a real URL
 * and the whole thing works without JavaScript. The active state is read from
 * the same search params the server used to fetch the results, which means what
 * is highlighted and what was queried cannot drift apart.
 */

function FacetGroup({
  title,
  paramKey,
  values,
  params,
}: {
  title: string;
  paramKey: string;
  values: Array<{ value: string; label: string; count: number }>;
  params: SearchParams;
}) {
  if (values.length === 0) return null;

  return (
    <fieldset className="border-t border-slate-200 py-4 first:border-t-0 first:pt-0">
      <legend className="text-sm font-semibold text-slate-900">{title}</legend>
      <ul className="mt-2 space-y-1">
        {values.map((facet) => {
          const active = isFacetActive(params, paramKey, facet.value);
          return (
            <li key={facet.value}>
              <Link
                href={toggleFacet(params, paramKey, facet.value)}
                aria-current={active ? 'true' : undefined}
                className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-sm ${
                  active
                    ? 'bg-brand-50 font-medium text-brand-800'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span>{facet.label}</span>
                <span className="text-xs text-slate-500">{facet.count}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

export function ProductFilters({ facets, params }: { facets: SearchFacets; params: SearchParams }) {
  const hasAnyFilter = ['category', 'type', 'brand', 'attr'].some(
    (key) => params[key] !== undefined,
  );

  return (
    <aside aria-label="Filter products" className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Filter</h2>
        {hasAnyFilter ? (
          <Link href="/products" className="text-xs font-medium text-brand-700 hover:underline">
            Clear all
          </Link>
        ) : null}
      </div>

      <div className="mt-3">
        <FacetGroup
          title="Category"
          paramKey="category"
          values={facets.categories}
          params={params}
        />
        <FacetGroup title="Product type" paramKey="type" values={facets.types} params={params} />
        <FacetGroup title="Brand" paramKey="brand" values={facets.brands} params={params} />

        {facets.attributes.map((attribute) => (
          <FacetGroup
            key={attribute.key}
            title={attribute.label}
            paramKey="attr"
            values={attribute.values.map((value) => ({
              ...value,
              value: `${attribute.key}:${value.value}`,
            }))}
            params={params}
          />
        ))}

        {facets.priceRange ? (
          <p className="border-t border-slate-200 pt-4 text-sm text-slate-600">
            Prices in this selection range from {formatMoney(facets.priceRange.minCents, 'USD')} to{' '}
            {formatMoney(facets.priceRange.maxCents, 'USD')}.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
