import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  PRODUCT_TYPE_LABELS,
  WARNING_AUDIENCE_LABELS,
  type ProductType,
  type WarningAudience,
} from '@health/types';
import type { CatalogueQuery } from '@health/validation';
import { parseAttributeFilters } from '../search/query-parser.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { MediaUrlService } from '../../media/media-url.service.js';
import { SEARCH_PROVIDER, type SearchFacets, type SearchProvider } from '../search/search.types.js';

/**
 * The public catalogue.
 *
 * Everything here is scoped to published, non-deleted products — not by a flag
 * the caller passes, but structurally: there is no parameter that could widen
 * it. An unpublished listing is not something a customer can reach by guessing
 * a slug or an id.
 *
 * The projection is also deliberately narrow. Cost price, margin, compliance
 * workflow state and internal notes are not in the response shape at all, so
 * they cannot leak by someone adding a field to the wrong mapper.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaUrls: MediaUrlService,
    private readonly logger: PinoLogger,
    @Inject(SEARCH_PROVIDER) private readonly search: SearchProvider,
  ) {
    this.logger.setContext(CatalogueService.name);
  }

  async browse(query: CatalogueQuery): Promise<{
    data: PublicProductSummary[];
    facets: SearchFacets;
    meta: { total: number; limit: number; offset: number; suggestion: string | null };
  }> {
    const categoryIds = query.category ? await this.resolveCategoryBranch(query.category) : [];

    // A category slug that does not exist yields no results rather than
    // silently ignoring the filter and showing the whole catalogue.
    if (query.category && categoryIds.length === 0) {
      return {
        data: [],
        facets: emptyFacets(),
        meta: { total: 0, limit: query.limit, offset: 0, suggestion: null },
      };
    }

    const offset = query.cursor ? decodeOffset(query.cursor) : 0;
    const result = await this.search.search({
      ...(query.q ? { query: query.q } : {}),
      filters: {
        ...(categoryIds.length > 0 ? { categoryIds } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.brand ? { brand: query.brand } : {}),
        ...(query.minPriceCents !== undefined ? { minPriceCents: query.minPriceCents } : {}),
        ...(query.maxPriceCents !== undefined ? { maxPriceCents: query.maxPriceCents } : {}),
        attributes: parseAttributeFilters(query.attr),
      },
      sort: query.sort,
      limit: query.limit,
      offset,
    });

    const products = await this.loadSummaries(result.hits.map((hit) => hit.productId));

    return {
      data: products,
      facets: result.facets,
      meta: {
        total: result.total,
        limit: query.limit,
        offset,
        suggestion: result.suggestion,
      },
    };
  }

  /**
   * A product detail page.
   *
   * Warnings are the interesting part: those attached to ingredients are
   * *inherited* rather than copied, so a warning added to an ingredient appears
   * on every product containing it without anyone editing those listings. They
   * are merged with product-specific warnings and de-duplicated by text.
   */
  async findBySlug(slug: string): Promise<PublicProductDetail> {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: 'PUBLISHED', deletedAt: null },
      include: {
        images: {
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          include: { media: true },
        },
        variants: {
          where: { isActive: true, deletedAt: null },
          orderBy: [{ position: 'asc' }],
        },
        categories: {
          include: { category: { select: { id: true, name: true, slug: true, path: true } } },
        },
        ingredients: {
          orderBy: [{ position: 'asc' }],
          include: {
            ingredient: {
              include: { warnings: true, sources: true },
            },
          },
        },
        warnings: { orderBy: [{ position: 'asc' }] },
        disclaimers: { orderBy: [{ position: 'asc' }] },
      },
    });

    if (!product) throw AppException.notFound('Product');

    const seo = await this.prisma.seoMetadata.findUnique({
      where: { entityType_entityId: { entityType: 'PRODUCT', entityId: product.id } },
    });

    const inheritedWarnings = product.ingredients.flatMap((entry) =>
      entry.ingredient.warnings.map((warning) => ({
        severity: warning.severity,
        audience: warning.audience,
        text: warning.text,
        source: entry.ingredient.name,
      })),
    );
    const ownWarnings = product.warnings.map((warning) => ({
      severity: warning.severity,
      audience: warning.audience,
      text: warning.text,
      source: null,
    }));

    const seen = new Set<string>();
    const warnings = [...ownWarnings, ...inheritedWarnings].filter((warning) => {
      const key = warning.text.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const primary = product.categories.find((entry) => entry.isPrimary) ?? product.categories[0];
    const breadcrumbs = primary ? await this.buildBreadcrumbs(primary.category) : [];

    const allergens = [
      ...new Set(
        product.ingredients
          .filter((entry) => entry.ingredient.isAllergen)
          .map((entry) => entry.ingredient.allergen ?? entry.ingredient.name),
      ),
    ];

    return {
      id: product.id,
      sku: product.sku,
      slug: product.slug,
      name: product.name,
      shortDescription: product.shortDescription,
      longDescription: product.longDescription,
      type: product.type,
      typeLabel: PRODUCT_TYPE_LABELS[product.type as ProductType] ?? product.type,
      brand: product.brand,
      manufacturer: product.manufacturer,
      countryOfOrigin: product.countryOfOrigin,
      priceCents: product.priceCents,
      compareAtPriceCents: product.compareAtPriceCents,
      currency: product.currency,
      requiresShipping: product.requiresShipping,
      subscriptionEligible: product.subscriptionEligible,
      weightGrams: product.weightGrams,
      publishedAt: product.publishedAt?.toISOString() ?? null,
      images: product.images.map((image) => ({
        role: image.role,
        altText: image.altText,
        url: this.mediaUrls.publicUrl(image.media.storageKey),
        renditions: this.mediaUrls.renditions(image.media.checksum),
        width: image.media.width,
        height: image.media.height,
      })),
      variants: product.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        name: variant.name,
        priceCents: variant.priceCents ?? product.priceCents,
        options: variant.options,
      })),
      categories: product.categories.map((entry) => ({
        name: entry.category.name,
        slug: entry.category.slug,
        isPrimary: entry.isPrimary,
      })),
      breadcrumbs,
      ingredients: product.ingredients.map((entry) => ({
        name: entry.ingredient.name,
        slug: entry.ingredient.slug,
        scientificName: entry.ingredient.scientificName,
        description: entry.ingredient.description,
        amount: entry.amount?.toString() ?? null,
        unit: entry.unit,
        dailyValuePercent: entry.dailyValuePercent?.toString() ?? null,
        isActive: entry.isActive,
        isAllergen: entry.ingredient.isAllergen,
        notes: entry.notes,
        sources: entry.ingredient.sources.map((source) => ({
          type: source.type,
          isVegan: source.isVegan,
          isVegetarian: source.isVegetarian,
          originCountry: source.originCountry,
        })),
      })),
      warnings: warnings.map((warning) => ({
        severity: warning.severity,
        audience: warning.audience,
        audienceLabel:
          WARNING_AUDIENCE_LABELS[warning.audience as WarningAudience] ?? warning.audience,
        text: warning.text,
        source: warning.source,
      })),
      allergens,
      disclaimers: product.disclaimers.map((disclaimer) => ({
        kind: disclaimer.kind,
        text: disclaimer.text,
      })),
      seo: {
        title: seo?.title ?? product.name,
        description: seo?.description ?? product.shortDescription,
        canonicalUrl: seo?.canonicalUrl ?? null,
        ogTitle: seo?.ogTitle ?? null,
        ogDescription: seo?.ogDescription ?? null,
        noindex: seo?.noindex ?? false,
      },
    };
  }

  /** Slugs of every published product, for the sitemap. */
  async listPublishedForSitemap(): Promise<
    Array<{ slug: string; updatedAt: string; noindex: boolean }>
  > {
    const products = await this.prisma.product.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      select: { id: true, slug: true, updatedAt: true },
      orderBy: { publishedAt: 'desc' },
      take: 50_000, // the sitemap protocol's own limit
    });

    const noindexIds = new Set(
      (
        await this.prisma.seoMetadata.findMany({
          where: { entityType: 'PRODUCT', noindex: true },
          select: { entityId: true },
        })
      ).map((entry) => entry.entityId),
    );

    return products.map((product) => ({
      slug: product.slug,
      updatedAt: product.updatedAt.toISOString(),
      noindex: noindexIds.has(product.id),
    }));
  }

  // -------------------------------------------------------------------------

  /**
   * A category filter means "this category and everything under it" — a
   * customer browsing Vitamins expects to see Vitamin D, not an empty page.
   * The materialised `path` makes that one indexed query.
   */
  private async resolveCategoryBranch(slug: string): Promise<string[]> {
    const category = await this.prisma.category.findFirst({
      where: { slug, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!category) return [];

    const descendants = await this.prisma.category.findMany({
      where: { path: { has: category.id }, isActive: true, deletedAt: null },
      select: { id: true },
    });

    return [category.id, ...descendants.map((entry) => entry.id)];
  }

  private async buildBreadcrumbs(category: {
    id: string;
    name: string;
    slug: string;
    path: string[];
  }): Promise<Array<{ name: string; slug: string }>> {
    if (category.path.length === 0) return [{ name: category.name, slug: category.slug }];

    const ancestors = await this.prisma.category.findMany({
      where: { id: { in: category.path } },
      select: { id: true, name: true, slug: true },
    });
    const byId = new Map(ancestors.map((entry) => [entry.id, entry]));

    // `path` is ordered root-first, so the trail is already in display order.
    const trail = category.path
      .map((id) => byId.get(id))
      .filter((entry): entry is { id: string; name: string; slug: string } => entry !== undefined)
      .map((entry) => ({ name: entry.name, slug: entry.slug }));

    return [...trail, { name: category.name, slug: category.slug }];
  }

  private async loadSummaries(ids: string[]): Promise<PublicProductSummary[]> {
    if (ids.length === 0) return [];

    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, status: 'PUBLISHED', deletedAt: null },
      include: {
        images: {
          where: { role: 'HERO' },
          take: 1,
          include: { media: true },
        },
      },
    });

    // Restore the ranking the search provider produced; `IN` does not preserve it.
    const byId = new Map(products.map((product) => [product.id, product]));
    return ids
      .map((id) => byId.get(id))
      .filter((product): product is NonNullable<typeof product> => product !== undefined)
      .map((product) => {
        const hero = product.images[0];
        return {
          id: product.id,
          slug: product.slug,
          name: product.name,
          shortDescription: product.shortDescription,
          brand: product.brand,
          type: product.type,
          typeLabel: PRODUCT_TYPE_LABELS[product.type as ProductType] ?? product.type,
          priceCents: product.priceCents,
          compareAtPriceCents: product.compareAtPriceCents,
          currency: product.currency,
          image: hero
            ? {
                url: this.mediaUrls.publicUrl(hero.media.storageKey),
                renditions: this.mediaUrls.renditions(hero.media.checksum),
                altText: hero.altText,
                width: hero.media.width,
                height: hero.media.height,
              }
            : null,
        };
      });
  }
}

export interface PublicProductSummary {
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
  image: {
    url: string;
    renditions: Record<string, string>;
    altText: string;
    width: number | null;
    height: number | null;
  } | null;
}

export interface PublicProductDetail {
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
  images: Array<{
    role: string;
    altText: string;
    url: string;
    renditions: Record<string, string>;
    width: number | null;
    height: number | null;
  }>;
  variants: Array<{
    id: string;
    sku: string;
    name: string;
    priceCents: number;
    options: unknown;
  }>;
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
    /** The ingredient this warning came from, or null if written for the product. */
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

function emptyFacets(): SearchFacets {
  return { types: [], brands: [], categories: [], attributes: [], priceRange: null };
}

/**
 * Search results are ranked, so paging is by offset rather than by row cursor.
 * The value is still encoded so clients treat it as opaque and we can change
 * the scheme later.
 */
function decodeOffset(cursor: string): number {
  try {
    const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(decoded) && decoded >= 0 && decoded <= 10_000 ? decoded : 0;
  } catch {
    return 0;
  }
}

export function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}
