#!/usr/bin/env node
/**
 * Fails when the Prisma schema and the migration history disagree.
 *
 * The usual failure this catches is a model edited without a matching
 * migration — which only surfaces at deploy time otherwise, and by then the
 * database and the code have already diverged.
 *
 * Prisma cannot express everything PostgreSQL can. Generated columns, GIN
 * indexes with operator classes, partial indexes and CHECK constraints all live
 * in hand-written migrations, and `migrate diff` therefore always wants to
 * remove them. Those specific statements are allow-listed below. Anything else
 * is real drift and fails the build.
 *
 * Usage: check-schema-drift.mjs
 * Requires: SHADOW_DATABASE_URL
 */
import { execFileSync } from 'node:child_process';

const shadowUrl = process.env.SHADOW_DATABASE_URL;
if (!shadowUrl) {
  console.error('SHADOW_DATABASE_URL must be set (an empty database Prisma may rebuild).');
  process.exit(2);
}

/**
 * Statements `migrate diff` is expected to produce because the construct is
 * SQL-managed. Each entry names why it cannot live in the Prisma schema.
 */
const EXPECTED = [
  {
    pattern: /^DROP INDEX "products_search_vector_idx";$/,
    reason: 'GIN index on a tsvector column; Prisma cannot declare GIN for an Unsupported type',
  },
  {
    pattern: /^DROP INDEX "products_name_trgm_idx";$/,
    reason: 'GIN trigram index; Prisma has no gin_trgm_ops operator class',
  },
  {
    pattern: /^DROP INDEX "ingredients_name_trgm_idx";$/,
    reason: 'GIN trigram index; Prisma has no gin_trgm_ops operator class',
  },
  {
    pattern: /^ALTER TABLE "products" ALTER COLUMN "search_vector" DROP DEFAULT;$/,
    reason: 'stored generated column; Prisma models the column but not its expression',
  },
];

let diffSql;
try {
  diffSql = execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'diff',
      '--from-migrations',
      'prisma/migrations',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--shadow-database-url',
      shadowUrl,
      '--script',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  console.error('Could not compute the schema diff:');
  console.error(error.stderr?.toString() ?? error.message);
  process.exit(2);
}

// Reduce to executable statements: drop comments and blank lines.
const statements = diffSql
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('--'));

if (statements.length === 0) {
  console.log('Schema and migrations agree exactly.');
  process.exit(0);
}

const unexpected = [];
const matched = new Set();

for (const statement of statements) {
  const expectation = EXPECTED.find((entry) => entry.pattern.test(statement));
  if (expectation) {
    matched.add(expectation.pattern.source);
  } else {
    unexpected.push(statement);
  }
}

console.log(`${matched.size} of ${EXPECTED.length} SQL-managed constructs accounted for:`);
for (const entry of EXPECTED) {
  const seen = matched.has(entry.pattern.source);
  console.log(`  ${seen ? 'ok  ' : 'gone'}  ${entry.reason}`);
}

// An allow-listed statement that stops appearing means the construct was
// dropped from the migrations — worth knowing, but not a build failure, since
// removing an index is a legitimate change.
const missing = EXPECTED.filter((entry) => !matched.has(entry.pattern.source));
if (missing.length > 0) {
  console.log(
    '\nNote: some allow-listed constructs no longer appear in the diff. If that was ' +
      'deliberate, remove them from EXPECTED in this script.',
  );
}

if (unexpected.length > 0) {
  console.error('\nThe Prisma schema has changes with no matching migration:\n');
  for (const statement of unexpected) console.error(`  ${statement}`);
  console.error('\nRun `pnpm db:migrate` to generate one.');
  process.exit(1);
}

console.log('\nNo unexplained drift.');
