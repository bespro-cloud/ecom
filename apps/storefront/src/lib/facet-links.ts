/**
 * URL building for facet navigation.
 *
 * Facets are links, not a form, so every filtered view has a real URL that can
 * be shared, bookmarked and crawled, and the whole thing works without
 * JavaScript. That makes correct URL construction the load-bearing part, which
 * is why it lives here where it can be tested rather than inline in a
 * component.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Parameters the API accepts more than once.
 *
 * `category`, `type` and `brand` are single-valued in the query contract, so a
 * second value would be silently ignored — and the page would then highlight a
 * filter that is not actually being applied. Attribute filters are genuinely
 * repeatable.
 */
const REPEATABLE = new Set(['attr']);

/** Parameters that must never survive a change of filter, sort or page. */
const RESET_ON_CHANGE = new Set(['cursor']);

function base(params: SearchParams, drop: Set<string>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || drop.has(name)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== '') search.append(name, entry);
    }
  }
  return search;
}

function render(search: URLSearchParams): string {
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '?';
}

/**
 * The URL for turning a facet value on, or — if it is already on — off.
 *
 * The cursor is always dropped: an offset calculated against one result set is
 * meaningless against a different one, and keeping it would land the customer
 * on an empty page.
 */
export function toggleFacet(params: SearchParams, key: string, value: string): string {
  const search = base(params, RESET_ON_CHANGE);
  const existing = search.getAll(key);
  search.delete(key);

  if (existing.includes(value)) {
    for (const entry of existing.filter((item) => item !== value)) search.append(key, entry);
  } else if (REPEATABLE.has(key)) {
    for (const entry of existing) search.append(key, entry);
    search.append(key, value);
  } else {
    search.append(key, value);
  }

  return render(search);
}

export function isFacetActive(params: SearchParams, key: string, value: string): boolean {
  const current = params[key];
  if (current === undefined) return false;
  return Array.isArray(current) ? current.includes(value) : current === value;
}

export function withSort(params: SearchParams, sort: string): string {
  const search = base(params, new Set([...RESET_ON_CHANGE, 'sort']));
  search.set('sort', sort);
  return render(search);
}

/** Results are ranked, so paging is by encoded offset rather than a row cursor. */
export function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export function withOffset(params: SearchParams, offset: number): string {
  const search = base(params, RESET_ON_CHANGE);
  if (offset > 0) search.set('cursor', encodeOffset(offset));
  return render(search);
}

/** Everything the search box must carry forward, so a search keeps the filters. */
export function carriedFilters(params: SearchParams): Array<{ name: string; value: string }> {
  const carried: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || name === 'q' || RESET_ON_CHANGE.has(name)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== '') carried.push({ name, value: entry });
    }
  }
  return carried;
}
