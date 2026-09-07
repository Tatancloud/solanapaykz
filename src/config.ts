import { ConfigError } from './errors.js';

export type Cluster = 'mainnet' | 'devnet';
export type TokenSymbol = 'USDC' | 'SOL';

export interface TokenInfo {
  /** Адрес mint. Отсутствует у нативного SOL. */
  readonly mint?: string;
  readonly decimals: number;
}

/** Адреса проверены запросом getTokenSupply к соответствующему кластеру. */
const TOKENS: Record<Cluster, Record<TokenSymbol, TokenInfo>> = {
  mainnet: {
    USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    SOL: { decimals: 9 },
  },
  devnet: {
    USDC: { mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 },
    SOL: { decimals: 9 },
  },
};

export function resolveToken(cluster: Cluster, token: TokenSymbol): TokenInfo {
  const info = TOKENS[cluster]?.[token];
  if (!info) throw new ConfigError(`Неизвестный токен ${token} в кластере ${cluster}`);
  return info;
}

/** Срок жизни котировки по умолчанию — 15 минут. */
export const DEFAULT_QUOTE_TTL_MS = 15 * 60 * 1000;

/** Таймаут запроса к источнику курса. */
export const DEFAULT_RATE_TIMEOUT_MS = 10_000;
