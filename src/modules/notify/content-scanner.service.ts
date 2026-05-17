import { Injectable, Logger } from '@nestjs/common';

// ─── Suspicious content patterns — tuned for Web3/DeFi context ───────────────
// False-positive risk: DeFi legitimately uses urgency + financial language.
// These patterns target COMBINATIONS that indicate phishing, not single terms.
const SUSPICIOUS_PATTERNS: Array<{
  pattern: RegExp;
  weight: number;
  label: string;
}> = [
  {
    pattern: /claim\s+(?:your\s+)?airdrop\s+now/i,
    weight: 35,
    label: 'fake_airdrop_urgency',
  },
  {
    pattern: /connect\s+(?:your\s+)?wallet\s+to\s+verify/i,
    weight: 40,
    label: 'wallet_drainer_pattern',
  },
  {
    pattern: /verify\s+(?:your\s+)?wallet\s+(?:to\s+)?(?:claim|receive)/i,
    weight: 35,
    label: 'verify_to_claim',
  },
  {
    pattern:
      /(?:click|tap)\s+(?:here|below)\s+to\s+(?:claim|collect|receive)\s+(?:free|bonus)/i,
    weight: 30,
    label: 'click_to_claim_free',
  },
  {
    pattern:
      /(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly)[\\/?]/i,
    weight: 25,
    label: 'url_shortener',
  },
  {
    pattern: /urgent.{0,20}action.{0,20}required/i,
    weight: 20,
    label: 'phishing_urgency',
  },
  {
    pattern:
      /your\s+(?:account|wallet|funds)\s+(?:has\s+been\s+)?(?:compromised|hacked|flagged)/i,
    weight: 40,
    label: 'account_compromise_scare',
  },
  {
    pattern:
      /(?:send|transfer)\s+\d+\s*(?:eth|sol|bnb|usdc|usdt)\s+to\s+(?:this\s+)?(?:address|wallet)/i,
    weight: 50,
    label: 'transfer_to_address',
  },
  {
    pattern:
      /(?:metamask|phantom|trustwallet|ledger)\s+(?:support|team|official)\s+(?:here|is)/i,
    weight: 45,
    label: 'wallet_impersonation',
  },
  {
    pattern:
      /(?:doubled?|multiplied?|guaranteed?)\s+(?:your\s+)?(?:profit|return|investment)/i,
    weight: 30,
    label: 'pump_dump_language',
  },
  {
    pattern: /(?:limited\s+time|exclusive|only\s+\d+\s+spots?)\s+offer/i,
    weight: 15,
    label: 'scarcity_manipulation',
  },
  {
    pattern: /(?:seed\s+phrase|private\s+key|recovery\s+phrase|mnemonic)/i,
    weight: 60,
    label: 'seed_phrase_request',
  },
  {
    pattern:
      /(?:enter|provide|confirm|share)\s+(?:your\s+)?(?:password|credentials|login)/i,
    weight: 30,
    label: 'credential_phishing',
  },
];

// Known safe DeFi terms that should reduce the score when present
const ALLOW_TERMS: RegExp[] = [
  /(?:liquidation\s+threshold|health\s+factor|collateral\s+ratio)/i,
  /(?:staking\s+rewards?|validator\s+epoch|governance\s+proposal)/i,
  /(?:price\s+alert|market\s+order|limit\s+order|slippage)/i,
  /(?:transaction\s+(?:confirmed|failed|pending))/i,
  /(?:your\s+position|open\s+position|close\s+position)/i,
];

export interface ScanResult {
  riskScore: number; // 0–100
  verdict: 'pass' | 'review' | 'block';
  triggeredRules: string[];
}

@Injectable()
export class ContentScannerService {
  private readonly logger = new Logger(ContentScannerService.name);

  scan(subject: string, body: string): ScanResult {
    const text = `${subject}\n${body}`;
    let score = 0;
    const triggered: string[] = [];

    for (const { pattern, weight, label } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(text)) {
        score += weight;
        triggered.push(label);
      }
    }

    // Reduce score for legitimate DeFi content signals
    for (const safe of ALLOW_TERMS) {
      if (safe.test(text)) {
        score = Math.max(0, score - 10);
      }
    }

    // Cap at 100
    score = Math.min(100, score);

    const verdict: ScanResult['verdict'] =
      score >= 70 ? 'block' : score >= 40 ? 'review' : 'pass';

    if (verdict !== 'pass') {
      this.logger.warn(
        { score, verdict, triggered },
        'Content scan flagged notification',
      );
    }

    return { riskScore: score, verdict, triggeredRules: triggered };
  }
}
