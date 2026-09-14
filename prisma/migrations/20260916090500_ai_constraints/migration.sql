-- Phase 7 constraints.
--
-- These are the safety properties of the AI subsystem expressed as database
-- rules. The application enforces all of them; so does the database, because
-- the whole point of the design is that AI cannot take an action, and a
-- guarantee that depends on every future code path being careful is not a
-- guarantee.

-- ---------------------------------------------------------------------------
-- The purpose and suggestion vocabularies are closed
-- ---------------------------------------------------------------------------

-- An allow-list in the database as well as the application.
--
-- If somebody adds a purpose, they have to add it here too — which means
-- writing it down in a migration that a reviewer reads, rather than adding a
-- string to an array and shipping.
ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_purpose_is_declared"
  CHECK ("purpose" IN (
    'EVIDENCE_DIGEST',
    'PRODUCT_COPY_DRAFT',
    'SEO_METADATA_DRAFT',
    'BLOG_OUTLINE_DRAFT',
    'ANALYTICS_SUMMARY',
    'SUPPORT_REPLY_DRAFT',
    'KNOWLEDGE_ANSWER'
  ));

-- The enforcement of "AI never completes an action".
--
-- Every member of this list writes descriptive text to a draft. There is
-- deliberately no kind that approves a claim, changes a compliance status,
-- publishes a page, issues a refund or moves stock — and adding one would
-- require changing this CHECK, in a migration, deliberately.
ALTER TABLE "ai_suggestions"
  ADD CONSTRAINT "ai_suggestion_kind_is_declared"
  CHECK ("kind" IN (
    'PRODUCT_DESCRIPTION',
    'SEO_METADATA',
    'BLOG_OUTLINE',
    'SUPPORT_REPLY',
    'ADVISORY_NOTE'
  ));

-- ---------------------------------------------------------------------------
-- A decision is attributed, and a blocked suggestion can never be accepted
-- ---------------------------------------------------------------------------

ALTER TABLE "ai_suggestions"
  ADD CONSTRAINT "ai_suggestion_decision_is_attributed"
  CHECK (
    ("status" = 'PENDING' AND "decided_at" IS NULL AND "decided_by_id" IS NULL)
    OR ("status" = 'BLOCKED')
    OR ("decided_at" IS NOT NULL AND "decided_by_id" IS NOT NULL AND "decided_by_label" IS NOT NULL)
  );

-- Accepting is a person putting their name to the words. A suggestion the
-- guardrails refused must not be acceptable by any route — not by a code path
-- that forgot to check, not by a direct UPDATE, not by a data fix.
CREATE OR REPLACE FUNCTION reject_accepting_blocked_suggestion() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'BLOCKED' AND NEW."status" <> 'BLOCKED' THEN
    RAISE EXCEPTION
      'A blocked AI suggestion cannot be accepted or reopened. The guardrails refused this text; generate it again if it is still wanted.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_suggestion_blocked_is_final
  BEFORE UPDATE ON "ai_suggestions"
  FOR EACH ROW EXECUTE FUNCTION reject_accepting_blocked_suggestion();

-- ---------------------------------------------------------------------------
-- The audit trail is append-only
-- ---------------------------------------------------------------------------

-- "What did we ask it, and what did it say?" is the question asked after
-- something goes wrong, and it must not be answerable with edited rows.
CREATE TRIGGER ai_interactions_no_update
  BEFORE UPDATE ON "ai_interactions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER ai_interactions_no_delete
  BEFORE DELETE ON "ai_interactions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Accounting is honest
-- ---------------------------------------------------------------------------

ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_interaction_counts_not_negative"
  CHECK (
    "input_tokens" >= 0
    AND "output_tokens" >= 0
    AND "cost_micros" >= 0
    AND "latency_ms" >= 0
  );

-- A call that was refused before it happened, or that had nothing to ground it,
-- cannot have cost anything. Without this, a bug in the refusal path could
-- quietly inflate the spend that the budget is computed from — and then refuse
-- everything for the rest of the day.
ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_uncalled_interaction_is_free"
  CHECK (
    "outcome" NOT IN ('REFUSED', 'NO_GROUNDING')
    OR ("cost_micros" = 0 AND "input_tokens" = 0 AND "output_tokens" = 0)
  );

-- A blocked output still happened and still cost money, but it must carry the
-- reason it was refused. A block with no reason is unreviewable.
ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_blocked_interaction_has_a_reason"
  CHECK ("outcome" <> 'BLOCKED' OR "blocked_reason" IS NOT NULL);

ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_interaction_day_format"
  CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');

-- ---------------------------------------------------------------------------
-- A grounded answer cites what it was given
-- ---------------------------------------------------------------------------

-- A completed answer for a retrieval-grounded purpose must have had something
-- to ground it. If retrieval was empty the outcome is NO_GROUNDING and no model
-- was called; a COMPLETED row with no sources would mean the model answered
-- from memory, which is the failure the whole retrieval design prevents.
ALTER TABLE "ai_interactions"
  ADD CONSTRAINT "ai_grounded_answer_has_sources"
  CHECK (
    "outcome" <> 'COMPLETED'
    OR "purpose" NOT IN ('EVIDENCE_DIGEST', 'KNOWLEDGE_ANSWER')
    OR cardinality("retrieved_ids") > 0
  );
