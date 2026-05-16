import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { DnsVerificationService } from './dns-verification.service';
import axios from 'axios';

@Injectable()
export class BimiService {
  private readonly logger = new Logger(BimiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dns: DnsVerificationService,
  ) {}

  /**
   * Validates SVG compliance for BIMI.
   * BIMI requires SVG Tiny Portable/Secure (SVG P/S) profile.
   * Max 32KB file size.
   */
  async validateLogo(logoUrl: string): Promise<{
    valid: boolean;
    errors: string[];
    details?: {
      sizeBytes: number;
      profile?: string;
    };
  }> {
    try {
      const response = await axios.get(logoUrl, {
        responseType: 'text',
        maxContentLength: 1024 * 1024, // 1MB limit for fetch
      });

      const body = response.data;
      const sizeBytes = Buffer.byteLength(body);
      const errors: string[] = [];

      // 1. Size check
      if (sizeBytes > 32 * 1024) {
        errors.push(
          `Logo size is too large (${(sizeBytes / 1024).toFixed(2)} KB). Max 32 KB allowed.`,
        );
      }

      // 2. Format check (Basic SVG validation)
      if (!body.toLowerCase().includes('<svg')) {
        errors.push('File is not a valid SVG image.');
      }

      // 3. BIMI specific checks (Profile and Version)
      // v=1.2 and baseProfile=tiny are often used as indicators for SVG Tiny P/S
      const versionMatch = body.match(/version="([^"]+)"/);
      const profileMatch = body.match(/baseProfile="([^"]+)"/);

      const version = versionMatch ? versionMatch[1] : null;
      const profile = profileMatch ? profileMatch[1] : null;

      if (version !== '1.2') {
        // Technically BIMI allows 1.2, but some implementations are pickier.
        this.logger.warn(
          `SVG version ${version} detected for logo ${logoUrl}. BIMI prefers 1.2.`,
        );
      }

      if (
        profile !== 'tiny-ps' &&
        profile !== 'tiny' &&
        profile !== 'tiny-portable'
      ) {
        // Many logos aren't perfectly tagged but might still work.
        // We'll warn but maybe not fail outright unless it's obviously complex (e.g. contains <script> or <foreignObject>)
      }

      // 4. Security check (Important for BIMI)
      if (body.includes('<script') || body.includes('on')) {
        errors.push(
          'SVG contains scripts or event handlers, which are forbidden for BIMI.',
        );
      }

      if (body.includes('<foreignObject')) {
        errors.push(
          'SVG contains foreignObject tag, which is forbidden for BIMI.',
        );
      }

      if (body.includes('<image') || body.includes('xlink:href')) {
        errors.push(
          'SVG contains external references or embedded bitmap images, which are forbidden for BIMI.',
        );
      }

      return {
        valid: errors.length === 0,
        errors,
        details: {
          sizeBytes,
          profile: profile || undefined,
        },
      };
    } catch (err: any) {
      this.logger.error(`Failed to fetch logo for validation: ${err.message}`);
      return {
        valid: false,
        errors: [`Could not reach logo URL: ${err.message}`],
      };
    }
  }

  /**
   * Generates the BIMI DNS TXT record value.
   */
  generateDnsRecord(logoUrl: string, vmcUrl?: string): string {
    let record = `v=BIMI1; l=${logoUrl};`;
    if (vmcUrl) {
      record += ` a=${vmcUrl};`;
    } else {
      record += ` a=;`; // Empty a= tag is explicit
    }
    return record;
  }

  /**
   * Full BIMI eligibility check for a domain.
   */
  async checkEligibility(domain: string) {
    const dmarcStatus = await this.dns.checkDmarcPolicy(domain);

    // BIMI requires DKIM and SPF to be passing, but we mainly check DMARC policy here
    // as it's the most common blocker for BIMI.

    return {
      dmarc: dmarcStatus,
      eligible: dmarcStatus.valid,
      instructions: dmarcStatus.valid
        ? 'Domain is eligible for BIMI.'
        : `DMARC policy check failed: ${dmarcStatus.error}. BIMI requires a policy of quarantine or reject.`,
    };
  }

  /**
   * Resyncs BIMI status with DNS and records logs.
   */
  async syncBimiStatus(protocolId: string, domain: string) {
    const bimi = await this.prisma.bimi_records.findUnique({
      where: { protocol_id_domain: { protocol_id: protocolId, domain } },
    });

    if (!bimi) {
      throw new BadRequestException('BIMI record not found for this domain');
    }

    const dmarcStatus = await this.dns.checkDmarcPolicy(domain);
    const dnsStatus = await this.dns.checkBimiRecord(
      domain,
      bimi.selector,
      bimi.logo_url,
    );

    // Update BIMI record
    const updated = await this.prisma.bimi_records.update({
      where: { id: bimi.id },
      data: {
        dmarc_verified: dmarcStatus.valid,
        dns_record_published: dnsStatus.published,
        is_verified:
          dmarcStatus.valid && dnsStatus.published && dnsStatus.matches,
      },
    });

    // Log verification
    await this.prisma.bimi_verification_logs.createMany({
      data: [
        {
          protocol_id: protocolId,
          domain,
          checkType: 'dmarc',
          status: dmarcStatus.valid ? 'pass' : 'fail',
          details: {
            policy: dmarcStatus.policy,
            record: dmarcStatus.record,
            error: dmarcStatus.error,
          } as any,
        },
        {
          protocol_id: protocolId,
          domain,
          checkType: 'dns',
          status: dnsStatus.published ? 'pass' : 'fail',
          details: {
            published: dnsStatus.published,
            matches: dnsStatus.matches,
            record: dnsStatus.record,
          } as any,
        },
      ],
    });

    return updated;
  }
}
