import { Injectable, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';

@Injectable()
export class DnsVerificationService {
  private readonly logger = new Logger(DnsVerificationService.name);

  /**
   * Resolves TXT records for a given domain/hostname.
   */
  async resolveTxt(hostname: string): Promise<string[]> {
    try {
      const records = await dns.resolveTxt(hostname);
      return records.map((r) => r.join(''));
    } catch (err: any) {
      this.logger.warn(`DNS TXT lookup failed for ${hostname}: ${err.message}`);
      return [];
    }
  }

  /**
   * Checks the DMARC policy for a domain.
   * Looks up _dmarc.domain.
   */
  async checkDmarcPolicy(domain: string): Promise<{
    valid: boolean;
    policy?: 'none' | 'quarantine' | 'reject';
    record?: string;
    error?: string;
  }> {
    const dmarcHostname = `_dmarc.${domain}`;
    const records = await this.resolveTxt(dmarcHostname);

    if (records.length === 0) {
      return { valid: false, error: 'No DMARC record found' };
    }

    // Usually there should only be one DMARC record
    const record = records.find((r) => r.startsWith('v=DMARC1'));
    if (!record) {
      return { valid: false, error: 'Invalid DMARC record format' };
    }

    const policyMatch = record.match(/p=([^;]+)/);
    const policy = policyMatch ? (policyMatch[1].trim() as any) : null;

    if (policy === 'quarantine' || policy === 'reject') {
      return { valid: true, policy, record };
    }

    return {
      valid: false,
      policy: policy || 'none',
      record,
      error: 'DMARC policy must be quarantine or reject',
    };
  }

  /**
   * Verifies the BIMI DNS record is published and matches the expected logo URL.
   */
  async checkBimiRecord(
    domain: string,
    selector = 'default',
    expectedLogoUrl?: string,
  ): Promise<{
    published: boolean;
    record?: string;
    logoUrl?: string;
    vmcUrl?: string;
    matches: boolean;
  }> {
    const bimiHostname = `${selector}._bimi.${domain}`;
    const records = await this.resolveTxt(bimiHostname);

    if (records.length === 0) {
      return { published: false, matches: false };
    }

    const record = records.find((r) => r.startsWith('v=BIMI1'));
    if (!record) {
      return { published: false, matches: false };
    }

    const logoMatch = record.match(/l=([^;]+)/);
    const logoUrl = logoMatch ? logoMatch[1].trim() : undefined;

    const vmcMatch = record.match(/a=([^;]+)/);
    const vmcUrl = vmcMatch ? vmcMatch[1].trim() : undefined;

    return {
      published: true,
      record,
      logoUrl,
      vmcUrl,
      matches: expectedLogoUrl ? logoUrl === expectedLogoUrl : true,
    };
  }
}
