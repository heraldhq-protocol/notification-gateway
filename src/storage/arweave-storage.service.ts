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
  private irys: Irys;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const network = this.config.get<string>('IRYS_NETWORK', 'devnet');
    const secretB58 = this.config.getOrThrow<string>('HERALD_AUTHORITY_SECRET');
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

  async storeNotificationPayload(
    payload: NotificationPayload,
  ): Promise<StorageReceipt> {
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

    const receipt = await this.irys.upload(data, { tags });

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
    const balance = await this.irys.getLoadedBalance();
    return this.irys.utils.fromAtomic(balance).toString();
  }

  private async ensureFunded(dataSize: number): Promise<void> {
    const cost = await this.irys.getPrice(dataSize);
    const balance = await this.irys.getLoadedBalance();

    if (balance.lt(cost)) {
      this.logger.warn('Irys balance low, funding...');
      await this.irys.fund(cost);
    }
  }
}
