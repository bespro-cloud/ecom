#!/usr/bin/env node
/**
 * Load test.
 *
 * Drives real scenarios against a running API and reports what it measured:
 * latency percentiles from recorded samples, throughput, and the status-code
 * distribution. It computes nothing it did not observe.
 *
 * This is the only place in this repository permitted to produce a performance
 * figure, and the roadmap's rule is that a number may only be quoted alongside
 * the conditions it was measured under. The report therefore prints those
 * conditions with the numbers, so a figure cannot be copied out of context
 * without them.
 *
 * Usage:
 *   node scripts/load-test.mjs --url http://localhost:4000 --concurrency 20 --duration 30
 *
 * Options:
 *   --url          base URL of the API            (default http://localhost:4000)
 *   --concurrency  simultaneous virtual users     (default 10)
 *   --duration     seconds of measured load       (default 30)
 *   --warmup       seconds discarded before measuring (default 5)
 *   --p95-budget   fail if overall p95 exceeds this, ms (default 0 = no budget)
 *   --error-budget fail if error rate exceeds this fraction (default 0.01)
 *   --json         write the raw report to this path
 *
 * Read-only by design. Nothing here places an order or writes customer data:
 * a load test that leaves rows behind is one you cannot run twice, and this
 * platform's write paths take payment and inventory with them.
 */

const args = parse(process.argv.slice(2));
const BASE = (args.url ?? 'http://localhost:4000').replace(/\/$/, '');
const CONCURRENCY = Number(args.concurrency ?? 10);
const DURATION_S = Number(args.duration ?? 30);
const WARMUP_S = Number(args.warmup ?? 5);
const P95_BUDGET = Number(args['p95-budget'] ?? 0);
const ERROR_BUDGET = Number(args['error-budget'] ?? 0.01);

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/**
 * The scenarios.
 *
 * Weighted to look roughly like a storefront rather than like a benchmark:
 * most traffic browses, some searches, a little reaches a cart. `weight` is
 * relative, not a percentage.
 */
const SCENARIOS = [
  { name: 'health', weight: 1, path: () => '/health/live' },
  { name: 'catalogue:list', weight: 30, path: () => `/api/v1/catalogue/products?limit=24&page=${1 + ((Math.random() * 3) | 0)}` },
  { name: 'catalogue:search', weight: 10, path: () => `/api/v1/catalogue/products?q=${pick(['magnesium', 'zinc', 'sleep', 'vitamin'])}` },
  { name: 'catalogue:categories', weight: 8, path: () => '/api/v1/catalogue/categories' },
  { name: 'catalogue:product', weight: 25, path: (state) => (state.slug ? `/api/v1/catalogue/products/${state.slug}` : null) },
  { name: 'catalogue:reviews', weight: 6, path: (state) => (state.slug ? `/api/v1/catalogue/products/${state.slug}/reviews?limit=10` : null) },
  { name: 'cart:read', weight: 12, path: () => '/api/v1/cart' },
  { name: 'content:sitemap', weight: 2, path: () => '/api/v1/catalogue/sitemap' },
];

const pick = (xs) => xs[(Math.random() * xs.length) | 0];

/** Latency samples per scenario, plus status counts. Sampled, never derived. */
const samples = new Map();
const statuses = new Map();
let networkErrors = 0;

function record(scenario, ms, status) {
  if (!samples.has(scenario)) samples.set(scenario, []);
  samples.get(scenario).push(ms);
  const key = `${status}`;
  statuses.set(key, (statuses.get(key) ?? 0) + 1);
}

/**
 * Percentiles from the samples actually collected.
 *
 * Nearest-rank on the sorted samples: no interpolation, no estimation, no
 * reservoir. Every number the report prints is a latency that was genuinely
 * observed, which is the property that makes it quotable.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

async function discoverProductSlug() {
  try {
    const response = await fetch(`${BASE}/api/v1/catalogue/products?limit=1`);
    if (!response.ok) return null;
    const body = await response.json();
    return body?.data?.[0]?.slug ?? null;
  } catch {
    return null;
  }
}

/** Weighted pick, so the mix is stable rather than uniform across scenarios. */
function buildTable() {
  const table = [];
  for (const scenario of SCENARIOS) {
    for (let i = 0; i < scenario.weight; i += 1) table.push(scenario);
  }
  return table;
}

async function user(table, state, deadline, measuring) {
  const cookies = new Map();
  while (Date.now() < deadline()) {
    const scenario = pick(table);
    const path = scenario.path(state);
    if (path === null) continue;

    const started = performance.now();
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: cookies.size
          ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
          : {},
      });
      // Keep the cart cookie so cart:read exercises a real session rather than
      // creating a fresh anonymous cart on every request.
      const setCookie = response.headers.getSetCookie?.() ?? [];
      for (const raw of setCookie) {
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      await response.arrayBuffer();
      if (measuring()) record(scenario.name, performance.now() - started, response.status);
    } catch {
      if (measuring()) {
        networkErrors += 1;
        record(scenario.name, performance.now() - started, 'network-error');
      }
    }
  }
}

async function main() {
  process.stdout.write(`==> Checking ${BASE} is up\n`);
  try {
    const probe = await fetch(`${BASE}/health/ready`);
    if (!probe.ok) {
      console.error(`    /health/ready returned ${probe.status}. Load testing an unhealthy service measures nothing useful.`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`    cannot reach ${BASE}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const slug = await discoverProductSlug();
  if (!slug) {
    console.error('    no published product found — seed the database first, or the product scenarios measure 404s');
    process.exit(1);
  }
  const state = { slug };
  const table = buildTable();

  const startedAt = new Date();
  let measuring = false;
  const warmupEnd = Date.now() + WARMUP_S * 1000;
  const end = warmupEnd + DURATION_S * 1000;

  process.stdout.write(`==> Warming up for ${WARMUP_S}s at concurrency ${CONCURRENCY}\n`);
  setTimeout(() => {
    measuring = true;
    process.stdout.write(`==> Measuring for ${DURATION_S}s\n`);
  }, Math.max(warmupEnd - Date.now(), 0));

  const measuredFrom = warmupEnd;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => user(table, state, () => end, () => measuring)),
  );

  const wallSeconds = (Date.now() - measuredFrom) / 1000;
  report({ startedAt, wallSeconds, slug });
}

function report({ startedAt, wallSeconds, slug }) {
  const all = [];
  const rows = [];

  for (const [name, values] of [...samples.entries()].sort()) {
    const sorted = [...values].sort((a, b) => a - b);
    all.push(...sorted);
    rows.push({
      scenario: name,
      requests: sorted.length,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
    });
  }

  all.sort((a, b) => a - b);
  const total = all.length;
  const failed = [...statuses.entries()]
    .filter(([status]) => status === 'network-error' || Number(status) >= 400)
    .reduce((sum, [, count]) => sum + count, 0);
  const errorRate = total === 0 ? 0 : failed / total;

  const ms = (value) => (value === null ? '   -  ' : `${value.toFixed(1).padStart(6)}`);

  console.log('');
  console.log('=== Conditions ===========================================');
  console.log(`  measured at   ${startedAt.toISOString()}`);
  console.log(`  target        ${BASE}`);
  console.log(`  concurrency   ${CONCURRENCY} virtual users`);
  console.log(`  duration      ${DURATION_S}s measured (${WARMUP_S}s warmup discarded)`);
  console.log(`  product slug  ${slug}`);
  console.log(`  node          ${process.version} on ${process.platform}/${process.arch}`);
  console.log('');
  console.log('  These conditions are part of the result. A latency figure');
  console.log('  quoted without them is not a measurement of anything.');
  console.log('');
  console.log('=== Latency, milliseconds ================================');
  console.log('  scenario                    reqs     p50     p90     p95     p99     max');
  for (const row of rows) {
    console.log(
      `  ${row.scenario.padEnd(24)} ${String(row.requests).padStart(6)}  ` +
        `${ms(row.p50)} ${ms(row.p90)} ${ms(row.p95)} ${ms(row.p99)} ${ms(row.max)}`,
    );
  }
  console.log('  ' + '-'.repeat(54));
  console.log(
    `  ${'OVERALL'.padEnd(24)} ${String(total).padStart(6)}  ` +
      `${ms(percentile(all, 50))} ${ms(percentile(all, 90))} ${ms(percentile(all, 95))} ` +
      `${ms(percentile(all, 99))} ${ms(all[all.length - 1] ?? null)}`,
  );
  console.log('');
  console.log('=== Throughput and errors ================================');
  console.log(`  requests      ${total}`);
  console.log(`  throughput    ${(total / wallSeconds).toFixed(1)} req/s over ${wallSeconds.toFixed(1)}s`);
  console.log(`  error rate    ${(errorRate * 100).toFixed(2)}%  (${failed} of ${total})`);
  if (networkErrors > 0) console.log(`  network errors ${networkErrors}`);
  console.log('  status codes  ' + [...statuses.entries()].sort().map(([s, c]) => `${s}=${c}`).join('  '));
  console.log('');

  if (args.json) {
    const path = String(args.json);
    const payload = {
      conditions: {
        measuredAt: startedAt.toISOString(),
        target: BASE,
        concurrency: CONCURRENCY,
        durationSeconds: DURATION_S,
        warmupSeconds: WARMUP_S,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
      },
      scenarios: rows,
      overall: {
        requests: total,
        throughputPerSecond: total / wallSeconds,
        errorRate,
        p50: percentile(all, 50),
        p95: percentile(all, 95),
        p99: percentile(all, 99),
      },
      statusCodes: Object.fromEntries(statuses),
    };
    import('node:fs').then((fs) => {
      fs.writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
      console.log(`  raw report written to ${path}`);
    });
  }

  let failures = 0;
  if (errorRate > ERROR_BUDGET) {
    console.error(`FAIL: error rate ${(errorRate * 100).toFixed(2)}% exceeds budget ${(ERROR_BUDGET * 100).toFixed(2)}%`);
    failures += 1;
  }
  const p95 = percentile(all, 95);
  if (P95_BUDGET > 0 && p95 !== null && p95 > P95_BUDGET) {
    console.error(`FAIL: p95 ${p95.toFixed(1)}ms exceeds budget ${P95_BUDGET}ms`);
    failures += 1;
  }
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
