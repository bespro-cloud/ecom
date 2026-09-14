/**
 * The compliance domain: claims, evidence, documents, lots and recalls.
 *
 * This is the part of the platform that exists because the products are
 * regulated. Two principles run through all of it, and both are structural
 * rather than advisory.
 *
 * **Nothing here is ever inferred.** A claim is a record a person wrote, an
 * evidence entry is a study a person read, a certificate is a file a person
 * uploaded. The system does not read marketing copy and decide whether it
 * contains a claim, does not summarise a study into a conclusion, and does not
 * assert that a certification exists. Every one of those would be the software
 * manufacturing a regulatory fact, which is the failure mode this whole module
 * is built to prevent.
 *
 * **Approved history is never rewritten.** Editing an approved claim produces a
 * new version; the approved one stays exactly as it was signed off, along with
 * who signed it and what evidence they were looking at. The database enforces
 * this with append-only triggers, so it holds regardless of what the
 * application asks for.
 */

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * What kind of statement a claim is.
 *
 * The categories matter because US law treats them very differently. A
 * structure/function claim about a dietary supplement may be made on
 * substantiation held by the marketer, with the DSHEA disclaimer; a disease
 * claim may not be made about a supplement at all without it being regulated as
 * a drug. Recording the category is how a reviewer's judgement about which
 * rules apply survives the review.
 */
export const CLAIM_TYPES = [
  /** "Supports healthy sleep." Permitted with substantiation and the DSHEA disclaimer. */
  'STRUCTURE_FUNCTION',
  /** "Good source of magnesium." Governed by nutrient content rules. */
  'NUTRIENT_CONTENT',
  /** An FDA-authorised or qualified health claim. Only with an authorising basis recorded. */
  'HEALTH_CLAIM',
  /** "Cures insomnia." Not lawful for a supplement. Recorded so it can be refused, and stay refused. */
  'DISEASE',
  /** "Third-party tested." A factual assertion about the product, not about health. */
  'GENERAL',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/**
 * Claim types that require substantiating evidence before they may be approved.
 *
 * `GENERAL` is excluded because its substantiation is a document — a test
 * report, a certificate — rather than a study, and documents are modelled
 * separately. A disease claim is not on this list because no amount of evidence
 * makes it lawful on a supplement listing; it is refused on category alone.
 */
export const EVIDENCE_REQUIRED_CLAIM_TYPES: readonly ClaimType[] = [
  'STRUCTURE_FUNCTION',
  'NUTRIENT_CONTENT',
  'HEALTH_CLAIM',
];

export const CLAIM_STATUSES = [
  'DRAFT',
  'EVIDENCE_REQUIRED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  /** The approval interval elapsed. The claim stops being publishable. */
  'EXPIRED',
  /** Deliberately taken down. Distinct from rejected, which is a review outcome. */
  'WITHDRAWN',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * The claim lifecycle.
 *
 * An explicit map rather than scattered conditionals, for the same reason the
 * order state machine is one: every transition anyone can make is visible in a
 * single place, and a transition that is not listed cannot happen.
 *
 * Note what is absent. There is no edge from `APPROVED` back to `DRAFT`:
 * changing the words of an approved claim is a *new version*, not a mutation of
 * the approved one. And `REJECTED` is terminal — a rejected claim is answered
 * by writing a different claim, not by quietly re-submitting the same one until
 * a reviewer says yes.
 */
export const CLAIM_STATUS_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  DRAFT: ['EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'WITHDRAWN'],
  EVIDENCE_REQUIRED: ['UNDER_REVIEW', 'DRAFT', 'WITHDRAWN'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'EVIDENCE_REQUIRED'],
  APPROVED: ['EXPIRED', 'WITHDRAWN'],
  REJECTED: [],
  EXPIRED: ['UNDER_REVIEW', 'WITHDRAWN'],
  WITHDRAWN: [],
};

export function canTransitionClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses in which a claim may appear on a public listing. Exactly one. */
export function isClaimPublishable(status: ClaimStatus): boolean {
  return status === 'APPROVED';
}

export const CLAIM_DECISIONS = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] as const;
export type ClaimDecision = (typeof CLAIM_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Where a piece of evidence comes from.
 *
 * Ordered roughly by the weight a reviewer would normally give it, but the
 * system draws no conclusion from the ordering: deciding whether a particular
 * study supports a particular claim is the reviewer's judgement, and there is
 * no scoring anywhere in this module that could quietly substitute for it.
 */
export const EVIDENCE_SOURCE_TYPES = [
  'SYSTEMATIC_REVIEW',
  'META_ANALYSIS',
  'RANDOMISED_CONTROLLED_TRIAL',
  'OBSERVATIONAL_STUDY',
  'IN_VITRO',
  'ANIMAL_STUDY',
  'MANUFACTURER_DATA',
  'REGULATORY_GUIDANCE',
  'MONOGRAPH',
  'OTHER',
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

/** A reviewer's judgement of how well a source supports the claim it is attached to. */
export const EVIDENCE_RELEVANCE = ['DIRECT', 'INDIRECT', 'BACKGROUND', 'CONTRADICTORY'] as const;
export type EvidenceRelevance = (typeof EVIDENCE_RELEVANCE)[number];

/**
 * Relevance values that can substantiate a claim.
 *
 * `CONTRADICTORY` is deliberately a value a reviewer can record. Evidence that
 * cuts against a claim is part of the substantiation file — a file containing
 * only supportive studies is not a review, it is a sales document — but it
 * cannot be what an approval rests on.
 */
export const SUBSTANTIATING_RELEVANCE: readonly EvidenceRelevance[] = ['DIRECT', 'INDIRECT'];

export const EVIDENCE_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Regulatory and quality documents held against a product or a lot.
 *
 * These are uploaded artefacts. The system records what a person said a
 * document is, who issued it and when it expires; it does not verify any of
 * that, and nothing in the platform should ever present a document's presence
 * as proof that a certification is valid.
 */
export const DOCUMENT_TYPES = [
  /** Certificate of analysis for a specific lot. */
  'CERTIFICATE_OF_ANALYSIS',
  'GMP_CERTIFICATE',
  'THIRD_PARTY_TEST_REPORT',
  'ALLERGEN_STATEMENT',
  'SAFETY_DATA_SHEET',
  'SUPPLIER_QUALIFICATION',
  'HEAVY_METALS_REPORT',
  'MICROBIOLOGY_REPORT',
  'STABILITY_STUDY',
  'LABEL_ARTWORK',
  'REGULATORY_CORRESPONDENCE',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Batches and lots
// ---------------------------------------------------------------------------

/**
 * The disposition of a lot of stock.
 *
 * Only `AVAILABLE` stock may be allocated to an order. Everything else is a
 * reason the units are physically present but must not ship, and the
 * distinction between those reasons is why they are separate states rather than
 * one "blocked" flag.
 */
export const BATCH_STATUSES = [
  'AVAILABLE',
  /** Held pending a decision. Reversible, with a recorded reason either way. */
  'QUARANTINED',
  /** Subject to a recall. Never allocatable again. */
  'RECALLED',
  /** Past its expiry date. Never allocatable again. */
  'EXPIRED',
  /** Written off — damaged, destroyed, returned to supplier. */
  'DISPOSED',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * Statuses whose stock may be sold.
 *
 * Written as an allow-list rather than a block-list on purpose. A status added
 * later is not sellable until someone deliberately adds it here — whereas a
 * block-list would make every new status silently shippable, which on a
 * regulated product is the wrong way round.
 */
export const ALLOCATABLE_BATCH_STATUSES: readonly BatchStatus[] = ['AVAILABLE'];

export function isBatchAllocatable(status: BatchStatus): boolean {
  return ALLOCATABLE_BATCH_STATUSES.includes(status);
}

/** Transitions a person may make. Expiry and recall are applied by the system. */
export const BATCH_STATUS_TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  AVAILABLE: ['QUARANTINED', 'RECALLED', 'EXPIRED', 'DISPOSED'],
  QUARANTINED: ['AVAILABLE', 'RECALLED', 'EXPIRED', 'DISPOSED'],
  // Terminal. Releasing recalled stock back into sale is not an operation this
  // system offers; correcting a mistaken recall means receiving the goods again
  // as a new lot, with the receipt recorded.
  RECALLED: ['DISPOSED'],
  EXPIRED: ['DISPOSED'],
  DISPOSED: [],
};

export function canTransitionBatch(from: BatchStatus, to: BatchStatus): boolean {
  return BATCH_STATUS_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Recalls
// ---------------------------------------------------------------------------

/**
 * FDA recall classification.
 *
 * Recorded, never computed. Classification is a regulatory judgement about
 * probability of harm; software guessing it from a free-text reason would be
 * inventing the single most consequential field on the record.
 */
export const RECALL_CLASSIFICATIONS = [
  /** Reasonable probability of serious adverse health consequences or death. */
  'CLASS_I',
  /** May cause temporary or medically reversible adverse health consequences. */
  'CLASS_II',
  /** Not likely to cause adverse health consequences. */
  'CLASS_III',
  /** Not yet classified. A recall may need to start before this is settled. */
  'UNCLASSIFIED',
] as const;
export type RecallClassification = (typeof RECALL_CLASSIFICATIONS)[number];

export const RECALL_STATUSES = [
  /** Being prepared. Stock is not yet blocked. */
  'DRAFT',
  /** Live. Affected lots are quarantined and cannot be allocated. */
  'OPEN',
  /** Customer notification has been approved by a named person. */
  'NOTIFICATION_APPROVED',
  'CLOSED',
  /** Opened in error. Blocked stock is released back to its previous status. */
  'CANCELLED',
] as const;
export type RecallStatus = (typeof RECALL_STATUSES)[number];

/**
 * The recall lifecycle.
 *
 * `OPEN → NOTIFICATION_APPROVED` is the only edge that unlocks contacting
 * customers, and it exists as its own transition precisely so that approval is
 * a separate, recorded act rather than a side effect of opening a recall.
 * Nothing in this system contacts anyone without it.
 */
export const RECALL_STATUS_TRANSITIONS: Record<RecallStatus, readonly RecallStatus[]> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['NOTIFICATION_APPROVED', 'CLOSED', 'CANCELLED'],
  NOTIFICATION_APPROVED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canTransitionRecall(from: RecallStatus, to: RecallStatus): boolean {
  return RECALL_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses in which affected lots are blocked from allocation. */
export function recallBlocksStock(status: RecallStatus): boolean {
  return status === 'OPEN' || status === 'NOTIFICATION_APPROVED' || status === 'CLOSED';
}

/**
 * Whether customers may be contacted about this recall.
 *
 * The one question the recall console asks before it will even *render* a
 * contact list. Notifying customers during a recall carries legal consequences
 * and is not something to arrive at by clicking through screens.
 */
export function recallNotificationApproved(status: RecallStatus): boolean {
  return status === 'NOTIFICATION_APPROVED' || status === 'CLOSED';
}

export const RECALL_ACTION_TYPES = [
  'OPENED',
  'LOT_ADDED',
  'LOT_REMOVED',
  'STOCK_QUARANTINED',
  'IMPACT_ASSESSED',
  'NOTIFICATION_APPROVED',
  'NOTIFICATION_EXPORTED',
  'REGULATOR_NOTIFIED',
  'NOTE',
  'CLOSED',
  'CANCELLED',
] as const;
export type RecallActionType = (typeof RECALL_ACTION_TYPES)[number];
