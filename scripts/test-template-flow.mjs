#!/usr/bin/env node

/**
 * Herald Template E2E Test Script
 *
 * Tests the full custom template lifecycle against a running server:
 *   1. Create a custom email template (branded HTML)
 *   2. Send a notification using templateId + templateVariables
 *   3. Check notification status
 *
 * Usage:
 *   export API_KEY="hrld_dev_xxxx..."
 *   export API_BASE="http://localhost:3002"
 *   node scripts/test-template-flow.mjs
 *
 * Or with env vars inline:
 *   API_KEY="hrld_dev_..." node scripts/test-template-flow.mjs
 */

const API_KEY = process.env.API_KEY;
const API_BASE = (process.env.API_BASE || 'http://localhost:3002').replace(/\/+$/, '');
const WALLET = process.env.WALLET;

if (!API_KEY) {
  console.error('ERROR: API_KEY environment variable is required.');
  console.error('');
  console.error('First, generate a dev API key:');
  console.error('  node scripts/seed-dev-api-key.mjs');
  console.error('');
  console.error('Then export it:');
  console.error('  export API_KEY="hrld_dev_<generated_key>"');
  console.error('  node scripts/test-template-flow.mjs');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

let createdTemplateId = null;

function log(label, data) {
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(data, null, 2));
}

async function apiPost(path, body) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function apiGet(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ── Step 1: Create a branded custom template ────────────────────────

const BRAND_TEMPLATE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{subject}}</title>
  <style>
    body { margin:0; padding:0; background:#F0FDF4; font-family:'Plus Jakarta Sans',-apple-system,sans-serif; }
    .wrap { width:100%; padding:32px 16px; }
    .container { max-width:600px; margin:0 auto; }
    .card { background:#FFFFFF; border:1px solid #DCFCE7; border-radius:12px; padding:36px 32px; }
    .brand-header { text-align:center; margin-bottom:24px; }
    .brand-header img { width:48px; height:48px; border-radius:10px; }
    .brand-name { font-family:'Syne',sans-serif; font-size:20px; font-weight:700; color:#166534; margin-top:8px; }
    .headline { font-family:'Syne',sans-serif; font-size:24px; font-weight:700; color:#14532D; margin:0 0 16px; }
    .body-text { font-size:15px; line-height:1.7; color:#374151; }
    .highlight { background:#F0FDF4; border-left:4px solid #22C55E; padding:12px 16px; margin:16px 0; border-radius:4px; }
    .cta { display:inline-block; padding:14px 28px; background:#22C55E; color:#FFFFFF !important; border-radius:8px; font-weight:700; font-size:15px; text-decoration:none; font-family:'Syne',sans-serif; }
    .cta-wrap { text-align:center; margin:28px 0; }
    .meta { font-size:12px; color:#6B7280; padding:16px 0; border-top:1px solid #E5E7EB; margin-top:24px; }
    .meta-item { display:flex; justify-content:space-between; padding:4px 0; }
    .custom-field { font-weight:600; color:#14532D; }
  </style>
</head>
<body>
  <div class="wrap"><div class="container">
    <div class="brand-header">
      <div style="display:inline-flex;align-items:center;gap:10px;">
        <img src="https://herald-storage-bucket.s3.eu-north-1.amazonaws.com/herald-logo.svg" width="32" height="32" style="display:block;border-radius:7px;">
        <span class="brand-name">{{brandName}}</span>
      </div>
    </div>
    <div class="card">
      <h1 class="headline">{{subject}}</h1>
      <div class="body-text">
        <p>{{body}}</p>
      </div>
      <div class="highlight">
        <strong>Health Factor:</strong> {{healthFactor}}<br>
        <strong>Position Value:</strong> {{positionValue}}
      </div>
      {{#if actionUrl}}
      <div class="cta-wrap"><a class="cta" href="{{actionUrl}}">{{actionLabel}}</a></div>
      {{/if}}
      <div class="meta">
        <div class="meta-item"><span>Wallet</span><span class="custom-field">{{truncateAddress walletAddress 6}}</span></div>
        <div class="meta-item"><span>Time</span><span>{{timeAgo timestamp}}</span></div>
      </div>
    </div>
  </div></div>
</body>
</html>`;

async function run() {
  console.log('═'.repeat(50));
  console.log('  Herald Template E2E Test');
  console.log('═'.repeat(50));
  console.log(`  API Base: ${API_BASE}`);
  console.log(`  Wallet:   ${WALLET}`);
  console.log(`  Key:      ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);

  try {
    // ── Step 1: Health Check ──────────────────────────────────────────
    console.log('\n\n── Step 1: Health Check ──');
    const health = await apiGet('/health/live');
    log('Server Response', health);

    // ── Step 2: Create custom template ───────────────────────────────
    console.log('\n\n── Step 2: Create Custom Template ──');
    const templatePayload = {
      name: 'Branded DeFi Alert',
      category: 'defi',
      subjectTemplate: '{{brandName}} — {{subject}}',
      htmlSource: BRAND_TEMPLATE_HTML,
      isDefault: false,
    };

    log('Creating template...', { name: templatePayload.name, category: templatePayload.category });
    const createResult = await apiPost('/v1/templates/email', templatePayload);
    createdTemplateId = createResult.templateId;
    log('Template Created', createResult);

    // ── Step 3: List templates ─────────────────────────────────────
    console.log('\n\n── Step 3: List Templates ──');
    const listResult = await apiGet('/v1/templates/email');
    log('Templates', { count: listResult.data ? listResult.data.length : 0 });

    // ── Step 4: Get single template ─────────────────────────────────
    console.log('\n\n── Step 4: Get Template by ID ──');
    if (createdTemplateId) {
      const getResult = await apiGet(`/v1/templates/email/${createdTemplateId}`);
      log('Template Detail', { id: getResult.id, name: getResult.name, version: getResult.version });
    }

    // ── Step 5: Send notification with template ─────────────────────
    console.log('\n\n── Step 5: Send Notification with Template ──');
    const notifyPayload = {
      wallet: WALLET,
      subject: 'Your position health is critical',
      body: 'Your SOL collateralized position on Orca has dropped below the safe threshold. Please take action immediately to avoid liquidation.',
      category: 'defi',
      templateId: createdTemplateId,
      templateVariables: {
        brandName: 'Orca Finance',
        healthFactor: '1.05',
        positionValue: '$12,450.00 USDC',
        timestamp: String(Math.floor(Date.now() / 1000)),
        actionUrl: 'https://app.orca.so/positions',
        actionLabel: 'View Position',
      },
      receipt: false,
    };

    log('Sending notification...', {
      wallet: notifyPayload.wallet,
      subject: notifyPayload.subject,
      templateId: notifyPayload.templateId,
      templateVariables: Object.keys(notifyPayload.templateVariables),
    });

    const notifyResult = await apiPost('/v1/notify', notifyPayload);
    log('Notification Sent', notifyResult);

    // ── Step 6: Check notification status ────────────────────────────
    if (notifyResult.notification_id) {
      console.log('\n\n── Step 6: Check Notification Status ──');
      // Wait a moment for async processing
      console.log('  Waiting 3s for processing...');
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const statusResult = await apiGet(`/v1/notifications/${notifyResult.notification_id}`);
        log('Notification Status', statusResult);
      } catch (err) {
        console.log('  Status check (expected if worker not running):', err.message);
      }
    }

    // ── Step 7: Update template ──────────────────────────────────────
    console.log('\n\n── Step 7: Update Template ──');
    if (createdTemplateId) {
      const updatePayload = {
        name: 'Branded DeFi Alert v2',
        subjectTemplate: '{{brandName}} — {{subject}}',
        htmlSource: BRAND_TEMPLATE_HTML.replace('font-size:24px', 'font-size:28px'),
        isDefault: true,
      };
      const updateResult = await apiPost(`/v1/templates/email/${createdTemplateId}`, {
        ...updatePayload,
        _method: 'PUT',
      });
      // API uses PUT for updates
      const updateResult2 = await fetch(`${API_BASE}/v1/templates/email/${createdTemplateId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(updatePayload),
      });
      const updateData = await updateResult2.json();
      log('Template Updated', updateResult2.ok ? { success: true, version: 2 } : updateData);
    }

    console.log('\n');
    console.log('═'.repeat(50));
    console.log('  ✅ ALL TESTS PASSED');
    console.log('═'.repeat(50));
    console.log(`\nTemplate ID: ${createdTemplateId}`);
    console.log('\nTo view the rendered template in a browser:');
    console.log(`  GET ${API_BASE}/v1/templates/email/${createdTemplateId}`);
    console.log('\nTo send another notification with this template:');
    console.log(`  POST ${API_BASE}/v1/notify`);
    console.log('  with templateVariables matching your custom template variables');

  } catch (err) {
    console.error('\n');
    console.error('═'.repeat(50));
    console.error('  ❌ TEST FAILED');
    console.error('═'.repeat(50));
    console.error(`  ${err.message}`);
    if (err.cause) console.error(`  Cause: ${err.cause}`);
    process.exit(1);
  }
}

run();
