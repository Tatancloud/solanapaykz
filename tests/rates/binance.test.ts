import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateSourceError } from '../../src/errors.js';
import { BinanceRateSource } from '../../src/rates/binance.js';

/** Подменяет глобальный fetch картой «часть URL → ответ». */
function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`Неожиданный запрос: ${url}`);
    const route = routes[key]!;
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('BinanceRateSource', () => {
  it('считает курс USDC через USDTKZT и USDCUSDT', async () => {
    mockFetch({
      'symbol=USDTKZT': { body: { symbol: 'USDTKZT', price: '459.60000000' } },
      'symbol=USDCUSDT': { body: { symbol: 'USDCUSDT', price: '1.00008000' } },
    });
    const rate = await new BinanceRateSource().getKztPerToken('USDC');
    expect(rate).toBe('459.63676800');
  });

  it('считает курс SOL через USDTKZT и SOLUSDT', async () => {
    mockFetch({
      'symbol=USDTKZT': { body: { symbol: 'USDTKZT', price: '459.60000000' } },
      'symbol=SOLUSDT': { body: { symbol: 'SOLUSDT', price: '103.90000000' } },
    });
    const rate = await new BinanceRateSource().getKztPerToken('SOL');
    expect(rate).toBe('47752.44000000');
  });

  it('падает на ошибке HTTP', async () => {
    mockFetch({ 'symbol=USDTKZT': { status: 502, body: { msg: 'bad gateway' } } });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает, когда в ответе нет поля price', async () => {
    mockFetch({ 'symbol=USDTKZT': { body: {} } });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает на нулевом курсе', async () => {
    mockFetch({
      'symbol=USDTKZT': { body: { price: '0' } },
      'symbol=USDCUSDT': { body: { price: '1.00000000' } },
    });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает, когда тело ответа null', async () => {
    mockFetch({ 'symbol=USDTKZT': { body: null } });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает, когда тело ответа массив', async () => {
    mockFetch({ 'symbol=USDTKZT': { body: [] } });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает на экспоненциальной нотации price', async () => {
    mockFetch({
      'symbol=USDTKZT': { body: { price: '1e400' } },
      'symbol=USDCUSDT': { body: { price: '1.00000000' } },
    });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает на Infinity', async () => {
    mockFetch({
      'symbol=USDTKZT': { body: { price: 'Infinity' } },
      'symbol=USDCUSDT': { body: { price: '1.00000000' } },
    });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает на цене с пробелами', async () => {
    mockFetch({
      'symbol=USDTKZT': { body: { price: ' 1.5 ' } },
      'symbol=USDCUSDT': { body: { price: '1.00000000' } },
    });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает, когда второй запрос падает при первом успешном', async () => {
    mockFetch({
      'symbol=USDTKZT': { body: { price: '459.60000000' } },
      'symbol=USDCUSDT': { status: 502, body: { msg: 'bad gateway' } },
    });
    await expect(new BinanceRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('имеет имя для аудита', () => {
    expect(new BinanceRateSource().name).toBe('binance');
  });
});
