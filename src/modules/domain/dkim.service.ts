import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  KMSClient,
  CreateKeyCommand,
  GetPublicKeyCommand,
} from '@aws-sdk/client-kms';
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
} from '@aws-sdk/client-sesv2';
import { promises as dns } from 'dns';

@Injectable()
export class DkimService {
  private readonly logger = new Logger(DkimService.name);
  private readonly kms: KMSClient;
  private readonly ses: SESv2Client;

  constructor(private readonly prisma: PrismaService) {
    const region =
      process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
    this.kms = new KMSClient({ region });
    this.ses = new SESv2Client({ region });
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
      // Check limits
      const protocol = await this.prisma.protocol.findUnique({
        where: { id: protocolId },
        select: { tier: true },
      });

      if (!protocol) throw new Error('Protocol not found');

      const maxDomains = protocol.tier === 0 ? 1 : 20;

      const currentCount = await this.prisma.dkimKey.count({
        where: { protocolId, isActive: true },
      });

      if (currentCount >= maxDomains) {
        throw new ForbiddenException(
          `Domain limit reached. Your current plan (${protocol.tier === 0 ? 'Free' : 'Paid'}) allows up to ${maxDomains} custom domains.`,
        );
      }

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
        instructions: `Add a TXT record to your DNS provider. Name/Host: ${selector}._domainkey.${domain} (Tip: If your DNS provider like Namecheap or GoDaddy auto-appends your root domain, omit it from the Name/Host field). Value: v=DKIM1; k=rsa; p=${base64Pub}`,
      };
    } catch (error) {
      this.logger.error(`DKIM provisioning failed for ${domain}:`, error);
      throw new Error('Failed to provision DKIM key');
    }
  }

  /**
   * Verifies the DKIM TXT DNS record is live for the domain.
   * Looks up <selector>._domainkey.<domain> and checks the public key matches.
   * Marks dnsVerified=true in the DB on success.
   */
  async verifyDomain(id: string, protocolId: string) {
    const key = await this.prisma.dkimKey.findFirst({
      where: { id, protocolId },
    });
    if (!key) throw new Error('DKIM key not found');

    const recordName = `${key.selector}._domainkey.${key.domain}`;

    try {
      const records = await dns.resolveTxt(recordName);
      const flatRecords = records.map((r) => r.join('')).join('');

      // Extract the public key portion from the DB value (strip header/footer)
      const pubKeyB64 = key.publicKey
        .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, '')
        .replace(/\s/g, '');

      const verified = flatRecords.includes(pubKeyB64.slice(0, 32));

      if (verified) {
        await this.prisma.dkimKey.update({
          where: { id },
          data: { dnsVerified: true },
        });
      }

      return {
        id,
        domain: key.domain,
        selector: key.selector,
        dnsRecordName: recordName,
        dnsVerified: verified,
        records: flatRecords,
      };
    } catch (err) {
      this.logger.warn(`DNS lookup failed for ${recordName}:`, err);
      return {
        id,
        domain: key.domain,
        selector: key.selector,
        dnsRecordName: recordName,
        dnsVerified: false,
        records: null,
      };
    }
  }

  /**
   * Registers the domain as an SES email identity using Easy DKIM.
   *
   * NOTE: SES BYODKIM is incompatible with KMS (KMS never exports private keys).
   * Easy DKIM is the correct approach: SES generates its own DKIM keypair and
   * returns 3 CNAME records the protocol must publish to their DNS.
   * The per-domain KMS key from provisionDomainKey() is reserved for future
   * raw-email signing (send via SES SendRawEmail with pre-computed DKIM-Signature).
   *
   * Required DNS records returned by this method:
   *   <token>._domainkey.<domain> CNAME <token>.dkim.amazonses.com
   */
  async registerWithSes(id: string, protocolId: string) {
    const key = await this.prisma.dkimKey.findFirst({
      where: { id, protocolId },
    });
    if (!key) throw new NotFoundException('DKIM key not found');

    try {
      // 1. Attempt to create the identity (idempotent)
      try {
        await this.ses.send(
          new CreateEmailIdentityCommand({
            EmailIdentity: key.domain,
            // No DkimSigningAttributes = Easy DKIM mode (SES generates and manages keys)
          }),
        );
      } catch (err: any) {
        if (err.name === 'AlreadyExistsException') {
          this.logger.log(
            `SES identity for ${key.domain} already exists, proceeding to fetch status.`,
          );
        } else {
          throw err;
        }
      }

      // 2. Fetch current verification status and the CNAME records to publish
      const status = await this.ses.send(
        new GetEmailIdentityCommand({ EmailIdentity: key.domain }),
      );

      const dkimTokens = status.DkimAttributes?.Tokens ?? [];

      return {
        domain: key.domain,
        sesVerified: status.VerifiedForSendingStatus ?? false,
        dkimStatus: status.DkimAttributes?.Status,
        signingEnabled: status.DkimAttributes?.SigningEnabled,
        // Protocols must add these CNAME records to their DNS alongside the TXT record
        cnameRecords: dkimTokens.map((token) => ({
          name: `${token}._domainkey.${key.domain}`,
          value: `${token}.dkim.amazonses.com`,
          type: 'CNAME',
        })),
        instructions: `For each item in cnameRecords, add a CNAME record to your DNS provider. Name/Host: [the 'name' string] (Tip: If your DNS provider auto-appends your root domain, omit it from the Name/Host field). Target/Value: [the 'value' string]. Verification may take up to 72h.`,
      };
    } catch (error: any) {
      this.logger.error(`SES registration failed for ${key.domain}:`, {
        name: error.name,
        message: error.message,
        requestId: error.$metadata?.requestId,
      });
      throw new Error('Failed to register domain with SES');
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
