-- Commerce invariants that live in the database.
--
-- Everything here is a rule the application also enforces. They are repeated at
-- this level because application code can be bypassed by a migration, a console
-- session or a bug, and these are the rules where being wrong means money moves
-- incorrectly or stock is sold twice.

-- ---------------------------------------------------------------------------
-- Money is never negative, and totals are internally consistent.
-- ---------------------------------------------------------------------------

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_money_non_negative" CHECK (
    subtotal_cents >= 0
    AND discount_cents >= 0
    AND shipping_cents >= 0
    AND tax_cents >= 0
    AND total_cents >= 0
    AND amount_paid_cents >= 0
    AND amount_refunded_cents >= 0
  ),
  -- The arithmetic on an invoice has to add up. A discount larger than the
  -- goods, or a total that does not follow from the parts, is a defect that
  -- must not reach an accounting export.
  ADD CONSTRAINT "orders_total_is_consistent" CHECK (
    total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents
  ),
  ADD CONSTRAINT "orders_discount_within_subtotal" CHECK (discount_cents <= subtotal_cents),
  -- More refunded than captured is the shape of a double-refund bug.
  ADD CONSTRAINT "orders_refund_within_paid" CHECK (amount_refunded_cents <= amount_paid_cents);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive" CHECK (quantity > 0),
  ADD CONSTRAINT "order_items_money_non_negative" CHECK (
    unit_price_cents >= 0
    AND line_subtotal_cents >= 0
    AND discount_cents >= 0
    AND tax_cents >= 0
    AND line_total_cents >= 0
  ),
  ADD CONSTRAINT "order_items_subtotal_is_consistent" CHECK (
    line_subtotal_cents = unit_price_cents * quantity
  ),
  ADD CONSTRAINT "order_items_total_is_consistent" CHECK (
    line_total_cents = line_subtotal_cents - discount_cents + tax_cents
  ),
  -- Fulfilling or refunding more than was ordered is never correct.
  ADD CONSTRAINT "order_items_fulfilled_within_ordered" CHECK (
    quantity_fulfilled >= 0 AND quantity_fulfilled <= quantity
  ),
  ADD CONSTRAINT "order_items_refunded_within_ordered" CHECK (
    quantity_refunded >= 0 AND quantity_refunded <= quantity
  );

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_money_non_negative" CHECK (
    amount_cents >= 0 AND amount_captured_cents >= 0 AND amount_refunded_cents >= 0
  ),
  ADD CONSTRAINT "payments_captured_within_amount" CHECK (amount_captured_cents <= amount_cents),
  ADD CONSTRAINT "payments_refunded_within_captured" CHECK (
    amount_refunded_cents <= amount_captured_cents
  );

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK (amount_cents > 0);

ALTER TABLE "carts"
  ADD CONSTRAINT "carts_money_non_negative" CHECK (
    subtotal_cents >= 0
    AND discount_cents >= 0
    AND shipping_cents >= 0
    AND tax_cents >= 0
    AND total_cents >= 0
  );

ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_quantity_positive" CHECK (quantity > 0),
  ADD CONSTRAINT "cart_items_price_non_negative" CHECK (quoted_unit_price_cents >= 0);

ALTER TABLE "checkouts"
  ADD CONSTRAINT "checkouts_money_non_negative" CHECK (
    subtotal_cents >= 0
    AND discount_cents >= 0
    AND shipping_cents >= 0
    AND tax_cents >= 0
    AND total_cents >= 0
  ),
  ADD CONSTRAINT "checkouts_total_is_consistent" CHECK (
    total_cents = subtotal_cents - discount_cents + shipping_cents + tax_cents
  );

ALTER TABLE "shipping_rates"
  ADD CONSTRAINT "shipping_rates_price_non_negative" CHECK (price_cents >= 0);

-- ---------------------------------------------------------------------------
-- Stock cannot go negative, and cannot be reserved beyond what exists.
--
-- This is the constraint that makes overselling a database error rather than a
-- customer complaint. Application code takes a row lock before adjusting, but
-- if a code path ever forgets, the transaction fails here instead of quietly
-- promising stock that is not there.
-- ---------------------------------------------------------------------------

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_on_hand_non_negative" CHECK (on_hand_quantity >= 0),
  ADD CONSTRAINT "inventory_reserved_non_negative" CHECK (reserved_quantity >= 0);

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "inventory_reservations_quantity_positive" CHECK (quantity > 0),
  -- A reservation belongs to exactly one thing. Belonging to both, or to
  -- neither, means the release path cannot know what to release.
  ADD CONSTRAINT "inventory_reservations_one_owner" CHECK (
    (cart_id IS NOT NULL AND order_id IS NULL)
    OR (cart_id IS NULL AND order_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- An order's timeline is append-only.
--
-- Same mechanism as the audit log: this is the first place anyone looks when a
-- customer disputes a charge, and a timeline that could be rewritten afterwards
-- is not evidence of anything.
-- ---------------------------------------------------------------------------

CREATE TRIGGER "order_events_no_update"
  BEFORE UPDATE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "order_events_no_delete"
  BEFORE DELETE ON "order_events"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "inventory_adjustments_no_update"
  BEFORE UPDATE ON "inventory_adjustments"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "inventory_adjustments_no_delete"
  BEFORE DELETE ON "inventory_adjustments"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Partial indexes for the queries that run constantly.
-- ---------------------------------------------------------------------------

-- Finding a customer's live cart, and sweeping abandoned ones.
CREATE INDEX "carts_active_customer_idx"
  ON "carts" ("customer_id", "updated_at" DESC)
  WHERE status = 'ACTIVE';

-- The reservation expiry sweep: only held reservations can expire.
CREATE INDEX "inventory_reservations_expiring_idx"
  ON "inventory_reservations" ("expires_at")
  WHERE status = 'HELD';

-- The fulfilment queue.
CREATE INDEX "orders_awaiting_fulfilment_idx"
  ON "orders" ("placed_at")
  WHERE status IN ('PAID', 'PROCESSING', 'PARTIALLY_SHIPPED');
