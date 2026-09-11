import 'server-only';
import { apiRequest } from './api-client';

/**
 * The storefront's view of the catalogue.
 *
 * These types mirror what the API actually returns rather than importing the
 * service's own interfaces: the storefront talks to an HTTP contract, and
 * sharing internal types would let a change to the service compile cleanly here
 * while breaking the page at runtime.
 */

export interface CatalogueImage {
  url: string;
  renditions: Record<string, string>;
  altText: string;
  width: number | null;
  height: number | null;
}

export interface ProductSummary {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  brand: string | null;
  type: string;
  typeLabel: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  image: CatalogueImage | null;
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

export interface BrowseResult {
  data: ProductSummary[];
  facets: SearchFacets;
  meta: { total: number; limit: number; offset: number; suggestion: string | null };
}

export interface ProductDetail {
  id: string;
  sku: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  type: string;
  typeLabel: string;
  brand: string | null;
  manufacturer: string | null;
  countryOfOrigin: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  requiresShipping: boolean;
  subscriptionEligible: boolean;
  weightGrams: number | null;
  publishedAt: string | null;
  images: Array<CatalogueImage & { role: string }>;
  variants: Array<{ id: string; sku: string; name: string; priceCents: number; options: unknown }>;
  categories: Array<{ name: string; slug: string; isPrimary: boolean }>;
  breadcrumbs: Array<{ name: string; slug: string }>;
  ingredients: Array<{
    name: string;
    slug: string;
    scientificName: string | null;
    description: string | null;
    amount: string | null;
    unit: string | null;
    dailyValuePercent: string | null;
    isActive: boolean;
    isAllergen: boolean;
    notes: string | null;
    sources: Array<{
      type: string;
      isVegan: boolean;
      isVegetarian: boolean;
      originCountry: string | null;
    }>;
  }>;
  warnings: Array<{
    severity: string;
    audience: string;
    audienceLabel: string;
    text: string;
    source: string | null;
  }>;
  allergens: string[];
  disclaimers: Array<{ kind: string; text: string }>;
  seo: {
    title: string;
    description: string | null;
    canonicalUrl: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    noindex: boolean;
  };
}

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  depth: number;
  productCount: number;
  children: CategoryNode[];
}

/**
 * How long a catalogue page may be served from cache.
 *
 * Short on purpose. Withdrawing a listing is sometimes urgent — a recall, a
 * label error — and a long cache would keep serving it after the API has
 * stopped. A minute is a reasonable trade between load and that risk; the
 * product page revalidates faster still.
 */
const BROWSE_REVALIDATE_SECONDS = 60;
const PRODUCT_REVALIDATE_SECONDS = 30;

function queryString(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(key, entry);
    } else {
      search.set(key, String(value));
    }
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export async function browseProducts(
  params: Record<string, string | number | string[] | undefined>,
): Promise<BrowseResult> {
  return apiRequest<BrowseResult>(`/api/v1/catalogue/products${queryString(params)}`, {
    // The catalogue is the same for everyone, so there is no per-user data to
    // leak into a shared cache.
    forwardCookies: false,
    revalidate: BROWSE_REVALIDATE_SECONDS,
  });
}

export async function fetchProduct(slug: string): Promise<ProductDetail> {
  return apiRequest<ProductDetail>(`/api/v1/catalogue/products/${encodeURIComponent(slug)}`, {
    forwardCookies: false,
    revalidate: PRODUCT_REVALIDATE_SECONDS,
  });
}

export async function fetchCategoryTree(): Promise<CategoryNode[]> {
  const response = await apiRequest<{ data: CategoryNode[] }>('/api/v1/catalogue/categories', {
    forwardCookies: false,
    revalidate: BROWSE_REVALIDATE_SECONDS,
  });
  return response.data;
}

export async function fetchSitemapEntries(): Promise<{
  products: Array<{ slug: string; updatedAt: string }>;
  categories: Array<{ slug: string }>;
}> {
  return apiRequest('/api/v1/catalogue/sitemap', {
    forwardCookies: false,
    revalidate: BROWSE_REVALIDATE_SECONDS,
  });
}

/** Finds a node anywhere in the tree, so a category page can render its children. */
export function findCategory(nodes: CategoryNode[], slug: string): CategoryNode | null {
  for (const node of nodes) {
    if (node.slug === slug) return node;
    const found = findCategory(node.children, slug);
    if (found) return found;
  }
  return null;
}

/** The path from the root to a category, for breadcrumbs. */
export function categoryTrail(nodes: CategoryNode[], slug: string): CategoryNode[] {
  for (const node of nodes) {
    if (node.slug === slug) return [node];
    const below = categoryTrail(node.children, slug);
    if (below.length > 0) return [node, ...below];
  }
  return [];
}
