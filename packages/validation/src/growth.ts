import { z } from 'zod';
import { ANALYTICS_EVENT_TYPES, SERVER_ONLY_EVENTS } from '@health/types';
import { paginationSchema, slugSchema, uuidSchema } from './primitives.js';
import { pageBlocksSchema } from './content.js';

/**
 * Growth request validation: analytics collection, the blog, and redirects.
 *
 * The analytics schemas are where this file earns its keep, and they are
 * unusual in one respect: **they are deliberately narrow to the point of being
 * awkward.** Most request schemas exist to reject malformed input. These exist
 * to make it impossible to send personal data in the first place.
 *
 * There is no free-form payload object on an analytics event. There is no
 * field for an email, a customer id, a search term, a symptom or a note. The
 * shape is a closed set of scalars, so the question "could somebody put
 * personal data in an analytics beacon?" has a structural answer rather than a
 * policy one.
 *
 * `.strict()` everywhere, so an unexpected key is a refusal rather than a
 * silently ignored field that someone later assumes is being stored.
 */

// ---------------------------------------------------------------------------
// Analytics collection
// ---------------------------------------------------------------------------

/** The events a browser may report. `order_placed` is written server-side. */
const CLIENT_EVENT_TYPES = ANALYTICS_EVENT_TYPES.filter(
  (type) => !(SERVER_ONLY_EVENTS as readonly string[]).includes(type),
) as unknown as [string, ...string[]];

/**
 * A URL as the browser reports it.
 *
 * Accepted with its query string still attached, because the server strips it —
 * `normalisePath` discards everything after `?` before anything is stored. The
 * client is not trusted to have removed it, and the server does not assume it
 * did.
 */
const reportedUrlSchema = z.string().trim().min(1).max(2048);

export const analyticsEventSchema = z
  .object({
    type: z.enum(CLIENT_EVENT_TYPES, {
      errorMap: () => ({ message: 'Not an event this site records.' }),
    }),
    url: reportedUrlSchema,
    /** Only meaningful on product_view and add_to_cart. Ignored otherwise. */
    productId: uuidSchema.optional(),
    quantity: z.number().int().min(1).max(1000).optional(),
    /**
     * When the browser says it happened. Clamped server-side to the time the
     * request arrived, so a client cannot backdate an event into a closed
     * rollup or forward-date one into a day that has not happened.
     */
    occurredAt: z.coerce.date().optional(),
  })
  .strict();
export type AnalyticsEventInput = z.infer<typeof analyticsEventSchema>;

/**
 * A beacon.
 *
 * Batched, because a page that fires one request per interaction is a page that
 * is slow for the visitor and noisy for the server. Capped at a size a real
 * page could plausibly produce.
 */
export const analyticsBeaconSchema = z
  .object({
    /**
     * The visit this belongs to. Client-generated, opaque, and rotated per
     * visit — deliberately not derived from anything about the person. An
     * unknown id starts a new session rather than being refused: a beacon is
     * not a place to tell a stranger which session ids exist.
     */
    sessionId: z.string().trim().uuid('Not a session identifier.'),
    events: z.array(analyticsEventSchema).min(1).max(50),
    /**
     * The document referrer, sent on the first beacon of a visit. Reduced to a
     * host before anything is stored — a referrer path is a page on somebody
     * else's site and carries their search terms.
     */
    referrer: z.string().trim().max(2048).optional(),
    /**
     * Whether the visitor accepted analytics. The server checks the browser's
     * own privacy headers too, and those win: see `shouldCollect`.
     */
    consent: z.boolean(),
  })
  .strict();
export type AnalyticsBeaconInput = z.infer<typeof analyticsBeaconSchema>;

export const analyticsRangeSchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((value) => value.to >= value.from, {
    message: 'The end of the range must not be before the start.',
    path: ['to'],
  })
  .refine((value) => value.to.getTime() - value.from.getTime() <= 400 * 24 * 60 * 60 * 1000, {
    message: 'Reports cover at most 400 days at a time.',
    path: ['to'],
  });
export type AnalyticsRangeInput = z.infer<typeof analyticsRangeSchema>;

// ---------------------------------------------------------------------------
// Blog
// ---------------------------------------------------------------------------

const excerptSchema = z.string().trim().max(400);

/**
 * Creating or editing a post.
 *
 * No `status`, no `publishedAt` and no `complianceApprovedAt`. Publishing is a
 * separate, permissioned act, and compliance approval is a decision somebody
 * makes — a field for either would let a writer publish unreviewed copy about a
 * regulated product by setting a boolean.
 *
 * Body is the same typed block vocabulary as CMS pages: never HTML. An editor
 * that accepts HTML eventually stores a script tag, whether through a
 * compromised account or a well-meant paste.
 */
export const createBlogPostSchema = z
  .object({
    slug: slugSchema,
    title: z.string().trim().min(3, 'Give the post a title.').max(200),
    excerpt: excerptSchema.optional(),
    blocks: pageBlocksSchema.default([]),
    categoryId: uuidSchema.optional(),
    heroMediaId: uuidSchema.optional(),
    /**
     * Alternative text for the hero image, in this post's context.
     *
     * Written by a person, never generated. A machine-written description of a
     * photograph on an article about a supplement is a guess presented to
     * somebody who cannot check it.
     */
    heroAltText: z.string().trim().max(300).optional(),
    /**
     * Products the post is about.
     *
     * Declared by the writer rather than detected from the text. A regex over
     * prose deciding whether an article is about a regulated product would fail
     * in the direction nobody notices — the post it missed is the one that
     * publishes unreviewed claims. Declaring is a person's judgement, and the
     * compliance reviewer sees the text regardless.
     */
    productIds: z.array(uuidSchema).max(50).default([]),
  })
  .strict();
export type CreateBlogPostInput = z.infer<typeof createBlogPostSchema>;

export const updateBlogPostSchema = createBlogPostSchema.partial().strict();
export type UpdateBlogPostInput = z.infer<typeof updateBlogPostSchema>;

/**
 * A compliance decision on a post.
 *
 * Reasoning is required on either outcome. An approval with no reasoning is not
 * a review, and "why is this live?" is the question asked later.
 */
export const reviewBlogPostSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    notes: z
      .string()
      .trim()
      .min(10, 'Record what you read and why you reached this decision.')
      .max(4000),
  })
  .strict();
export type ReviewBlogPostInput = z.infer<typeof reviewBlogPostSchema>;

export const blogQuerySchema = paginationSchema.extend({
  status: z.enum(['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED']).optional(),
  categoryId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type BlogQuery = z.infer<typeof blogQuerySchema>;

export const createBlogCategorySchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).optional(),
    position: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
export type CreateBlogCategoryInput = z.infer<typeof createBlogCategorySchema>;

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

/**
 * A site-relative path, normalised.
 *
 * Rejects a query string outright rather than stripping it. A redirect rule
 * written against `/old?ref=x` means something different from one written
 * against `/old`, and silently turning the first into the second would make a
 * redirect match URLs its author did not intend.
 */
const redirectPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((value) => value.startsWith('/'), { message: 'Paths start with a slash.' })
  .refine((value) => !value.includes('?'), {
    message: 'Write the path without a query string.',
  })
  .refine((value) => !value.includes('#'), { message: 'Write the path without a fragment.' })
  .refine((value) => !value.startsWith('//'), {
    message: 'That is a URL to another site, not a path on this one.',
  })
  .transform((value) => (value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value));

/**
 * The destination.
 *
 * A path on this site, or an absolute `https://` URL for a genuine move to
 * another domain. Plain `http://` is refused: redirecting a customer from a
 * secure page to an insecure one is a downgrade, and doing it with a 301 makes
 * it sticky in their browser.
 */
const redirectTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine((value) => value.startsWith('/') || value.startsWith('https://'), {
    message: 'Use a path on this site, or an https:// URL.',
  })
  .refine((value) => !value.startsWith('//'), {
    message: 'That is a protocol-relative URL. Write it out in full.',
  });

export const createRedirectSchema = z
  .object({
    fromPath: redirectPathSchema,
    toPath: redirectTargetSchema,
    /**
     * 301 by default. A permanent redirect is cached hard by browsers and
     * search engines, which is the point — and the reason a temporary move
     * should say 302 rather than being "fixed later".
     */
    statusCode: z.union([z.literal(301), z.literal(302)]).default(301),
    reason: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((value) => value.fromPath !== value.toPath, {
    message: 'A redirect to itself is a loop.',
    path: ['toPath'],
  });
export type CreateRedirectInput = z.infer<typeof createRedirectSchema>;

export const updateRedirectSchema = z
  .object({
    toPath: redirectTargetSchema.optional(),
    statusCode: z.union([z.literal(301), z.literal(302)]).optional(),
    isActive: z.boolean().optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();
export type UpdateRedirectInput = z.infer<typeof updateRedirectSchema>;

export const redirectQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  activeOnly: z.coerce.boolean().optional(),
});
export type RedirectQuery = z.infer<typeof redirectQuerySchema>;

/** Resolving a path, for the storefront's middleware. */
export const resolveRedirectSchema = z.object({ path: redirectPathSchema });
export type ResolveRedirectInput = z.infer<typeof resolveRedirectSchema>;
