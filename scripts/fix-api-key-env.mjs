import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const result = await pool.query(
  `UPDATE api_keys SET environment = 'staging' WHERE environment = 'sandbox' RETURNING id, environment, key_prefix`,
);
console.log(`Updated ${result.rowCount} API key(s):`);
for (const row of result.rows) {
  console.log(`  ${row.id} → ${row.environment} (${row.key_prefix})`);
}

const devKeys = await pool.query(
  `SELECT id, environment, key_prefix FROM api_keys WHERE environment = 'development'`,
);
console.log(`\nDev API keys available: ${devKeys.rowCount}`);
for (const row of devKeys.rows) {
  console.log(`  ${row.key_prefix}...`);
}

await pool.end();
