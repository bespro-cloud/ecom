-- pgcrypto provides gen_random_uuid() on PostgreSQL versions that do not have
-- it built in. On 13+ it is redundant but harmless, and it keeps the image
-- interchangeable.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram indexes back the "search by name or email" admin queries without a
-- separate search service. Introduced properly with the catalogue in Phase 2.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Query statistics, so a slow endpoint can be traced to a specific statement.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
