-- Phase 6: growth — first-party analytics, the blog, and redirects.
--
-- The same four statements Prisma always generates against this schema were
-- removed by hand, and must stay removed:
--
--   DROP INDEX "ingredients_name_trgm_idx";
--   DROP INDEX "products_name_trgm_idx";
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "search_vector" DROP DEFAULT;
--
-- Prisma cannot express a GIN index with gin_trgm_ops, nor the expression
-- behind a stored generated column, so every diff proposes destroying all four.
-- Applying them would silently delete catalogue search. See
-- scripts/check-schema-drift.mjs and the same note on the Phase 3, 4 and 5
-- migrations.

-- CreateEnum
CREATE TYPE "FunnelStepValue" AS ENUM ('VISITED', 'VIEWED_PRODUCT', 'ADDED_TO_CART', 'STARTED_CHECKOUT', 'ORDERED');

-- CreateEnum
CREATE TYPE "BlogPostStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BlogReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "checkouts" ADD COLUMN     "attribution_campaign" TEXT,
ADD COLUMN     "attribution_channel" TEXT,
ADD COLUMN     "attribution_medium" TEXT,
ADD COLUMN     "attribution_source" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "attribution_campaign" TEXT,
ADD COLUMN     "attribution_channel" TEXT,
ADD COLUMN     "attribution_medium" TEXT,
ADD COLUMN     "attribution_source" TEXT;

-- CreateTable
CREATE TABLE "analytics_salts" (
    "day" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_salts_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "analytics_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "public_id" TEXT NOT NULL,
    "visitor_hash" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'direct',
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "referrer_host" TEXT,
    "landing_path" TEXT,
    "device_type" TEXT,
    "country" TEXT,
    "furthest_step" "FunnelStepValue" NOT NULL DEFAULT 'VISITED',
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "product_id" UUID,
    "quantity" INTEGER,
    "day" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_daily_metrics" (
    "day" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "unique_visitors" INTEGER NOT NULL DEFAULT 0,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    "product_views" INTEGER NOT NULL DEFAULT 0,
    "add_to_carts" INTEGER NOT NULL DEFAULT 0,
    "checkouts_started" INTEGER NOT NULL DEFAULT 0,
    "reached_viewed_product" INTEGER NOT NULL DEFAULT 0,
    "reached_added_to_cart" INTEGER NOT NULL DEFAULT 0,
    "reached_started_checkout" INTEGER NOT NULL DEFAULT 0,
    "reached_ordered" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_daily_metrics_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "analytics_product_daily" (
    "day" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "add_to_carts" INTEGER NOT NULL DEFAULT 0,
    "units_ordered" INTEGER NOT NULL DEFAULT 0,
    "revenue_cents" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_product_daily_pkey" PRIMARY KEY ("day","product_id")
);

-- CreateTable
CREATE TABLE "analytics_channel_daily" (
    "day" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "revenue_cents" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_channel_daily_pkey" PRIMARY KEY ("day","channel")
);

-- CreateTable
CREATE TABLE "blog_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "blog_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "BlogPostStatus" NOT NULL DEFAULT 'DRAFT',
    "excerpt" TEXT,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "draft_blocks" JSONB,
    "draft_title" TEXT,
    "draft_excerpt" TEXT,
    "category_id" UUID,
    "author_id" UUID NOT NULL,
    "author_name" TEXT NOT NULL,
    "hero_media_id" UUID,
    "product_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "compliance_approved_by_id" UUID,
    "compliance_approved_by_label" TEXT,
    "compliance_approved_at" TIMESTAMPTZ(6),
    "compliance_notes" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "last_edited_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_post_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "post_id" UUID NOT NULL,
    "decision" "BlogReviewDecision" NOT NULL,
    "notes" TEXT NOT NULL,
    "reviewed_title" TEXT NOT NULL,
    "reviewed_blocks" JSONB NOT NULL,
    "reviewed_product_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "reviewer_id" UUID NOT NULL,
    "reviewer_label" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blog_post_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "redirects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "from_path" TEXT NOT NULL,
    "to_path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL DEFAULT 301,
    "is_automatic" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "created_by_id" UUID,
    "created_by_label" TEXT,
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "last_hit_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analytics_sessions_public_id_key" ON "analytics_sessions"("public_id");

-- CreateIndex
CREATE INDEX "analytics_sessions_day_channel_idx" ON "analytics_sessions"("day", "channel");

-- CreateIndex
CREATE INDEX "analytics_sessions_day_furthest_step_idx" ON "analytics_sessions"("day", "furthest_step");

-- CreateIndex
CREATE INDEX "analytics_sessions_day_visitor_hash_idx" ON "analytics_sessions"("day", "visitor_hash");

-- CreateIndex
CREATE INDEX "analytics_sessions_last_seen_at_idx" ON "analytics_sessions"("last_seen_at");

-- CreateIndex
CREATE INDEX "analytics_events_day_type_idx" ON "analytics_events"("day", "type");

-- CreateIndex
CREATE INDEX "analytics_events_session_id_occurred_at_idx" ON "analytics_events"("session_id", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_product_id_day_idx" ON "analytics_events"("product_id", "day");

-- CreateIndex
CREATE INDEX "analytics_events_occurred_at_idx" ON "analytics_events"("occurred_at");

-- CreateIndex
CREATE INDEX "analytics_product_daily_day_views_idx" ON "analytics_product_daily"("day", "views");

-- CreateIndex
CREATE UNIQUE INDEX "blog_categories_slug_key" ON "blog_categories"("slug");

-- CreateIndex
CREATE INDEX "blog_posts_status_published_at_idx" ON "blog_posts"("status", "published_at");

-- CreateIndex
CREATE INDEX "blog_posts_category_id_published_at_idx" ON "blog_posts"("category_id", "published_at");

-- CreateIndex
CREATE INDEX "blog_post_reviews_post_id_decided_at_idx" ON "blog_post_reviews"("post_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "redirects_from_path_key" ON "redirects"("from_path");

-- CreateIndex
CREATE INDEX "redirects_is_active_from_path_idx" ON "redirects"("is_active", "from_path");

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "analytics_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_product_daily" ADD CONSTRAINT "analytics_product_daily_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "blog_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_hero_media_id_fkey" FOREIGN KEY ("hero_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_post_reviews" ADD CONSTRAINT "blog_post_reviews_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
