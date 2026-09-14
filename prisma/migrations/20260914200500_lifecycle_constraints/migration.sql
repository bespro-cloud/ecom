-- Customer-lifecycle invariants that live in the database.
--
-- As elsewhere, every rule here is also enforced by the application. They are
-- repeated at this level because application code can be bypassed by a
-- migration, a console session or a defect, and these are the rules where being
-- wrong means an unreviewed health claim on a listing, a discount larger than
-- the order, or a customer charged twice for one month.

-- ---------------------------------------------------------------------------
-- Append-only history
-- ---------------------------------------------------------------------------

CREATE TRIGGER "review_moderations_no_update"
  BEFORE UPDATE ON "review_moderations"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "review_moderations_no_delete"
  BEFORE DELETE ON "review_moderations"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "subscription_events_no_update"
  BEFORE UPDATE ON "subscription_events"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "subscription_events_no_delete"
  BEFORE DELETE ON "subscription_events"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- A redemption is the record that a discount was given. Deleting one would
-- free a usage slot that was actually spent, and rewriting the amount would
-- disagree with the order it discounted.
CREATE TRIGGER "coupon_redemptions_no_update"
  BEFORE UPDATE ON "coupon_redemptions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "coupon_redemptions_no_delete"
  BEFORE DELETE ON "coupon_redemptions"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- A customer's message is theirs. Staff can add to a thread; nobody edits what
-- somebody else wrote, and a support transcript that could be rewritten is not
-- evidence of what was said.
CREATE TRIGGER "support_messages_no_update"
  BEFORE UPDATE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "support_messages_no_delete"
  BEFORE DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------

ALTER TABLE "product_reviews"
  ADD CONSTRAINT "review_rating_in_range" CHECK (rating >= 1 AND rating <= 5),
  ADD CONSTRAINT "review_body_present" CHECK (length(btrim(body)) > 0),
  ADD CONSTRAINT "review_author_present" CHECK (length(btrim(author_display_name)) > 0),
  -- A published review has a publication timestamp. Without this, "published"
  -- could be a status with no moment behind it, and "when did this claim go
  -- live?" would have no answer.
  ADD CONSTRAINT "review_published_is_dated" CHECK (
    status <> 'PUBLISHED' OR published_at IS NOT NULL
  ),
  -- The badge is derived from a real order line, never set independently. This
  -- is the constraint that makes "verified purchase" mean something.
  ADD CONSTRAINT "review_verified_has_a_purchase" CHECK (
    verified_purchase = false OR order_item_id IS NOT NULL
  );

ALTER TABLE "review_moderations"
  ADD CONSTRAINT "review_moderation_notes_present" CHECK (length(btrim(notes)) > 0);

-- ---------------------------------------------------------------------------
-- Coupons
-- ---------------------------------------------------------------------------

ALTER TABLE "coupons"
  -- Each type needs its own value, and only its own. A percentage coupon with
  -- an amount is a coupon whose worth depends on which branch of the code runs.
  ADD CONSTRAINT "coupon_value_matches_type" CHECK (
    (type = 'FIXED_AMOUNT' AND amount_cents IS NOT NULL AND amount_cents > 0 AND basis_points IS NULL)
    OR (type = 'PERCENTAGE' AND basis_points IS NOT NULL AND basis_points > 0 AND basis_points <= 10000 AND amount_cents IS NULL)
    OR (type = 'FREE_SHIPPING' AND amount_cents IS NULL AND basis_points IS NULL)
  ),
  ADD CONSTRAINT "coupon_limits_positive" CHECK (
    (max_redemptions IS NULL OR max_redemptions > 0)
    AND (max_per_customer IS NULL OR max_per_customer > 0)
  ),
  ADD CONSTRAINT "coupon_thresholds_non_negative" CHECK (
    (min_subtotal_cents IS NULL OR min_subtotal_cents >= 0)
    AND (max_discount_cents IS NULL OR max_discount_cents > 0)
  ),
  ADD CONSTRAINT "coupon_window_is_ordered" CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
  ),
  ADD CONSTRAINT "coupon_redemption_count_non_negative" CHECK (redemption_count >= 0),
  -- A per-customer limit is unenforceable against guests. Requiring an account
  -- is the only way the limit means anything.
  ADD CONSTRAINT "coupon_per_customer_limit_needs_an_account" CHECK (
    max_per_customer IS NULL OR requires_customer = true
  );

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "redemption_amount_positive" CHECK (amount_cents > 0);

-- ---------------------------------------------------------------------------
-- Payment methods: there is nowhere here to put a card number
-- ---------------------------------------------------------------------------

ALTER TABLE "customer_payment_methods"
  ADD CONSTRAINT "payment_method_token_present" CHECK (
    length(btrim(provider_payment_method_id)) > 0
  ),
  -- Four digits at most. The column is a display string; a constraint that
  -- allows sixteen invites somebody to put a PAN in it one day.
  ADD CONSTRAINT "payment_method_last4_is_last4" CHECK (
    card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'
  ),
  ADD CONSTRAINT "payment_method_expiry_plausible" CHECK (
    (expiry_month IS NULL OR (expiry_month >= 1 AND expiry_month <= 12))
    AND (expiry_year IS NULL OR (expiry_year >= 2000 AND expiry_year <= 2100))
  );

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscription_interval_count_positive" CHECK (interval_count > 0),
  ADD CONSTRAINT "subscription_anchor_day_valid" CHECK (
    anchor_day_of_month IS NULL OR (anchor_day_of_month >= 1 AND anchor_day_of_month <= 31)
  ),
  ADD CONSTRAINT "subscription_period_is_ordered" CHECK (current_period_end > current_period_start),
  ADD CONSTRAINT "subscription_failed_attempts_non_negative" CHECK (failed_attempts >= 0),
  -- A cancelled subscription has no next charge. Leaving a date on it is how a
  -- billing run charges somebody who cancelled.
  ADD CONSTRAINT "cancelled_subscription_has_no_next_charge" CHECK (
    status <> 'CANCELLED' OR next_billing_at IS NULL
  ),
  ADD CONSTRAINT "cancelled_subscription_is_dated" CHECK (
    status <> 'CANCELLED' OR cancelled_at IS NOT NULL
  );

ALTER TABLE "subscription_items"
  ADD CONSTRAINT "subscription_item_quantity_positive" CHECK (quantity > 0),
  ADD CONSTRAINT "subscription_item_price_non_negative" CHECK (unit_price_cents >= 0);

ALTER TABLE "subscription_invoices"
  ADD CONSTRAINT "invoice_total_non_negative" CHECK (total_cents >= 0),
  ADD CONSTRAINT "invoice_period_is_ordered" CHECK (period_end > period_start),
  ADD CONSTRAINT "invoice_attempt_positive" CHECK (attempt > 0);

-- ---------------------------------------------------------------------------
-- Support and erasure
-- ---------------------------------------------------------------------------

ALTER TABLE "support_messages"
  ADD CONSTRAINT "support_message_body_present" CHECK (length(btrim(body)) > 0),
  ADD CONSTRAINT "support_message_author_type_known" CHECK (author_type IN ('CUSTOMER', 'STAFF')),
  -- Only staff write internal notes. A customer message marked internal would
  -- vanish from the customer's own view of their conversation.
  ADD CONSTRAINT "only_staff_write_internal_notes" CHECK (
    is_internal = false OR author_type = 'STAFF'
  );

ALTER TABLE "support_threads"
  ADD CONSTRAINT "support_subject_present" CHECK (length(btrim(subject)) > 0);

ALTER TABLE "erasure_requests"
  -- A decision says what was removed, what was kept, and why. A status with no
  -- reasoning behind it is not a response to a legal request.
  ADD CONSTRAINT "erasure_decision_is_explained" CHECK (
    status IN ('REQUESTED', 'IN_REVIEW')
    OR (decided_at IS NOT NULL AND decided_by_id IS NOT NULL AND length(btrim(coalesce(decision_notes, ''))) > 0)
  );

-- ---------------------------------------------------------------------------
-- Indexes for the queries this phase runs
-- ---------------------------------------------------------------------------

-- The published reviews on a listing, and the rating aggregate over them.
CREATE INDEX "product_reviews_published_idx"
  ON "product_reviews" ("product_id", "created_at" DESC)
  WHERE status = 'PUBLISHED';

-- The moderation queue.
CREATE INDEX "product_reviews_awaiting_idx"
  ON "product_reviews" ("created_at")
  WHERE status IN ('PENDING', 'ESCALATED');

-- A customer cannot review the same purchase twice, and cannot review the same
-- product twice without a purchase behind each one. The unique index on
-- order_item_id covers the first; this covers the second.
CREATE UNIQUE INDEX "product_reviews_one_unverified_per_product_idx"
  ON "product_reviews" ("customer_id", "product_id")
  WHERE order_item_id IS NULL;

-- The billing run: subscriptions due a charge.
CREATE INDEX "subscriptions_due_idx"
  ON "subscriptions" ("next_billing_at")
  WHERE status IN ('ACTIVE', 'PAST_DUE') AND next_billing_at IS NOT NULL;

-- Case-insensitive coupon lookup, because customers type what is on the card.
CREATE UNIQUE INDEX "coupons_code_lower_idx" ON "coupons" (lower(code));

-- The support inbox.
CREATE INDEX "support_threads_open_idx"
  ON "support_threads" ("last_message_at" DESC)
  WHERE status IN ('OPEN', 'AWAITING_CUSTOMER');
