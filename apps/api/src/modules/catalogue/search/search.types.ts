import type { ProductType } from '@health/types';

/**
 * Search contract.
 *
 * PostgreSQL full-text search is the implementation today. It is behind this
 * interface so OpenSearch can replace it later without the commerce domain
 * knowing — which is the point at which a search migration stops being a
 * rewrite and becomes a configuration change.
 */

export interface SearchFilters {
  categoryIds?: string[];
  type?: ProductType;
  brand?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  /** Attribute equality filters, keyed by attribute key. */
  attributes?: Array<{ key: string; value: string }>;
}

export type SearchSort = 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'name';

export interface SearchRequest {
  query?: string;
  filters: SearchFilters;
  sort: SearchSort;
  limit: number;
  /** Zero-based offset. Results are ranked, so a row cursor is meaningless. */
  offset: number;
}

export interface SearchHit {
  productId: string;
  /** Provider-specific relevance score. Comparable within one result set only. */
  score: number;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export interface SearchFacets {
  types: FacetValue[];
  brands: FacetValue[];
  categories: FacetValue[];
  attributes: Array<{ key: string; label: string; values: FacetValue[] }>;
  priceRange: { minCents: number; maxCents: number } | null;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  facets: SearchFacets;
  /** A spelling suggestion, offered only when the query found nothing. */
  suggestion: string | null;
}

export interface SearchProvider {
  readonly name: string;
  search(request: SearchRequest): Promise<SearchResult>;
  /**
   * Refreshes whatever the provider needs after a product changes.
   *
   * The PostgreSQL implementation does not push to an index — the text vector
   * is a generated column the database maintains — but it does recompute the
   * denormalised keyword field, which folds in names from other tables. An
   * external engine would push a document here instead.
   */
  reindexProduct(productId: string): Promise<void>;
  removeProduct(productId: string): Promise<void>;
}

export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');
