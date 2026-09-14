-- Phase 5: customer lifecycle — reviews, coupons, subscriptions, support.
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
-- scripts/check-schema-drift.mjs and the same note on the Phase 3 and 4
-- migrations.

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED', 'ESCALATED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ReviewRejectionReason" AS ENUM ('OFF_TOPIC', 'ABUSIVE', 'SPAM', 'PERSONAL_INFORMATION', 'HEALTH_CLAIM', 'ADVERSE_EVENT', 'OTHER');

-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE', 'FREE_SHIPPING');

-- CreateEnum
CREATE TYPE "SubscriptionInterval" AS ENUM ('WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'PAST_DUE', 'UNPAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'AWAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportTopic" AS ENUM ('ORDER', 'DELIVERY', 'RETURN_OR_REFUND', 'PRODUCT_QUESTION', 'SUBSCRIPTION', 'ACCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "ErasureStatus" AS ENUM ('REQUESTED', 'IN_REVIEW', 'COMPLETED', 'REFUSED');

-- AlterTable
ALTER TABLE "checkouts" ADD COLUMN     "coupon_code" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "coupon_code" TEXT,
ADD COLUMN     "subscription_id" UUID;

-- CreateTable
CREATE TABLE "product_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_item_id" UUID,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "author_display_name" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "verified_purchase" BOOLEAN NOT NULL DEFAULT false,
    "claim_prompt_terms" TEXT[],
    "adverse_event_prompt_terms" TEXT[],
    "adverse_event_flagged_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_moderations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_id" UUID NOT NULL,
    "from_status" "ReviewStatus" NOT NULL,
    "to_status" "ReviewStatus" NOT NULL,
    "reason" "ReviewRejectionReason",
    "notes" TEXT NOT NULL,
    "moderator_id" UUID NOT NULL,
    "moderator_label" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_moderations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "CouponType" NOT NULL,
    "amount_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "basis_points" INTEGER,
    "min_subtotal_cents" INTEGER,
    "max_discount_cents" INTEGER,
    "max_redemptions" INTEGER,
    "max_per_customer" INTEGER,
    "redemption_count" INTEGER NOT NULL DEFAULT 0,
    "eligible_product_ids" UUID[],
    "eligible_category_ids" UUID[],
    "requires_customer" BOOLEAN NOT NULL DEFAULT false,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_by_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coupon_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "customer_id" UUID,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_payment_method_id" TEXT NOT NULL,
    "provider_customer_id" TEXT,
    "card_brand" TEXT,
    "card_last4" TEXT,
    "expiry_month" INTEGER,
    "expiry_year" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "detached_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "interval" "SubscriptionInterval" NOT NULL,
    "interval_count" INTEGER NOT NULL DEFAULT 1,
    "anchor_day_of_month" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "shipping_address" JSONB NOT NULL,
    "shipping_method_code" TEXT,
    "payment_method_id" UUID,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "next_billing_at" TIMESTAMPTZ(6),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_failure_at" TIMESTAMPTZ(6),
    "last_failure_code" TEXT,
    "paused_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "actor_id" UUID,
    "actor_label" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "total_cents" INTEGER NOT NULL,
    "order_id" UUID,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "topic" "SupportTopic" NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to_id" UUID,
    "assigned_to_label" TEXT,
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thread_id" UUID NOT NULL,
    "author_type" TEXT NOT NULL,
    "author_id" UUID,
    "author_label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erasure_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "status" "ErasureStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "decided_by_id" UUID,
    "decided_by_label" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "erasure_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_reviews_order_item_id_key" ON "product_reviews"("order_item_id");

-- CreateIndex
CREATE INDEX "product_reviews_product_id_status_created_at_idx" ON "product_reviews"("product_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "product_reviews_customer_id_created_at_idx" ON "product_reviews"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "product_reviews_status_created_at_idx" ON "product_reviews"("status", "created_at");

-- CreateIndex
CREATE INDEX "review_moderations_review_id_decided_at_idx" ON "review_moderations"("review_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_is_active_ends_at_idx" ON "coupons"("is_active", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_order_id_key" ON "coupon_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "coupon_redemptions_coupon_id_created_at_idx" ON "coupon_redemptions"("coupon_id", "created_at");

-- CreateIndex
CREATE INDEX "coupon_redemptions_customer_id_idx" ON "coupon_redemptions"("customer_id");

-- CreateIndex
CREATE INDEX "customer_payment_methods_customer_id_detached_at_idx" ON "customer_payment_methods"("customer_id", "detached_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payment_methods_provider_provider_payment_method_i_key" ON "customer_payment_methods"("provider", "provider_payment_method_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_reference_key" ON "subscriptions"("reference");

-- CreateIndex
CREATE INDEX "subscriptions_status_next_billing_at_idx" ON "subscriptions"("status", "next_billing_at");

-- CreateIndex
CREATE INDEX "subscriptions_customer_id_created_at_idx" ON "subscriptions"("customer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_items_subscription_id_variant_id_key" ON "subscription_items"("subscription_id", "variant_id");

-- CreateIndex
CREATE INDEX "subscription_events_subscription_id_created_at_idx" ON "subscription_events"("subscription_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_order_id_key" ON "subscription_invoices"("order_id");

-- CreateIndex
CREATE INDEX "subscription_invoices_status_created_at_idx" ON "subscription_invoices"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_subscription_id_period_start_key" ON "subscription_invoices"("subscription_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "support_threads_reference_key" ON "support_threads"("reference");

-- CreateIndex
CREATE INDEX "support_threads_status_last_message_at_idx" ON "support_threads"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "support_threads_customer_id_created_at_idx" ON "support_threads"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "support_messages_thread_id_created_at_idx" ON "support_messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "erasure_requests_status_created_at_idx" ON "erasure_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "erasure_requests_customer_id_created_at_idx" ON "erasure_requests"("customer_id", "created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_moderations" ADD CONSTRAINT "review_moderations_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "product_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payment_methods" ADD CONSTRAINT "customer_payment_methods_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "customer_payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "support_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

