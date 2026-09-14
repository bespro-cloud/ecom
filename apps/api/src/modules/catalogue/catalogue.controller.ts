import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { catalogueQuerySchema, slugSchema, type CatalogueQuery } from '@health/validation';
import { Public } from '../../common/decorators/public.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  CatalogueService,
  type PublicProductDetail,
  type PublicProductSummary,
} from './products/catalogue.service.js';
import { CategoriesService, type CategoryTreeNode } from './categories/categories.service.js';
import { IngredientsService, type IngredientView } from './ingredients/ingredients.service.js';
import type { SearchFacets } from './search/search.types.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

/**
 * The public catalogue.
 *
 * Every route here is `@Public()` — a customer browsing does not have an
 * account. That makes the scoping structural rather than permission-based:
 * `CatalogueService` only ever reads published, non-deleted products, and
 * there is no parameter that could widen it.
 */
@ApiTags('Catalogue')
@Controller({ path: 'catalogue', version: '1' })
export class CatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly categories: CategoriesService,
    private readonly ingredients: IngredientsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('products')
  @Public()
  @ApiOperation({
    summary: 'Browse and search published products',
    description:
      'Full-text search with trigram fallback, so a misspelling still finds the product. Returns facet counts for the current result set.',
  })
  @ApiOkResponse({ description: 'A page of products, with facets.' })
  async browse(@Query(zodBody(catalogueQuerySchema)) query: CatalogueQuery): Promise<{
    data: PublicProductSummary[];
    facets: SearchFacets;
    meta: { total: number; limit: number; offset: number; suggestion: string | null };
  }> {
    return this.catalogue.browse(query);
  }

  @Get('products/:slug')
  @Public()
  @ApiOperation({
    summary: 'Fetch a published product',
    description:
      'Includes ingredients, warnings inherited from those ingredients, allergen declarations and the required disclaimers.',
  })
  async findProduct(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
  ): Promise<PublicProductDetail> {
    return this.catalogue.findBySlug(slug);
  }

  @Get('categories')
  @Public()
  @ApiOperation({ summary: 'The active category tree' })
  async categoryTree(): Promise<{ data: CategoryTreeNode[] }> {
    return { data: await this.categories.tree(false) };
  }

  @Get('ingredients/:slug')
  @Public()
  @ApiOperation({
    summary: 'Fetch an ingredient',
    description:
      'What it is, where it is sourced from, and any warnings attached to it. Ingredient pages exist so a customer can look something up before buying.',
  })
  async findIngredient(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
  ): Promise<IngredientView> {
    return this.ingredients.findBySlug(slug);
  }

  @Get('sitemap')
  @Public()
  @ApiOperation({
    summary: 'Indexable URLs',
    description: 'Drives the storefront sitemap. Excludes anything marked noindex.',
  })
  async sitemap(): Promise<{
    products: Array<{ slug: string; updatedAt: string; noindex: boolean }>;
    categories: Array<{ slug: string }>;
    pages: Array<{ slug: string; updatedAt: string }>;
    posts: Array<{ slug: string; updatedAt: string }>;
  }> {
    const [products, categories, pages, posts] = await Promise.all([
      this.catalogue.listPublishedForSitemap(),
      this.categories.list(false),
      this.sitemapPages(),
      this.sitemapPosts(),
    ]);
    return {
      // `noindex` is honoured here rather than left to the storefront. A page
      // an editor asked to be kept out of the index must not be listed in the
      // file that exists to tell search engines what to index.
      products: products.filter((product) => !product.noindex),
      categories: categories.map((category) => ({ slug: category.slug })),
      pages,
      posts,
    };
  }

  private async sitemapPages(): Promise<Array<{ slug: string; updatedAt: string }>> {
    const rows = await this.prisma.page.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      select: { id: true, slug: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 5000,
    });
    return this.withoutNoindex(rows, 'PAGE');
  }

  private async sitemapPosts(): Promise<Array<{ slug: string; updatedAt: string }>> {
    const rows = await this.prisma.blogPost.findMany({
      where: { status: 'PUBLISHED', deletedAt: null },
      select: { id: true, slug: true, updatedAt: true },
      orderBy: { publishedAt: 'desc' },
      take: 5000,
    });
    return this.withoutNoindex(rows, 'BLOG_POST');
  }

  private async withoutNoindex(
    rows: Array<{ id: string; slug: string; updatedAt: Date }>,
    entityType: 'PAGE' | 'BLOG_POST',
  ): Promise<Array<{ slug: string; updatedAt: string }>> {
    if (rows.length === 0) return [];

    // Blog posts have no SeoMetadata entity type of their own, so only pages
    // can carry a noindex flag today. Querying rather than assuming means
    // adding one later needs no change here.
    const hidden =
      entityType === 'PAGE'
        ? await this.prisma.seoMetadata.findMany({
            where: {
              entityType: 'PAGE',
              entityId: { in: rows.map((row) => row.id) },
              noindex: true,
            },
            select: { entityId: true },
          })
        : [];
    const excluded = new Set(hidden.map((row) => row.entityId));

    return rows
      .filter((row) => !excluded.has(row.id))
      .map((row) => ({ slug: row.slug, updatedAt: row.updatedAt.toISOString() }));
  }
}
