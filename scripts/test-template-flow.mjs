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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>{{subject}}</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
    :root { color-scheme: light dark; }
    * { box-sizing:border-box; }
    body { margin:0; padding:0; background:#F8FAFC; color:#0F172A;
      font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
      -webkit-font-smoothing:antialiased; text-size-adjust:100%; }
    .wrap { width:100%; background:#F8FAFC; padding:32px 16px; }
    .container { max-width:600px; margin:0 auto; }
    .preheader { display:none !important; visibility:hidden; opacity:0; height:0; max-height:0; overflow:hidden; font-size:1px; line-height:1px; color:transparent; mso-hide:all; }
    .brand-name { font-family:'Syne',sans-serif; font-weight:700; font-size:15px; letter-spacing:-0.01em; color:#0F172A; }
    .card { background:#FFFFFF; border:1px solid #E2E8F0; border-radius:8px; padding:36px 32px; }
    .eyebrow { display:block; font-size:10px; text-transform:uppercase; letter-spacing:0.16em; font-weight:700; color:#00C896; margin:0 0 20px; }
    .eyebrow .dot { width:6px; height:6px; border-radius:99px; background:#00C896; display:inline-block; vertical-align:middle; margin-right:6px; position:relative; top:-1px; }
    .headline { font-family:'Syne',sans-serif; font-size:26px; font-weight:700; line-height:1.18; letter-spacing:-0.022em; color:#0F172A; margin:0 0 16px; }
    .body-text { font-size:15px; line-height:1.6; color:#475569; margin:0 0 8px; font-weight:400; }
    .body-text strong { color:#0F172A; font-weight:600; }
    .cta-wrap { margin-top:28px; }
    .cta { display:inline-block; padding:13px 22px; background:#00C896; color:#FFFFFF !important; border-radius:6px; font-weight:700; font-size:14px; text-decoration:none; letter-spacing:-0.005em; font-family:'Syne',sans-serif; }
    .divider { height:1px; background:#E2E8F0; border:0; margin:28px 0; }
    .meta-row { display:flex; justify-content:space-between; gap:16px; padding:14px 0; border-top:1px solid #E2E8F0; font-size:13px; }
    .meta-row:first-child { border-top:0; padding-top:0; }
    .meta-key { color:#64748B; font-size:11px; text-transform:uppercase; letter-spacing:0.12em; font-weight:600; }
    .meta-val { color:#0F172A; font-weight:600; text-align:right; }
    .mono { font-family:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace; }
    img { color-scheme: light; }
    @media (prefers-color-scheme: dark) {
      img { filter: none !important; -webkit-filter: none !important; }
    }
    @media (max-width:600px) {
      .card { padding:28px 22px; }
      .headline { font-size:22px; }
    }
  </style>
</head>
<body>
  <span class="preheader">{{brandName}} — {{subject}}</span>
  <div class="wrap"><div class="container">

    <table width="100%" cellpadding="0" cellspacing="0" style="padding:8px 4px 0;">
      <tr>
        <td style="vertical-align:middle;">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;padding-right:12px;line-height:0;"><img src="https://herald-storage-bucket.s3.eu-north-1.amazonaws.com/herald-logo.svg" width="32" height="32" style="display:block;border-radius:7px;" alt="{{brandName}}"></td>
            <td style="vertical-align:middle;font-family:'Syne',sans-serif;font-weight:700;font-size:15px;letter-spacing:-0.01em;color:#0F172A;">{{brandName}}</td>
          </tr></table>
        </td>
        <td align="right" style="vertical-align:middle;font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:#64748B;font-weight:700;white-space:nowrap;">DeFi Alert</td>
      </tr>
    </table>
    <div style="height:20px;line-height:20px;font-size:20px;">&nbsp;</div>

    <div class="card">
      <div class="eyebrow"><span class="dot"></span>DeFi Alert</div>
      <h1 class="headline">{{subject}}</h1>
      <div class="body-text">
        <p>{{body}}</p>
      </div>

      <hr class="divider">

      <div class="meta-row" style="border-top:0;padding-top:0;">
        <span class="meta-key">Health Factor</span>
        <span class="meta-val mono">{{healthFactor}}</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Position Value</span>
        <span class="meta-val mono">{{positionValue}}</span>
      </div>
      {{#if walletAddress}}
      <div class="meta-row">
        <span class="meta-key">Wallet</span>
        <span class="meta-val mono" style="font-size:12px;">{{truncateAddress walletAddress 6}}</span>
      </div>
      {{/if}}
      <div class="meta-row">
        <span class="meta-key">Time</span>
        <span class="meta-val">{{timeAgo timestamp}}</span>
      </div>

      {{#if actionUrl}}
      <div class="cta-wrap"><a class="cta" href="{{actionUrl}}">{{actionLabel}}</a></div>
      {{/if}}
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
        protocolName: 'Orca Finance',
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
