import { z } from 'zod';
import { PAGE_STATUSES, SEO_TITLE_MAX, SEO_DESCRIPTION_MAX } from '@health/types';
import { slugSchema, uuidSchema } from './primitives.js';

/**
 * CMS page content.
 *
 * Stored as typed blocks rather than HTML. An admin form that accepts HTML
 * eventually stores a script tag — either through a compromised account or a
 * well-meaning paste from elsewhere — and rendering it would be stored XSS.
 * A fixed block vocabulary cannot express script at all.
 *
 * Rich text within a block is Markdown, rendered with HTML disabled.
 */

const blockBase = { id: z.string().trim().min(1).max(64) };

export const headingBlockSchema = z.object({
  ...blockBase,
  type: z.literal('heading'),
  // h1 is the page title; body headings start at h2 so the outline stays valid.
  level: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2),
  text: z.string().trim().min(1).max(200),
});

export const richTextBlockSchema = z.object({
  ...blockBase,
  type: z.literal('richText'),
  markdown: z.string().max(20_000),
});

export const imageBlockSchema = z.object({
  ...blockBase,
  type: z.literal('image'),
  mediaId: uuidSchema,
  altText: z.string().trim().min(3, 'Describe what the image shows.').max(300),
  caption: z.string().trim().max(500).optional(),
});

export const calloutBlockSchema = z.object({
  ...blockBase,
  type: z.literal('callout'),
  tone: z.enum(['info', 'warning']).default('info'),
  title: z.string().trim().max(200).optional(),
  markdown: z.string().max(4000),
});

export const faqBlockSchema = z.object({
  ...blockBase,
  type: z.literal('faq'),
  items: z
    .array(
      z.object({
        question: z.string().trim().min(3).max(300),
        answer: z.string().trim().min(3).max(4000),
      }),
    )
    .min(1)
    .max(50),
});

export const productGridBlockSchema = z.object({
  ...blockBase,
  type: z.literal('productGrid'),
  title: z.string().trim().max(200).optional(),
  /**
   * Products are referenced by id and resolved at render time, so an unpublished
   * or withdrawn product disappears from the page automatically rather than
   * lingering as stale copy.
   */
  productIds: z.array(uuidSchema).min(1).max(12),
});

export const pageBlockSchema = z.discriminatedUnion('type', [
  headingBlockSchema,
  richTextBlockSchema,
  imageBlockSchema,
  calloutBlockSchema,
  faqBlockSchema,
  productGridBlockSchema,
]);
export type PageBlock = z.infer<typeof pageBlockSchema>;

export const pageBlocksSchema = z.array(pageBlockSchema).max(100);

export const createPageSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(2).max(200),
  blocks: pageBlocksSchema.default([]),
});
export type CreatePageInput = z.infer<typeof createPageSchema>;

export const updatePageSchema = z.object({
  slug: slugSchema.optional(),
  title: z.string().trim().min(2).max(200).optional(),
  blocks: pageBlocksSchema.optional(),
});
export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export const pageStatusSchema = z.enum(PAGE_STATUSES);

export const publishPageSchema = z.object({
  /** Recorded in the audit trail. */
  note: z.string().trim().max(500).optional(),
});
export type PublishPageInput = z.infer<typeof publishPageSchema>;

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

/**
 * Lengths are advisory, not enforced by search engines — but a title that gets
 * truncated in results is a real cost, so the admin warns at the limits and
 * the publishing checklist requires a title and description to exist.
 */
export const seoMetadataSchema = z.object({
  title: z.string().trim().max(SEO_TITLE_MAX).nullish(),
  description: z.string().trim().max(SEO_DESCRIPTION_MAX).nullish(),
  canonicalUrl: z.string().url().max(2000).nullish(),
  ogTitle: z.string().trim().max(120).nullish(),
  ogDescription: z.string().trim().max(300).nullish(),
  ogImageMediaId: uuidSchema.nullish(),
  noindex: z.boolean().default(false),
});
export type SeoMetadataInput = z.infer<typeof seoMetadataSchema>;
