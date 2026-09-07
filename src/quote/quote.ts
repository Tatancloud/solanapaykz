import type { Cluster, TokenSymbol } from '../config.js';
import { DEFAULT_QUOTE_TTL_MS, resolveToken } from '../config.js';
import {
  applyMarkup,
  convertKztToTokenUnits,
  formatUnits,
  isValidDecimalFormat,
  parseDecimalToUnits,
} from '../money.js';
import { ConfigError } from '../errors.js';
import type { RateProvider } from '../rates/provider.js';
import { KZT_DECIMALS } from '../money.js';

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

  // Валидация TTL перед дорогими операциями.
  if (ttlMs <= 0) {
    throw new ConfigError(
      `Срок жизни котировки должен быть положительным, получено ${ttlMs} мс`,
    );
  }

  // Дешёвые валидации перед сетевым запросом.
  const { decimals } = resolveToken(cluster, token);
  const amountKztCharged = applyMarkup(amountKzt, markupPercent);

  // Проверка нулевой суммы (после применения наценки).
  const chargedUnits = parseDecimalToUnits(amountKztCharged, KZT_DECIMALS, {
    allowTruncation: false,
  });
  if (chargedUnits === 0n) {
    throw new ConfigError('Сумма котировки не может быть нулевой');
  }

  // Только после всех синхронных проверок — сетевой запрос.
  const { rate, source } = await rateProvider.getKztPerToken(token);
  const units = convertKztToTokenUnits(amountKztCharged, rate, decimals);

  const createdAt = new Date();
  const quote: Quote = {
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

  // Замораживаем объект, чтобы предотвратить случайное или намеренное
  // изменение данных котировки после создания.
  return Object.freeze(quote);
}

/** Котировка считается просроченной начиная с момента expiresAt включительно. */
export function isQuoteExpired(quote: Quote, now: number = Date.now()): boolean {
  return now >= Date.parse(quote.expiresAt);
}

/**
 * Проверяет, что котировка не испорчена, прежде чем её содержимое пойдёт в
 * платёжную ссылку или в проверку транзакции.
 *
 * Котировка приходит извне: продавец хранит её у себя (в своей БД) и
 * возвращает SDK при создании платёжного запроса или проверке платежа. SDK
 * не может доверять этим данным так же, как данным, которые сам только что
 * создал — пустая колонка после миграции, повреждённая запись или чужой
 * кластер не должны превращаться в «подтверждён любой платёж» или в
 * нечитаемый QR.
 *
 * Вызывается в начале createPaymentRequest и checkPayment, до любых других
 * действий (в частности, до сетевых запросов).
 */
export function assertValidQuote(quote: Quote): void {
  // resolveToken бросает ConfigError на неизвестном token/cluster — это же
  // проверяет, что котировка ссылается на реальную пару токен/кластер, а не
  // на произвольную строку.
  const { decimals } = resolveToken(quote.cluster, quote.token);

  if (typeof quote.amountToken !== 'string' || !isValidDecimalFormat(quote.amountToken)) {
    throw new ConfigError(
      'Котировка испорчена: amountToken должен быть строкой в допустимом ' +
      `десятичном формате, получено ${JSON.stringify(quote.amountToken)}. ` +
      'Похоже, котировка была повреждена в хранилище продавца (например, ' +
      'пустая колонка после миграции).',
    );
  }

  const units = parseDecimalToUnits(quote.amountToken, decimals);
  if (units <= 0n) {
    throw new ConfigError(
      `Котировка испорчена: amountToken должен быть строго больше нуля, ` +
      `получено "${quote.amountToken}".`,
    );
  }
}
