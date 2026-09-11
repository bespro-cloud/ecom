import { carriedFilters, type SearchParams } from '@/lib/facet-links';

/**
 * The catalogue search box.
 *
 * A plain GET form. It submits to the same route it lives on, so a search has a
 * shareable URL and works with JavaScript disabled; there is no client state to
 * get out of step with what the server actually queried.
 *
 * Hidden inputs carry the current filters through, because a customer who
 * narrows to "capsules" and then searches expects to still be looking at
 * capsules.
 */
export function ProductSearch({
  action = '/products',
  query,
  carry = {},
}: {
  action?: string;
  query?: string;
  carry?: SearchParams;
}) {
  const hidden = carriedFilters(carry);

  return (
    <form action={action} method="get" role="search" className="flex gap-2">
      <label htmlFor="catalogue-search" className="sr-only">
        Search products
      </label>
      <input
        id="catalogue-search"
        type="search"
        name="q"
        defaultValue={query ?? ''}
        placeholder="Search by name, ingredient or brand"
        maxLength={200}
        autoComplete="off"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
      {hidden.map((field, index) => (
        <input key={`${field.name}-${index}`} type="hidden" name={field.name} value={field.value} />
      ))}
      <button
        type="submit"
        className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Search
      </button>
    </form>
  );
}
