import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Prisma } from '@health/database';
import { PRODUCT_TYPE_LABELS, type ProductType } from '@health/types';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { parseSearchQuery } from './query-parser.js';
import type {
  FacetValue,
  SearchFacets,
  SearchProvider,
  SearchRequest,
  SearchResult,
} from './search.types.js';

/**
 * Catalogue search on PostgreSQL.
 *
 * The text index is a stored generated `tsvector` column maintained by the
 * database, so it cannot drift from the row it describes. Ranking combines
 * `ts_rank_cd` with a trigram similarity term, and that second term is what
 * makes a misspelling like "magnesim" still find magnesium — full-text search
 * on its own returns nothing for it.
 *
 * Every value reaches the database as a bound parameter. `Prisma.sql` composes
 * the fragments; nothing is string-concatenated into a statement.
 */
@Injectable()
export class PostgresSearchProvider implements SearchProvider {
  readonly name = 'postgres';

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PostgresSearchProvider.name);
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const where = this.buildWhere(request);
    const parsed = request.query ? parseSearchQuery(request.query) : null;
    const hasQuery = parsed !== null && parsed.websearch.length > 0;

    const rank = hasQuery
      ? Prisma.sql`(
          ts_rank_cd(p.search_vector, websearch_to_tsquery('english', ${parsed.websearch})) * 4
          + word_similarity(${parsed.websearch}, p.name) * 2
        )`
      : Prisma.sql`0::float4`;

    const [rows, totals, facets] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; score: number }>>(Prisma.sql`
        SELECT p.id, ${rank} AS score
          FROM products p
         WHERE ${where}
         ${this.buildOrderBy(request.sort, hasQuery, rank)}
         LIMIT ${request.limit}
        OFFSET ${request.offset}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(*)::bigint AS count FROM products p WHERE ${where}
      `),
      this.buildFacets(where),
    ]);

    return {
      hits: rows.map((row) => ({ productId: row.id, score: Number(row.score) })),
      total: Number(totals[0]?.count ?? 0),
      facets,
      suggestion: rows.length === 0 && hasQuery ? await this.suggest(parsed.websearch) : null,
    };
  }

  /**
   * Recomputes the denormalised keyword field.
   *
   * There is no external index to push to — but `search_keywords` folds in
   * ingredient and category names, which live in other tables and therefore
   * cannot be part of a generated column expression.
   */
  async reindexProduct(productId: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE products p
         SET search_keywords = sub.keywords
        FROM (
          SELECT pr.id,
                 trim(concat_ws(' ',
                   (SELECT string_agg(DISTINCT i.name, ' ')
                      FROM product_ingredients pi
                      JOIN ingredients i ON i.id = pi.ingredient_id
                     WHERE pi.product_id = pr.id),
                   (SELECT string_agg(DISTINCT i.scientific_name, ' ')
                      FROM product_ingredients pi
                      JOIN ingredients i ON i.id = pi.ingredient_id
                     WHERE pi.product_id = pr.id),
                   (SELECT string_agg(DISTINCT c.name, ' ')
                      FROM product_categories pc
                      JOIN categories c ON c.id = pc.category_id
                     WHERE pc.product_id = pr.id),
                   pr.manufacturer
                 )) AS keywords
            FROM products pr
           WHERE pr.id = ${productId}::uuid
        ) AS sub
       WHERE p.id = sub.id
    `);
  }

  async removeProduct(productId: string): Promise<void> {
    // Nothing to remove: the index lives on the row itself, so deleting or
    // unpublishing a product takes it out of results by definition. An external
    // engine would delete its document here.
    this.logger.debug({ productId }, 'no external index to update');
  }

  // -------------------------------------------------------------------------

  private buildWhere(request: SearchRequest): Prisma.Sql {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`p.status = 'PUBLISHED'`,
      Prisma.sql`p.deleted_at IS NULL`,
    ];

    const parsed = request.query ? parseSearchQuery(request.query) : null;
    if (parsed !== null && parsed.websearch.length > 0) {
      // Full-text OR trigram: the second clause is what survives a typo. The
      // third matches a word the customer is still typing.
      //
      // `<%` (word_similarity), not `%`. Plain similarity compares the query
      // against the *whole* product name, so "magnesim" scores 0.26 against
      // "Magnesium Glycinate 120 Capsules" and falls under the threshold —
      // the longer and more descriptive the name, the worse typo tolerance
      // gets, which is precisely backwards. `<%` scores the query against the
      // best-matching run of words inside the name instead.
      conditions.push(Prisma.sql`(
        p.search_vector @@ websearch_to_tsquery('english', ${parsed.websearch})
        OR ${parsed.websearch} <% p.name
        ${
          parsed.prefix
            ? Prisma.sql`OR p.search_vector @@ to_tsquery('simple', ${parsed.prefix})`
            : Prisma.empty
        }
      )`);
    }

    const { filters } = request;
    if (filters.type) conditions.push(Prisma.sql`p.type = ${filters.type}::"ProductType"`);
    if (filters.brand) conditions.push(Prisma.sql`p.brand = ${filters.brand}`);
    if (filters.minPriceCents !== undefined) {
      conditions.push(Prisma.sql`p.price_cents >= ${filters.minPriceCents}`);
    }
    if (filters.maxPriceCents !== undefined) {
      conditions.push(Prisma.sql`p.price_cents <= ${filters.maxPriceCents}`);
    }

    if (filters.categoryIds && filters.categoryIds.length > 0) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM product_categories pc
         WHERE pc.product_id = p.id
           AND pc.category_id IN (${Prisma.join(
             filters.categoryIds.map((id) => Prisma.sql`${id}::uuid`),
           )})
      )`);
    }

    // Attribute filters are ANDed across keys and ORed within a key, which is
    // how a facet list behaves: "capsule or powder", but "vegan and capsule".
    const byKey = new Map<string, string[]>();
    for (const attribute of filters.attributes ?? []) {
      byKey.set(attribute.key, [...(byKey.get(attribute.key) ?? []), attribute.value]);
    }
    for (const [key, values] of byKey) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1
          FROM product_attribute_values pav
          JOIN product_attributes pa ON pa.id = pav.attribute_id
         WHERE pav.product_id = p.id
           AND pa.key = ${key}
           AND pav.value IN (${Prisma.join(values.map((value) => Prisma.sql`${value}`))})
      )`);
    }

    return Prisma.join(conditions, ' AND ');
  }

  private buildOrderBy(
    sort: SearchRequest['sort'],
    hasQuery: boolean,
    rank: Prisma.Sql,
  ): Prisma.Sql {
    switch (sort) {
      case 'price_asc':
        return Prisma.sql`ORDER BY p.price_cents ASC, p.id ASC`;
      case 'price_desc':
        return Prisma.sql`ORDER BY p.price_cents DESC, p.id ASC`;
      case 'name':
        return Prisma.sql`ORDER BY p.name ASC, p.id ASC`;
      case 'newest':
        return Prisma.sql`ORDER BY p.published_at DESC NULLS LAST, p.id DESC`;
      case 'relevance':
      default:
        // With no query text there is no relevance to sort by, so newest-first
        // is the honest default rather than an arbitrary but stable order.
        return hasQuery
          ? Prisma.sql`ORDER BY ${rank} DESC, p.published_at DESC NULLS LAST, p.id DESC`
          : Prisma.sql`ORDER BY p.published_at DESC NULLS LAST, p.id DESC`;
    }
  }

  /**
   * Facet counts over the filtered set.
   *
   * One aggregate per dimension rather than a query per value — the difference
   * between five statements and several hundred once the catalogue grows.
   */
  private async buildFacets(where: Prisma.Sql): Promise<SearchFacets> {
    const [types, brands, categories, attributes, priceRange] = await Promise.all([
      this.prisma.$queryRaw<Array<{ value: string; count: bigint }>>(Prisma.sql`
        SELECT p.type::text AS value, count(*)::bigint AS count
          FROM products p WHERE ${where}
         GROUP BY p.type ORDER BY count DESC
      `),
      this.prisma.$queryRaw<Array<{ value: string; count: bigint }>>(Prisma.sql`
        SELECT p.brand AS value, count(*)::bigint AS count
          FROM products p WHERE ${where} AND p.brand IS NOT NULL
         GROUP BY p.brand ORDER BY count DESC, value ASC LIMIT 30
      `),
      this.prisma.$queryRaw<Array<{ value: string; label: string; count: bigint }>>(Prisma.sql`
        SELECT c.slug AS value, c.name AS label, count(*)::bigint AS count
          FROM products p
          JOIN product_categories pc ON pc.product_id = p.id
          JOIN categories c ON c.id = pc.category_id AND c.is_active = true
         WHERE ${where}
         GROUP BY c.slug, c.name ORDER BY count DESC, label ASC LIMIT 40
      `),
      this.prisma.$queryRaw<Array<{ key: string; label: string; value: string; count: bigint }>>(
        Prisma.sql`
        SELECT pa.key, pa.label, pav.value, count(*)::bigint AS count
          FROM products p
          JOIN product_attribute_values pav ON pav.product_id = p.id
          JOIN product_attributes pa ON pa.id = pav.attribute_id AND pa.is_filterable = true
         WHERE ${where}
         GROUP BY pa.key, pa.label, pav.value, pa.position
         ORDER BY pa.position ASC, count DESC LIMIT 100
      `,
      ),
      this.prisma.$queryRaw<Array<{ min: number | null; max: number | null }>>(Prisma.sql`
        SELECT min(p.price_cents)::int AS min, max(p.price_cents)::int AS max
          FROM products p WHERE ${where}
      `),
    ]);

    const attributeGroups = new Map<string, { label: string; values: FacetValue[] }>();
    for (const row of attributes) {
      const group = attributeGroups.get(row.key) ?? { label: row.label, values: [] };
      group.values.push({ value: row.value, label: row.value, count: Number(row.count) });
      attributeGroups.set(row.key, group);
    }

    const range = priceRange[0];
    return {
      types: types.map((row) => ({
        value: row.value,
        label: PRODUCT_TYPE_LABELS[row.value as ProductType] ?? row.value,
        count: Number(row.count),
      })),
      brands: brands.map((row) => ({
        value: row.value,
        label: row.value,
        count: Number(row.count),
      })),
      categories: categories.map((row) => ({
        value: row.value,
        label: row.label,
        count: Number(row.count),
      })),
      attributes: [...attributeGroups.entries()].map(([key, group]) => ({
        key,
        label: group.label,
        values: group.values,
      })),
      priceRange:
        range && range.min !== null && range.max !== null
          ? { minCents: range.min, maxCents: range.max }
          : null,
    };
  }

  /**
   * "Did you mean…", from trigram similarity against product and ingredient
   * names. Offered only when the original query found nothing, so it never
   * second-guesses a query that worked.
   */
  private async suggest(query: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      SELECT name
        FROM (
          SELECT name FROM products WHERE status = 'PUBLISHED' AND deleted_at IS NULL
          UNION ALL
          SELECT name FROM ingredients WHERE deleted_at IS NULL
        ) candidates
       WHERE similarity(name, ${query}) > 0.25
       ORDER BY similarity(name, ${query}) DESC
       LIMIT 1
    `);
    return rows[0]?.name ?? null;
  }
}
