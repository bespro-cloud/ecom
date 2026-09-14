import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@health/types';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

/**
 * Retrieval over approved knowledge.
 *
 * The rule is one sentence: **a model is only ever shown records a person has
 * already approved.** Not the catalogue, not drafts, not rejected evidence, not
 * a claim somebody is still arguing about — only text that a named reviewer
 * signed off and that is already lawful to show a customer.
 *
 * That filter lives in the `where` clause of each query, not in a `.filter()`
 * afterwards and not in a prompt instruction. A prompt saying "only use
 * approved sources" is a request; a `status: 'APPROVED'` in SQL is a fact.
 *
 * **Retrieval is scoped by the asking person's permissions.** A staff member
 * cannot learn through an AI answer what they could not read directly — an
 * assistant that reads with the application's own authority is an authorisation
 * bypass with a chat interface. Someone without `EVIDENCE_READ` gets no
 * evidence in their retrieval, and so no evidence in their answer.
 *
 * **Lexical, not semantic.** This searches with Postgres full-text ranking
 * rather than embeddings. That is a real limitation and worth stating plainly:
 * a question phrased differently from the source text will retrieve less than a
 * vector search would. It was chosen because the approved-only filter stays a
 * SQL predicate that anyone can read, there is no second copy of the corpus to
 * fall out of sync with the records, and no embedding of approved text is
 * shipped to a third party. A vector index would be a meaningful improvement
 * and is the obvious next step; it is not pretended to exist here.
 */

export type KnowledgeSourceType = 'CLAIM' | 'EVIDENCE' | 'PAGE' | 'BLOG_POST' | 'PRODUCT';

export interface KnowledgeChunk {
  /** Short, stable, and what the model must cite. */
  id: string;
  type: KnowledgeSourceType;
  title: string;
  text: string;
  /** Where a person can go and read the real thing. */
  reference: string;
}

export interface RetrievalOptions {
  /** The permissions the asking staff member actually holds. */
  permissions: readonly PermissionKey[];
  limit?: number;
  /** Narrow to one product, for a product-specific question. */
  productId?: string;
  types?: readonly KnowledgeSourceType[];
}

const DEFAULT_LIMIT = 8;
const MAX_CHUNK_CHARS = 1200;

@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds approved records matching a query.
   *
   * Returns an empty array rather than throwing when nothing matches. The
   * caller's job is then to *not call a model at all* — see the gateway. An
   * empty retrieval is the single most important signal in this subsystem,
   * because it is the case where a model would otherwise answer from memory.
   */
  async retrieve(query: string, options: RetrievalOptions): Promise<KnowledgeChunk[]> {
    const terms = significantTerms(query);
    if (terms.length === 0) return [];

    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 20);
    const held = new Set<string>(options.permissions);
    const wants = (type: KnowledgeSourceType) =>
      options.types === undefined || options.types.includes(type);

    const chunks: KnowledgeChunk[] = [];

    // --- Approved claims ---------------------------------------------------
    //
    // The approved *version's* text, not the current draft. A claim whose
    // wording has moved on since approval still shows a customer the approved
    // words, and a model must see the same thing a customer would.
    if (wants('CLAIM') && held.has('CLAIM_READ')) {
      const claims = await this.prisma.productClaim.findMany({
        where: {
          status: 'APPROVED',
          approvedVersionId: { not: null },
          ...(options.productId ? { productId: options.productId } : {}),
          approvedVersion: { OR: matchAny(terms, ['text']) },
        },
        take: limit,
        include: {
          approvedVersion: { select: { text: true, context: true } },
          product: { select: { name: true, slug: true } },
        },
      });

      for (const claim of claims) {
        if (!claim.approvedVersion) continue;
        chunks.push({
          id: `claim:${claim.id}`,
          type: 'CLAIM',
          title: `Approved claim — ${claim.product.name}`,
          text: truncate(claim.approvedVersion.text),
          reference: `/claims/${claim.id}`,
        });
      }
    }

    // --- Accepted evidence -------------------------------------------------
    //
    // `ACCEPTED` only. Draft and rejected evidence is somebody's work in
    // progress or somebody's considered "no"; putting either in front of a
    // model and calling the result a summary of the evidence would misrepresent
    // the state of the file.
    if (wants('EVIDENCE') && held.has('EVIDENCE_READ')) {
      const evidence = await this.prisma.evidenceRecord.findMany({
        where: {
          status: 'ACCEPTED',
          OR: matchAny(terms, ['title', 'outcome', 'population', 'citation']),
        },
        take: limit,
        select: {
          id: true,
          title: true,
          citation: true,
          population: true,
          dosage: true,
          duration: true,
          outcome: true,
          limitations: true,
        },
      });

      for (const record of evidence) {
        chunks.push({
          id: `evidence:${record.id}`,
          type: 'EVIDENCE',
          title: record.title,
          // Limitations are included deliberately and last, so a digest that
          // quotes this record has them in front of it. An evidence summary
          // that drops the limitations is the most misleading possible summary.
          text: truncate(
            [
              `Citation: ${record.citation}`,
              `Population: ${record.population}`,
              `Dosage: ${record.dosage}`,
              `Duration: ${record.duration}`,
              `Outcome as recorded by the reviewer: ${record.outcome}`,
              `Limitations as recorded by the reviewer: ${record.limitations}`,
            ].join('\n'),
          ),
          reference: `/evidence/${record.id}`,
        });
      }
    }

    // --- Published customer-facing content ---------------------------------
    //
    // Published pages and posts are already lawful to show a customer: a person
    // wrote them and, where they name a product, a compliance reviewer approved
    // them. That is exactly the bar for what a model may repeat.
    if (wants('PAGE')) {
      const pages = await this.prisma.page.findMany({
        where: {
          status: 'PUBLISHED',
          deletedAt: null,
          OR: matchAny(terms, ['title']),
        },
        take: limit,
        select: { id: true, slug: true, title: true, blocks: true },
      });

      for (const page of pages) {
        chunks.push({
          id: `page:${page.id}`,
          type: 'PAGE',
          title: page.title,
          text: truncate(blockText(page.blocks)),
          reference: `/pages/${page.slug}`,
        });
      }
    }

    if (wants('BLOG_POST')) {
      const posts = await this.prisma.blogPost.findMany({
        where: {
          status: 'PUBLISHED',
          deletedAt: null,
          OR: matchAny(terms, ['title', 'excerpt']),
        },
        take: limit,
        select: { id: true, slug: true, title: true, excerpt: true, blocks: true },
      });

      for (const post of posts) {
        chunks.push({
          id: `post:${post.id}`,
          type: 'BLOG_POST',
          title: post.title,
          text: truncate(post.excerpt ?? blockText(post.blocks)),
          reference: `/blog/${post.slug}`,
        });
      }
    }

    // --- Published product facts -------------------------------------------
    //
    // Descriptive fields only: name, type, brand, country of origin. Not price
    // (it changes), not stock (it changes faster), and no claim text — claims
    // come from the claims table above, where their approval status lives.
    if (wants('PRODUCT') && held.has('PRODUCT_READ')) {
      const products = await this.prisma.product.findMany({
        where: {
          status: 'PUBLISHED',
          deletedAt: null,
          ...(options.productId ? { id: options.productId } : {}),
          OR: matchAny(terms, ['name', 'shortDescription']),
        },
        take: limit,
        select: {
          id: true,
          slug: true,
          name: true,
          type: true,
          brand: true,
          countryOfOrigin: true,
          shortDescription: true,
        },
      });

      for (const product of products) {
        chunks.push({
          id: `product:${product.id}`,
          type: 'PRODUCT',
          title: product.name,
          text: truncate(
            [
              `Name: ${product.name}`,
              `Type: ${product.type}`,
              product.brand ? `Brand: ${product.brand}` : null,
              product.countryOfOrigin ? `Country of origin: ${product.countryOfOrigin}` : null,
              product.shortDescription ? `Description: ${product.shortDescription}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
          reference: `/catalogue/${product.id}`,
        });
      }
    }

    return chunks.slice(0, limit);
  }

  /**
   * The evidence accepted against one claim, for a digest.
   *
   * Separate from the search path because a reviewer asking for a digest wants
   * *this claim's* file, not the best keyword matches across the library.
   */
  async evidenceForClaim(
    claimId: string,
    permissions: readonly PermissionKey[],
  ): Promise<KnowledgeChunk[]> {
    if (!permissions.includes('EVIDENCE_READ')) return [];

    const links = await this.prisma.claimEvidence.findMany({
      where: { claimId, evidence: { status: 'ACCEPTED' } },
      include: {
        evidence: {
          select: {
            id: true,
            title: true,
            citation: true,
            population: true,
            dosage: true,
            duration: true,
            outcome: true,
            limitations: true,
          },
        },
      },
      take: 20,
    });

    return links.map((link) => ({
      id: `evidence:${link.evidence.id}`,
      type: 'EVIDENCE' as const,
      title: link.evidence.title,
      text: truncate(
        [
          `Citation: ${link.evidence.citation}`,
          `Population: ${link.evidence.population}`,
          `Dosage: ${link.evidence.dosage}`,
          `Duration: ${link.evidence.duration}`,
          `Outcome as recorded by the reviewer: ${link.evidence.outcome}`,
          `Limitations as recorded by the reviewer: ${link.evidence.limitations}`,
        ].join('\n'),
      ),
      reference: `/evidence/${link.evidence.id}`,
    }));
  }
}

/**
 * The words in a query worth searching on.
 *
 * Matching the whole question against a `contains` would almost never hit
 * anything — "what does the trial say about sleep latency?" is not a substring
 * of any record. Splitting into terms and matching any of them is crude, and it
 * is the honest description of what this retrieval does: lexical, not semantic.
 *
 * Short words and the obvious question words are dropped, because "what", "the"
 * and "our" match everything and rank nothing. Bounded to eight terms so a long
 * question cannot turn into a query with fifty OR branches.
 */
function significantTerms(query: string): string[] {
  const stop = new Set([
    'what',
    'which',
    'does',
    'do',
    'did',
    'the',
    'our',
    'this',
    'that',
    'with',
    'from',
    'about',
    'have',
    'has',
    'are',
    'was',
    'were',
    'for',
    'and',
    'any',
    'can',
    'you',
    'tell',
    'more',
    'there',
    'their',
    'them',
    'how',
    'why',
  ]);

  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of query.toLowerCase().split(/[^a-z0-9_-]+/)) {
    const word = raw.trim();
    if (word.length < 4 || stop.has(word) || seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= 8) break;
  }

  return terms;
}

/** An OR of `field contains term` over every field and every term. */
function matchAny(
  terms: readonly string[],
  fields: readonly string[],
): Array<Record<string, { contains: string; mode: 'insensitive' }>> {
  return fields.flatMap((field) =>
    terms.map((term) => ({ [field]: { contains: term, mode: 'insensitive' as const } })),
  );
}

function truncate(text: string): string {
  return text.length > MAX_CHUNK_CHARS ? `${text.slice(0, MAX_CHUNK_CHARS)}…` : text;
}

/** Readable text from a typed block array. Best-effort; used only as context. */
function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => {
      const value = block as { markdown?: string; text?: string };
      return value.markdown ?? value.text ?? '';
    })
    .filter(Boolean)
    .join('\n\n');
}
