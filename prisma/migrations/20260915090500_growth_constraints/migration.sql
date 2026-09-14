-- Phase 6 constraints.
--
-- The application enforces all of this. So does the database, independently,
-- because the privacy properties of the analytics tables are the kind that get
-- eroded by a well-meant migration two years from now — and a CHECK that
-- refuses is a better guard than a comment that asks.

-- ---------------------------------------------------------------------------
-- Blog: one live post per slug
-- ---------------------------------------------------------------------------

-- Partial, so a soft-deleted post frees its slug for reuse while its own row
-- stays readable. The same pattern as pages and products.
CREATE UNIQUE INDEX "blog_posts_slug_live_key"
  ON "blog_posts" ("slug")
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Analytics: the event taxonomy is closed
-- ---------------------------------------------------------------------------

-- An allow-list in the database as well as the application. A future code path
-- that invents an event type is refused rather than quietly creating a new
-- category of stored behaviour nobody reviewed.
ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_event_type_is_declared"
  CHECK ("type" IN (
    'page_view',
    'product_view',
    'search_performed',
    'add_to_cart',
    'remove_from_cart',
    'checkout_started',
    'order_placed'
  ));

-- A path, not a URL, and never a query string. Both halves matter: '?' would
-- mean somebody stored the query, and a path not starting with '/' would mean
-- somebody stored an absolute URL to another site as though it were ours.
ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_event_path_is_a_path"
  CHECK ("path" LIKE '/%' AND "path" NOT LIKE '%?%' AND "path" NOT LIKE '%#%');

ALTER TABLE "analytics_sessions"
  ADD CONSTRAINT "analytics_session_landing_is_a_path"
  CHECK (
    "landing_path" IS NULL
    OR ("landing_path" LIKE '/%' AND "landing_path" NOT LIKE '%?%')
  );

-- A referrer is a HOST. A '/' in this column means somebody stored a path on
-- somebody else's site, which carries their search terms.
ALTER TABLE "analytics_sessions"
  ADD CONSTRAINT "analytics_session_referrer_is_a_host"
  CHECK ("referrer_host" IS NULL OR "referrer_host" NOT LIKE '%/%');

-- Country, never a city. A city on a health site is a small crowd.
ALTER TABLE "analytics_sessions"
  ADD CONSTRAINT "analytics_session_country_is_iso2"
  CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');

ALTER TABLE "analytics_sessions"
  ADD CONSTRAINT "analytics_session_device_is_coarse"
  CHECK ("device_type" IS NULL OR "device_type" IN ('mobile', 'tablet', 'desktop'));

-- Days are YYYY-MM-DD so rollups, retention and the salt rotation cannot
-- disagree about which day a row belongs to.
ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_event_day_format"
  CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');

ALTER TABLE "analytics_sessions"
  ADD CONSTRAINT "analytics_session_day_format"
  CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');

ALTER TABLE "analytics_salts"
  ADD CONSTRAINT "analytics_salt_day_format"
  CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$');

-- Counts are counts.
ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_event_quantity_positive"
  CHECK ("quantity" IS NULL OR "quantity" > 0);

ALTER TABLE "analytics_sessions"
  ADD CONSTRAINT "analytics_session_event_count_not_negative"
  CHECK ("event_count" >= 0);

-- ---------------------------------------------------------------------------
-- Analytics: no identity, enforced rather than asked for
-- ---------------------------------------------------------------------------

-- The privacy guarantee this whole subsystem rests on, as a database rule.
--
-- If a future migration adds a customer_id, user_id, email, order_id or
-- ip_address column to any analytics table, this trigger makes the migration
-- fail rather than letting a per-person browsing profile quietly become
-- possible. The comment above the tables explains the intent; this makes the
-- intent enforceable.
CREATE OR REPLACE FUNCTION reject_identifying_analytics_columns() RETURNS event_trigger AS $$
DECLARE
  offending record;
BEGIN
  FOR offending IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.table_name IN (
        'analytics_events',
        'analytics_sessions',
        'analytics_daily_metrics',
        'analytics_product_daily',
        'analytics_channel_daily'
      )
      AND c.column_name IN (
        'customer_id',
        'user_id',
        'email',
        'order_id',
        'ip_address',
        'ip',
        'customer_reference'
      )
  LOOP
    RAISE EXCEPTION
      'Column %.% would make analytics identifying. Analytics tables carry no identity by design; see the Phase 6 notes in prisma/schema.prisma.',
      offending.table_name, offending.column_name;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

DROP EVENT TRIGGER IF EXISTS analytics_stays_anonymous;
CREATE EVENT TRIGGER analytics_stays_anonymous
  ON ddl_command_end
  WHEN TAG IN ('ALTER TABLE', 'CREATE TABLE')
  EXECUTE FUNCTION reject_identifying_analytics_columns();

-- ---------------------------------------------------------------------------
-- Analytics: rollups are non-negative, and the funnel is cumulative
-- ---------------------------------------------------------------------------

ALTER TABLE "analytics_daily_metrics"
  ADD CONSTRAINT "analytics_daily_counts_not_negative"
  CHECK (
    "sessions" >= 0
    AND "unique_visitors" >= 0
    AND "page_views" >= 0
    AND "product_views" >= 0
    AND "add_to_carts" >= 0
    AND "checkouts_started" >= 0
    AND "reached_viewed_product" >= 0
    AND "reached_added_to_cart" >= 0
    AND "reached_started_checkout" >= 0
    AND "reached_ordered" >= 0
  );

-- A funnel that widens as it descends is a bug in the rollup, not a surprising
-- customer behaviour. Refusing it here means a broken rollup fails loudly
-- instead of producing a conversion rate above 100% on a dashboard.
ALTER TABLE "analytics_daily_metrics"
  ADD CONSTRAINT "analytics_daily_funnel_is_cumulative"
  CHECK (
    "reached_ordered" <= "reached_started_checkout"
    AND "reached_started_checkout" <= "reached_added_to_cart"
    AND "reached_added_to_cart" <= "reached_viewed_product"
    AND "reached_viewed_product" <= "sessions"
    AND "unique_visitors" <= "sessions"
  );

ALTER TABLE "analytics_product_daily"
  ADD CONSTRAINT "analytics_product_daily_not_negative"
  CHECK ("views" >= 0 AND "add_to_carts" >= 0 AND "units_ordered" >= 0 AND "revenue_cents" >= 0);

ALTER TABLE "analytics_channel_daily"
  ADD CONSTRAINT "analytics_channel_daily_not_negative"
  CHECK ("sessions" >= 0 AND "orders" >= 0 AND "revenue_cents" >= 0);

-- ---------------------------------------------------------------------------
-- Blog: a post that names a product cannot be published unreviewed
-- ---------------------------------------------------------------------------

-- The gate, in the database.
--
-- A post referencing a product is marketing copy about a regulated product. The
-- application refuses to publish one without compliance sign-off; this refuses
-- it too, so a direct UPDATE, a data fix or a future code path cannot put
-- unreviewed product claims on a public page.
ALTER TABLE "blog_posts"
  ADD CONSTRAINT "blog_post_with_products_needs_compliance"
  CHECK (
    "status" <> 'PUBLISHED'
    OR cardinality("product_ids") = 0
    OR ("compliance_approved_at" IS NOT NULL AND "compliance_approved_by_id" IS NOT NULL)
  );

-- An approval is attributed or it is not an approval.
ALTER TABLE "blog_posts"
  ADD CONSTRAINT "blog_post_approval_is_attributed"
  CHECK (
    ("compliance_approved_at" IS NULL AND "compliance_approved_by_id" IS NULL)
    OR ("compliance_approved_at" IS NOT NULL
        AND "compliance_approved_by_id" IS NOT NULL
        AND "compliance_approved_by_label" IS NOT NULL)
  );

ALTER TABLE "blog_posts"
  ADD CONSTRAINT "blog_post_published_has_timestamp"
  CHECK ("status" <> 'PUBLISHED' OR "published_at" IS NOT NULL);

-- Reasoning is required on either outcome. An approval with no reasoning is not
-- a review, and "why is this live?" is the question that gets asked later.
ALTER TABLE "blog_post_reviews"
  ADD CONSTRAINT "blog_post_review_has_reasoning"
  CHECK (length(btrim("notes")) >= 10);

-- ---------------------------------------------------------------------------
-- Blog compliance decisions are append-only
-- ---------------------------------------------------------------------------

CREATE TRIGGER blog_post_reviews_no_update
  BEFORE UPDATE ON "blog_post_reviews"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER blog_post_reviews_no_delete
  BEFORE DELETE ON "blog_post_reviews"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Redirects
-- ---------------------------------------------------------------------------

ALTER TABLE "redirects"
  ADD CONSTRAINT "redirect_paths_are_paths"
  CHECK (
    "from_path" LIKE '/%'
    AND "from_path" NOT LIKE '%?%'
    AND ("to_path" LIKE '/%' OR "to_path" LIKE 'https://%')
  );

-- A redirect to itself is an infinite loop the moment it is served.
ALTER TABLE "redirects"
  ADD CONSTRAINT "redirect_is_not_a_self_loop"
  CHECK ("from_path" <> "to_path");

ALTER TABLE "redirects"
  ADD CONSTRAINT "redirect_status_is_a_redirect"
  CHECK ("status_code" IN (301, 302, 307, 308));

ALTER TABLE "redirects"
  ADD CONSTRAINT "redirect_hit_count_not_negative"
  CHECK ("hit_count" >= 0);
