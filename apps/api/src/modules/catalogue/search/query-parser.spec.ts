import { normaliseQuery, parseAttributeFilters, parseSearchQuery } from './query-parser.js';

describe('normaliseQuery', () => {
  it('collapses whitespace and trims', () => {
    expect(normaliseQuery('  magnesium   glycinate \n')).toBe('magnesium glycinate');
  });

  it('strips control characters', () => {
    // A NUL byte reaching PostgreSQL's text-search parser is an error, not a
    // no-op, so a pasted string containing one must not reach the query.
    expect(normaliseQuery('vitamin\u0000\u0007 d3')).toBe('vitamin d3');
  });

  it('caps the length', () => {
    // An unbounded search term is a cheap way to make the server do expensive
    // parsing work on every request.
    expect(normaliseQuery('a'.repeat(500))).toHaveLength(200);
  });

  it('returns an empty string for whitespace only', () => {
    expect(normaliseQuery('   \t  ')).toBe('');
  });
});

describe('parseSearchQuery', () => {
  it('reports nothing for an empty query', () => {
    expect(parseSearchQuery('')).toEqual({ websearch: '', prefix: null, terms: [] });
  });

  it('offers a prefix match for the final term while it is still being typed', () => {
    const parsed = parseSearchQuery('magnes');
    expect(parsed.prefix).toBe('magnes:*');
    expect(parsed.terms).toEqual(['magnes']);
  });

  it('drops the prefix match once a trailing space says the word is finished', () => {
    expect(parseSearchQuery('magnesium ').prefix).toBeNull();
  });

  it('does not prefix-match a term too short to discriminate', () => {
    // "a:*" matches most of the catalogue, which is not a search result.
    expect(parseSearchQuery('vitamin a').prefix).toBeNull();
  });

  it('keeps the raw text for websearch_to_tsquery so operators still work', () => {
    // The quoting and the leading minus are meaningful to websearch_to_tsquery;
    // stripping them here would silently discard what the customer asked for.
    const parsed = parseSearchQuery('"fish oil" -capsule');
    expect(parsed.websearch).toBe('"fish oil" -capsule');
    expect(parsed.terms).toEqual(['fish', 'oil', 'capsule']);
  });

  it('strips punctuation before building the prefix term', () => {
    // `:*` appended to something containing a quote or a colon is a syntax
    // error in tsquery, and the prefix term is the one value that is composed
    // rather than bound.
    expect(parseSearchQuery('omega-3!').prefix).toBe('omega3:*');
  });

  it('does not let a query smuggle tsquery syntax into the prefix term', () => {
    expect(parseSearchQuery("foo') | 'bar").prefix).toBe('bar:*');
  });
});

describe('parseAttributeFilters', () => {
  it('parses key:value pairs', () => {
    expect(parseAttributeFilters(['form:capsule', 'Vegan:true'])).toEqual([
      { key: 'form', value: 'capsule' },
      { key: 'vegan', value: 'true' },
    ]);
  });

  it('keeps colons that appear inside the value', () => {
    expect(parseAttributeFilters(['note:a:b'])).toEqual([{ key: 'note', value: 'a:b' }]);
  });

  it('drops malformed entries instead of failing the request', () => {
    // A mangled facet link should cost the customer that one refinement, not
    // the whole page of results.
    expect(parseAttributeFilters([':capsule', 'form:', 'nocolon', ''])).toEqual([]);
  });

  it('rejects keys that are not plain identifiers', () => {
    expect(parseAttributeFilters(["form';drop:capsule", 'form key:capsule'])).toEqual([]);
  });

  it('bounds how many filters and how long a value can be', () => {
    const many = Array.from({ length: 25 }, (_, index) => `key${index}:value`);
    expect(parseAttributeFilters(many)).toHaveLength(10);
    expect(parseAttributeFilters([`form:${'x'.repeat(500)}`])[0]!.value).toHaveLength(120);
  });
});
