import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await pool.query('UPDATE protocols SET tier = 0 WHERE protocol_pubkey = $1', [
  'TestProtocol11111111111111111111111xyz',
]);
console.log('Protocol tier set to 0 (Developer)');
await pool.end();
