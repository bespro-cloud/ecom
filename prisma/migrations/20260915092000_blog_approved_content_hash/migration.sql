-- Bind a blog post's compliance approval to the exact text that was approved.
--
-- The previous rule was "a published post that names a product has an
-- approval". That is necessary and not sufficient: a post could be approved as
-- one article and published as another, which is precisely the failure the
-- review exists to prevent.
--
-- This records a hash of what the reviewer read, and the CHECK recomputes it
-- from what is actually published. Approve a recipe and publish a disease
-- claim, and the write fails.
--
-- The hash is computed by the DATABASE at both ends rather than by the
-- application, so the two cannot disagree about JSON key order or whitespace.
-- `jsonb` normalises its text representation, which is what makes this stable.

ALTER TABLE "blog_posts" ADD COLUMN "compliance_approved_content_hash" TEXT;

-- The canonical text of a post: the title, the body, and the products it says
-- it is about. A change to any of the three is a different article for this
-- purpose — adding a product to an approved post is exactly the kind of edit
-- that needs looking at again.
CREATE OR REPLACE FUNCTION blog_post_content_hash(
  p_title TEXT,
  p_blocks JSONB,
  p_product_ids UUID[]
) RETURNS TEXT AS $$
  SELECT md5(
    coalesce(p_title, '') || E'\x1f' ||
    coalesce(p_blocks::text, '') || E'\x1f' ||
    coalesce(array_to_string(p_product_ids, ','), '')
  );
$$ LANGUAGE sql IMMUTABLE;

-- Replace the weaker rule with the one that actually binds.
ALTER TABLE "blog_posts" DROP CONSTRAINT "blog_post_with_products_needs_compliance";

ALTER TABLE "blog_posts"
  ADD CONSTRAINT "blog_post_with_products_needs_compliance"
  CHECK (
    "status" <> 'PUBLISHED'
    OR cardinality("product_ids") = 0
    OR (
      "compliance_approved_at" IS NOT NULL
      AND "compliance_approved_by_id" IS NOT NULL
      AND "compliance_approved_content_hash"
          = blog_post_content_hash("title", "blocks", "product_ids")
    )
  );
