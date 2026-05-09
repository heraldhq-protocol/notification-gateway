import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.HERALD_TEST_API_KEY || 'hrld_test_YOUR_API_KEY';
const BASE_URL = 'http://localhost:3002';
const RATE_PER_SEC = 2;
const BURST_COUNT = 5;

const payloads = JSON.parse(
  readFileSync(join(__dirname, 'stress-test-payloads.json'), 'utf-8'),
);

console.log(`\x1b[1mHERALD STRESS TEST\x1b[0m
${'─'.repeat(55)}
  Payloads:      ${payloads.length}
  Rate limit:    ${RATE_PER_SEC} req/sec (Developer tier)
  Burst test:    ${BURST_COUNT} immediate requests first
  Target:        ${BASE_URL}
${'─'.repeat(55)}\n`);

const results = [];

// ── Phase 1: Burst ─────────────────────────────────────────────
console.log(`\x1b[33mPhase 1: Burst (${BURST_COUNT} immediate requests)\x1b[0m`);
for (let i = 0; i < Math.min(BURST_COUNT, payloads.length); i++) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloads[i]),
    });
    const body = await res.json();
    const ms = Math.round(performance.now() - start);
    results.push({ idx: i, status: res.status, ms, body, headers: res.headers, payload: payloads[i] });
    console.log(`  [#${String(i).padStart(2)}] ${res.status === 202 ? '✅' : '❌'} ${String(ms).padStart(4)}ms  ${res.headers.get('x-ratelimit-remaining')?.padStart(4) ?? '-'}/${res.headers.get('x-ratelimit-limit') ?? '?'} remaining  ${payloads[i].category}  ${payloads[i].subject.substring(0, 40)}`);
  } catch (err) {
    console.log(`  [#${String(i).padStart(2)}] ❌ NETWORK ERROR: ${err.message}`);
  }
}

// ── Phase 2: Paced ─────────────────────────────────────────────
console.log(`\n\x1b[33mPhase 2: Paced (1 req / ${1000/RATE_PER_SEC}ms)\x1b[0m`);
for (let i = BURST_COUNT; i < payloads.length; i++) {
  await new Promise((r) => setTimeout(r, 1000 / RATE_PER_SEC));

  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloads[i]),
    });
    const body = await res.json();
    const ms = Math.round(performance.now() - start);
    results.push({ idx: i, status: res.status, ms, body, headers: res.headers, payload: payloads[i] });
    const remaining = res.headers.get('x-ratelimit-remaining') ?? '-';
    console.log(`  [#${String(i).padStart(2)}] ${res.status === 202 ? '✅' : '❌'} ${String(ms).padStart(4)}ms  ${remaining.padStart(4)}/${res.headers.get('x-ratelimit-limit') ?? '?'} remaining  ${payloads[i].category}  ${payloads[i].subject.substring(0, 40)}`);
  } catch (err) {
    console.log(`  [#${String(i).padStart(2)}] ❌ NETWORK ERROR: ${err.message}`);
  }
}

// ── Phase 3: Over-limit burst (test rate limiter enforcement) ──
console.log(`\n\x1b[33mPhase 3: Over-limit burst (10 rapid requests — expect 429s)\x1b[0m`);
const burst = [];
for (let i = 0; i < 10; i++) {
  // Don't await — fire all at once
  burst.push(
    (async () => {
      const start = performance.now();
      try {
        const res = await fetch(`${BASE_URL}/v1/notify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payloads[i % payloads.length]),
        });
        const body = await res.json();
        const ms = Math.round(performance.now() - start);
        const remaining = res.headers.get('x-ratelimit-remaining') ?? '-';
        const retryAfter = res.headers.get('retry-after') ?? '-';
        const icon = res.status === 429 ? '⛔' : res.status === 202 ? '✅' : '❌';
        console.log(`  ${icon} ${String(ms).padStart(4)}ms  HTTP ${res.status}  ${remaining.padStart(4)} remaining  retry-after: ${retryAfter}`);
        return { status: res.status, ms, remaining, retryAfter, body };
      } catch (err) {
        console.log(`  ❌ NETWORK ERROR: ${err.message}`);
        return { status: 0, ms: 0, remaining: '-', retryAfter: '-', body: null };
      }
    })(),
  );
}
const burstResults = await Promise.all(burst);
const rateLimitedCount = burstResults.filter((r) => r.status === 429).length;

// ── Final Report ───────────────────────────────────────────────
const allResults = [...results];
const accepted = allResults.filter((r) => r.status === 202);
const rateLimited = allResults.filter((r) => r.status === 429).length + rateLimitedCount;
const failed = allResults.filter((r) => r.status !== 202 && r.status !== 429).length;

console.log(`\n${'═'.repeat(55)}`);
console.log(`\x1b[1mFINAL RESULTS\x1b[0m`);
console.log(`${'─'.repeat(55)}`);
console.log(`  Total requests:     ${payloads.length + 10}`);
console.log(`  ├─ Phase 1 (burst): ${Math.min(BURST_COUNT, payloads.length)}`);
console.log(`  ├─ Phase 2 (paced): ${Math.max(0, payloads.length - BURST_COUNT)}`);
console.log(`  └─ Phase 3 (flood): 10`);
console.log(`\n  ✅ Accepted (202):    ${accepted.length}`);
console.log(`  ⛔ Rate limited (429): ${rateLimited}`);
console.log(`  ❌ Other errors:      ${failed}`);

if (accepted.length > 0) {
  const sorted = [...accepted].sort((a, b) => a.ms - b.ms);
  const avg = Math.round(accepted.reduce((s, r) => s + r.ms, 0) / accepted.length);
  const median = sorted[Math.floor(sorted.length / 2)].ms;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]?.ms ?? '-';
  console.log(`\n  Latency (accepted only):`);
  console.log(`    Average: ${avg}ms`);
  console.log(`    Median:  ${median}ms`);
  console.log(`    P95:     ${p95}ms`);
  console.log(`    Min:     ${sorted[0].ms}ms`);
  console.log(`    Max:     ${sorted[sorted.length - 1].ms}ms`);
}

const byCat = {};
for (const r of accepted) {
  const c = r.payload.category;
  byCat[c] = (byCat[c] || 0) + 1;
}
console.log(`\n  Category breakdown (accepted):`);
for (const [cat, count] of Object.entries(byCat)) {
  console.log(`    ${cat}: ${count}`);
}

// Check for any non-rate-limit errors
const otherErrors = results.filter((r) => r.status !== 202 && r.status !== 429);
if (otherErrors.length > 0) {
  console.log(`\n  \x1b[31mOther errors:\x1b[0m`);
  for (const e of otherErrors) {
    console.log(`    [#${e.idx}] ${e.body?.error ?? JSON.stringify(e.body)} (${e.ms}ms)`);
  }
} else {
  console.log(`\n  \x1b[32mNo unexpected errors ✓\x1b[0m`);
}
