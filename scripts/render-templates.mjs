#!/usr/bin/env node

import Handlebars from 'handlebars';
import juice from 'juice';
import { marked } from 'marked';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'src', 'modules', 'template', 'templates');
const OUTPUT_DIR = path.join(ROOT, 'rendered-templates');

// ── Register Handlebars helpers (mirrors template.service.ts) ──────────────

Handlebars.registerHelper('truncate', (str, len) =>
  str?.length > len ? str.slice(0, len) + '...' : str,
);
Handlebars.registerHelper('formatDate', (ts) =>
  new Date(ts * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
);
Handlebars.registerHelper('categoryColor', (category) =>
  ({ defi: '#EF4444', governance: '#8B5CF6', system: '#F59E0B', marketing: '#10B981', security: '#EF4444' })[category] ?? '#00C896',
);
Handlebars.registerHelper('categoryLabel', (category) =>
  ({ defi: 'DeFi Alert', governance: 'Governance', system: 'System', marketing: 'Update', security: 'Security' })[category] ?? 'Notification',
);
Handlebars.registerHelper('categoryEmoji', (category) =>
  ({ defi: '\u{1F534}', governance: '\u{1F3DB}\u{FE0F}', system: '\u{2699}\u{FE0F}', marketing: '\u{1F4E2}', security: '\u{1F512}' })[category] ?? '\u{1F514}',
);
Handlebars.registerHelper('markdown', (content) => {
  if (!content) return '';
  return new Handlebars.SafeString(marked.parse(content, { gfm: true }));
});
Handlebars.registerHelper('money', (amount, symbol = 'USDC') => {
  if (typeof amount !== 'number') return `${amount} ${symbol}`;
  return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
});
Handlebars.registerHelper('truncateAddress', (address, chars = 4) => {
  if (!address || typeof address !== 'string') return '';
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
});
Handlebars.registerHelper('timeAgo', (timestamp) => {
  if (!timestamp) return '';
  const now = Math.floor(Date.now() / 1000);
  const seconds = now - timestamp;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
});
Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('ne', (a, b) => a !== b);
Handlebars.registerHelper('gt', (a, b) => a > b);
Handlebars.registerHelper('lt', (a, b) => a < b);
Handlebars.registerHelper('and', (...args) => { args.pop(); return args.every(Boolean); });
Handlebars.registerHelper('or', (...args) => { args.pop(); return args.some(Boolean); });
Handlebars.registerHelper('not', (v) => !v);
Handlebars.registerHelper('default', (v, d) => v ?? d);

// ── Fixture data per template ─────────────────────────────────────────────

const FIXTURES = {
  'defi-alert': {
    subject: 'Your position is approaching liquidation',
    body: 'Your **SOL collateral / USDC borrow** position on Marginfi has crossed a health factor of **1.08**. At current prices you have roughly **6 hours** before liquidation.\n\nYour position health is approaching the liquidation threshold. Acting now keeps your collateral intact.',
    protocolName: 'Marginfi',
    categoryLabel: 'DeFi Alert',
    walletAddress: '7xKXt19LNGdF…YqAv',
    actionUrl: 'https://app.marginfi.com/positions',
    actionLabel: 'Manage Position',
    txHash: '5KJp8nQc7vL2bMxR9pK1zE8gT3fY6sH0jW4dN2',
    unsubscribeUrl: 'https://herald.xyz/unsubscribe?id=defi-001',
    category: 'defi',
  },
  governance: {
    subject: 'Jupiter DAO: Vote on Proposal JUP-42',
    body: 'A new proposal to allocate **50,000 JUP** for the Q3 liquidity incentive program has been submitted by @defi_maker. Voting ends in **72 hours**.\n\n| Option | Description |\n|--------|------------|\n| For | Allocate 50,000 JUP as proposed |\n| Against | Reject and return to discussion |\n| Abstain | No position',
    protocolName: 'Jupiter DAO',
    categoryLabel: 'Governance',
    walletAddress: '7xKXt19LNGdF…YqAv',
    actionUrl: 'https://vote.jupiter.com/proposal/42',
    actionLabel: 'Vote Now',
    unsubscribeUrl: 'https://herald.xyz/unsubscribe?id=gov-042',
    category: 'governance',
  },
  marketing: {
    subject: 'Kamino Lend V2 is now live on mainnet',
    body: "We're excited to announce **Kamino Lend V2** — now live on Solana mainnet.\n\nNew features include:\n- **Isolated pools** for safer lending\n- **Flexible leverage** up to 5x\n- **Improved risk parameters** with real-time oracles\n\nUpgrade your positions today.",
    protocolName: 'Kamino',
    categoryLabel: 'Product Update',
    walletAddress: '7xKXt19LNGdF…YqAv',
    actionUrl: 'https://app.kamino.finance/lend',
    actionLabel: 'Explore Lend V2',
    unsubscribeUrl: 'https://herald.xyz/unsubscribe?id=mkt-003',
    category: 'marketing',
  },
  system: {
    subject: 'Scheduled Maintenance — Solana Mainnet',
    body: 'Marginfi will undergo scheduled maintenance on **March 15 at 14:00 UTC**. The platform will be unavailable for approximately **2 hours**.\n\nNo action is required on your part. Your positions will be safely migrated during the upgrade.',
    protocolName: 'Marginfi',
    categoryLabel: 'System',
    walletAddress: '7xKXt19LNGdF…YqAv',
    actionUrl: 'https://status.marginfi.com',
    actionLabel: 'Check Status',
    unsubscribeUrl: 'https://herald.xyz/unsubscribe?id=sys-001',
    category: 'system',
  },
  welcome: {
    subject: 'Welcome to Herald Protocol',
    body: "You're now part of the privacy-preserving notification layer for Solana DeFi. Send email, SMS and Telegram to your users — without ever touching a single contact address.\n\nYour first API key is ready. Encryption happens on-chain. Decryption happens inside a TEE. We never see who your notifications are for.",
    protocolName: 'Herald Protocol',
    categoryLabel: 'Onboarding',
    walletAddress: '7xKXt19LNGdF…YqAv',
    actionUrl: 'https://docs.useherald.xyz/quickstart',
    actionLabel: 'Send your first notification',
    unsubscribeUrl: 'https://herald.xyz/unsubscribe?id=welcome-001',
    category: 'defi',
  },
  'api-usage-alert': {
    subject: 'API Usage Alert: 90% of monthly quota used',
    body: 'Your protocol has used **90%** of its monthly notification quota (45,000 / 50,000). At the current rate you\'ll exhaust your quota in **3 days**.\n\nUpgrade your plan to avoid disruption.',
    protocolName: 'Marginfi',
    categoryLabel: 'API Usage Alert',
    walletAddress: '7xKXt19LNGdF…YqAv',
    actionUrl: 'https://dashboard.useherald.xyz/billing',
    actionLabel: 'Upgrade Plan',
    unsubscribeUrl: 'https://herald.xyz/unsubscribe?id=usage-001',
    category: 'system',
  },
};

// ── Render ─────────────────────────────────────────────────────────────────

async function render() {
  console.log('Rendering templates...\n');

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const sizes = [];

  for (const [name, data] of Object.entries(FIXTURES)) {
    const hbsPath = path.join(TEMPLATES_DIR, name, 'index.hbs');
    if (!fs.existsSync(hbsPath)) {
      console.warn(`  [SKIP] ${name}: template not found at ${hbsPath}`);
      continue;
    }

    const source = fs.readFileSync(hbsPath, 'utf-8');
    const compiled = Handlebars.compile(source);
    const htmlWithVars = compiled(data);

    const inlinedHtml = juice(htmlWithVars, {
      removeStyleTags: false,
      preserveMediaQueries: true,
      preserveFontFaces: true,
      preserveImportant: true,
      applyAttributeStyleTags: true,
    });

    const outPath = path.join(OUTPUT_DIR, `${name}.html`);
    fs.writeFileSync(outPath, inlinedHtml, 'utf-8');

    const sizeKb = (Buffer.byteLength(inlinedHtml, 'utf-8') / 1024).toFixed(1);
    sizes.push({ name, sizeKb, path: outPath });

    console.log(`  [DONE] ${name} — ${sizeKb} KB`);
  }

  // Write index page
  const indexHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Rendered Email Templates</title>
<style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;background:#0F172A;color:#F8FAFC}
h1{font-size:24px;font-weight:700;margin-bottom:24px}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 16px;text-align:left;border-bottom:1px solid #1E293B}
th{font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#64748B}
td{font-size:14px}
a{color:#00C896;text-decoration:none}
a:hover{text-decoration:underline}
.size{color:#64748B;font-family:monospace;font-size:13px}</style></head><body>
<h1>Rendered Email Templates</h1>
<table><thead><tr><th>Template</th><th>Size</th><th>File</th></tr></thead><tbody>
${sizes.map(s => `<tr><td><strong>${s.name}</strong></td><td class="size">${s.sizeKb} KB</td><td><a href="${path.relative(OUTPUT_DIR, s.path)}">Open &#8599;</a></td></tr>`).join('\n')}
</tbody></table>
<p style="margin-top:32px;font-size:13px;color:#64748B;line-height:1.6">
  Open each file in a browser to preview. Copy the HTML into
  <a href="https://putsmail.com" target="_blank">Putsmail</a> or
  <a href="https://www.emailonacid.com" target="_blank">Email on Acid</a>
  to test rendering across email clients.
</p></body></html>`;

  // ── Render the custom template from test-template-flow.mjs ────────────────
  // This mirrors the exact server pipeline: Handlebars → juice → output.
  // Open rendered-templates/custom-defi-alert.html in a browser to verify
  // that all CSS classes are correctly inlined by juice.
  console.log('\n  Rendering custom template (test-template-flow)...');

  const CUSTOM_TEMPLATE_HTML = `<!doctype html>
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
      <div class="body-text"><p>{{body}}</p></div>
      <hr class="divider">
      <div class="meta-row" style="border-top:0;padding-top:0;">
        <span class="meta-key">Health Factor</span>
        <span class="meta-val mono">{{healthFactor}}</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Position Value</span>
        <span class="meta-val mono">{{positionValue}}</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Wallet</span>
        <span class="meta-val mono" style="font-size:12px;">{{walletAddress}}</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Time</span>
        <span class="meta-val">just now</span>
      </div>
      <div class="cta-wrap"><a class="cta" href="{{actionUrl}}">{{actionLabel}}</a></div>
    </div>
    <!-- SERVER INJECTS HERALD FOOTER HERE via injectHeraldFooter() -->
    <div style="padding:28px 8px 8px;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;">
      <p style="font-size:12.5px;line-height:1.65;color:#64748B;margin:0;">Delivered securely by Herald Protocol. <strong style="color:#475569;font-weight:600;">{{brandName}}</strong> does not have access to your email address.</p>
      <hr style="height:1px;background:#E2E8F0;margin:20px 0 18px;border:0;">
      <table cellpadding="0" cellspacing="0" style="font-size:12px;color:#64748B;">
        <tr>
          <td style="vertical-align:middle;padding-right:6px;line-height:0;"><img src="https://herald-storage-bucket.s3.eu-north-1.amazonaws.com/herald-logo.svg" width="20" height="20" style="display:block;border-radius:5px;"></td>
          <td style="vertical-align:middle;font-family:'Syne',sans-serif;font-weight:700;font-size:12px;color:#475569;letter-spacing:-0.01em;padding-right:2px;">Herald</td>
          <td style="vertical-align:middle;color:#CBD5E1;padding:0 4px;">|</td>
          <td style="vertical-align:middle;"><a href="{{unsubscribeUrl}}" style="color:#64748B;text-decoration:none;">Unsubscribe</a></td>
          <td style="vertical-align:middle;color:#CBD5E1;padding:0 4px;">|</td>
          <td style="vertical-align:middle;"><a href="https://useherald.xyz" style="color:#64748B;text-decoration:none;">useherald.xyz</a></td>
        </tr>
      </table>
    </div>
  </div></div>
</body>
</html>`;

  const customData = {
    brandName: 'Orca Finance',
    protocolName: 'Orca Finance',
    subject: 'Your position health is critical',
    body: 'Your SOL collateralized position on Orca has dropped below the safe threshold. Please take action immediately to avoid liquidation.',
    healthFactor: '1.05',
    positionValue: '$12,450.00 USDC',
    walletAddress: '55bnYVxXz5RhFQBqPpuF8XazvEC5XL6kbA2wmVb2eiDc',
    actionUrl: 'https://app.orca.so/positions',
    actionLabel: 'View Position',
    unsubscribeUrl: 'https://useherald.xyz/unsubscribe/preview',
  };

  const customCompiled = Handlebars.compile(CUSTOM_TEMPLATE_HTML);
  const customHtmlWithVars = customCompiled(customData);
  const customInlined = juice(customHtmlWithVars, {
    removeStyleTags: false,
    preserveMediaQueries: true,
    preserveFontFaces: true,
    preserveImportant: true,
    applyAttributeStyleTags: true,
  });

  // Verify CSS inlining worked — check key classes are present as inline styles
  const inlineChecks = [
    { selector: 'background: #FFFFFF', label: '.card background' },
    { selector: 'background: #00C896', label: '.cta background' },
    { selector: 'color: #00C896', label: '.eyebrow color' },
    { selector: "font-family: 'Syne'", label: 'Syne font' },
    { selector: '@media', label: '@media queries preserved' },
  ];

  console.log('\n  CSS inlining checks:');
  for (const { selector, label } of inlineChecks) {
    const found = customInlined.includes(selector);
    console.log(`    ${found ? '✅' : '❌'} ${label}${found ? '' : ` — MISSING: "${selector}"` }`);
  }

  const customOutPath = path.join(OUTPUT_DIR, 'custom-defi-alert.html');
  fs.writeFileSync(customOutPath, customInlined, 'utf-8');
  const customSizeKb = (Buffer.byteLength(customInlined, 'utf-8') / 1024).toFixed(1);
  console.log(`\n  [DONE] custom-defi-alert — ${customSizeKb} KB`);
  console.log(`  Open: ${customOutPath}`);

  console.log(`\n  Output: ${OUTPUT_DIR}`);
}

render().catch((err) => {
  console.error('Render failed:', err);
  process.exit(1);
});
