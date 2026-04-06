import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  KMSClient,
  CreateKeyCommand,
  GetPublicKeyCommand,
} from '@aws-sdk/client-kms';

@Injectable()
export class DkimService {
  private readonly logger = new Logger(DkimService.name);
  private readonly kms: KMSClient;

  constructor(private readonly prisma: PrismaService) {
    this.kms = new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }

  /**
   * Provisions a new DKIM key in AWS KMS for a domain.
   * Generates RSA_2048 key, extracts public key, saves to DB.
   */
  async provisionDomainKey(
    protocolId: string,
    domain: string,
    selector = 'herald',
  ) {
    try {
      // 1. Create KMS Key (RSA_2048 for DKIM)
      const createResponse = await this.kms.send(
        new CreateKeyCommand({
          KeySpec: 'RSA_2048',
          KeyUsage: 'SIGN_VERIFY',
          Description: `DKIM key for ${domain} (${protocolId})`,
        }),
      );

      const kmsKeyId = createResponse.KeyMetadata?.KeyId;
      if (!kmsKeyId) throw new Error('Failed to create KMS key');

      // 2. Get Public Key (DER formatted)
      const pubResponse = await this.kms.send(
        new GetPublicKeyCommand({ KeyId: kmsKeyId }),
      );

      const derPublicKey = pubResponse.PublicKey;
      if (!derPublicKey) throw new Error('Failed to get KMS public key');

      // Convert DER to PEM format
      const base64Pub = Buffer.from(derPublicKey).toString('base64');
      const pemPublicKey = `-----BEGIN PUBLIC KEY-----\n${base64Pub.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;

      // 3. Save to database
      const dkimKey = await this.prisma.dkimKey.create({
        data: {
          protocolId,
          domain,
          selector,
          publicKey: pemPublicKey,
          kmsKeyId,
          isActive: true,
          dnsVerified: false,
        },
      });

      return {
        id: dkimKey.id,
        domain: dkimKey.domain,
        selector: dkimKey.selector,
        dnsRecordName: `${selector}._domainkey.${domain}`,
        dnsRecordValue: `v=DKIM1; k=rsa; p=${base64Pub}`,
        kmsKeyId: dkimKey.kmsKeyId,
      };
    } catch (error) {
      this.logger.error(`DKIM provisioning failed for ${domain}:`, error);
      throw new Error('Failed to provision DKIM key');
    }
  }

  async getDomainKeys(protocolId: string) {
    return this.prisma.dkimKey.findMany({
      where: { protocolId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteDomainKey(id: string, protocolId: string) {
    return this.prisma.dkimKey.deleteMany({
      where: { id, protocolId },
    });
  }
}
