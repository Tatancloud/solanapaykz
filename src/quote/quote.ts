import type { Cluster, TokenSymbol } from '../config.js';
import { DEFAULT_QUOTE_TTL_MS, resolveToken } from '../config.js';
import { applyMarkup, convertKztToTokenUnits, formatUnits } from '../money.js';
import type { RateProvider } from '../rates/provider.js';

export interface Quote {
  /** Идентификатор для связи с заказом на стороне продавца. */
  readonly quoteId: string;
  /** Исходная сумма в тенге, как её передал продавец. */
  readonly amountKzt: string;
  /** Сумма в тенге после наценки — по ней считался токен. */
  readonly amountKztCharged: string;
  readonly token: TokenSymbol;
  readonly cluster: Cluster;
  /** Сумма к оплате, строкой с точностью токена. */
  readonly amountToken: string;
  /** Тенге за один токен на момент создания. */
  readonly rate: string;
  /** Имя источника курса — для разбора спорных ситуаций. */
  readonly rateSource: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateQuoteParams {
  amountKzt: string;
  token: TokenSymbol;
  cluster: Cluster;
  rateProvider: RateProvider;
  markupPercent?: number;
  ttlMs?: number;
}

export async function createQuote(params: CreateQuoteParams): Promise<Quote> {
  const { amountKzt, token, cluster, rateProvider } = params;
  const ttlMs = params.ttlMs ?? DEFAULT_QUOTE_TTL_MS;
  const markupPercent = params.markupPercent ?? 0;

  const { rate, source } = await rateProvider.getKztPerToken(token);
  const { decimals } = resolveToken(cluster, token);

  const amountKztCharged = applyMarkup(amountKzt, markupPercent);
  const units = convertKztToTokenUnits(amountKztCharged, rate, decimals);

  const createdAt = new Date();
  return {
    // crypto.randomUUID доступен и в Node 18+, и в браузере — импорт из
    // node:crypto сломал бы работу SDK на стороне клиента.
    quoteId: crypto.randomUUID(),
    amountKzt,
    amountKztCharged,
    token,
    cluster,
    amountToken: formatUnits(units, decimals),
    rate,
    rateSource: source,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
}

/** Котировка считается просроченной начиная с момента expiresAt включительно. */
export function isQuoteExpired(quote: Quote, now: number = Date.now()): boolean {
  return now >= Date.parse(quote.expiresAt);
}
