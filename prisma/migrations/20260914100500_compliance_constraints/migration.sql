-- Compliance invariants that live in the database.
--
-- These are the rules whose violation is a regulatory problem rather than a
-- bug: substantiation that was rewritten after approval, stock that shipped
-- while recalled, a quarantine with no recorded reason. The application
-- enforces all of them too. They are repeated here because application code can
-- be bypassed by a migration, a console session or a defect, and for this
-- particular set of rules "the code was wrong that day" is not an answer
-- anybody can give afterwards.

-- ---------------------------------------------------------------------------
-- Append-only history
-- ---------------------------------------------------------------------------
--
-- `reject_mutation()` already exists (Phase 1, extended in Phase 3). Attaching
-- it to these tables is what makes "approved history is never overwritten" a
-- property of the database rather than a promise in a service.
--
-- Claim *versions* are append-only; the claim row that points at them is not,
-- because the pointer has to move as a claim progresses. That split is the
-- whole design: the words a reviewer signed off can never change, while the
-- record of which version is current is free to.

CREATE TRIGGER "product_claim_versions_no_update"
  BEFORE UPDATE ON "product_claim_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "product_claim_versions_no_delete"
  BEFORE DELETE ON "product_claim_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "claim_reviews_no_update"
  BEFORE UPDATE ON "claim_reviews"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "claim_reviews_no_delete"
  BEFORE DELETE ON "claim_reviews"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "batch_events_no_update"
  BEFORE UPDATE ON "batch_events"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "batch_events_no_delete"
  BEFORE DELETE ON "batch_events"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "recall_actions_no_update"
  BEFORE UPDATE ON "recall_actions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "recall_actions_no_delete"
  BEFORE DELETE ON "recall_actions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- A lot cannot be removed from a recall's scope once recorded. Which lots were
-- in scope is the recall's factual core; editing it afterwards would rewrite
-- what was actually withdrawn from sale.
CREATE TRIGGER "recall_lots_no_delete"
  BEFORE DELETE ON "recall_lots"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Evidence is not allowed to be empty where it matters
-- ---------------------------------------------------------------------------
--
-- `limitations` in particular. A Zod schema enforces this on the way in, but a
-- backfill or an import bypasses Zod entirely, and evidence recorded with no
-- stated limitations is evidence being oversold.

ALTER TABLE "evidence_records"
  ADD CONSTRAINT "evidence_substance_present" CHECK (
    length(btrim(title)) > 0
    AND length(btrim(citation)) > 0
    AND length(btrim(population)) > 0
    AND length(btrim(dosage)) > 0
    AND length(btrim(duration)) > 0
    AND length(btrim(outcome)) > 0
    AND length(btrim(limitations)) >= 10
  ),
  ADD CONSTRAINT "evidence_year_plausible" CHECK (
    published_year IS NULL OR (published_year >= 1800 AND published_year <= 2200)
  ),
  -- Accepted or rejected evidence names the person who decided. Nullable
  -- columns plus a status is how an unattributed review happens.
  ADD CONSTRAINT "evidence_decision_is_attributed" CHECK (
    status IN ('DRAFT', 'UNDER_REVIEW')
    OR (reviewed_by_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(btrim(coalesce(review_notes, ''))) > 0)
  );

ALTER TABLE "product_claim_versions"
  ADD CONSTRAINT "claim_version_text_present" CHECK (length(btrim(text)) > 0),
  ADD CONSTRAINT "claim_version_number_positive" CHECK (version > 0),
  -- The first version has nothing to explain. Every later one does.
  ADD CONSTRAINT "claim_version_change_is_explained" CHECK (
    version = 1 OR length(btrim(coalesce(change_reason, ''))) > 0
  );

ALTER TABLE "claim_reviews"
  ADD CONSTRAINT "claim_review_notes_present" CHECK (length(btrim(notes)) > 0);

-- An approved claim names when it was approved and when the approval lapses.
-- Without this, "approved" could be a status with no dates behind it, which is
-- indistinguishable from a claim that was never reviewed.
ALTER TABLE "product_claims"
  ADD CONSTRAINT "claim_approval_is_dated" CHECK (
    status <> 'APPROVED'
    OR (approved_version_id IS NOT NULL AND approved_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Lots: quantities, and reasons
-- ---------------------------------------------------------------------------

ALTER TABLE "inventory_batches"
  ADD CONSTRAINT "batch_quantities_non_negative" CHECK (
    quantity_on_hand >= 0 AND quantity_reserved >= 0
  ),
  -- Promising more of a lot than exists in it is the lot-level shape of
  -- overselling, and it is the bug FEFO allocation would produce if it ever
  -- read a stale quantity.
  ADD CONSTRAINT "batch_reserved_within_on_hand" CHECK (quantity_reserved <= quantity_on_hand),
  ADD CONSTRAINT "batch_lot_code_present" CHECK (length(btrim(lot_code)) > 0),
  -- Goods cannot expire before they were made.
  ADD CONSTRAINT "batch_expiry_after_manufacture" CHECK (
    manufactured_at IS NULL OR expires_at IS NULL OR expires_at >= manufactured_at
  );

ALTER TABLE "batch_events"
  ADD CONSTRAINT "batch_event_reason_present" CHECK (length(btrim(reason)) > 0);

-- ---------------------------------------------------------------------------
-- Recalls: nobody is contacted without a named approver
-- ---------------------------------------------------------------------------
--
-- The single most consequential rule in this file. A recall can only sit in
-- NOTIFICATION_APPROVED if a person and a timestamp are recorded against that
-- approval — so "the system decided to notify customers" is not a state the
-- database will hold.

ALTER TABLE "recalls"
  ADD CONSTRAINT "recall_reason_present" CHECK (length(btrim(reason)) > 0),
  ADD CONSTRAINT "recall_notification_is_attributed" CHECK (
    notification_approved_at IS NULL
    OR (notification_approved_by_id IS NOT NULL AND length(btrim(coalesce(notification_approved_by_label, ''))) > 0)
  ),
  ADD CONSTRAINT "recall_notified_status_has_approval" CHECK (
    status <> 'NOTIFICATION_APPROVED' OR notification_approved_at IS NOT NULL
  ),
  -- An open recall names who opened it.
  ADD CONSTRAINT "recall_opened_is_attributed" CHECK (
    status IN ('DRAFT', 'CANCELLED') OR (opened_at IS NOT NULL AND opened_by_id IS NOT NULL)
  );

ALTER TABLE "recall_lots"
  ADD CONSTRAINT "recall_lot_quantity_non_negative" CHECK (quantity_at_recall >= 0);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

ALTER TABLE "product_documents"
  -- A document belongs to a product or a lot. One with neither is a file
  -- nobody can find and nobody is accountable for.
  ADD CONSTRAINT "document_has_an_owner" CHECK (
    (product_id IS NOT NULL) OR (batch_id IS NOT NULL)
  ),
  ADD CONSTRAINT "document_title_present" CHECK (length(btrim(title)) > 0),
  ADD CONSTRAINT "document_expiry_after_issue" CHECK (
    issued_at IS NULL OR expires_at IS NULL OR expires_at >= issued_at
  ),
  ADD CONSTRAINT "document_does_not_supersede_itself" CHECK (supersedes_id IS NULL OR supersedes_id <> id);

-- ---------------------------------------------------------------------------
-- Indexes for the queries this phase actually runs
-- ---------------------------------------------------------------------------

-- FEFO allocation: the allocatable lots for an item, earliest expiry first.
-- Partial, because allocation never looks at anything but AVAILABLE stock.
CREATE INDEX "inventory_batches_allocatable_idx"
  ON "inventory_batches" ("inventory_item_id", "expires_at" NULLS LAST, "received_at")
  WHERE status = 'AVAILABLE' AND quantity_on_hand > quantity_reserved;

-- The expiry sweep: lots that have passed their date but are still sellable.
CREATE INDEX "inventory_batches_expiring_idx"
  ON "inventory_batches" ("expires_at")
  WHERE status = 'AVAILABLE' AND expires_at IS NOT NULL;

-- Recall impact: given a lot, which orders received units from it.
CREATE INDEX "inventory_reservations_batch_order_idx"
  ON "inventory_reservations" ("batch_id", "order_id")
  WHERE batch_id IS NOT NULL AND order_id IS NOT NULL;

-- The claims a published listing may show, and the ones due for re-review.
CREATE INDEX "product_claims_approved_idx"
  ON "product_claims" ("product_id", "position")
  WHERE status = 'APPROVED';

-- Documents that have lapsed or are about to.
CREATE INDEX "product_documents_current_idx"
  ON "product_documents" ("product_id", "type", "expires_at")
  WHERE archived_at IS NULL;
