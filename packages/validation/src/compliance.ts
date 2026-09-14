import { z } from 'zod';
import {
  BATCH_STATUSES,
  CLAIM_DECISIONS,
  CLAIM_TYPES,
  DOCUMENT_TYPES,
  EVIDENCE_RELEVANCE,
  EVIDENCE_SOURCE_TYPES,
  RECALL_CLASSIFICATIONS,
} from '@health/types';
import { paginationSchema, uuidSchema } from './primitives.js';

/**
 * Compliance request validation.
 *
 * Two rules shape all of it.
 *
 * **Nothing may be submitted empty that a regulator would expect to read.**
 * Reasons, notes, limitations and outcomes all carry real minimum lengths, not
 * `min(1)`. A one-character justification satisfies a validator and satisfies
 * nobody else; the length floors here are the lowest bar at which the field is
 * still doing its job.
 *
 * **No request may assert a regulatory fact the system would then repeat.**
 * There is no field for "FDA approved", no field that marks a claim approved
 * without going through the review route, and no field that lets a caller
 * declare a certificate valid. A document's issuer and dates are recorded as
 * *what the uploader said*, and the API presents them that way.
 */

const reason = (min: number, message: string) => z.string().trim().min(min, message).max(2000);

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * The words of a claim.
 *
 * Capped at 500 characters because a claim is a specific statement that a
 * reviewer signs off. A paragraph is several claims, and reviewing it as one
 * hides which part the evidence actually supports.
 */
export const claimTextSchema = z
  .string()
  .trim()
  .min(3, 'Write the claim as it would appear on the listing.')
  .max(500, 'That is too long to review as a single claim. Split it into separate claims.');

export const createClaimSchema = z.object({
  type: z.enum(CLAIM_TYPES),
  text: claimTextSchema,
  /** Where the claim appears, for the reviewer's context. */
  context: z.string().trim().max(500).optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export type CreateClaimInput = z.infer<typeof createClaimSchema>;

/**
 * A new version of an existing claim.
 *
 * `changeReason` is required and has a real floor. This is the field that
 * answers "why does the live wording differ from what was approved in March?",
 * and it is the only place that answer is ever recorded.
 */
export const reviseClaimSchema = z.object({
  text: claimTextSchema,
  context: z.string().trim().max(500).optional(),
  changeReason: reason(10, 'Record why the wording is changing.'),
});
export type ReviseClaimInput = z.infer<typeof reviseClaimSchema>;

export const submitClaimSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});
export type SubmitClaimInput = z.infer<typeof submitClaimSchema>;

/**
 * A reviewer's decision on a claim.
 *
 * There is no `approvedAt`, no `reviewerId` and no `reviewDueAt` on this
 * schema: all three are set by the server from the authenticated session and
 * the configured review interval. A caller who could name the reviewer could
 * attribute an approval to someone who never made one.
 */
export const claimDecisionSchema = z.object({
  decision: z.enum(CLAIM_DECISIONS),
  notes: reason(20, 'Record what you reviewed and why you reached this decision.'),
  /** The version being decided on, so a decision cannot land on a newer edit. */
  versionId: uuidSchema,
});
export type ClaimDecisionInput = z.infer<typeof claimDecisionSchema>;

export const withdrawClaimSchema = z.object({
  reason: reason(10, 'Record why the claim is being withdrawn.'),
});
export type WithdrawClaimInput = z.infer<typeof withdrawClaimSchema>;

export const claimQuerySchema = paginationSchema.extend({
  productId: uuidSchema.optional(),
  status: z.string().trim().max(40).optional(),
  type: z.enum(CLAIM_TYPES).optional(),
  /** Approved claims whose review is due within this many days. */
  dueWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
});
export type ClaimQuery = z.infer<typeof claimQuerySchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * A source, in the reviewer's own words.
 *
 * Every descriptive field is required, `limitations` most of all. Nothing here
 * is fetched from an identifier or generated from a title — a system that
 * filled in `outcome` from a DOI would be inventing the finding a health claim
 * rests on, which is the single thing this module exists to make impossible.
 */
export const createEvidenceSchema = z.object({
  sourceType: z.enum(EVIDENCE_SOURCE_TYPES),
  title: z.string().trim().min(3, 'Give the source a short title.').max(300),
  citation: z.string().trim().min(10, 'Record the full citation as published.').max(1000),
  /** DOI, PubMed id or URL. Stored for lookup; never resolved by the system. */
  identifier: z.string().trim().max(300).optional(),
  publishedYear: z.number().int().min(1800).max(2200).optional(),

  population: reason(5, 'Who was studied — species, sample size, characteristics.'),
  dosage: reason(2, 'The amount and form studied, as the source states it.'),
  duration: reason(2, 'How long the study ran.'),
  outcome: reason(10, 'What the source found.'),
  limitations: reason(
    10,
    'What this source cannot support. Evidence recorded without limitations is evidence being oversold.',
  ),

  /** An uploaded copy of the source. */
  mediaId: uuidSchema.optional(),
});
export type CreateEvidenceInput = z.infer<typeof createEvidenceSchema>;

export const updateEvidenceSchema = createEvidenceSchema.partial();
export type UpdateEvidenceInput = z.infer<typeof updateEvidenceSchema>;

export const evidenceDecisionSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  notes: reason(10, 'Record why this source was accepted or rejected.'),
});
export type EvidenceDecisionInput = z.infer<typeof evidenceDecisionSchema>;

/**
 * Attaching a source to a claim.
 *
 * `relevance` is the reviewer's judgement and cannot be defaulted: whether a
 * trial is direct support or merely background is the substance of the review,
 * and a default would quietly make that judgement for them.
 */
export const linkEvidenceSchema = z.object({
  evidenceId: uuidSchema,
  relevance: z.enum(EVIDENCE_RELEVANCE),
  notes: z.string().trim().max(2000).optional(),
});
export type LinkEvidenceInput = z.infer<typeof linkEvidenceSchema>;

export const evidenceQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  sourceType: z.enum(EVIDENCE_SOURCE_TYPES).optional(),
  status: z.enum(['DRAFT', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED']).optional(),
});
export type EvidenceQuery = z.infer<typeof evidenceQuerySchema>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Recording a document.
 *
 * `issuer`, `reference` and the dates are what the uploader read off the
 * document. The system stores them, shows them as claimed rather than verified,
 * and never treats the presence of a row here as proof that a certification is
 * genuine or current.
 */
export const createDocumentSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    title: z.string().trim().min(3).max(300),
    productId: uuidSchema.optional(),
    batchId: uuidSchema.optional(),
    mediaId: uuidSchema,
    issuer: z.string().trim().max(300).optional(),
    reference: z.string().trim().max(200).optional(),
    issuedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
    notes: z.string().trim().max(2000).optional(),
    /** The document this replaces, which stops being current but is kept. */
    supersedesId: uuidSchema.optional(),
  })
  .refine((value) => value.productId !== undefined || value.batchId !== undefined, {
    message: 'Attach the document to a product or a lot.',
    path: ['productId'],
  })
  .refine(
    (value) =>
      value.issuedAt === undefined ||
      value.expiresAt === undefined ||
      value.expiresAt >= value.issuedAt,
    { message: 'A document cannot expire before it was issued.', path: ['expiresAt'] },
  );
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const documentQuerySchema = paginationSchema.extend({
  productId: uuidSchema.optional(),
  batchId: uuidSchema.optional(),
  type: z.enum(DOCUMENT_TYPES).optional(),
  /** Documents whose stated expiry has passed or falls within this many days. */
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
});
export type DocumentQuery = z.infer<typeof documentQuerySchema>;

// ---------------------------------------------------------------------------
// Batches and lots
// ---------------------------------------------------------------------------

/**
 * Receiving a lot.
 *
 * The quantity is a receipt, not a correction: it says how many units arrived
 * under this lot code. Adjusting a lot afterwards goes through the adjustment
 * route, which carries a reason into the append-only ledger, so there is never
 * a quantity change with nothing behind it.
 */
export const receiveBatchSchema = z
  .object({
    variantId: uuidSchema,
    warehouseId: uuidSchema,
    lotCode: z
      .string()
      .trim()
      .min(1, 'Record the lot code exactly as printed on the goods.')
      .max(100),
    quantity: z
      .number()
      .int('Enter a whole number of units.')
      .min(1, 'A receipt is at least one unit.')
      .max(1_000_000),
    manufacturedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
    supplier: z.string().trim().max(300).optional(),
    supplierReference: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine(
    (value) =>
      value.manufacturedAt === undefined ||
      value.expiresAt === undefined ||
      value.expiresAt >= value.manufacturedAt,
    { message: 'Goods cannot expire before they were made.', path: ['expiresAt'] },
  );
export type ReceiveBatchInput = z.infer<typeof receiveBatchSchema>;

/**
 * Changing a lot's disposition.
 *
 * A reason is required in both directions. "Why was this stock held?" and "on
 * what basis was it released?" are the same question asked at different times,
 * and a release with no recorded basis is the more dangerous of the two.
 */
export const batchDispositionSchema = z.object({
  status: z.enum(BATCH_STATUSES),
  reason: reason(10, 'Record the basis for this decision. It cannot be edited afterwards.'),
});
export type BatchDispositionInput = z.infer<typeof batchDispositionSchema>;

export const batchQuerySchema = paginationSchema.extend({
  variantId: uuidSchema.optional(),
  warehouseId: uuidSchema.optional(),
  status: z.enum(BATCH_STATUSES).optional(),
  search: z.string().trim().max(200).optional(),
  /** Lots expiring within this many days, including ones already past. */
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
});
export type BatchQuery = z.infer<typeof batchQuerySchema>;

/** Turning lot tracking on or off for a stock record. */
export const lotTrackingSchema = z.object({
  variantId: uuidSchema,
  warehouseId: uuidSchema,
  lotTracked: z.boolean(),
});
export type LotTrackingInput = z.infer<typeof lotTrackingSchema>;

// ---------------------------------------------------------------------------
// Recalls
// ---------------------------------------------------------------------------

export const createRecallSchema = z.object({
  title: z.string().trim().min(5, 'Give the recall a title people will recognise.').max(300),
  reason: reason(20, 'Record why this recall is being opened.'),
  /** The hazard, assessed by a person. Never generated from the reason. */
  hazard: z.string().trim().max(2000).optional(),
  classification: z.enum(RECALL_CLASSIFICATIONS).optional(),
  /** The lots in scope. More can be added while the recall is open. */
  batchIds: z.array(uuidSchema).max(500).optional(),
});
export type CreateRecallInput = z.infer<typeof createRecallSchema>;

export const recallLotsSchema = z.object({
  batchIds: z.array(uuidSchema).min(1, 'Name at least one lot.').max(500),
  reason: reason(10, 'Record why these lots are in scope.'),
});
export type RecallLotsInput = z.infer<typeof recallLotsSchema>;

/**
 * Approving customer contact.
 *
 * Its own schema, its own route, its own permission and a second factor,
 * because this is the decision with legal consequences. The acknowledgement is
 * not a formality: it is the reason a person cannot arrive here by clicking
 * through screens and find customers already contacted.
 */
export const approveRecallNotificationSchema = z.object({
  /** Typed by the approver. Deliberately not a checkbox. */
  acknowledgement: z.literal('I approve contacting affected customers', {
    errorMap: () => ({
      message:
        'Type the acknowledgement exactly to confirm you are approving contact with customers.',
    }),
  }),
  notes: reason(
    20,
    'Record the basis for approving customer contact, including any legal or regulatory advice relied on.',
  ),
});
export type ApproveRecallNotificationInput = z.infer<typeof approveRecallNotificationSchema>;

export const recallNoteSchema = z.object({
  note: z.string().trim().min(1).max(2000),
});
export type RecallNoteInput = z.infer<typeof recallNoteSchema>;

export const closeRecallSchema = z.object({
  reason: reason(20, 'Record the outcome of the recall and why it is being closed.'),
});
export type CloseRecallInput = z.infer<typeof closeRecallSchema>;

export const cancelRecallSchema = z.object({
  reason: reason(
    20,
    'Record why this recall is being cancelled. Blocked stock returns to the status it held before.',
  ),
});
export type CancelRecallInput = z.infer<typeof cancelRecallSchema>;

export const recallRegulatorSchema = z.object({
  regulatorReference: z.string().trim().min(1).max(200),
  notes: reason(10, 'Record what was reported and to whom.'),
});
export type RecallRegulatorInput = z.infer<typeof recallRegulatorSchema>;

export const recallQuerySchema = paginationSchema.extend({
  status: z.string().trim().max(40).optional(),
});
export type RecallQuery = z.infer<typeof recallQuerySchema>;
