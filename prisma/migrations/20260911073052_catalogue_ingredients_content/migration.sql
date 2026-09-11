-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SUPPLEMENT', 'COSMETIC', 'FOOD', 'DEVICE', 'WELLNESS', 'ACCESSORY');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'READY', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('NOT_REVIEWED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProductImageRole" AS ENUM ('HERO', 'GALLERY', 'LABEL', 'FACTS_PANEL', 'CERTIFICATE');

-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'ENUM');

-- CreateEnum
CREATE TYPE "IngredientSourceType" AS ENUM ('PLANT', 'ANIMAL', 'MINERAL', 'SYNTHETIC', 'FERMENTATION', 'MICROBIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "WarningSeverity" AS ENUM ('INFORMATION', 'CAUTION', 'WARNING');

-- CreateEnum
CREATE TYPE "WarningAudience" AS ENUM ('GENERAL', 'PREGNANCY', 'NURSING', 'CHILDREN', 'MEDICATION_INTERACTION', 'ALLERGY', 'MEDICAL_CONDITION');

-- CreateEnum
CREATE TYPE "DisclaimerKind" AS ENUM ('DSHEA', 'GENERAL_HEALTH', 'ALLERGEN', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplianceDecision" AS ENUM ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SeoEntityType" AS ENUM ('PRODUCT', 'CATEGORY', 'PAGE', 'INGREDIENT');

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "MediaKind" NOT NULL DEFAULT 'IMAGE',
    "storage_key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "original_filename" TEXT,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sku" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_description" TEXT,
    "long_description" TEXT,
    "type" "ProductType" NOT NULL,
    "brand" TEXT,
    "manufacturer" TEXT,
    "country_of_origin" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "compliance_status" "ComplianceStatus" NOT NULL DEFAULT 'NOT_REVIEWED',
    "compliance_approved_at" TIMESTAMPTZ(6),
    "compliance_approved_by" UUID,
    "compliance_review_due_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "price_cents" INTEGER NOT NULL,
    "compare_at_price_cents" INTEGER,
    "cost_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "tax_code" TEXT,
    "weight_grams" INTEGER,
    "length_mm" INTEGER,
    "width_mm" INTEGER,
    "height_mm" INTEGER,
    "requires_shipping" BOOLEAN NOT NULL DEFAULT true,
    "subscription_eligible" BOOLEAN NOT NULL DEFAULT false,
    "search_keywords" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "barcode" TEXT,
    "price_cents" INTEGER,
    "compare_at_price_cents" INTEGER,
    "cost_cents" INTEGER,
    "weight_grams" INTEGER,
    "options" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "media_id" UUID NOT NULL,
    "role" "ProductImageRole" NOT NULL DEFAULT 'GALLERY',
    "alt_text" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "parent_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "depth" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "product_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("product_id","category_id")
);

-- CreateTable
CREATE TABLE "product_attributes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "AttributeType" NOT NULL DEFAULT 'TEXT',
    "unit" TEXT,
    "is_filterable" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "allowed_values" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attribute_values" (
    "product_id" UUID NOT NULL,
    "attribute_id" UUID NOT NULL,
    "value" TEXT NOT NULL,
    "numeric_value" DECIMAL(14,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_attribute_values_pkey" PRIMARY KEY ("product_id","attribute_id")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scientific_name" TEXT,
    "common_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "cas_number" TEXT,
    "allergen" TEXT,
    "is_allergen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ingredient_id" UUID NOT NULL,
    "type" "IngredientSourceType" NOT NULL,
    "description" TEXT,
    "origin_country" TEXT,
    "supplier" TEXT,
    "is_vegan" BOOLEAN NOT NULL DEFAULT false,
    "is_vegetarian" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingredient_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredient_warnings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ingredient_id" UUID NOT NULL,
    "severity" "WarningSeverity" NOT NULL DEFAULT 'CAUTION',
    "audience" "WarningAudience" NOT NULL DEFAULT 'GENERAL',
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingredient_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_ingredients" (
    "product_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "amount" DECIMAL(14,4),
    "unit" TEXT,
    "daily_value_percent" DECIMAL(6,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_ingredients_pkey" PRIMARY KEY ("product_id","ingredient_id")
);

-- CreateTable
CREATE TABLE "product_warnings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "severity" "WarningSeverity" NOT NULL DEFAULT 'WARNING',
    "audience" "WarningAudience" NOT NULL DEFAULT 'GENERAL',
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_disclaimers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "kind" "DisclaimerKind" NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_disclaimers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "decision" "ComplianceDecision" NOT NULL,
    "notes" TEXT NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "reviewer_label" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_due_at" TIMESTAMPTZ(6),
    "checklist_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "PageStatus" NOT NULL DEFAULT 'DRAFT',
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "draft_blocks" JSONB,
    "draft_title" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "last_edited_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_metadata" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" "SeoEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "canonical_url" TEXT,
    "og_title" TEXT,
    "og_description" TEXT,
    "og_image_media_id" UUID,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seo_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_storage_key_key" ON "media"("storage_key");

-- CreateIndex
CREATE INDEX "media_checksum_idx" ON "media"("checksum");

-- CreateIndex
CREATE INDEX "media_kind_created_at_idx" ON "media"("kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_status_published_at_idx" ON "products"("status", "published_at");

-- CreateIndex
CREATE INDEX "products_type_status_idx" ON "products"("type", "status");

-- CreateIndex
CREATE INDEX "products_compliance_status_idx" ON "products"("compliance_status");

-- CreateIndex
CREATE INDEX "products_brand_idx" ON "products"("brand");

-- CreateIndex
CREATE INDEX "products_created_at_idx" ON "products"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "product_variants_product_id_position_idx" ON "product_variants"("product_id", "position");

-- CreateIndex
CREATE INDEX "product_images_product_id_position_idx" ON "product_images"("product_id", "position");

-- CreateIndex
CREATE INDEX "product_images_variant_id_idx" ON "product_images"("variant_id");

-- CreateIndex
CREATE INDEX "product_images_media_id_idx" ON "product_images"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_parent_id_position_idx" ON "categories"("parent_id", "position");

-- CreateIndex
CREATE INDEX "categories_is_active_idx" ON "categories"("is_active");

-- CreateIndex
CREATE INDEX "product_categories_category_id_position_idx" ON "product_categories"("category_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_attributes_key_key" ON "product_attributes"("key");

-- CreateIndex
CREATE INDEX "product_attribute_values_attribute_id_value_idx" ON "product_attribute_values"("attribute_id", "value");

-- CreateIndex
CREATE INDEX "product_attribute_values_attribute_id_numeric_value_idx" ON "product_attribute_values"("attribute_id", "numeric_value");

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_slug_key" ON "ingredients"("slug");

-- CreateIndex
CREATE INDEX "ingredients_is_allergen_idx" ON "ingredients"("is_allergen");

-- CreateIndex
CREATE INDEX "ingredients_name_idx" ON "ingredients"("name");

-- CreateIndex
CREATE INDEX "ingredient_sources_ingredient_id_idx" ON "ingredient_sources"("ingredient_id");

-- CreateIndex
CREATE INDEX "ingredient_warnings_ingredient_id_severity_idx" ON "ingredient_warnings"("ingredient_id", "severity");

-- CreateIndex
CREATE INDEX "product_ingredients_ingredient_id_idx" ON "product_ingredients"("ingredient_id");

-- CreateIndex
CREATE INDEX "product_warnings_product_id_position_idx" ON "product_warnings"("product_id", "position");

-- CreateIndex
CREATE INDEX "product_disclaimers_product_id_position_idx" ON "product_disclaimers"("product_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_disclaimers_product_id_kind_key" ON "product_disclaimers"("product_id", "kind");

-- CreateIndex
CREATE INDEX "compliance_reviews_product_id_decided_at_idx" ON "compliance_reviews"("product_id", "decided_at");

-- CreateIndex
CREATE INDEX "compliance_reviews_decision_decided_at_idx" ON "compliance_reviews"("decision", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "pages_slug_key" ON "pages"("slug");

-- CreateIndex
CREATE INDEX "pages_status_published_at_idx" ON "pages"("status", "published_at");

-- CreateIndex
CREATE INDEX "seo_metadata_og_image_media_id_idx" ON "seo_metadata"("og_image_media_id");

-- CreateIndex
CREATE UNIQUE INDEX "seo_metadata_entity_type_entity_id_key" ON "seo_metadata"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_values" ADD CONSTRAINT "product_attribute_values_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_sources" ADD CONSTRAINT "ingredient_sources_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredient_warnings" ADD CONSTRAINT "ingredient_warnings_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_warnings" ADD CONSTRAINT "product_warnings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_disclaimers" ADD CONSTRAINT "product_disclaimers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_reviews" ADD CONSTRAINT "compliance_reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seo_metadata" ADD CONSTRAINT "seo_metadata_og_image_media_id_fkey" FOREIGN KEY ("og_image_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
