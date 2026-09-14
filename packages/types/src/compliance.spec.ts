import { describe, expect, it } from 'vitest';
import {
  ALLOCATABLE_BATCH_STATUSES,
  BATCH_STATUSES,
  BATCH_STATUS_TRANSITIONS,
  CLAIM_STATUSES,
  CLAIM_STATUS_TRANSITIONS,
  EVIDENCE_REQUIRED_CLAIM_TYPES,
  RECALL_STATUSES,
  RECALL_STATUS_TRANSITIONS,
  SUBSTANTIATING_RELEVANCE,
  canTransitionBatch,
  canTransitionClaim,
  canTransitionRecall,
  isBatchAllocatable,
  isClaimPublishable,
  recallBlocksStock,
  recallNotificationApproved,
} from './compliance.js';

/**
 * These are the rules that decide what a customer is told about a health
 * product and what ships to them. A wrong edge in one of these tables is not a
 * bug that shows up as a stack trace — it is an unapproved claim on a live
 * listing, or recalled stock going out of the door. They are tested
 * exhaustively for that reason.
 */

describe('the claim lifecycle', () => {
  it('publishes only an approved claim', () => {
    const publishable = CLAIM_STATUSES.filter(isClaimPublishable);
    expect(publishable).toEqual(['APPROVED']);
  });

  it('has no route from approved back to draft', () => {
    // Changing the words of an approved claim is a new version, not a mutation
    // of the one that was signed off. An edge here would let an approval be
    // inherited by text no reviewer ever saw.
    expect(canTransitionClaim('APPROVED', 'DRAFT')).toBe(false);
    expect(canTransitionClaim('APPROVED', 'UNDER_REVIEW')).toBe(false);
  });

  it('makes rejection terminal', () => {
    // A rejected claim is answered by writing a different claim, not by
    // re-submitting the same words until someone says yes.
    expect(CLAIM_STATUS_TRANSITIONS.REJECTED).toEqual([]);
  });

  it('makes withdrawal terminal', () => {
    expect(CLAIM_STATUS_TRANSITIONS.WITHDRAWN).toEqual([]);
  });

  it('lets an expired claim be re-reviewed rather than stranding it', () => {
    expect(canTransitionClaim('EXPIRED', 'UNDER_REVIEW')).toBe(true);
  });

  it('only ever approves out of review', () => {
    const approving = CLAIM_STATUSES.filter((from) => canTransitionClaim(from, 'APPROVED'));
    expect(approving).toEqual(['UNDER_REVIEW']);
  });

  it('names every status in the transition table', () => {
    // A status missing from the table would throw at runtime on the first
    // transition attempt, in the middle of a review.
    for (const status of CLAIM_STATUSES) {
      expect(CLAIM_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('only lists statuses that exist', () => {
    for (const targets of Object.values(CLAIM_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(CLAIM_STATUSES).toContain(target);
      }
    }
  });

  it('requires evidence for every claim type that asserts an effect', () => {
    expect(EVIDENCE_REQUIRED_CLAIM_TYPES).toContain('STRUCTURE_FUNCTION');
    expect(EVIDENCE_REQUIRED_CLAIM_TYPES).toContain('HEALTH_CLAIM');
    expect(EVIDENCE_REQUIRED_CLAIM_TYPES).toContain('NUTRIENT_CONTENT');
  });

  it('does not treat a disease claim as merely needing more evidence', () => {
    // No amount of substantiation makes a disease claim lawful on a supplement
    // listing. Listing it here would imply it could be approved with enough
    // studies attached.
    expect(EVIDENCE_REQUIRED_CLAIM_TYPES).not.toContain('DISEASE');
  });

  it('does not let contradictory evidence substantiate a claim', () => {
    expect(SUBSTANTIATING_RELEVANCE).not.toContain('CONTRADICTORY');
    expect(SUBSTANTIATING_RELEVANCE).not.toContain('BACKGROUND');
  });
});

describe('lot disposition', () => {
  it('allocates from available stock and nothing else', () => {
    expect(ALLOCATABLE_BATCH_STATUSES).toEqual(['AVAILABLE']);
    for (const status of BATCH_STATUSES) {
      expect(isBatchAllocatable(status)).toBe(status === 'AVAILABLE');
    }
  });

  it('never returns recalled stock to sale', () => {
    // Correcting a mistaken recall means receiving the goods again as a new
    // lot, with the receipt recorded — not flipping a status back.
    expect(canTransitionBatch('RECALLED', 'AVAILABLE')).toBe(false);
    expect(canTransitionBatch('RECALLED', 'QUARANTINED')).toBe(false);
  });

  it('never returns expired stock to sale', () => {
    expect(canTransitionBatch('EXPIRED', 'AVAILABLE')).toBe(false);
  });

  it('lets quarantined stock be released, because a hold is a question not a verdict', () => {
    expect(canTransitionBatch('QUARANTINED', 'AVAILABLE')).toBe(true);
  });

  it('makes disposal terminal', () => {
    expect(BATCH_STATUS_TRANSITIONS.DISPOSED).toEqual([]);
  });

  it('never transitions into a status that does not exist', () => {
    for (const targets of Object.values(BATCH_STATUS_TRANSITIONS)) {
      for (const target of targets) {
        expect(BATCH_STATUSES).toContain(target);
      }
    }
  });
});

describe('recalls', () => {
  it('does not consider customer contact approved merely because a recall is open', () => {
    // The single most important assertion in this file. If opening a recall
    // implied approval to contact customers, the separate permission and the
    // typed acknowledgement would both be decoration.
    expect(recallNotificationApproved('OPEN')).toBe(false);
    expect(recallNotificationApproved('DRAFT')).toBe(false);
    expect(recallNotificationApproved('CANCELLED')).toBe(false);
    expect(recallNotificationApproved('NOTIFICATION_APPROVED')).toBe(true);
  });

  it('reaches notification approval only from an open recall', () => {
    const approving = RECALL_STATUSES.filter((from) =>
      canTransitionRecall(from, 'NOTIFICATION_APPROVED'),
    );
    expect(approving).toEqual(['OPEN']);
  });

  it('blocks stock from the moment a recall opens until it is cancelled', () => {
    expect(recallBlocksStock('DRAFT')).toBe(false);
    expect(recallBlocksStock('OPEN')).toBe(true);
    expect(recallBlocksStock('NOTIFICATION_APPROVED')).toBe(true);
    // Closing a recall does not put the withdrawn stock back on the shelf.
    expect(recallBlocksStock('CLOSED')).toBe(true);
    expect(recallBlocksStock('CANCELLED')).toBe(false);
  });

  it('cannot be cancelled once customers have been approved for contact', () => {
    // Cancelling releases blocked stock. Once contact is approved, the recall
    // is a matter of record and is closed rather than undone.
    expect(canTransitionRecall('NOTIFICATION_APPROVED', 'CANCELLED')).toBe(false);
  });

  it('makes closed and cancelled terminal', () => {
    expect(RECALL_STATUS_TRANSITIONS.CLOSED).toEqual([]);
    expect(RECALL_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('names every status in the transition table', () => {
    for (const status of RECALL_STATUSES) {
      expect(RECALL_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });
});
