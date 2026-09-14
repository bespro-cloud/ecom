-- Alternative text for a blog post's hero image.
--
-- On the post rather than on the media row, because the same photograph needs
-- different alt text in different places — the same reason product images carry
-- their own. A reader using a screen reader on an article about a supplement
-- needs to know what the picture shows, and a description written for one
-- article is wrong in another.
ALTER TABLE "blog_posts" ADD COLUMN "hero_alt_text" TEXT;
