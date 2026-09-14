import 'server-only';
import { apiRequestOrSignIn } from './guards';

/**
 * Admin-side compliance types.
 *
 * Mirrors the HTTP contract, as elsewhere in this app. Two naming choices are
 * deliberate and carried all the way to the screen:
 *
 * `issuerAsStated` rather than `issuer` — the system has not verified who
 * issued a certificate, and a field called `issuer` reads like it has.
 *
 * `approvedText` separate from `currentText` — they are frequently different,
 * and the one a customer sees is the approved one. Collapsing them into `text`
 * would make a screen that shows the wrong one very easy to write.
 */

export type ClaimStatus =
  | 'DRAFT'
  | 'EVIDENCE_REQUIRED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'WITHDRAWN';

export interface AdminClaimSummary {
  id: string;
  productId: string;
  type: string;
  status: ClaimStatus;
  position: number;
  currentText: string | null;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  approvedText: string | null;
  approvedVersionNumber: number | null;
  hasUnapprovedChanges: boolean;
  approvedAt: string | null;
  reviewDueAt: string | null;
  reviewOverdue: boolean;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
  product?: { id: string; sku: string; name: string; status: string };
}

export interface AdminClaimVersion {
  id: string;
  version: number;
  text: string;
  context: string | null;
  changeReason: string | null;
  authorLabel: string;
  createdAt: string;
}

export interface AdminClaimReview {
  id: string;
  versionId: string;
  decision: string;
  notes: string;
  reviewerLabel: string;
  decidedAt: string;
  reviewDueAt: string | null;
}

export interface AdminEvidence {
  id: string;
  sourceType: string;
  status: string;
  title: string;
  citation: string;
  identifier: string | null;
  publishedYear: number | null;
  population: string;
  dosage: string;
  duration: string;
  outcome: string;
  limitations: string;
  addedByLabel: string;
  reviewedByLabel: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
  claimCount?: number;
}

export interface AdminClaim extends AdminClaimSummary {
  versions: AdminClaimVersion[];
  reviews: AdminClaimReview[];
  evidence: Array<AdminEvidence & { linkId: string; relevance: string; notes: string | null }>;
  substantiation: {
    sufficient: boolean;
    detail: string;
    accepted: number;
    contradictory: number;
  };
}

export interface AdminDocument {
  id: string;
  type: string;
  title: string;
  issuerAsStated: string | null;
  reference: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  notes: string | null;
  uploadedByLabel: string;
  createdAt: string;
  productId: string | null;
  batchId: string | null;
  verification: 'NOT_VERIFIED_BY_THIS_SYSTEM';
  product?: { id: string; sku: string; name: string } | null;
  batch?: { id: string; lotCode: string } | null;
}

export interface AdminBatch {
  id: string;
  lotCode: string;
  status: string;
  manufacturedAt: string | null;
  expiresAt: string | null;
  receivedAt: string;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAllocatable: number;
  pastExpiry: boolean;
  supplierAsStated: string | null;
  supplierReference: string | null;
  notes: string | null;
  inventoryItemId: string;
  lotTracked: boolean;
  warehouse: { id: string; code: string; name: string };
  variant: {
    id: string;
    sku: string;
    name: string;
    productId: string;
    productName: string;
  };
}

export interface AdminBatchEvent {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  quantityDelta: number | null;
  reason: string;
  actorLabel: string | null;
  isSystem: boolean;
  createdAt: string;
}

export interface AdminRecallSummary {
  id: string;
  reference: string;
  status: string;
  classification: string;
  title: string;
  openedAt: string | null;
  notificationApprovedAt: string | null;
  closedAt: string | null;
  lotCount: number;
  createdAt: string;
}

export interface AdminRecall extends Omit<AdminRecallSummary, 'lotCount'> {
  reason: string;
  hazard: string | null;
  openedByLabel: string | null;
  notificationApprovedByLabel: string | null;
  notificationApproved: boolean;
  regulatorNotifiedAt: string | null;
  regulatorReference: string | null;
  lots: Array<{
    id: string;
    batchId: string;
    lotCode: string;
    status: string;
    previousStatus: string;
    quantityAtRecall: number;
    quantityOnHand: number;
    expiresAt: string | null;
    warehouse: { code: string; name: string };
    sku: string;
    productId: string;
    productName: string;
  }>;
  actions: Array<{
    id: string;
    type: string;
    message: string;
    actorLabel: string | null;
    isSystem: boolean;
    createdAt: string;
  }>;
}

export interface RecallImpact {
  notificationApproved: boolean;
  orderCount: number;
  customerCount: number;
  unitsShipped: number;
  byProduct: Array<{ productId: string; productName: string; units: number }>;
  /** Null until a named person has approved contacting customers. */
  orders: Array<{
    orderId: string;
    reference: string;
    email: string;
    orderStatus: string;
    placedAt: string;
    units: number;
  }> | null;
  disclosureNote: string;
}

// ---------------------------------------------------------------------------

const BASE = '/api/v1/admin/compliance';
const TRACE = '/api/v1/admin/traceability';

export async function listClaims(query: string): Promise<{
  data: AdminClaimSummary[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${BASE}/claims${query ? `?${query}` : ''}`);
}

export async function getClaim(id: string): Promise<AdminClaim> {
  return apiRequestOrSignIn(`${BASE}/claims/${id}`);
}

export async function listEvidence(query: string): Promise<{
  data: AdminEvidence[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${BASE}/evidence${query ? `?${query}` : ''}`);
}

export async function listDocuments(query: string): Promise<{
  data: AdminDocument[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${BASE}/documents${query ? `?${query}` : ''}`);
}

export async function listBatches(query: string): Promise<{
  data: AdminBatch[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${TRACE}/batches${query ? `?${query}` : ''}`);
}

export async function getBatch(
  id: string,
): Promise<AdminBatch & { events: AdminBatchEvent[]; documents: AdminDocument[] }> {
  return apiRequestOrSignIn(`${TRACE}/batches/${id}`);
}

export async function listRecalls(query: string): Promise<{
  data: AdminRecallSummary[];
  meta: { hasMore: boolean };
}> {
  return apiRequestOrSignIn(`${TRACE}/recalls${query ? `?${query}` : ''}`);
}

export async function getRecall(id: string): Promise<AdminRecall> {
  return apiRequestOrSignIn(`${TRACE}/recalls/${id}`);
}

export async function getRecallImpact(id: string): Promise<RecallImpact> {
  return apiRequestOrSignIn(`${TRACE}/recalls/${id}/impact`);
}

// ---------------------------------------------------------------------------

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const CLAIM_TONE: Record<ClaimStatus, Tone> = {
  DRAFT: 'neutral',
  EVIDENCE_REQUIRED: 'warning',
  UNDER_REVIEW: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
  WITHDRAWN: 'neutral',
};

export function claimTone(status: string): Tone {
  return CLAIM_TONE[status as ClaimStatus] ?? 'neutral';
}

export function batchTone(status: string): Tone {
  switch (status) {
    case 'AVAILABLE':
      return 'success';
    case 'QUARANTINED':
      return 'warning';
    case 'RECALLED':
      return 'danger';
    case 'EXPIRED':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function recallTone(status: string): Tone {
  switch (status) {
    case 'OPEN':
      return 'danger';
    case 'NOTIFICATION_APPROVED':
      return 'danger';
    case 'CLOSED':
      return 'neutral';
    case 'CANCELLED':
      return 'neutral';
    default:
      return 'warning';
  }
}

export function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}
