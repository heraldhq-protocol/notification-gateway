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

    const inlinedHtml = juice(htmlWithVars, { removeStyleTags: false });

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

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), indexHtml, 'utf-8');
  console.log(`\n  [DONE] index.html — preview page`);
  console.log(`\n  Output: ${OUTPUT_DIR}`);
}

render().catch((err) => {
  console.error('Render failed:', err);
  process.exit(1);
});
