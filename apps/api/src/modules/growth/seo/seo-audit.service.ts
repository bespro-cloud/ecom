import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@health/config';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';

/**
 * The SEO audit.
 *
 * "SEO automation" is the phrase in the roadmap, and it needs a line drawn
 * through it, because half of what the phrase usually means would be
 * indefensible here.
 *
 * **Automated: the mechanical half.** Sitemaps, canonical URLs, redirects on
 * slug change, structured data, and this audit — finding pages with a missing
 * title, a duplicate description, an image with no alternative text, or a
 * listing quietly excluded from the index. These are facts about markup. A
 * machine can check them and be right or wrong in a way anybody can verify.
 *
 * **Never automated: the words.** Nothing in this codebase generates a meta
 * description, a title, an alt text or a snippet of copy. A meta description
 * for a supplement is a public statement about a health product, and a
 * generated one is exactly the kind of fluent, plausible sentence that ends up
 * claiming something nobody reviewed and no evidence supports. The audit says
 * "this product has no meta description"; a person writes it.
 *
 * So every finding here is a *report*, and nothing is fixed automatically.
 */

export type SeoIssueSeverity = 'error' | 'warning' | 'info';

export interface SeoIssue {
  severity: SeoIssueSeverity;
  code: string;
  message: string;
  entityType: 'PRODUCT' | 'CATEGORY' | 'PAGE' | 'BLOG_POST';
  entityId: string;
  label: string;
  path: string;
}

export interface SeoAuditReport {
  checkedAt: string;
  counts: { error: number; warning: number; info: number };
  issues: SeoIssue[];
}

/** Google truncates around here. Not a rule, a legibility limit. */
const TITLE_MAX = 60;
const TITLE_MIN = 15;
const DESCRIPTION_MAX = 160;
const DESCRIPTION_MIN = 50;

@Injectable()
export class SeoAuditService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(): Promise<SeoAuditReport> {
    const [products, categories, pages, posts, seo] = await Promise.all([
      this.prisma.product.findMany({
        where: { status: 'PUBLISHED', deletedAt: null },
        select: {
          id: true,
          slug: true,
          name: true,
          shortDescription: true,
          images: { select: { altText: true, role: true } },
        },
      }),
      this.prisma.category.findMany({
        where: { isActive: true },
        select: { id: true, slug: true, name: true },
      }),
      this.prisma.page.findMany({
        where: { status: 'PUBLISHED', deletedAt: null },
        select: { id: true, slug: true, title: true },
      }),
      this.prisma.blogPost.findMany({
        where: { status: 'PUBLISHED', deletedAt: null },
        select: { id: true, slug: true, title: true, excerpt: true },
      }),
      this.prisma.seoMetadata.findMany(),
    ]);

    const metaFor = (entityType: string, entityId: string) =>
      seo.find((row) => row.entityType === entityType && row.entityId === entityId) ?? null;

    const issues: SeoIssue[] = [];

    for (const product of products) {
      const meta = metaFor('PRODUCT', product.id);
      const path = `/products/${product.slug}`;
      const base = {
        entityType: 'PRODUCT' as const,
        entityId: product.id,
        label: product.name,
        path,
      };

      issues.push(...this.checkMeta(base, meta?.title ?? null, meta?.description ?? null));

      if (meta?.noindex) {
        // Worth saying out loud. A published product excluded from the index is
        // usually somebody's deliberate decision and occasionally a mistake
        // that costs the listing all of its traffic.
        issues.push({
          ...base,
          severity: 'warning',
          code: 'published_but_noindex',
          message:
            'This product is published but marked noindex, so search engines are asked to leave it out.',
        });
      }

      const missingAlt = product.images.filter((image) => !image.altText?.trim()).length;
      if (missingAlt > 0) {
        // Accessibility first, SEO second. Someone using a screen reader on a
        // supplement listing needs to know what the label photograph shows.
        issues.push({
          ...base,
          severity: 'error',
          code: 'image_missing_alt_text',
          message: `${missingAlt} image(s) have no alternative text.`,
        });
      }
    }

    for (const category of categories) {
      const meta = metaFor('CATEGORY', category.id);
      issues.push(
        ...this.checkMeta(
          {
            entityType: 'CATEGORY',
            entityId: category.id,
            label: category.name,
            path: `/categories/${category.slug}`,
          },
          meta?.title ?? null,
          meta?.description ?? null,
        ),
      );
    }

    for (const page of pages) {
      const meta = metaFor('PAGE', page.id);
      issues.push(
        ...this.checkMeta(
          {
            entityType: 'PAGE',
            entityId: page.id,
            label: page.title,
            path: `/pages/${page.slug}`,
          },
          meta?.title ?? null,
          meta?.description ?? null,
        ),
      );
    }

    for (const post of posts) {
      const base = {
        entityType: 'BLOG_POST' as const,
        entityId: post.id,
        label: post.title,
        path: `/blog/${post.slug}`,
      };
      // A post's excerpt stands in for a description when no SEO record exists,
      // because an editor writing an excerpt has already written the sentence.
      issues.push(...this.checkMeta(base, post.title, post.excerpt));
    }

    issues.push(...this.duplicateTitles(seo));

    const counts = { error: 0, warning: 0, info: 0 };
    for (const issue of issues) counts[issue.severity] += 1;

    return {
      checkedAt: this.clock.now().toISOString(),
      counts,
      issues: issues.sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path),
      ),
    };
  }

  // -------------------------------------------------------------------------

  private checkMeta(
    base: Pick<SeoIssue, 'entityType' | 'entityId' | 'label' | 'path'>,
    title: string | null,
    description: string | null,
  ): SeoIssue[] {
    const issues: SeoIssue[] = [];

    if (!title?.trim()) {
      issues.push({
        ...base,
        severity: 'error',
        code: 'missing_title',
        message: 'No page title. Search engines will invent one from the page content.',
      });
    } else if (title.length > TITLE_MAX) {
      issues.push({
        ...base,
        severity: 'info',
        code: 'title_too_long',
        message: `Title is ${title.length} characters; results usually truncate around ${TITLE_MAX}.`,
      });
    } else if (title.trim().length < TITLE_MIN) {
      issues.push({
        ...base,
        severity: 'info',
        code: 'title_too_short',
        message: `Title is only ${title.trim().length} characters.`,
      });
    }

    if (!description?.trim()) {
      // A warning rather than an error, and deliberately not auto-filled. A
      // meta description for a health product is a public claim; the audit
      // names the gap and a person writes the sentence.
      issues.push({
        ...base,
        severity: 'warning',
        code: 'missing_description',
        message:
          'No meta description. Write one — nothing in this system will generate copy for a health product.',
      });
    } else if (description.length > DESCRIPTION_MAX) {
      issues.push({
        ...base,
        severity: 'info',
        code: 'description_too_long',
        message: `Description is ${description.length} characters; results usually truncate around ${DESCRIPTION_MAX}.`,
      });
    } else if (description.trim().length < DESCRIPTION_MIN) {
      issues.push({
        ...base,
        severity: 'info',
        code: 'description_too_short',
        message: `Description is only ${description.trim().length} characters.`,
      });
    }

    return issues;
  }

  /**
   * Two pages claiming the same title.
   *
   * Search engines pick one and drop the other, and the one they drop is
   * usually not the one you would have chosen.
   */
  private duplicateTitles(
    seo: Array<{ entityType: string; entityId: string; title: string | null }>,
  ): SeoIssue[] {
    const byTitle = new Map<string, Array<{ entityType: string; entityId: string }>>();

    for (const row of seo) {
      const title = row.title?.trim().toLowerCase();
      if (!title) continue;
      const bucket = byTitle.get(title) ?? [];
      bucket.push({ entityType: row.entityType, entityId: row.entityId });
      byTitle.set(title, bucket);
    }

    const issues: SeoIssue[] = [];
    for (const [title, rows] of byTitle) {
      if (rows.length < 2) continue;
      for (const row of rows) {
        issues.push({
          severity: 'warning',
          code: 'duplicate_title',
          message: `${rows.length} pages share the title "${title}". Search engines will pick one.`,
          entityType: row.entityType as SeoIssue['entityType'],
          entityId: row.entityId,
          label: title,
          path: '',
        });
      }
    }

    return issues;
  }
}

function severityRank(severity: SeoIssueSeverity): number {
  return { error: 0, warning: 1, info: 2 }[severity];
}
