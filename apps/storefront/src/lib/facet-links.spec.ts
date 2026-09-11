import { describe, expect, it } from 'vitest';
import {
  carriedFilters,
  encodeOffset,
  isFacetActive,
  toggleFacet,
  withOffset,
  withSort,
} from './facet-links';

/** Parses a built URL back into pairs, so assertions do not depend on ordering. */
function pairs(url: string): Array<[string, string]> {
  return [...new URLSearchParams(url.replace(/^\?/, ''))].sort();
}

describe('toggleFacet', () => {
  it('adds a filter', () => {
    expect(pairs(toggleFacet({}, 'category', 'minerals'))).toEqual([['category', 'minerals']]);
  });

  it('removes a filter that is already applied', () => {
    expect(toggleFacet({ category: 'minerals' }, 'category', 'minerals')).toBe('?');
  });

  it('replaces a single-valued filter rather than adding a second', () => {
    // `category` is single-valued in the query contract. Appending would make
    // the page highlight a filter the API silently ignores.
    expect(pairs(toggleFacet({ category: 'minerals' }, 'category', 'vitamins'))).toEqual([
      ['category', 'vitamins'],
    ]);
  });

  it('accumulates repeatable attribute filters', () => {
    expect(pairs(toggleFacet({ attr: 'form:capsule' }, 'attr', 'vegan:true'))).toEqual([
      ['attr', 'form:capsule'],
      ['attr', 'vegan:true'],
    ]);
  });

  it('removes one attribute filter and keeps the rest', () => {
    expect(
      pairs(toggleFacet({ attr: ['form:capsule', 'vegan:true'] }, 'attr', 'form:capsule')),
    ).toEqual([['attr', 'vegan:true']]);
  });

  it('keeps the other filters and the query', () => {
    expect(pairs(toggleFacet({ q: 'magnesium', type: 'SUPPLEMENT' }, 'brand', 'Acme'))).toEqual([
      ['brand', 'Acme'],
      ['q', 'magnesium'],
      ['type', 'SUPPLEMENT'],
    ]);
  });

  it('drops the cursor, because an offset does not survive a filter change', () => {
    // Keeping it would land the customer on an empty page of a different set.
    const url = toggleFacet({ cursor: 'MjA', category: 'minerals' }, 'type', 'SUPPLEMENT');
    expect(new URLSearchParams(url.replace(/^\?/, '')).has('cursor')).toBe(false);
  });

  it('does not emit empty values', () => {
    expect(pairs(toggleFacet({ q: '' }, 'category', 'minerals'))).toEqual([
      ['category', 'minerals'],
    ]);
  });

  it('escapes values that would otherwise break the query string', () => {
    const url = toggleFacet({}, 'brand', 'A & B');
    expect(url).not.toContain(' & ');
    expect(new URLSearchParams(url.replace(/^\?/, '')).get('brand')).toBe('A & B');
  });
});

describe('isFacetActive', () => {
  it('reports a single value', () => {
    expect(isFacetActive({ category: 'minerals' }, 'category', 'minerals')).toBe(true);
    expect(isFacetActive({ category: 'minerals' }, 'category', 'vitamins')).toBe(false);
  });

  it('reports membership of a repeated value', () => {
    expect(isFacetActive({ attr: ['form:capsule'] }, 'attr', 'form:capsule')).toBe(true);
    expect(isFacetActive({ attr: ['form:capsule'] }, 'attr', 'vegan:true')).toBe(false);
  });

  it('reports false when the parameter is absent', () => {
    expect(isFacetActive({}, 'category', 'minerals')).toBe(false);
  });
});

describe('withSort', () => {
  it('replaces the sort and drops the cursor', () => {
    expect(pairs(withSort({ sort: 'newest', cursor: 'MjA', q: 'mag' }, 'price_asc'))).toEqual([
      ['q', 'mag'],
      ['sort', 'price_asc'],
    ]);
  });
});

describe('withOffset', () => {
  it('omits the cursor for the first page, so page one has one URL', () => {
    expect(pairs(withOffset({ q: 'mag' }, 0))).toEqual([['q', 'mag']]);
  });

  it('encodes the offset', () => {
    const url = withOffset({}, 20);
    const cursor = new URLSearchParams(url.replace(/^\?/, '')).get('cursor');
    expect(cursor).toBe(encodeOffset(20));
    expect(Buffer.from(cursor!, 'base64url').toString('utf8')).toBe('20');
  });

  it('replaces an existing cursor rather than appending one', () => {
    const url = withOffset({ cursor: 'MjA' }, 40);
    expect(new URLSearchParams(url.replace(/^\?/, '')).getAll('cursor')).toHaveLength(1);
  });
});

describe('carriedFilters', () => {
  it('carries filters but not the previous query or cursor', () => {
    // A new search should apply to the same narrowed set, starting from page
    // one, and must not re-submit the old search term.
    expect(
      carriedFilters({ q: 'old', cursor: 'MjA', category: 'minerals', attr: ['form:capsule'] }),
    ).toEqual([
      { name: 'category', value: 'minerals' },
      { name: 'attr', value: 'form:capsule' },
    ]);
  });

  it('returns nothing when there is nothing to carry', () => {
    expect(carriedFilters({})).toEqual([]);
  });
});
