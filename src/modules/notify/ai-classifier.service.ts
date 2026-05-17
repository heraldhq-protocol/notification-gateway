import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { PrismaService } from '../../database/prisma.service';

export interface AiVerdict {
  verdict: 'allow' | 'flag' | 'block';
  reason: string;
  confidence: number;
}

// ─── Env vars ─────────────────────────────────────────────────────────────────
// AI_PROVIDER          = "anthropic" | "openai"   (default: anthropic)
// ANTHROPIC_API_KEY    = sk-ant-...
// ANTHROPIC_MODEL      = claude-haiku-4-5-20251001 (default)
// OPENAI_API_KEY       = sk-...
// OPENAI_BASE_URL      = https://api.openai.com/v1 (default; override for Azure/Groq/Ollama etc.)
// OPENAI_MODEL         = gpt-4o-mini               (default)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a content moderation classifier for Herald, a Web3 DeFi notification platform.

LEGITIMATE notifications include: liquidation alerts, health factor warnings, governance votes, staking rewards, price alerts, transaction confirmations, airdrop claims FROM KNOWN VERIFIED PROTOCOLS, portfolio updates.

FLAG or BLOCK: phishing attempts, wallet drainer links, impersonation of known protocols (Uniswap, Phantom, MetaMask etc.), pump-and-dump schemes, seed phrase / private key requests, fake urgency to transfer funds to external addresses.

Respond ONLY with valid JSON (no markdown): { "verdict": "allow"|"flag"|"block", "reason": "<one sentence>", "confidence": <0.0-1.0> }`;

@Injectable()
export class AiClassifierService {
  private readonly logger = new Logger(AiClassifierService.name);
  private readonly provider: 'anthropic' | 'openai' | null = null;
  private readonly anthropic: Anthropic | null = null;
  private readonly openai: OpenAI | null = null;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const provider = this.config.get<string>('AI_PROVIDER', 'anthropic') as
      | 'anthropic'
      | 'openai';

    if (provider === 'openai') {
      const apiKey = this.config.get<string>('OPENAI_API_KEY');
      if (!apiKey) {
        this.logger.warn(
          'AI_PROVIDER=openai but OPENAI_API_KEY not set — AI classification disabled',
        );
        this.model = '';
        return;
      }
      const baseURL = this.config.get<string>('OPENAI_BASE_URL'); // undefined = SDK default
      this.openai = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      this.model = this.config.get<string>('OPENAI_MODEL', 'gpt-4o-mini');
      this.provider = 'openai';
      this.logger.log(
        `AI classifier: openai / ${this.model}${baseURL ? ` @ ${baseURL}` : ''}`,
      );
    } else {
      const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
      if (!apiKey) {
        this.logger.warn(
          'ANTHROPIC_API_KEY not set — AI classification disabled',
        );
        this.model = '';
        return;
      }
      this.anthropic = new Anthropic({ apiKey });
      this.model = this.config.get<string>(
        'ANTHROPIC_MODEL',
        'claude-haiku-4-5-20251001',
      );
      this.provider = 'anthropic';
      this.logger.log(`AI classifier: anthropic / ${this.model}`);
    }
  }

  async classifyAndFlag(params: {
    notificationId: string;
    protocolId: string;
    protocolName: string;
    subject: string;
    body: string;
    riskScore: number;
    triggeredRules: string[];
  }): Promise<void> {
    if (!this.provider) return;

    let verdict: AiVerdict;
    try {
      verdict = await this.classify(
        params.protocolName,
        params.subject,
        params.body,
      );
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'AI classification failed');
      return;
    }

    if (verdict.verdict === 'allow' && params.riskScore < 60) return;

    const severity =
      verdict.verdict === 'block' || params.riskScore >= 70
        ? 'high'
        : verdict.confidence >= 0.8
          ? 'medium'
          : 'low';

    try {
      await this.prisma.moderationQueue.create({
        data: {
          protocolId: params.protocolId,
          type: 'content_scan',
          severity,
          flagReason: `Rules engine: ${params.riskScore}/100. AI (${this.provider}/${this.model}): ${verdict.verdict} @ ${(verdict.confidence * 100).toFixed(0)}% — ${verdict.reason}`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          aiScanResult: verdict as any,
          rulesTriggers: params.triggeredRules,
        },
      });

      await this.prisma.protocol.updateMany({
        where: {
          id: params.protocolId,
          verificationStatus: { notIn: ['VERIFIED', 'FLAGGED'] },
        },
        data: { verificationStatus: 'FLAGGED' },
      });
    } catch (err: any) {
      this.logger.error(
        { err: err.message },
        'Failed to write moderation queue item',
      );
    }
  }

  private async classify(
    protocolName: string,
    subject: string,
    body: string,
  ): Promise<AiVerdict> {
    const userContent = `Protocol: ${protocolName}\nSubject: ${subject.slice(0, 500)}\n\nBody: ${body.slice(0, 1000)}`;

    const raw =
      this.provider === 'openai'
        ? await this.classifyOpenAi(userContent)
        : await this.classifyAnthropic(protocolName, userContent);

    const parsed = JSON.parse(raw) as AiVerdict;
    if (!['allow', 'flag', 'block'].includes(parsed.verdict)) {
      throw new Error(`Unexpected AI verdict value: ${parsed.verdict}`);
    }
    return parsed;
  }

  private async classifyAnthropic(
    protocolName: string,
    userContent: string,
  ): Promise<string> {
    const msg = await this.anthropic!.messages.create({
      model: this.model,
      max_tokens: 150,
      system:
        SYSTEM_PROMPT +
        `\n\nContext: the sending protocol is "${protocolName}".`,
      messages: [{ role: 'user', content: userContent }],
    });
    return (msg.content[0] as { text: string }).text.trim();
  }

  private async classifyOpenAi(userContent: string): Promise<string> {
    const completion = await this.openai!.chat.completions.create({
      model: this.model,
      max_tokens: 150,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? '{}';
  }
}
