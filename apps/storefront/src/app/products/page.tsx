import type { Metadata } from 'next';
import Link from 'next/link';
import { browseProducts } from '@/lib/catalogue';
import { withOffset, withSort, type SearchParams } from '@/lib/facet-links';
import { ProductCard } from '@/components/product-card';
import { ProductFilters } from '@/components/product-filters';
import { ProductSearch } from '@/components/product-search';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const query = typeof params.q === 'string' ? params.q : undefined;

  return {
    title: query ? `Search: ${query}` : 'All products',
    description:
      'Browse every product we list, with its full ingredient record, sourcing and required warnings.',
    // A filtered or searched listing is a view of the same set, so it points at
    // the unfiltered page rather than competing with it for indexing.
    alternates: { canonical: '/products' },
    robots: query ? { index: false, follow: true } : undefined,
  };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const query = first(params.q);

  const result = await browseProducts({
    q: query,
    category: first(params.category),
    type: first(params.type),
    brand: first(params.brand),
    sort: first(params.sort),
    cursor: first(params.cursor),
    attr: params.attr === undefined ? undefined : ([] as string[]).concat(params.attr),
  });

  const { data, facets, meta } = result;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          {query ? `Results for “${query}”` : 'All products'}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Every listing here has passed a recorded compliance review. Ingredient records, sourcing
          and required warnings are on each product page.
        </p>
        <div className="mt-5 max-w-xl">
          <ProductSearch query={query} carry={params} />
        </div>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[16rem_1fr]">
        <ProductFilters facets={facets} params={params} />

        <section aria-label="Products">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-slate-600" role="status">
              {meta.total === 0
                ? 'No products match.'
                : `${meta.total} product${meta.total === 1 ? '' : 's'}`}
            </p>
            <SortLinks params={params} />
          </div>

          {meta.suggestion ? (
            <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Nothing matched that. Did you mean{' '}
              <Link
                href={`/products?q=${encodeURIComponent(meta.suggestion)}`}
                className="font-semibold underline"
              >
                {meta.suggestion}
              </Link>
              ?
            </p>
          ) : null}

          {data.length > 0 ? (
            <ul className="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {data.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-6 rounded-xl bg-white p-8 text-center text-sm text-slate-600 ring-1 ring-slate-200">
              Nothing here yet. Try a different search, or{' '}
              <Link href="/products" className="font-medium text-brand-700 underline">
                clear the filters
              </Link>
              .
            </p>
          )}

          <Pagination meta={meta} params={params} />
        </section>
      </div>
    </div>
  );
}

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'newest', label: 'Newest' },
  { value: 'price_asc', label: 'Price, low to high' },
  { value: 'price_desc', label: 'Price, high to low' },
  { value: 'name', label: 'Name' },
];

function SortLinks({ params }: { params: SearchParams }) {
  const active = first(params.sort) ?? 'relevance';

  return (
    <nav aria-label="Sort products" className="flex flex-wrap gap-1 text-sm">
      {SORTS.map((option) => (
        <Link
          key={option.value}
          href={withSort(params, option.value)}
          aria-current={option.value === active ? 'true' : undefined}
          className={`rounded px-2 py-1 ${
            option.value === active
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Offset paging.
 *
 * Ranked results have no stable row cursor — a relevance score is not a sort
 * key you can resume from — so the API encodes an offset and the page walks it
 * a step at a time.
 */
function Pagination({
  meta,
  params,
}: {
  meta: { total: number; limit: number; offset: number };
  params: SearchParams;
}) {
  const hasPrevious = meta.offset > 0;
  const hasNext = meta.offset + meta.limit < meta.total;
  if (!hasPrevious && !hasNext) return null;

  const page = Math.floor(meta.offset / meta.limit) + 1;
  const pages = Math.max(1, Math.ceil(meta.total / meta.limit));

  return (
    <nav aria-label="Pagination" className="mt-8 flex items-center justify-between gap-4">
      {hasPrevious ? (
        <Link
          href={withOffset(params, Math.max(0, meta.offset - meta.limit))}
          rel="prev"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Previous
        </Link>
      ) : (
        <span />
      )}

      <p className="text-sm text-slate-600">
        Page {page} of {pages}
      </p>

      {hasNext ? (
        <Link
          href={withOffset(params, meta.offset + meta.limit)}
          rel="next"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Next
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
