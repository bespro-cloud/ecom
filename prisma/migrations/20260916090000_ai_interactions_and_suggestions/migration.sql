-- Phase 7: AI — interactions and suggestions.
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
-- scripts/check-schema-drift.mjs and the same note on the Phase 3-6 migrations.

-- CreateEnum
CREATE TYPE "AiOutcomeValue" AS ENUM ('COMPLETED', 'BLOCKED', 'NO_GROUNDING', 'REFUSED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiSuggestionStatusValue" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'BLOCKED');

-- CreateTable
CREATE TABLE "ai_interactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "purpose" TEXT NOT NULL,
    "outcome" "AiOutcomeValue" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "is_real_model" BOOLEAN NOT NULL DEFAULT false,
    "system_prompt" TEXT NOT NULL,
    "user_prompt" TEXT NOT NULL,
    "was_redacted" BOOLEAN NOT NULL DEFAULT false,
    "response_text" TEXT,
    "retrieved_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "guardrail_findings" JSONB,
    "blocked_reason" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "actor_id" UUID NOT NULL,
    "actor_label" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "interaction_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "AiSuggestionStatusValue" NOT NULL DEFAULT 'PENDING',
    "target_type" TEXT,
    "target_id" UUID,
    "content" JSONB NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_by_label" TEXT NOT NULL,
    "decided_by_id" UUID,
    "decided_by_label" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_interactions_day_actor_id_idx" ON "ai_interactions"("day", "actor_id");

-- CreateIndex
CREATE INDEX "ai_interactions_purpose_created_at_idx" ON "ai_interactions"("purpose", "created_at");

-- CreateIndex
CREATE INDEX "ai_interactions_outcome_created_at_idx" ON "ai_interactions"("outcome", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_suggestions_interaction_id_key" ON "ai_suggestions"("interaction_id");

-- CreateIndex
CREATE INDEX "ai_suggestions_status_created_at_idx" ON "ai_suggestions"("status", "created_at");

-- CreateIndex
CREATE INDEX "ai_suggestions_requested_by_id_created_at_idx" ON "ai_suggestions"("requested_by_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "ai_interactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
