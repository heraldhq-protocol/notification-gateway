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

const TIER_NAMES = ['Developer', 'Growth', 'Scale', 'Enterprise'];

function buildSystemPrompt(params: {
  protocolName: string;
  verificationStatus?: string;
  tier: number;
  environment: string;
  riskScore: number;
  triggeredRules: string[];
}): string {
  const tierName = TIER_NAMES[params.tier] ?? 'Developer';

  const strictness =
    params.verificationStatus === 'VERIFIED'
      ? `RELAXED MODE. This protocol is VERIFIED and trusted.
Allow routine notifications (liquidation alerts, governance votes, staking rewards,
price alerts, tx confirmations, portfolio updates).
Only BLOCK if there are clear phishing indicators: wallet drainer links, seed phrase
requests, impersonation of other protocols, fake urgency to transfer funds.`
      : `STRICT MODE. This protocol is ${params.verificationStatus ?? 'UNVERIFIED'}.
Default to "flag" unless the content is clearly a standard, low-risk notification.
Treat airdrop claims, urgency language, and external links as highly suspicious.
Block any impersonation attempt or wallet drainer pattern.`;

  return `You are a content moderation classifier for Herald, a Web3 DeFi notification platform.

Protocol context:
  Name: "${params.protocolName}"
  Verification: ${params.verificationStatus ?? 'UNVERIFIED'}
  Tier: ${tierName}
  Environment: ${params.environment}

Rules engine (first-pass) scored this ${params.riskScore}/100 and triggered: [${params.triggeredRules.join(', ')}]

${strictness}

LEGITIMATE notifications include: liquidation alerts, health factor warnings, governance votes, staking rewards, price alerts, transaction confirmations, airdrop claims FROM KNOWN VERIFIED PROTOCOLS, portfolio updates.

FLAG or BLOCK: phishing attempts, wallet drainer links, impersonation of known protocols (Uniswap, Phantom, MetaMask etc.), pump-and-dump schemes, seed phrase / private key requests, fake urgency to transfer funds to external addresses.

Confidence scale:
  >= 0.9: certain
  >= 0.7: likely correct
  <  0.7: uncertain — default to "flag"

Respond ONLY with valid JSON (no markdown):
{ "verdict": "allow"|"flag"|"block", "reason": "<one sentence>", "confidence": <0.0-1.0> }

If you cannot classify, return: {"verdict": "flag", "reason": "Uncertain content", "confidence": 0.3}`;
}

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
      const baseURL = this.config.get<string>('OPENAI_BASE_URL');
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
    verificationStatus?: string;
    tier: number;
    environment: string;
    subject: string;
    body: string;
    riskScore: number;
    triggeredRules: string[];
  }): Promise<void> {
    if (!this.provider) return;

    let verdict: AiVerdict;
    try {
      verdict = await this.classify({
        protocolName: params.protocolName,
        verificationStatus: params.verificationStatus,
        tier: params.tier,
        environment: params.environment,
        subject: params.subject,
        body: params.body,
        riskScore: params.riskScore,
        triggeredRules: params.triggeredRules,
      });
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

  private async classify(params: {
    protocolName: string;
    verificationStatus?: string;
    tier: number;
    environment: string;
    subject: string;
    body: string;
    riskScore: number;
    triggeredRules: string[];
  }): Promise<AiVerdict> {
    const userContent = `Protocol: ${params.protocolName}\nSubject: ${params.subject.slice(0, 500)}\n\nBody: ${params.body.slice(0, 1000)}`;

    const systemPrompt = buildSystemPrompt({
      protocolName: params.protocolName,
      verificationStatus: params.verificationStatus,
      tier: params.tier,
      environment: params.environment,
      riskScore: params.riskScore,
      triggeredRules: params.triggeredRules,
    });

    const raw =
      this.provider === 'openai'
        ? await this.classifyOpenAi(userContent, systemPrompt)
        : await this.classifyAnthropic(userContent, systemPrompt);

    const parsed = JSON.parse(raw) as AiVerdict;
    if (!['allow', 'flag', 'block'].includes(parsed.verdict)) {
      throw new Error(`Unexpected AI verdict value: ${parsed.verdict}`);
    }
    return parsed;
  }

  private async classifyAnthropic(
    userContent: string,
    systemPrompt: string,
  ): Promise<string> {
    const msg = await this.anthropic!.messages.create({
      model: this.model,
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    return (msg.content[0] as { text: string }).text.trim();
  }

  private async classifyOpenAi(
    userContent: string,
    systemPrompt: string,
  ): Promise<string> {
    const completion = await this.openai!.chat.completions.create({
      model: this.model,
      max_tokens: 150,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? '{}';
  }
}
