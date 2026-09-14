-- Phase 4: compliance — claims, evidence, documents, lots and recalls.
--
-- Four statements Prisma generated were removed from this file by hand, and it
-- matters that they stay removed:
--
--   DROP INDEX "ingredients_name_trgm_idx";
--   DROP INDEX "products_name_trgm_idx";
--   DROP INDEX "products_search_vector_idx";
--   ALTER TABLE "products" ALTER COLUMN "search_vector" DROP DEFAULT;
--
-- Prisma cannot express a GIN index with gin_trgm_ops, nor the expression
-- behind a stored generated column, so every diff against this schema proposes
-- destroying all four. Applying them would silently delete catalogue search.
-- See scripts/check-schema-drift.mjs, which accounts for exactly these
-- constructs, and the same note on the Phase 3 migration.

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('STRUCTURE_FUNCTION', 'NUTRIENT_CONTENT', 'HEALTH_CLAIM', 'DISEASE', 'GENERAL');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ClaimDecision" AS ENUM ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('SYSTEMATIC_REVIEW', 'META_ANALYSIS', 'RANDOMISED_CONTROLLED_TRIAL', 'OBSERVATIONAL_STUDY', 'IN_VITRO', 'ANIMAL_STUDY', 'MANUFACTURER_DATA', 'REGULATORY_GUIDANCE', 'MONOGRAPH', 'OTHER');

-- CreateEnum
CREATE TYPE "EvidenceStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EvidenceRelevance" AS ENUM ('DIRECT', 'INDIRECT', 'BACKGROUND', 'CONTRADICTORY');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('CERTIFICATE_OF_ANALYSIS', 'GMP_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT', 'ALLERGEN_STATEMENT', 'SAFETY_DATA_SHEET', 'SUPPLIER_QUALIFICATION', 'HEAVY_METALS_REPORT', 'MICROBIOLOGY_REPORT', 'STABILITY_STUDY', 'LABEL_ARTWORK', 'REGULATORY_CORRESPONDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('AVAILABLE', 'QUARANTINED', 'RECALLED', 'EXPIRED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "RecallClassification" AS ENUM ('CLASS_I', 'CLASS_II', 'CLASS_III', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('DRAFT', 'OPEN', 'NOTIFICATION_APPROVED', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "inventory_reservations" ADD COLUMN     "batch_id" UUID;

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "lot_tracked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "product_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "type" "ClaimType" NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version_id" UUID,
    "approved_version_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "approved_at" TIMESTAMPTZ(6),
    "review_due_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_claim_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "claim_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "context" TEXT,
    "change_reason" TEXT,
    "author_id" UUID,
    "author_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_claim_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "claim_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "decision" "ClaimDecision" NOT NULL,
    "notes" TEXT NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "reviewer_label" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_due_at" TIMESTAMPTZ(6),
    "evidence_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_type" "EvidenceSourceType" NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "identifier" TEXT,
    "published_year" INTEGER,
    "population" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "limitations" TEXT NOT NULL,
    "media_id" UUID,
    "added_by_id" UUID,
    "added_by_label" TEXT NOT NULL,
    "reviewed_by_id" UUID,
    "reviewed_by_label" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "claim_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "relevance" "EvidenceRelevance" NOT NULL,
    "notes" TEXT,
    "linked_by_id" UUID,
    "linked_by_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID,
    "batch_id" UUID,
    "type" "DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT,
    "reference" TEXT,
    "issued_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "media_id" UUID NOT NULL,
    "notes" TEXT,
    "supersedes_id" UUID,
    "uploaded_by_id" UUID,
    "uploaded_by_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "inventory_item_id" UUID NOT NULL,
    "lot_code" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'AVAILABLE',
    "manufactured_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "quantity_reserved" INTEGER NOT NULL DEFAULT 0,
    "supplier" TEXT,
    "supplier_reference" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "BatchStatus",
    "to_status" "BatchStatus",
    "quantity_delta" INTEGER,
    "reason" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_label" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recalls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'DRAFT',
    "classification" "RecallClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "hazard" TEXT,
    "regulator_notified_at" TIMESTAMPTZ(6),
    "regulator_reference" TEXT,
    "opened_by_id" UUID,
    "opened_by_label" TEXT,
    "opened_at" TIMESTAMPTZ(6),
    "notification_approved_by_id" UUID,
    "notification_approved_by_label" TEXT,
    "notification_approved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_lots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recall_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "previous_status" "BatchStatus" NOT NULL,
    "quantity_at_recall" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recall_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recall_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "actor_id" UUID,
    "actor_label" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recall_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_claims_current_version_id_key" ON "product_claims"("current_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_claims_approved_version_id_key" ON "product_claims"("approved_version_id");

-- CreateIndex
CREATE INDEX "product_claims_product_id_status_idx" ON "product_claims"("product_id", "status");

-- CreateIndex
CREATE INDEX "product_claims_status_review_due_at_idx" ON "product_claims"("status", "review_due_at");

-- CreateIndex
CREATE INDEX "product_claim_versions_claim_id_created_at_idx" ON "product_claim_versions"("claim_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_claim_versions_claim_id_version_key" ON "product_claim_versions"("claim_id", "version");

-- CreateIndex
CREATE INDEX "claim_reviews_claim_id_decided_at_idx" ON "claim_reviews"("claim_id", "decided_at");

-- CreateIndex
CREATE INDEX "claim_reviews_decision_decided_at_idx" ON "claim_reviews"("decision", "decided_at");

-- CreateIndex
CREATE INDEX "evidence_records_status_created_at_idx" ON "evidence_records"("status", "created_at");

-- CreateIndex
CREATE INDEX "evidence_records_source_type_idx" ON "evidence_records"("source_type");

-- CreateIndex
CREATE INDEX "claim_evidence_evidence_id_idx" ON "claim_evidence"("evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_evidence_claim_id_evidence_id_key" ON "claim_evidence"("claim_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_documents_supersedes_id_key" ON "product_documents"("supersedes_id");

-- CreateIndex
CREATE INDEX "product_documents_product_id_type_idx" ON "product_documents"("product_id", "type");

-- CreateIndex
CREATE INDEX "product_documents_batch_id_type_idx" ON "product_documents"("batch_id", "type");

-- CreateIndex
CREATE INDEX "product_documents_expires_at_idx" ON "product_documents"("expires_at");

-- CreateIndex
CREATE INDEX "inventory_batches_inventory_item_id_status_expires_at_idx" ON "inventory_batches"("inventory_item_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "inventory_batches_status_expires_at_idx" ON "inventory_batches"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_batches_inventory_item_id_lot_code_key" ON "inventory_batches"("inventory_item_id", "lot_code");

-- CreateIndex
CREATE INDEX "batch_events_batch_id_created_at_idx" ON "batch_events"("batch_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "recalls_reference_key" ON "recalls"("reference");

-- CreateIndex
CREATE INDEX "recalls_status_created_at_idx" ON "recalls"("status", "created_at");

-- CreateIndex
CREATE INDEX "recall_lots_batch_id_idx" ON "recall_lots"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_lots_recall_id_batch_id_key" ON "recall_lots"("recall_id", "batch_id");

-- CreateIndex
CREATE INDEX "recall_actions_recall_id_created_at_idx" ON "recall_actions"("recall_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_reservations_batch_id_idx" ON "inventory_reservations"("batch_id");

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "inventory_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_claims" ADD CONSTRAINT "product_claims_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_claims" ADD CONSTRAINT "product_claims_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "product_claim_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_claims" ADD CONSTRAINT "product_claims_approved_version_id_fkey" FOREIGN KEY ("approved_version_id") REFERENCES "product_claim_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_claim_versions" ADD CONSTRAINT "product_claim_versions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "product_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "product_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "product_claim_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "product_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "inventory_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "product_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_events" ADD CONSTRAINT "batch_events_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "inventory_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_lots" ADD CONSTRAINT "recall_lots_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "recalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_lots" ADD CONSTRAINT "recall_lots_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "inventory_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_actions" ADD CONSTRAINT "recall_actions_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "recalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

