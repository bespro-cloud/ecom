-- Catalogue search, plus the constraints the application relies on but cannot
-- itself guarantee under concurrency.

-- ---------------------------------------------------------------------------
-- Full-text search
-- ---------------------------------------------------------------------------
--
-- A stored generated column rather than an application-maintained tsvector:
-- PostgreSQL keeps it correct on every write, so a code path that forgets to
-- reindex cannot leave a product unsearchable.
--
-- Weights: A for the name and SKU (what people actually type), B for brand and
-- the denormalised keywords (ingredient and category names), C for the short
-- description. `search_keywords` is maintained by the application in the same
-- transaction as the relationships it summarises — a generated column cannot
-- read another table.
ALTER TABLE "products"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("sku", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("brand", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("search_keywords", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("short_description", '')), 'C')
  ) STORED;

CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("search_vector");

-- Trigram index for typo tolerance and substring matching, which full-text
-- search does not provide: "magnesim" and "magnes" both need to find magnesium.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "products_name_trgm_idx" ON "products" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "ingredients_name_trgm_idx" ON "ingredients" USING GIN ("name" gin_trgm_ops);

-- The storefront's hot path: published, not-deleted products ordered by
-- publication date. A partial index keeps it small — drafts and archived rows
-- are the majority over time and are never shown publicly.
CREATE INDEX "products_public_listing_idx"
  ON "products" ("published_at" DESC, "id" DESC)
  WHERE "status" = 'PUBLISHED' AND "deleted_at" IS NULL;

CREATE INDEX "products_public_price_idx"
  ON "products" ("price_cents")
  WHERE "status" = 'PUBLISHED' AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Compliance reviews are append-only
-- ---------------------------------------------------------------------------
--
-- Same reasoning as the audit log: a compliance decision that could have been
-- edited afterwards is not evidence of anything. `reject_mutation()` is defined
-- in the audit_log_append_only migration.
CREATE TRIGGER compliance_reviews_no_update
  BEFORE UPDATE ON "compliance_reviews"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER compliance_reviews_no_delete
  BEFORE DELETE ON "compliance_reviews"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Uniqueness that must hold under concurrency
-- ---------------------------------------------------------------------------

-- At most one primary category per product. Two simultaneous requests could
-- both pass an application-level check; a partial unique index cannot.
CREATE UNIQUE INDEX "product_categories_one_primary"
  ON "product_categories" ("product_id")
  WHERE "is_primary" = true;

-- At most one hero image per product.
CREATE UNIQUE INDEX "product_images_one_hero"
  ON "product_images" ("product_id")
  WHERE "role" = 'HERO';

-- Slugs are recycled after a soft delete, so uniqueness only applies to live
-- rows. The column-level UNIQUE from the Prisma schema is replaced by these.
DROP INDEX IF EXISTS "products_slug_key";
CREATE UNIQUE INDEX "products_slug_active_key"
  ON "products" ("slug") WHERE "deleted_at" IS NULL;

DROP INDEX IF EXISTS "categories_slug_key";
CREATE UNIQUE INDEX "categories_slug_active_key"
  ON "categories" ("slug") WHERE "deleted_at" IS NULL;

DROP INDEX IF EXISTS "ingredients_slug_key";
CREATE UNIQUE INDEX "ingredients_slug_active_key"
  ON "ingredients" ("slug") WHERE "deleted_at" IS NULL;

DROP INDEX IF EXISTS "pages_slug_key";
CREATE UNIQUE INDEX "pages_slug_active_key"
  ON "pages" ("slug") WHERE "deleted_at" IS NULL;

-- SKUs are never recycled: they appear on orders, invoices and 3PL manifests,
-- and reusing one would make historical records ambiguous. The unqualified
-- unique constraint from the schema is therefore left in place.

-- ---------------------------------------------------------------------------
-- Category tree integrity
-- ---------------------------------------------------------------------------
--
-- A category cannot be its own parent. Deeper cycles are prevented by the
-- application maintaining `path`, which this constraint anchors.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_no_self_parent"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- A category must not appear in its own ancestor path.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_not_in_own_path"
  CHECK (NOT ("id"::text = ANY("path")));

-- ---------------------------------------------------------------------------
-- Money and measurement sanity
-- ---------------------------------------------------------------------------
--
-- These are cheap and catch the class of bug where a unit conversion or a
-- parsing slip produces a negative price that then flows into an order total.
ALTER TABLE "products"
  ADD CONSTRAINT "products_price_non_negative" CHECK ("price_cents" >= 0),
  ADD CONSTRAINT "products_compare_at_non_negative"
    CHECK ("compare_at_price_cents" IS NULL OR "compare_at_price_cents" >= 0),
  ADD CONSTRAINT "products_cost_non_negative"
    CHECK ("cost_cents" IS NULL OR "cost_cents" >= 0),
  ADD CONSTRAINT "products_weight_non_negative"
    CHECK ("weight_grams" IS NULL OR "weight_grams" >= 0);

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_price_non_negative"
    CHECK ("price_cents" IS NULL OR "price_cents" >= 0),
  ADD CONSTRAINT "product_variants_cost_non_negative"
    CHECK ("cost_cents" IS NULL OR "cost_cents" >= 0);

ALTER TABLE "media"
  ADD CONSTRAINT "media_size_positive" CHECK ("size_bytes" > 0);

ALTER TABLE "product_attributes"
  ADD CONSTRAINT "product_attributes_enum_has_values"
  CHECK ("type" <> 'ENUM' OR array_length("allowed_values", 1) > 0);
