/**
 * Turns what a customer typed into a PostgreSQL text-search query.
 *
 * `plainto_tsquery` would be simpler, but it ANDs every term, so "magnesium
 * glycinate powder" returns nothing unless a product matches all three. What
 * people actually want is "prefer everything, accept most", which is what
 * `websearch_to_tsquery` gives — plus support for quoted phrases and `-term`
 * exclusions, which customers use whether or not we document them.
 *
 * The input is never interpolated into SQL. It is passed as a bound parameter;
 * these functions only decide *which* tsquery function to call and sanitise the
 * prefix-match variant.
 */

/** Strips characters that are meaningless to the parser and noisy in logs. */
export function normaliseQuery(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  );
}

export interface ParsedQuery {
  /** The text passed to `websearch_to_tsquery`. */
  websearch: string;
  /**
   * A prefix query for the last term, so results appear while someone is still
   * typing: "magnes" finds magnesium.
   */
  prefix: string | null;
  terms: string[];
}

export function parseSearchQuery(raw: string): ParsedQuery {
  // Read before normalising: normalisation trims, so by the time we have the
  // cleaned string the trailing space that tells us the word is finished is
  // already gone.
  const endsWithSeparator = /\s$/.test(raw);

  const normalised = normaliseQuery(raw);
  if (normalised.length === 0) {
    return { websearch: '', prefix: null, terms: [] };
  }

  const terms = normalised
    .split(' ')
    .map((term) => term.replace(/^-/, '').replace(/"/g, ''))
    .filter((term) => term.length > 0);

  // Prefix matching only makes sense for a final term long enough to be
  // discriminating; "a" as a prefix matches most of the catalogue. It is also
  // skipped once the user types a trailing space, which reads as "that word is
  // finished".
  const last = terms[terms.length - 1];
  const stripped = last ? last.replace(/[^\p{L}\p{N}]/gu, '') : '';
  const prefix = stripped.length >= 3 && !endsWithSeparator ? `${stripped}:*` : null;

  return { websearch: normalised, prefix, terms };
}

/**
 * Parses `key:value` attribute filters from the query string.
 *
 * Anything malformed is dropped rather than rejected: a filter is a refinement,
 * and failing the whole request because one facet link was mangled is worse for
 * the customer than ignoring it.
 */
export function parseAttributeFilters(raw: string[]): Array<{ key: string; value: string }> {
  const parsed: Array<{ key: string; value: string }> = [];
  for (const entry of raw) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) continue;
    if (!/^[a-z0-9_-]+$/.test(key)) continue;
    parsed.push({ key, value: value.slice(0, 120) });
  }
  return parsed.slice(0, 10);
}
