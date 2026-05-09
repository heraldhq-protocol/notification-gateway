import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Fix protocol pubkeys
  const protocols = await pool.query(
    `SELECT id, protocol_pubkey FROM protocols WHERE protocol_pubkey LIKE '%TestProtocol%'`
  );
  console.log(`Found ${protocols.rows.length} protocols with invalid pubkey`);
  for (const row of protocols.rows) {
    const fixed = row.protocol_pubkey.replace('TestProtocol', 'TestProtocoL');
    await pool.query(
      `UPDATE protocols SET protocol_pubkey = $1 WHERE id = $2`,
      [fixed, row.id]
    );
    console.log(`Fixed: ${row.protocol_pubkey} -> ${fixed}`);
  }

  // Disable stuck receipts
  const stuck = await pool.query(
    `SELECT id FROM notifications WHERE write_receipt = true AND receipt_tx IS NULL AND status = 'delivered'`
  );
  console.log(`Found ${stuck.rows.length} stuck notifications`);
  for (const row of stuck.rows) {
    await pool.query(
      `UPDATE notifications SET write_receipt = false WHERE id = $1`,
      [row.id]
    );
    console.log(`Disabled receipt for ${row.id}`);
  }
}

main().catch(console.error).finally(() => pool.end());
