import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  encryptEmailForGateway,
  UserClient,
  ReadClient,
  findIdentityPda,
  HERALD_PROGRAM_ID,
} = await import('@herald-protocol/sdk');

const { HERALD_X25519_PRIV_HEX } = process.env;

if (!HERALD_X25519_PRIV_HEX) {
  console.error('HERALD_X25519_PRIV_HEX is required');
  process.exit(1);
}

const rpcUrl = 'https://api.devnet.solana.com';
const programId = HERALD_PROGRAM_ID || '2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf';

// Derive gateway X25519 pubkey
const gatewayPrivKey = new Uint8Array(Buffer.from(HERALD_X25519_PRIV_HEX, 'hex'));
const gatewayKeypair = nacl.box.keyPair.fromSecretKey(gatewayPrivKey);

console.log('Gateway X25519 pubkey:', Buffer.from(gatewayKeypair.publicKey).toString('hex'));

// === WALLET 2 ===
// Replace with your own wallet secret (or copy from scripts/local/)
const wallet = Keypair.generate();
console.log('Wallet 2:', wallet.publicKey.toBase58());

// Replace with your own email (or copy from scripts/local/)
const email = 'wallet2@test.com';

async function main() {
  const connection = new Connection(rpcUrl, 'confirmed');

  const balance = await connection.getBalance(wallet.publicKey);
  console.log('Balance:', balance / LAMPORTS_PER_SOL, 'SOL');
  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.error('Insufficient balance. Fund this wallet first:');
    console.error('  Wallet:', wallet.publicKey.toBase58());
    console.error('  Faucet: https://faucet.solana.com');
    process.exit(1);
  }

  const { encryptedEmail, nonce } = encryptEmailForGateway(email, gatewayKeypair.publicKey);
  const emailHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)),
  );

  console.log('Encrypted email length:', encryptedEmail.length);

  const userClient = new UserClient({ rpcUrl, programId, commitment: 'confirmed' });
  const [identityPda] = findIdentityPda(wallet.publicKey, programId);
  const readClient = new ReadClient({ rpcUrl, programId, commitment: 'confirmed' });
  const existing = await readClient.fetchIdentityAccount(wallet.publicKey);

  let ix;
  if (existing) {
    console.log('Identity exists — updating');
    ix = await userClient.updateIdentity({
      owner: wallet.publicKey, encryptedEmail, emailHash, nonce,
    });
  } else {
    console.log('Registering new identity');
    ix = await userClient.registerIdentity({
      owner: wallet.publicKey, encryptedEmail, emailHash, nonce,
      optIns: { optInAll: true, optInDefi: true, optInGovernance: true, optInMarketing: false },
      digestMode: false,
    });
  }

  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const txSig = await connection.sendTransaction(tx, [wallet]);
  await connection.confirmTransaction(txSig, 'confirmed');
  console.log('Identity registered:', txSig);
  console.log('Identity PDA:', identityPda.toBase58());

  const identity = await readClient.fetchIdentityAccount(wallet.publicKey);
  if (identity) {
    console.log('✅ channelEmail:', identity.channelEmail);
  } else {
    console.error('❌ Identity not found!');
  }
}

main().catch((err) => { console.error('Failed:', err); process.exit(1); });
