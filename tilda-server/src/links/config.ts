// tilda-server/src/links/config.ts
import { address } from '@solana/kit';

export interface LinksConfig {
  feeWallet: string;
  feeBps: number;
  invoiceTtlDays: number;
  debtLimit: { USDC: string; SOL: string };
  sessionPepper: string;
  detectIntervalMs: number;
  iconUrl: string;
  telegram?: { botToken: string; webhookSecret: string; botUsername: string };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intIn(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

const DECIMAL = /^\d+(\.\d+)?$/;

export function loadLinksConfig(raw: unknown): LinksConfig {
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error('links: must be an object');

  let feeWallet = '';
  try {
    feeWallet = address(String(raw.feeWallet ?? ''));
  } catch {
    problems.push('links.feeWallet: must be a Solana address');
  }

  const feeBps = raw.feeBps ?? 50;
  if (!intIn(feeBps, 0, 1000)) problems.push('links.feeBps: integer 0..1000');

  const invoiceTtlDays = raw.invoiceTtlDays ?? 7;
  if (!intIn(invoiceTtlDays, 1, 90)) problems.push('links.invoiceTtlDays: integer 1..90');

  const detectIntervalMs = raw.detectIntervalMs ?? 10_000;
  if (!intIn(detectIntervalMs, 1_000, 600_000)) problems.push('links.detectIntervalMs: integer 1000..600000');

  const pepper = raw.sessionPepper;
  if (typeof pepper !== 'string' || pepper.length < 16) problems.push('links.sessionPepper: string of 16+ chars');

  const limitRaw = isObject(raw.debtLimit) ? raw.debtLimit : {};
  const debtLimit = { USDC: String(limitRaw.USDC ?? '20'), SOL: String(limitRaw.SOL ?? '0.15') };
  if (!DECIMAL.test(debtLimit.USDC) || !DECIMAL.test(debtLimit.SOL)) problems.push('links.debtLimit: decimal strings');

  const iconUrl = String(raw.iconUrl ?? '/assets/icon.png');

  let telegram: LinksConfig['telegram'];
  if (raw.telegram !== undefined) {
    const t = raw.telegram;
    if (!isObject(t) || typeof t.botToken !== 'string' || typeof t.webhookSecret !== 'string'
      || typeof t.botUsername !== 'string' || t.webhookSecret.length < 16) {
      problems.push('links.telegram: botToken, botUsername and webhookSecret (16+ chars) are all required');
    } else {
      telegram = { botToken: t.botToken, webhookSecret: t.webhookSecret, botUsername: t.botUsername };
    }
  }

  if (problems.length > 0) throw new Error(problems.join('\n'));
  return {
    feeWallet, feeBps: feeBps as number, invoiceTtlDays: invoiceTtlDays as number,
    debtLimit, sessionPepper: pepper as string, detectIntervalMs: detectIntervalMs as number, iconUrl,
    ...(telegram ? { telegram } : {}),
  };
}
