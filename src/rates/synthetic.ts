import type { TokenSymbol } from '../config.js';
import { DEFAULT_RATE_TIMEOUT_MS } from '../config.js';
import { RateSourceError } from '../errors.js';
import { RATE_DECIMALS, isValidDecimalFormat, multiplyRates } from '../money.js';
import { fetchJson } from './http.js';
import type { RateSource } from './types.js';

const FX_ENDPOINT = 'https://open.er-api.com/v6/latest/USD';
const COINGECKO_ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';

const COINGECKO_IDS: Record<TokenSymbol, string> = {
  USDC: 'usd-coin',
  SOL: 'solana',
};

/**
 * Резервный источник курса: USD/KZT × цена токена в USD.
 *
 * Прямой запрос цены в тенге у CoinGecko невозможен — тенге отсутствует
 * в списке поддерживаемых валют, а запрос возвращает HTTP 200 и пустой
 * объект. Поэтому тенге берётся отдельно, у поставщика курсов валют.
 */
export class SyntheticRateSource implements RateSource {
  readonly name = 'synthetic';

  constructor(private readonly timeoutMs: number = DEFAULT_RATE_TIMEOUT_MS) {}

  async getKztPerToken(token: TokenSymbol): Promise<string> {
    const [kztPerUsd, usdPerToken] = await Promise.all([
      this.fetchKztPerUsd(),
      this.fetchUsdPerToken(token),
    ]);
    return multiplyRates(kztPerUsd, usdPerToken);
  }

  private async fetchKztPerUsd(): Promise<string> {
    const data = await fetchJson(FX_ENDPOINT, this.timeoutMs);
    assertIsObject(data, 'Курс валют: ответ не является объектом');
    const typedData = data as {
      result?: unknown;
      rates?: Record<string, unknown>;
    };
    if (typedData.result !== 'success') {
      throw new RateSourceError(`Курс валют: ответ не success (${String(typedData.result)})`);
    }
    return toRateString(typedData.rates?.['KZT'], 'Курс валют');
  }

  private async fetchUsdPerToken(token: TokenSymbol): Promise<string> {
    const id = COINGECKO_IDS[token];
    const url = `${COINGECKO_ENDPOINT}?ids=${id}&vs_currencies=usd`;
    const data = await fetchJson(url, this.timeoutMs);
    assertIsObject(data, 'CoinGecko: ответ не является объектом');
    const typedData = data as Record<string, { usd?: unknown }>;
    // CoinGecko на неподдерживаемую валюту отвечает HTTP 200 и пустым объектом:
    // {"usd-coin":{}}. Это отказ источника, а не нулевая цена.
    return toRateString(typedData[id]?.usd, `CoinGecko`);
  }
}

/** Проверяет что значение - объект (не null, не массив, не примитив). */
function assertIsObject(data: unknown, errorMessage: string): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RateSourceError(errorMessage);
  }
}

/** Приводит число к строке курса, отвергая всё непригодное. */
function toRateString(value: unknown, source: string): string {
  // Проверяем, что это число
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RateSourceError(`${source}: непригодное значение ${JSON.stringify(value)}`);
  }

  // Форматируем в строку курса
  const formatted = value.toFixed(RATE_DECIMALS);

  // Проверяем что после форматирования строка остаётся валидной десятичной
  if (!isValidDecimalFormat(formatted)) {
    throw new RateSourceError(`${source}: непригодное значение после форматирования ${JSON.stringify(value)} -> "${formatted}"`);
  }

  // Проверяем что результат не нулевой (от очень маленьких чисел toFixed может вернуть "0.00000000")
  if (Number(formatted) === 0) {
    throw new RateSourceError(`${source}: значение округлилось до нуля ${JSON.stringify(value)}`);
  }

  return formatted;
}
