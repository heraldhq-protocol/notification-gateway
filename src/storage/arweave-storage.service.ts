import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Irys from '@irys/sdk';
import bs58 from 'bs58';

export interface NotificationPayload {
  protocolId: string;
  recipientHash: string;
  channel: 'email' | 'telegram' | 'sms';
  subject: string;
  body: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export interface StorageReceipt {
  arweaveId: string;
  arweaveUrl: string;
  bundlrReceipt: string;
  timestamp: number;
  size: number;
}

@Injectable()
export class ArweaveStorageService implements OnModuleInit {
  private readonly logger = new Logger(ArweaveStorageService.name);
  // null when ARWEAVE_PAYER_SECRET is not configured — uploads are skipped gracefully
  private irys: Irys | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // ARWEAVE_PAYER_SECRET is a dedicated Solana keypair (base58) used to fund
    // Irys/Arweave uploads. It is intentionally separate from the on-chain
    // authority key. If not set, Arweave storage is disabled (non-fatal).
    const secretB58 = this.config.get<string>('ARWEAVE_PAYER_SECRET');

    if (!secretB58) {
      this.logger.warn(
        'ARWEAVE_PAYER_SECRET not configured — Arweave notification storage disabled.',
      );
      return;
    }

    const network = this.config.get<string>('IRYS_NETWORK', 'devnet');
    const keyBuffer = Buffer.from(bs58.decode(secretB58));
    const providerUrl =
      this.config.get<string>('HELIUS_RPC_URL') ??
      'https://api.devnet.solana.com';

    this.irys = new Irys({
      network,
      token: 'solana',
      key: keyBuffer,
      config: { providerUrl },
    });

    await this.irys.ready();
    this.logger.log(`Irys node connected (SOL payer): ${this.irys.address}`);
  }

  get isEnabled(): boolean {
    return this.irys !== null;
  }

  async storeNotificationPayload(
    payload: NotificationPayload,
  ): Promise<StorageReceipt> {
    if (!this.irys) {
      throw new Error('Arweave storage is not configured (ARWEAVE_PAYER_SECRET missing).');
    }

    const data = Buffer.from(JSON.stringify(payload));

    const tags = [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'App-Name', value: 'herald-protocol' },
      { name: 'Protocol-Id', value: payload.protocolId },
      { name: 'Channel', value: payload.channel },
      { name: 'Recipient-Hash', value: payload.recipientHash },
      { name: 'Unix-Timestamp', value: String(payload.timestamp) },
      { name: 'Version', value: '1' },
    ];

    await this.ensureFunded(data.length);

    const receipt = await Promise.race([
      this.irys.upload(data, { tags }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Arweave upload timed out after 30s')),
          30_000,
        ),
      ),
    ]);

    this.logger.log(`Stored notification body: ${receipt.id}`);

    return {
      arweaveId: receipt.id,
      arweaveUrl: `https://arweave.net/${receipt.id}`,
      bundlrReceipt: JSON.stringify(receipt),
      timestamp: payload.timestamp,
      size: data.length,
    };
  }

  async fetchNotificationBody(arweaveId: string): Promise<NotificationPayload> {
    const response = await fetch(`https://arweave.net/${arweaveId}`);

    if (!response.ok) {
      throw new Error(`Arweave fetch failed: ${response.statusText}`);
    }

    return response.json() as Promise<NotificationPayload>;
  }

  async getBalance(): Promise<string> {
    if (!this.irys) return '0';
    const balance = await this.irys.getLoadedBalance();
    return this.irys.utils.fromAtomic(balance).toString();
  }

  private async ensureFunded(dataSize: number): Promise<void> {
    if (!this.irys) return;
    const cost = await this.irys.getPrice(dataSize);
    const balance = await this.irys.getLoadedBalance();

    if (balance.lt(cost)) {
      this.logger.warn('Irys balance low, funding...');
      await this.irys.fund(cost);
    }
  }
}
