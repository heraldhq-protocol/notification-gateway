import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
const { encodeUTF8 } = util;

const {
  ReadClient,
  findIdentityPda,
  HERALD_PROGRAM_ID,
} = await import('@herald-protocol/sdk');

const testWallet = new PublicKey('55bnYVxXz5RhFQBqPpuF8XazvEC5XL6kbA2wmVb2eiDc');
const rpcUrl = 'https://api.devnet.solana.com';
const programId = HERALD_PROGRAM_ID || '2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf';
const gatewayPrivHex = process.env.HERALD_X25519_PRIV_HEX;
const gatewayPrivKey = new Uint8Array(Buffer.from(gatewayPrivHex, 'hex'));

const readClient = new ReadClient({ rpcUrl, programId, commitment: 'confirmed' });
const identity = await readClient.fetchIdentityAccount(testWallet);

if (!identity) {
  console.error('Identity not found');
  process.exit(1);
}

console.log('Identity found:');
console.log('  channelEmail:', identity.channelEmail);
console.log('  encryptedEmail length:', identity.encryptedEmail.length);
console.log('  nonce length:', identity.nonce.length);

// Decrypt the email using direct nacl.box
// Format: [ephemeral_pubkey(32) || ciphertext]
if (identity.encryptedEmail.length >= 33) {
  const ephPubkey = identity.encryptedEmail.slice(0, 32);
  const ciphertext = identity.encryptedEmail.slice(32);
  const decrypted = nacl.box.open(ciphertext, identity.nonce, ephPubkey, gatewayPrivKey);

  if (decrypted) {
    const email = encodeUTF8(decrypted);
    console.log('\n✅ Decrypted email:', email);
  } else {
    console.log('\n❌ nacl.box.open failed');
  }
}
