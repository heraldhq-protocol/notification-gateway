import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../database/prisma.service';

export interface AiVerdict {
  verdict: 'allow' | 'flag' | 'block';
  reason: string;
  confidence: number;
}

@Injectable()
export class AiClassifierService {
  private readonly logger = new Logger(AiClassifierService.name);
  private readonly client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI classification disabled');
    }
  }

  // Called async (fire-and-forget) after a notification is enqueued with review verdict.
  // Stores result in moderation_queue for admin review.
  async classifyAndFlag(params: {
    notificationId: string;
    protocolId: string;
    protocolName: string;
    subject: string;
    body: string;
    riskScore: number;
    triggeredRules: string[];
  }): Promise<void> {
    if (!this.client) return;

    let verdict: AiVerdict;

    try {
      verdict = await this.classify(params.protocolName, params.subject, params.body);
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'AI classification failed');
      return;
    }

    // Only create a moderation queue item if AI agrees this warrants review
    if (verdict.verdict === 'allow' && params.riskScore < 60) return;

    const severity =
      verdict.verdict === 'block' || params.riskScore >= 70 ? 'high'
      : verdict.confidence >= 0.8 ? 'medium'
      : 'low';

    try {
      await this.prisma.moderationQueue.create({
        data: {
          protocolId: params.protocolId,
          type: 'content_scan',
          severity,
          flagReason: `Rules engine score: ${params.riskScore}/100. AI verdict: ${verdict.verdict} (${(verdict.confidence * 100).toFixed(0)}% confidence). ${verdict.reason}`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          aiScanResult: verdict as any,
          rulesTriggers: params.triggeredRules,
        },
      });

      // Update verification status to FLAGGED if not already verified
      await this.prisma.protocol.updateMany({
        where: {
          id: params.protocolId,
          verificationStatus: { notIn: ['VERIFIED', 'FLAGGED'] },
        },
        data: { verificationStatus: 'FLAGGED' },
      });
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'Failed to write moderation queue item');
    }
  }

  private async classify(
    protocolName: string,
    subject: string,
    body: string,
  ): Promise<AiVerdict> {
    const message = await this.client!.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: `You are a content moderation classifier for Herald, a Web3 DeFi notification platform.

LEGITIMATE notifications include: liquidation alerts, health factor warnings, governance votes, staking rewards, price alerts, transaction confirmations, airdrop claims FROM KNOWN VERIFIED PROTOCOLS, portfolio updates.

FLAG or BLOCK: phishing attempts, wallet drainer links, impersonation of known protocols (Uniswap, Phantom, MetaMask etc.), pump-and-dump schemes, seed phrase / private key requests, fake urgency to transfer funds to external addresses.

Context: the sending protocol is "${protocolName}".

Respond ONLY with valid JSON (no markdown): { "verdict": "allow"|"flag"|"block", "reason": "<one sentence>", "confidence": <0.0-1.0> }`,
      messages: [
        {
          role: 'user',
          content: `Subject: ${subject.slice(0, 500)}\n\nBody: ${body.slice(0, 1000)}`,
        },
      ],
    });

    const raw = (message.content[0] as { text: string }).text.trim();
    const parsed = JSON.parse(raw) as AiVerdict;

    if (!['allow', 'flag', 'block'].includes(parsed.verdict)) {
      throw new Error(`Unexpected verdict: ${parsed.verdict}`);
    }

    return parsed;
  }
}
