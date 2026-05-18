#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import bs58 from 'bs58';

const clean = process.argv.includes('--clean');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const GATEWAY = process.env.TEST_GATEWAY_URL || 'http://localhost:3002';
const INTERNAL_SECRET = process.env.INTERNAL_API_KEY || '';
const TEST_WALLET = '55bnYVxXz5RhFQBqPpuF8XazvEC5XL6kbA2wmVb2eiDc';
const PROTOCOL_PUBKEY = 'GatewayE2ETest111111111111111111111111xyz';

const startTime = Date.now();
const log = [];
function emit(...args) { log.push(args.join(' ')); console.log(...args); }
function divider(title) { emit(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`); }
function nano() { return Number(process.hrtime.bigint()) / 1e6; }
function safeJson(txt) { try { return JSON.parse(txt); } catch { return { raw: txt }; } }

let passed = 0;
let failed = 0;

async function test(label, fn) {
  const start = nano();
  try {
    await fn();
    passed++;
    emit(`  ✅ ${label} — ${Math.round(nano() - start)}ms`);
  } catch (err) {
    failed++;
    emit(`  ❌ ${label} — ${Math.round(nano() - start)}ms — ${err.message}`);
  }
}

async function api(method, path, opts = {}) {
  const url = `${GATEWAY}${path}`;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const res = await fetch(url, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = safeJson(await res.text());
  return { ok: res.ok, status: res.status, data };
}

async function expect(label, fn, expectedStatus) {
  const start2 = nano();
  try {
    const res = await fn();
    if (res.status !== expectedStatus) {
      throw new Error(`Expected ${expectedStatus}, got ${res.status} — ${JSON.stringify(res.data)}`);
    }
    passed++;
    emit(`  ✅ ${label} — ${res.status} in ${Math.round(nano() - start2)}ms`);
    return res;
  } catch (err) {
    failed++;
    emit(`  ❌ ${label} — ${Math.round(nano() - start2)}ms — ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// PHASE 0: SETUP — Seed Protocol + ApiKey + Campaign + Template
// ─────────────────────────────────────────────────────────────
divider('PHASE 0: SETUP');

let protocolId;
let apiKeyPlainText;
let campaignId;
let audienceId;
let pendingTemplateId;

await test('Seed Protocol + ApiKey', async () => {
  const protoResult = await pool.query(
    `INSERT INTO protocols (id, protocol_pubkey, name_encrypted, tier, is_active, sends_this_period, period_reset_at)
     VALUES (gen_random_uuid(), $1, $2, $3, true, 0, NOW() + INTERVAL '30 days')
     ON CONFLICT (protocol_pubkey) DO UPDATE SET tier = $3, is_active = true
     RETURNING id`,
    [PROTOCOL_PUBKEY, Buffer.from('E2E Test Protocol'), 1],
  );
  protocolId = protoResult.rows[0].id;

  const random = randomBytes(32);
  const suffix = bs58.encode(Buffer.from(random));
  apiKeyPlainText = `hrld_test_${suffix}`;
  const keyHash = createHash('sha256').update(apiKeyPlainText).digest('hex');
  const keyPrefix = apiKeyPlainText.substring(0, 16);

  await pool.query(
    `INSERT INTO api_keys (id, protocol_id, key_hash, key_prefix, environment, scopes, name, is_test_key)
     VALUES (gen_random_uuid(), $1, $2, $3, 'production', ARRAY['admin:broadcast','notify:write','admin'], 'E2E Gateway Test Key', false)
     ON CONFLICT (key_hash) DO NOTHING`,
    [protocolId, keyHash, keyPrefix],
  );
});

await test('Seed Subscription (active)', async () => {
  await pool.query(
    `INSERT INTO subscriptions (id, protocol_id, tier, status, current_period_end, period_reset_at)
     VALUES (gen_random_uuid(), $1, 1, 'active', NOW() + INTERVAL '30 days', NOW() + INTERVAL '30 days')
     ON CONFLICT (protocol_id) DO UPDATE SET status = 'active', tier = 1
     RETURNING id`,
    [protocolId],
  );
});

await test('Seed protocol_settings (test contact)', async () => {
  await pool.query(
    `INSERT INTO protocol_settings (protocol_id, test_email, updated_at)
     VALUES ($1, 'e2e-test@useherald.xyz', NOW())
     ON CONFLICT (protocol_id) DO UPDATE SET test_email = 'e2e-test@useherald.xyz', updated_at = NOW()`,
    [protocolId],
  );
});

await test('Seed Campaign + Audience', async () => {
  const audResult = await pool.query(
    `INSERT INTO audiences (id, protocol_id, name, wallets, wallet_count, updated_at)
     VALUES (gen_random_uuid(), $1, 'E2E Test Audience', ARRAY[$2], 1, NOW())
     RETURNING id`,
    [protocolId, TEST_WALLET],
  );
  audienceId = audResult.rows[0].id;

  const campResult = await pool.query(
    `INSERT INTO campaigns (id, protocol_id, audience_id, subject, body, category, channels, status, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'E2E Test Campaign', '<p>Test body</p>', 'marketing', ARRAY['email'], 'DRAFT', NOW())
     RETURNING id`,
    [protocolId, audienceId],
  );
  campaignId = campResult.rows[0].id;
});

await test('Seed PENDING_REVIEW template', async () => {
  const tmplResult = await pool.query(
    `INSERT INTO notification_templates (id, protocol_id, name, category, html_source, status)
     VALUES (gen_random_uuid(), $1, 'E2E Pending Review', 'marketing', '<div><h1>Test</h1><p>{{body}}</p></div>', 'PENDING_REVIEW')
     RETURNING id`,
    [protocolId],
  );
  pendingTemplateId = tmplResult.rows[0].id;
});

const BEARER = () => `Bearer ${apiKeyPlainText}`;

// ─────────────────────────────────────────────────────────────
// PHASE 1: ADMIN BROADCAST
// ─────────────────────────────────────────────────────────────
divider('PHASE 1: ADMIN BROADCAST');

await expect('Valid broadcast', () =>
  api('POST', '/v1/admin/broadcast', {
    headers: { Authorization: BEARER() },
    body: { subject: 'E2E Test Broadcast', body: '<p>Test message</p>', category: 'marketing' },
  }), 202);

await expect('Missing auth → 401', () =>
  api('POST', '/v1/admin/broadcast', {
    body: { subject: 'test', body: 'body', category: 'marketing' },
  }), 401);

await expect('Invalid category → 400', () =>
  api('POST', '/v1/admin/broadcast', {
    headers: { Authorization: BEARER() },
    body: { subject: 'test', body: 'body', category: 'invalid' },
  }), 400);

await expect('Empty subject → 400', () =>
  api('POST', '/v1/admin/broadcast', {
    headers: { Authorization: BEARER() },
    body: { subject: '', body: 'body', category: 'marketing' },
  }), 400);

// ─────────────────────────────────────────────────────────────
// PHASE 2: CAMPAIGN ENQUEUE
// ─────────────────────────────────────────────────────────────
divider('PHASE 2: CAMPAIGN ENQUEUE');

await expect('Valid campaign enqueue → 202', () =>
  api('POST', `/internal/campaigns/${campaignId}/enqueue`, {
    headers: { 'x-internal-secret': INTERNAL_SECRET, 'x-protocol-id': protocolId },
  }), 202);

await expect('No internal secret → 401', () =>
  api('POST', `/internal/campaigns/${campaignId}/enqueue`, {
    headers: { 'x-protocol-id': protocolId },
  }), 401);

await expect('No protocol-id header → 401', () =>
  api('POST', `/internal/campaigns/${campaignId}/enqueue`, {
    headers: { 'x-internal-secret': INTERNAL_SECRET },
  }), 401);

await expect('Non-existent campaign → 404', () =>
  api('POST', `/internal/campaigns/00000000-0000-0000-0000-000000000000/enqueue`, {
    headers: { 'x-internal-secret': INTERNAL_SECRET, 'x-protocol-id': protocolId },
  }), 404);

// ─────────────────────────────────────────────────────────────
// PHASE 3: DOMAINS
// ─────────────────────────────────────────────────────────────
divider('PHASE 3: DOMAINS');

let domainId;
const domainResult = await expect('Add domain → 201', () =>
  api('POST', '/v1/domains', {
    headers: { Authorization: BEARER() },
    body: { domain: 'e2e-test.example.com', selector: 'herald' },
  }), 201);

if (domainResult) domainId = domainResult.data?.id;

await expect('List domains → 200', () =>
  api('GET', '/v1/domains', {
    headers: { Authorization: BEARER() },
  }), 200);

await expect('Missing auth on domains → 401', () =>
  api('POST', '/v1/domains', {
    body: { domain: 'noauth.example.com' },
  }), 401);

if (domainId) {
  await expect('Delete domain → 204', async () => {
    const res = await fetch(`${GATEWAY}/v1/domains/${domainId}`, {
      method: 'DELETE',
      headers: { Authorization: BEARER() },
    });
    return { ok: res.ok, status: res.status, data: await res.text().catch(() => ({})) };
  }, 204);
}

// ─────────────────────────────────────────────────────────────
// PHASE 4: TEMPLATES
// ─────────────────────────────────────────────────────────────
divider('PHASE 4: TEMPLATES');

let templateId;
const templateResult = await expect('Create template → 201', () =>
  api('POST', '/v1/templates/email', {
    headers: { Authorization: BEARER() },
    body: {
      name: 'E2E Test Template',
      category: 'marketing',
      htmlSource: '<div><h1>Hello {{name}}</h1><p>{{body}}</p></div>',
      subjectTemplate: '{{subject}}',
    },
  }), 201);

if (templateResult) templateId = templateResult.data?.templateId;

await expect('List templates → 200', () =>
  api('GET', '/v1/templates/email', {
    headers: { Authorization: BEARER() },
  }), 200);

if (templateId) {
  await expect('Delete template → 200', () =>
    api('DELETE', `/v1/templates/email/${templateId}`, {
      headers: { Authorization: BEARER() },
    }), 200);
}

// ─────────────────────────────────────────────────────────────
// PHASE 5: CONTENT MODERATION
// ─────────────────────────────────────────────────────────────
divider('PHASE 5: CONTENT MODERATION');

// 5a: Phishing content should be blocked by content scanner
await expect('Phishing content blocked → 202 blocked', async () => {
  const res = await api('POST', '/v1/notify', {
    headers: { Authorization: BEARER() },
    body: {
      wallet: TEST_WALLET,
      subject: 'Claim your airdrop now!',
      body: 'Click here to claim free bonus - connect your wallet to verify at https://evil.com/claim',
      category: 'defi',
      receipt: false,
    },
  });
  if (res.data?.status !== 'blocked' || res.data?.error_code !== 'CONTENT_BLOCKED') {
    throw new Error(`Expected blocked/CONTENT_BLOCKED, got ${JSON.stringify(res.data)}`);
  }
  return res;
}, 202);

// 5b: Non-APPROVED template should be blocked
await expect('Non-approved template blocked → 202 blocked', async () => {
  const res = await api('POST', '/v1/notify', {
    headers: { Authorization: BEARER() },
    body: {
      wallet: TEST_WALLET,
      subject: 'Test with pending template',
      body: 'This should be blocked',
      category: 'defi',
      receipt: false,
      templateId: pendingTemplateId,
    },
  });
  if (res.data?.status !== 'blocked' || res.data?.error_code !== 'TEMPLATE_PENDING_REVIEW') {
    throw new Error(`Expected blocked/TEMPLATE_PENDING_REVIEW, got ${JSON.stringify(res.data)}`);
  }
  return res;
}, 202);

// 5c: Clean content should be queued
await expect('Clean content queued → 202 queued', async () => {
  const res = await api('POST', '/v1/notify', {
    headers: { Authorization: BEARER() },
    body: {
      wallet: TEST_WALLET,
      subject: 'E2E Test Clean Notification',
      body: 'This is a clean notification for testing purposes.',
      category: 'defi',
      receipt: false,
    },
  });
  if (res.data?.status !== 'queued') {
    throw new Error(`Expected queued, got ${JSON.stringify(res.data)}`);
  }
  return res;
}, 202);

// ─────────────────────────────────────────────────────────────
// PHASE 6: TEARDOWN (only with --clean flag)
// ─────────────────────────────────────────────────────────────

if (clean) {
  divider('PHASE 6: TEARDOWN');

  await test('Cleanup test data', async () => {
    await pool.query(`DELETE FROM channel_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE protocol_id = (SELECT id FROM protocols WHERE protocol_pubkey = $1))`, [PROTOCOL_PUBKEY]);
    await pool.query(`DELETE FROM subscriptions WHERE protocol_id = (SELECT id FROM protocols WHERE protocol_pubkey = $1)`, [PROTOCOL_PUBKEY]);
    await pool.query(`DELETE FROM notifications WHERE protocol_id = (SELECT id FROM protocols WHERE protocol_pubkey = $1)`, [PROTOCOL_PUBKEY]);
    await pool.query(`DELETE FROM api_keys WHERE key_prefix = $1`, [apiKeyPlainText.substring(0, 16)]);
    if (campaignId) await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId]);
    if (audienceId) await pool.query(`DELETE FROM audiences WHERE id = $1`, [audienceId]);
    if (pendingTemplateId) await pool.query(`DELETE FROM notification_templates WHERE id = $1`, [pendingTemplateId]);
    await pool.query(`DELETE FROM protocols WHERE protocol_pubkey = $1`, [PROTOCOL_PUBKEY]);
  });
} else {
  emit('  ℹ️  Skipping teardown (pass --clean to remove test data)');
}

await pool.end();

// ─────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
emit(`\n${'═'.repeat(60)}`);
emit(`  RESULTS: ${passed} passed, ${failed} failed (${elapsed}s)`);
emit(`${'═'.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
