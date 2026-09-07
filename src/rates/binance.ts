import type { TokenSymbol } from '../config.js';
import { DEFAULT_RATE_TIMEOUT_MS } from '../config.js';
import { RateSourceError } from '../errors.js';
import { multiplyRates } from '../money.js';
import { fetchJson } from './http.js';
import type { RateSource } from './types.js';

const ENDPOINT = 'https://api.binance.com/api/v3/ticker/price';

/**
 * Основной источник курса.
 *
 * На Binance существует ровно одна пара с тенге — USDTKZT, поэтому курс
 * токена собирается из двух тикеров: USDTKZT × USDCUSDT для USDC и
 * USDTKZT × SOLUSDT для SOL.
 */
export class BinanceRateSource implements RateSource {
  readonly name = 'binance';

  constructor(private readonly timeoutMs: number = DEFAULT_RATE_TIMEOUT_MS) {}

  async getKztPerToken(token: TokenSymbol): Promise<string> {
    const [kztPerUsdt, usdtPerToken] = await Promise.all([
      this.fetchPrice('USDTKZT'),
      this.fetchPrice(token === 'USDC' ? 'USDCUSDT' : 'SOLUSDT'),
    ]);
    return multiplyRates(kztPerUsdt, usdtPerToken);
  }

  private async fetchPrice(symbol: string): Promise<string> {
    const data = await fetchJson(`${ENDPOINT}?symbol=${symbol}`, this.timeoutMs);
    // Проверяем, что data - объект (не null, не массив, не примитив)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new RateSourceError(`Binance ${symbol}: ответ не является объектом`);
    }
    const price = (data as { price?: unknown }).price;
    if (typeof price !== 'string') {
      throw new RateSourceError(`Binance ${symbol}: непригодная цена ${JSON.stringify(price)}`);
    }
    // Проверяем формат: только цифры, опциональная точка, цифры
    if (!/^\d+(\.\d+)?$/.test(price)) {
      throw new RateSourceError(`Binance ${symbol}: непригодная цена ${JSON.stringify(price)}`);
    }
    // Проверяем, что число положительное
    if (!(Number(price) > 0)) {
      throw new RateSourceError(`Binance ${symbol}: непригодная цена ${JSON.stringify(price)}`);
    }
    return price;
  }
}
