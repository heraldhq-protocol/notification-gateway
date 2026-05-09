import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Connection, Keypair, Transaction, clusterApiUrl, LAMPORTS_PER_SOL } from '@solana/web3.js';
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

const {
  HELIUS_RPC_URL,
  HERALD_X25519_PRIV_HEX,
} = process.env;

if (!HERALD_X25519_PRIV_HEX) {
  console.error('HERALD_X25519_PRIV_HEX is required');
  process.exit(1);
}

const rpcUrl = 'https://api.devnet.solana.com';
const programId = HERALD_PROGRAM_ID || '2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf';

// Derive gateway X25519 pubkey from private key
const gatewayPrivKey = new Uint8Array(Buffer.from(HERALD_X25519_PRIV_HEX, 'hex'));
const gatewayKeypair = nacl.box.keyPair.fromSecretKey(gatewayPrivKey);

console.log('Gateway X25519 pubkey:', Buffer.from(gatewayKeypair.publicKey).toString('hex'));

// Load or create test wallet
const walletPath = join(__dirname, 'test-wallet.json');
let wallet;
try {
  const data = JSON.parse(readFileSync(walletPath, 'utf-8'));
  wallet = Keypair.fromSecretKey(new Uint8Array(data.secretKey));
  console.log('Loaded existing wallet:', wallet.publicKey.toBase58());
} catch {
  wallet = Keypair.generate();
  const walletData = {
    publicKey: wallet.publicKey.toBase58(),
    secretKey: Array.from(wallet.secretKey),
  };
  writeFileSync(walletPath, JSON.stringify(walletData, null, 2));
  console.log('Generated new wallet:', wallet.publicKey.toBase58());
  console.log('Secret (base58):', bs58.encode(Buffer.from(wallet.secretKey)));
  console.log('');
  console.log('Fund this wallet at https://faucet.solana.com, then rerun the script.');
  process.exit(0);
}

const email = 'adebayo.anuoluwa02@gmail.com';

async function main() {
  const connection = new Connection(rpcUrl, 'confirmed');

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.error(`Insufficient balance: ${balance / LAMPORTS_PER_SOL} SOL. Fund the wallet first.`);
    process.exit(1);
  }
  console.log('Balance:', balance / LAMPORTS_PER_SOL, 'SOL');

  // Encrypt email for gateway
  const { encryptedEmail, nonce } = encryptEmailForGateway(email, gatewayKeypair.publicKey);
  const emailHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)),
  );

  console.log('Encrypted email length:', encryptedEmail.length);
  console.log('Nonce length:', nonce.length);

  const userClient = new UserClient({
    rpcUrl,
    programId,
    commitment: 'confirmed',
  });

  // Check if identity already exists
  const [identityPda] = findIdentityPda(wallet.publicKey, programId);
  const readClient = new ReadClient({
    rpcUrl,
    programId,
    commitment: 'confirmed',
  });
  const existing = await readClient.fetchIdentityAccount(wallet.publicKey);

  let ix;
  if (existing) {
    console.log('Identity exists — updating encrypted email');
    ix = await userClient.updateIdentity({
      owner: wallet.publicKey,
      encryptedEmail,
      emailHash,
      nonce,
    });
  } else {
    console.log('Registering new identity');
    ix = await userClient.registerIdentity({
      owner: wallet.publicKey,
      encryptedEmail,
      emailHash,
      nonce,
      optIns: {
        optInAll: true,
        optInDefi: true,
        optInGovernance: true,
        optInMarketing: false,
      },
      digestMode: false,
    });
  }

  // Send tx
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const txSig = await connection.sendTransaction(tx, [wallet]);
  await connection.confirmTransaction(txSig, 'confirmed');
  console.log('Identity updated:', txSig);

  console.log('Identity PDA:', identityPda.toBase58());

  const identity = await readClient.fetchIdentityAccount(wallet.publicKey);
  if (identity) {
    console.log('Identity account found!');
    console.log('  channelEmail:', identity.channelEmail);
    console.log('  encryptedEmail length:', identity.encryptedEmail.length);
  } else {
    console.error('Identity account not found!');
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
