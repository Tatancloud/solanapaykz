import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateSourceError } from '../../src/errors.js';
import { SyntheticRateSource } from '../../src/rates/synthetic.js';

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

describe('SyntheticRateSource', () => {
  it('собирает курс USDC из USD/KZT и цены токена в USD', async () => {
    mockFetch({
      'open.er-api.com': { body: { result: 'success', rates: { KZT: 455.296 } } },
      'coingecko': { body: { 'usd-coin': { usd: 1.0 } } },
    });
    expect(await new SyntheticRateSource().getKztPerToken('USDC')).toBe('455.29600000');
  });

  it('собирает курс SOL', async () => {
    mockFetch({
      'open.er-api.com': { body: { result: 'success', rates: { KZT: 455.296 } } },
      'coingecko': { body: { solana: { usd: 103.9 } } },
    });
    expect(await new SyntheticRateSource().getKztPerToken('SOL')).toBe('47305.25440000');
  });

  it('считает молчаливый отказ CoinGecko ошибкой источника', async () => {
    mockFetch({
      'open.er-api.com': { body: { result: 'success', rates: { KZT: 455.296 } } },
      'coingecko': { body: { 'usd-coin': {} } },
    });
    await expect(new SyntheticRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает, когда в ответе FX нет тенге', async () => {
    mockFetch({
      'open.er-api.com': { body: { result: 'success', rates: { EUR: 0.9 } } },
      'coingecko': { body: { 'usd-coin': { usd: 1.0 } } },
    });
    await expect(new SyntheticRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('падает на неуспешном ответе FX', async () => {
    mockFetch({
      'open.er-api.com': { body: { result: 'error' } },
      'coingecko': { body: { 'usd-coin': { usd: 1.0 } } },
    });
    await expect(new SyntheticRateSource().getKztPerToken('USDC'))
      .rejects.toThrow(RateSourceError);
  });

  it('имеет имя для аудита', () => {
    expect(new SyntheticRateSource().name).toBe('synthetic');
  });
});
