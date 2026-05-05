#!/usr/bin/env node
/**
 * Validates that shared Prisma models have identical column @map() names
 * across admin-api and gateway schemas.
 *
 * Usage:
 *   node scripts/check-schema-sync.js <path-to-other-schema>
 *
 * Example (from admin-api root):
 *   node scripts/check-schema-sync.js ../herald-notification-gateway/prisma/schema.prisma
 *
 * In CI: both repos run this against a known-good snapshot (see below).
 */

const fs = require('fs');
const path = require('path');

const SHARED_MODELS = [
  'Protocol', 'ApiKey', 'Notification', 'NotificationTemplate',
  'NotificationTemplateVersion', 'Subscription', 'Webhook', 'WebhookDelivery',
  'Payment', 'ProtocolAsset', 'DigestQueue', 'DkimKey', 'EmailBounce',
  'HelioWebhookEvent',
];

function extractModels(schemaText) {
  const models = {};
  const modelRegex = /^model\s+(\w+)\s*\{([^}]*)\}/gm;
  let match;
  while ((match = modelRegex.exec(schemaText)) !== null) {
    models[match[1]] = match[2];
  }
  return models;
}

/** Extract all @map("column_name") values from a model body */
function extractMapNames(modelBody) {
  const maps = new Set();
  const mapRegex = /@map\("([^"]+)"\)/g;
  let m;
  while ((m = mapRegex.exec(modelBody)) !== null) {
    maps.add(m[1]);
  }
  // Also capture bare field names (fields without @map use the field name directly)
  const fieldRegex = /^\s+(\w+)\s+/gm;
  let f;
  while ((f = fieldRegex.exec(modelBody)) !== null) {
    maps.add(f[1]);
  }
  return maps;
}

function getTableMap(modelBody) {
  const m = /@@map\("([^"]+)"\)/.exec(modelBody);
  return m ? m[1] : null;
}

const otherSchemaPath = process.argv[2];
if (!otherSchemaPath) {
  console.error('Usage: node scripts/check-schema-sync.js <path-to-other-schema>');
  process.exit(1);
}

const thisSchema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
const otherSchema = fs.readFileSync(path.resolve(otherSchemaPath), 'utf8');

const thisModels = extractModels(thisSchema);
const otherModels = extractModels(otherSchema);

let drifted = false;

for (const model of SHARED_MODELS) {
  const thisBody = Object.entries(thisModels).find(([k]) => k === model)?.[1];
  // Gateway may use a different Prisma model name but same @@map table name
  const thisTable = thisBody ? getTableMap(thisBody) : null;
  const otherEntry = Object.entries(otherModels).find(([, body]) => {
    return getTableMap(body) === thisTable;
  });

  if (!thisBody) {
    // This repo doesn't have the model — skip (gateway intentionally omits some)
    continue;
  }

  if (!otherEntry) {
    console.warn(`⚠️  ${model} (table: ${thisTable}) is not in the other schema — OK if intentional`);
    continue;
  }

  const [otherModelName, otherBody] = otherEntry;
  const thisMaps = extractMapNames(thisBody);
  const otherMaps = extractMapNames(otherBody);

  const onlyInThis = [...thisMaps].filter(m => !otherMaps.has(m) && m !== '@@map' && !m.startsWith('@@'));
  const onlyInOther = [...otherMaps].filter(m => !thisMaps.has(m) && m !== '@@map' && !m.startsWith('@@'));

  if (onlyInThis.length || onlyInOther.length) {
    console.error(`\n❌ Schema drift in model ${model} (table: ${thisTable}):`);
    if (onlyInThis.length) {
      console.error(`   In THIS schema only:  ${onlyInThis.join(', ')}`);
    }
    if (onlyInOther.length) {
      console.error(`   In OTHER schema only: ${onlyInOther.join(', ')}`);
    }
    drifted = true;
  } else {
    console.log(`✅ ${model} (table: ${thisTable}) — in sync`);
  }
}

if (drifted) {
  console.error('\nSchema drift detected. Update both schemas to match before deploying.');
  process.exit(1);
} else {
  console.log('\nAll shared models are in sync.');
}
