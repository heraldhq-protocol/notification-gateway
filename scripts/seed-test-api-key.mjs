import 'dotenv/config';
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import bs58 from 'bs58';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Generate a test API key
  const random = randomBytes(32);
  const suffix = bs58.encode(Buffer.from(random));
  const plainText = `hrld_test_${suffix}`;
  const keyHash = createHash('sha256').update(plainText).digest('hex');
  const keyPrefix = plainText.substring(0, 16);

  // Upsert a test protocol
  const protocolPubkey = 'TestProtocoL11111111111111111111111xyz';
  const protocolResult = await pool.query(`
    INSERT INTO protocols (id, protocol_pubkey, name_encrypted, tier, is_active, sends_this_period, period_reset_at)
    VALUES (gen_random_uuid(), $1, $2, $3, true, 0, NOW() + INTERVAL '30 days')
    ON CONFLICT (protocol_pubkey) DO UPDATE SET is_active = true
    RETURNING id
  `, [protocolPubkey, Buffer.from('test'), 2]);

  const protocolId = protocolResult.rows[0].id;
  console.log('Protocol ID:', protocolId);

  // Create the API key
  await pool.query(`
    INSERT INTO api_keys (id, protocol_id, key_hash, key_prefix, environment, scopes, name, is_test_key)
    VALUES (gen_random_uuid(), $1, $2, $3, 'sandbox', ARRAY['notify:write'], 'E2E Test Key', true)
    ON CONFLICT (key_hash) DO NOTHING
  `, [protocolId, keyHash, keyPrefix]);

  console.log('API Key:', plainText);
  console.log('');
  console.log('curl -X POST http://localhost:3002/v1/notify \\');
  console.log('  -H "Authorization: Bearer ' + plainText + '" \\');
  console.log('  -H "Content-Type: application/json" \\');
  console.log('  -d \'{');
  console.log('    "wallet": "55bnYVxXz5RhFQBqPpuF8XazvEC5XL6kbA2wmVb2eiDc",');
  console.log('    "subject": "Test Notification from Herald",');
  console.log('    "body": "This is a test notification sent via direct decrypt mode.",');
  console.log('    "category": "defi",');
  console.log('    "receipt": false');
  console.log('  }\'');
}

main().catch(console.error).finally(() => pool.end());
