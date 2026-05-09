const API_KEY = process.env.HERALD_TEST_API_KEY || 'hrld_test_YOUR_API_KEY';
const BASE = 'http://localhost:3002';
// Replace with your own test wallets and emails (or copy from scripts/local/)
const WALLET1 = '55bnYVxXz5RhFQBqPpuF8XazvEC5XL6kbA2wmVb2eiDc';
const WALLET2 = 'F32PctHbWxW82PiNGSozdYiYGUrcQBFgtK2QjMfy255X';

const log = [];
function emit(...a) { log.push(a.join(' ')); console.log(...a); }

async function send(wallet, subject, body, opts = {}) {
  const start = performance.now();
  const res = await fetch(`${BASE}/v1/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, subject, body, category: opts.category || 'defi', receipt: opts.receipt ?? false, ...opts }),
  });
  const ms = Math.round(performance.now() - start);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ms, data, wallet: wallet === WALLET1 ? 'W1' : 'W2' };
}

emit(`\n${'━'.repeat(60)}\n  DUAL-WALLET TEST\n${'━'.repeat(60)}\n`);

// Round 1: 5 to each wallet (no receipt)
emit('--- Round 1: 5 each, no receipt ---');
for (let i = 0; i < 5; i++) {
  const w = i % 2 === 0 ? WALLET1 : WALLET2;
  const r = await send(w, `Round1 #${i} — ${w === WALLET1 ? 'Wallet 1' : 'Wallet 2'}`, `Dual-wallet test notification ${i}`, { receipt: false });
  emit(`  ${r.wallet} ${r.ok ? '✅' : '❌'} ${r.status} in ${r.ms}ms — ${r.data?.notification_id?.slice(0,8) ?? ''}`);
}

// Round 2: 3 to each wallet with receipt
emit('\n--- Round 2: 3 each, with receipt ---');
for (let i = 0; i < 6; i++) {
  const w = i % 2 === 0 ? WALLET1 : WALLET2;
  const r = await send(w, `Round2 Receipt #${i} — ${w === WALLET1 ? 'W1' : 'W2'}`, `ZK receipt test dual wallet ${i}`, { receipt: true });
  emit(`  ${r.wallet} ${r.ok ? '✅' : '❌'} ${r.status} in ${r.ms}ms — id: ${r.data?.notification_id?.slice(0,8) ?? ''}`);
}

// Round 3: 1 critical alert to each
emit('\n--- Round 3: critical priority ---');
for (const w of [WALLET1, WALLET2]) {
  const r = await send(w, `Critical Alert — ${w === WALLET1 ? 'W1' : 'W2'}`, 'Critical priority dual-wallet test', { priority: 'critical', receipt: true });
  emit(`  ${r.wallet} ${r.ok ? '✅' : '❌'} ${r.status} in ${r.ms}ms — id: ${r.data?.notification_id?.slice(0,8) ?? ''}`);
}

emit(`\n${'━'.repeat(60)}\nDual-wallet test complete — 16 notifications sent\n${'━'.repeat(60)}`);
