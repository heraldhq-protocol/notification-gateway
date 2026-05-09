import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.HERALD_TEST_API_KEY || 'hrld_test_YOUR_API_KEY';
const BASE = 'http://localhost:3002';
const WALLET = '55bnYVxXz5RhFQBqPpuF8XazvEC5XL6kbA2wmVb2eiDc';

const startTime = Date.now();
const log = [];
function emit(...args) { log.push(args.join(' ')); console.log(...args); }
function divider(title) { emit(`\n${'━'.repeat(60)}\n  ${title}\n${'━'.repeat(60)}`); }

function nano() { return Number(process.hrtime.bigint()) / 1e6; }
function safeJson(txt) { try { return JSON.parse(txt); } catch { return { raw: txt }; } }

async function send(body, label) {
  const start = nano();
  try {
    const res = await fetch(`${BASE}/v1/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ms = Math.round(nano() - start);
    const data = safeJson(await res.text());
    return { ok: res.ok, status: res.status, ms, data, label, headers: Object.fromEntries(res.headers) };
  } catch (err) {
    return { ok: false, status: 0, ms: Math.round(nano() - start), data: { error: err.message }, label };
  }
}

async function sendBatch(payloads, label) {
  const start = nano();
  try {
    const res = await fetch(`${BASE}/v1/notify/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifications: payloads }),
    });
    const ms = Math.round(nano() - start);
    const data = safeJson(await res.text());
    return { ok: res.ok, status: res.status, ms, data, label };
  } catch (err) {
    return { ok: false, status: 0, ms: Math.round(nano() - start), data: { error: err.message }, label };
  }
}

async function getNotification(id) {
  try {
    const res = await fetch(`${BASE}/v1/notifications/${id}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    return safeJson(await res.text());
  } catch { return null; }
}

const results = [];

// ════════════════════════════════════════════════════════════════
// PHASE 0: SANITY — baseline single notification
// ════════════════════════════════════════════════════════════════
divider('PHASE 0: SANITY CHECK');
const sanity = await send({
  wallet: WALLET,
  subject: 'Sanity Check — SES Delivery Test',
  body: 'This notification tests SES delivery with the verified useherald.xyz domain. If you see this, SES is working correctly.',
  category: 'system',
  receipt: false,
}, 'sanity-check');
results.push(sanity);
emit(`  ${sanity.ok ? '✅' : '❌'} ${sanity.status} in ${sanity.ms}ms — ${JSON.stringify(sanity.data)}`);

// ════════════════════════════════════════════════════════════════
// PHASE 1: ZK RECEIPTS — notification with on-chain proof
// ════════════════════════════════════════════════════════════════
divider('PHASE 1: ZK RECEIPTS');

// 1a: receipt=true
const r1 = await send({
  wallet: WALLET,
  subject: 'ZK Receipt Test — On-Chain Proof',
  body: 'This notification has receipt=true. A ZK delivery proof should be written on-chain via Light Protocol.',
  category: 'defi',
  receipt: true,
}, 'receipt-true');
results.push(r1);
emit(`  [receipt=true] ${r1.ok ? '✅' : '❌'} ${r1.status} in ${r1.ms}ms — id: ${r1.data.notification_id}, receipt_tx: ${r1.data.receipt_tx}`);

// 1b: receipt=false (default)
const r2 = await send({
  wallet: WALLET,
  subject: 'No Receipt Test',
  body: 'This notification has receipt=false. No on-chain proof should be written.',
  category: 'system',
  receipt: false,
}, 'receipt-false');
results.push(r2);
emit(`  [receipt=false] ${r2.ok ? '✅' : '❌'} ${r2.status} in ${r2.ms}ms`);

// 1c: receipt=true with priority=critical
const r3 = await send({
  wallet: WALLET,
  subject: 'Critical Alert With Receipt',
  body: 'Critical priority notification with ZK receipt enabled.',
  category: 'system',
  receipt: true,
  priority: 'critical',
}, 'receipt-critical');
results.push(r3);
emit(`  [receipt+critical] ${r3.ok ? '✅' : '❌'} ${r3.status} in ${r3.ms}ms`);

// Wait for processing
emit(`\n  Waiting 10s for notifications to process...`);
await new Promise(r => setTimeout(r, 10000));

// Check notification statuses
for (const r of [r1, r2, r3]) {
  if (r.data?.notification_id) {
    const n = await getNotification(r.data.notification_id);
    emit(`  Status [${r.label}]: ${n?.status ?? 'unknown'} — receiptTx: ${n?.receiptTx ?? n?.receipt_tx ?? 'none'}`);
  }
}

// ════════════════════════════════════════════════════════════════
// PHASE 2: EDGE CASES — validation, boundaries, injection
// ════════════════════════════════════════════════════════════════
divider('PHASE 2: EDGE CASE TORTURE');

const edgeCases = [
  { label: 'Empty subject', body: { wallet: WALLET, subject: '', body: 'Empty subject test', category: 'defi', receipt: false } },
  { label: 'Empty body', body: { wallet: WALLET, subject: 'Empty Body Test', body: '', category: 'defi', receipt: false } },
  { label: 'Subject 150 chars (limit)', body: { wallet: WALLET, subject: 'A'.repeat(150), body: 'Max subject test', category: 'defi', receipt: false } },
  { label: 'Subject overflow (200 chars)', body: { wallet: WALLET, subject: 'B'.repeat(200), body: 'Overflow subject', category: 'defi', receipt: false } },
  { label: 'Body 10k chars (limit)', body: { wallet: WALLET, subject: 'Max Body', body: 'C'.repeat(10000), category: 'defi', receipt: false } },
  { label: 'Body overflow (11k chars)', body: { wallet: WALLET, subject: 'Overflow Body', body: 'D'.repeat(11000), category: 'defi', receipt: false } },
  { label: 'Unicode: emoji+CJK+latin', body: { wallet: WALLET, subject: '🔥 测试 Test 🎉', body: 'こんにちは世界！🔥🎉 Überprüfung. 这是一条测试消息。', category: 'defi', receipt: false } },
  { label: 'HTML injection in body', body: { wallet: WALLET, subject: 'HTML XSS Test', body: '<script>alert("xss")</script><img src=x onerror=alert(1)>', category: 'defi', receipt: false } },
  { label: 'SQL injection in subject', body: { wallet: WALLET, subject: "'; DROP TABLE notifications; --", body: 'SQL injection test body', category: 'defi', receipt: false } },
  { label: 'Proto pollution in body', body: { wallet: WALLET, subject: 'Proto Pollution', body: '{"__proto__": {"polluted": true}}', category: 'defi', receipt: false } },
  { label: 'Invalid wallet address (200 chars)', body: { wallet: 'A'.repeat(200), subject: 'Bad Wallet', body: 'Invalid wallet', category: 'defi', receipt: false } },
  { label: 'Missing wallet field', body: { subject: 'Missing Wallet', body: 'No wallet', category: 'defi', receipt: false } },
  { label: 'Missing category', body: { wallet: WALLET, subject: 'No Category', body: 'Missing category', receipt: false } },
  { label: 'Null bytes in body', body: { wallet: WALLET, subject: 'Null Bytes', body: 'Null\x00byte\x00injection\x00test', category: 'defi', receipt: false } },
  { label: 'All fields null', body: { wallet: null, subject: null, body: null, category: null, receipt: null } },
];

for (const tc of edgeCases) {
  await new Promise(r => setTimeout(r, 500));
  const result = await send(tc.body, tc.label);
  results.push(result);
  const isExpected = result.status === 202 || result.status === 400 || result.status === 429;
  const icon = result.status === 202 ? '✅' : result.status === 400 ? '⚠️' : result.status === 413 ? '📏' : result.status === 429 ? '⛔' : '❌';
  emit(`  ${icon} ${result.status} ${String(result.ms).padStart(5)}ms  ${result.data?.error ?? result.data?.status ?? ''}  — ${tc.label}`);
}

// ════════════════════════════════════════════════════════════════
// PHASE 3: CHANNEL PREFERENCES & PRIORITY
// ════════════════════════════════════════════════════════════════
divider('PHASE 3: CHANNEL & PRIORITY VARIANTS');

const channelTests = [
  { label: 'preferredChannel=telegram', body: { wallet: WALLET, subject: 'Telegram Preferred', body: 'Should try Telegram first if registered', category: 'defi', receipt: false, preferredChannel: 'telegram' } },
  { label: 'channels=[email,sms]', body: { wallet: WALLET, subject: 'Explicit Channels', body: 'Only email and SMS channels', category: 'defi', receipt: false, channels: ['email', 'sms'] } },
  { label: 'excludedChannels=[email]', body: { wallet: WALLET, subject: 'No Email', body: 'Should NOT send via email', category: 'defi', receipt: false, excludedChannels: ['email'] } },
  { label: 'priority=critical', body: { wallet: WALLET, subject: 'Critical Alert', body: 'Critical priority — may force SMS', category: 'system', receipt: false, priority: 'critical' } },
  { label: 'priority=important', body: { wallet: WALLET, subject: 'Important Alert', body: 'Important priority notification', category: 'system', receipt: false, priority: 'important' } },
  { label: 'priority=super-critical (invalid)', body: { wallet: WALLET, subject: 'Bad Priority', body: 'Invalid priority value', category: 'defi', receipt: false, priority: 'super-critical' } },
];

for (const tc of channelTests) {
  await new Promise(r => setTimeout(r, 500));
  const result = await send(tc.body, tc.label);
  results.push(result);
  const icon = result.status === 202 ? '✅' : result.status === 400 ? '⚠️' : '❌';
  emit(`  ${icon} ${result.status} ${String(result.ms).padStart(5)}ms  ${result.data?.error ?? ''}  — ${tc.label}`);
}

// ════════════════════════════════════════════════════════════════
// PHASE 4: MULTI-CATEGORY — one of each category
// ════════════════════════════════════════════════════════════════
divider('PHASE 4: CATEGORY VARIETY');

const categories = [
  { subject: 'Liquidation Alert — SOL Position', body: 'Your SOL leveraged position is approaching liquidation at $124.50. Current price: $126.80. Top up collateral.', category: 'defi' },
  { subject: 'JUP-42: Vote on Treasury Reallocation', body: 'Vote now on JUP-42: Reallocate 2M JUP from treasury. Deadline: 3 days. Current turnout: 42%.', category: 'governance' },
  { subject: 'Scheduled Maintenance — May 15', body: 'Herald maintenance on May 15 at 02:00 UTC. Downtime: ~30 min. Queues preserved.', category: 'system' },
  { subject: 'New: Telegram Inline Notifications', body: 'Get real-time alerts in Telegram via @useheraldbot. Encrypted, always available.', category: 'marketing' },
];

for (const c of categories) {
  await new Promise(r => setTimeout(r, 600));
  const result = await send({ wallet: WALLET, ...c, receipt: false }, c.category);
  results.push(result);
  emit(`  ${result.ok ? '✅' : '❌'} ${result.status} ${String(result.ms).padStart(5)}ms  — ${c.subject}`);
}

// ════════════════════════════════════════════════════════════════
// PHASE 5: RATE LIMIT ENFORCEMENT
// ════════════════════════════════════════════════════════════════
divider('PHASE 5: RATE LIMIT ENFORCEMENT');

// 5a: Burst — fire 20 at once
emit(`  Phase 5a: Burst (20 concurrent requests)`);
const burstPayload = { wallet: WALLET, subject: 'Burst Rate Test', body: 'Rate limit burst test', category: 'system', receipt: false };
const burstPromises = [];
for (let i = 0; i < 20; i++) {
  burstPromises.push(send(burstPayload, `burst-${i}`));
}
const burstResults = await Promise.all(burstPromises);
const b202 = burstResults.filter(r => r.status === 202).length;
const b429 = burstResults.filter(r => r.status === 429).length;
emit(`  Burst: 202=${b202}  429=${b429}  other=${burstResults.length - b202 - b429}`);
results.push(...burstResults);

// 5b: Sustained — 30 requests @ 5/sec
emit(`\n  Phase 5b: Sustained (30 requests @ 5/sec)`);
let sOk = 0, sLimit = 0;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 200));
  const result = await send({ wallet: WALLET, subject: `Sustained #${i}`, body: `Sustained load test ${i}`, category: 'system', receipt: false }, `sustained-${i}`);
  results.push(result);
  if (result.status === 202) sOk++; else if (result.status === 429) sLimit++;
}
emit(`  Sustained: 202=${sOk}  429=${sLimit}`);

// ════════════════════════════════════════════════════════════════
// PHASE 6: BATCH ENDPOINT
// ════════════════════════════════════════════════════════════════
divider('PHASE 6: BATCH ENDPOINT');

const batchItems = [];
for (let i = 0; i < 10; i++) {
  batchItems.push({
    wallet: WALLET,
    subject: `Batch #${i} — ${['Liquidation Alert', 'Proposal Vote', 'System Update', 'New Feature'][i % 4]}`,
    body: `Batch stress test notification ${i}`,
    category: ['defi', 'governance', 'system', 'marketing'][i % 4],
    receipt: i === 0,
  });
}
const batchResult = await sendBatch(batchItems, 'batch-10');
results.push(batchResult);
emit(`  Batch of 10: ${batchResult.status} in ${batchResult.ms}ms`);
if (Array.isArray(batchResult.data)) {
  const accepted = batchResult.data.filter(r => r.status === 'queued').length;
  const failed = batchResult.data.filter(r => r.status !== 'queued').length;
  emit(`  Accepted: ${accepted}  Failed: ${failed}`);
}

// ════════════════════════════════════════════════════════════════
// WAIT & VERIFY DELIVERY
// ════════════════════════════════════════════════════════════════
divider('POST-TEST: DELIVERY VERIFICATION');

emit(`  Waiting 15s for async processing...`);
await new Promise(r => setTimeout(r, 15000));

// Check a sample of notifications
const checkIds = [
  ...(r1.data?.notification_id ? [r1.data.notification_id] : []),
  ...(r2.data?.notification_id ? [r2.data.notification_id] : []),
  ...(r3.data?.notification_id ? [r3.data.notification_id] : []),
];
for (const id of checkIds) {
  const n = await getNotification(id);
  emit(`  ${id.slice(0, 8)}... — status: ${n?.status ?? 'unknown'}, arweave: ${n?.arweaveId ?? n?.arweave_id ?? 'none'}, receiptTx: ${n?.receiptTx ?? n?.receipt_tx ?? 'none'}, channels: ${n?.channelDeliveries?.length ?? '?'}`);
}

// ════════════════════════════════════════════════════════════════
// FINAL REPORT
// ════════════════════════════════════════════════════════════════
const allResults = results;
const accepted = allResults.filter(r => r.status === 202);
const rateLimited = allResults.filter(r => r.status === 429);
const badRequest = allResults.filter(r => r.status === 400);
const errors = allResults.filter(r => ![202, 429, 400].includes(r.status));

const elapsed = Math.round((Date.now() - startTime) / 1000);

emit(`\n${'═'.repeat(60)}`);
emit(`  \x1b[1mCOMPREHENSIVE STRESS TEST — FINAL REPORT\x1b[0m`);
emit(`${'═'.repeat(60)}`);
emit(`  Duration: ${elapsed}s`);
emit(`  Total:   ${allResults.length}`);
emit(`  ✅ 202 Accepted:      ${accepted.length}`);
emit(`  ⚠️  400 Bad Request:   ${badRequest.length} (expected validation)`);
emit(`  ⛔ 429 Rate Limited:  ${rateLimited.length}`);
emit(`  ❌ Errors:             ${errors.length}`);
emit('');

if (errors.length > 0) {
  emit(`  \x1b[31mUNEXPECTED ERRORS:\x1b[0m`);
  for (const e of errors) {
    emit(`    ${e.label}: ${e.status} ${JSON.stringify(e.data)}`);
  }
  emit('');
}

emit(`  \x1b[1mCategory breakdown (accepted):\x1b[0m`);
const byCat = {};
for (const r of accepted) {
  const cat = r.data?.notification_id ? 'delivered' : 'other';
  // Try extracting category from the request
}
// Count by request type
const phases = {
  sanity: allResults.filter(r => r.label === 'sanity-check').length,
  receipt: 3,
  edge: edgeCases.length,
  channel: channelTests.length,
  categories: categories.length,
  burst: 20,
  sustained: 30,
  batch: 1,
};
emit(`    Sanity:          ${phases.sanity}`);
emit(`    ZK Receipts:     ${phases.receipt}`);
emit(`    Edge Cases:      ${phases.edge}`);
emit(`    Channel/Priority: ${phases.channel}`);
emit(`    Categories:      ${phases.categories}`);
emit(`    Burst (20):      ${b202} accepted, ${b429} rate-limited`);
emit(`    Sustained (30):  ${sOk} accepted, ${sLimit} rate-limited`);
emit(`    Batch (10):      ${batchResult.ok && Array.isArray(batchResult.data) ? batchResult.data.filter(r => r.status === 'queued').length : 'failed'}`);

if (accepted.length > 0) {
  const sorted = [...accepted].sort((a, b) => a.ms - b.ms);
  const avg = Math.round(accepted.reduce((s, r) => s + r.ms, 0) / accepted.length);
  emit(`\n  \x1b[1mLATENCY (accepted only):\x1b[0m`);
  emit(`    Average: ${avg}ms`);
  emit(`    Median:  ${sorted[Math.floor(sorted.length / 2)]?.ms ?? '-'}ms`);
  emit(`    P95:     ${sorted[Math.floor(sorted.length * 0.95)]?.ms ?? '-'}ms`);
  emit(`    Min:     ${sorted[0]?.ms ?? '-'}ms`);
  emit(`    Max:     ${sorted[sorted.length - 1]?.ms ?? '-'}ms`);
}

writeFileSync(join(__dirname, 'comprehensive-test-results.json'), JSON.stringify({
  timestamp: new Date().toISOString(),
  total: allResults.length,
  accepted: accepted.length,
  rateLimited: rateLimited.length,
  badRequest: badRequest.length,
  errors: errors.length,
  phases,
  latencies: accepted.map(r => r.ms),
  results: allResults.map(r => ({ label: r.label, status: r.status, ms: r.ms, data: r.data })),
}, null, 2));
emit(`\n  Results saved to comprehensive-test-results.json`);
