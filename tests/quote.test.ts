import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateProvider } from '../src/rates/provider.js';
import { createQuote, isQuoteExpired } from '../src/quote/quote.js';
import type { RateSource } from '../src/rates/types.js';
import { ConfigError, RateUnavailableError } from '../src/errors.js';

function providerWith(rate: string): RateProvider {
  const source: RateSource = { name: 'test', getKztPerToken: async () => rate };
  return new RateProvider([source], 0);
}

afterEach(() => vi.useRealTimers());

describe('создание котировки', () => {
  it('конвертирует сумму и заполняет поля', async () => {
    const quote = await createQuote({
      amountKzt: '10000',
      token: 'USDC',
      cluster: 'mainnet',
      rateProvider: providerWith('459.60000000'),
    });

    expect(quote.amountToken).toBe('21.758051');
    expect(quote.amountKzt).toBe('10000');
    expect(quote.token).toBe('USDC');
    expect(quote.rate).toBe('459.60000000');
    expect(quote.rateSource).toBe('test');
    expect(quote.quoteId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('срок жизни по умолчанию — 15 минут', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'));

    const quote = await createQuote({
      amountKzt: '10000',
      token: 'USDC',
      cluster: 'mainnet',
      rateProvider: providerWith('459.60000000'),
    });

    expect(quote.createdAt).toBe('2026-09-07T10:00:00.000Z');
    expect(quote.expiresAt).toBe('2026-09-07T10:15:00.000Z');
  });

  it('применяет наценку продавца к сумме в тенге', async () => {
    const quote = await createQuote({
      amountKzt: '10000',
      token: 'USDC',
      cluster: 'mainnet',
      markupPercent: 1,
      rateProvider: providerWith('459.60000000'),
    });
    // 10100.00 / 459.60 с округлением вверх
    expect(quote.amountToken).toBe('21.975631');
  });

  it('считает SOL с девятью знаками', async () => {
    const quote = await createQuote({
      amountKzt: '10000',
      token: 'SOL',
      cluster: 'mainnet',
      rateProvider: providerWith('47758.44000000'),
    });
    expect(quote.amountToken).toBe('0.209387074');
  });
});

describe('срок жизни котировки', () => {
  it('свежая котировка не просрочена', async () => {
    const quote = await createQuote({
      amountKzt: '100',
      token: 'USDC',
      cluster: 'mainnet',
      rateProvider: providerWith('459.60000000'),
    });
    expect(isQuoteExpired(quote)).toBe(false);
  });

  it('на границе срока котировка уже просрочена', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'));
    const quote = await createQuote({
      amountKzt: '100',
      token: 'USDC',
      cluster: 'mainnet',
      rateProvider: providerWith('459.60000000'),
    });

    expect(isQuoteExpired(quote, Date.parse('2026-09-07T10:14:59.999Z'))).toBe(false);
    expect(isQuoteExpired(quote, Date.parse('2026-09-07T10:15:00.000Z'))).toBe(true);
  });
});

describe('защита от неверных входов', () => {
  it('валидирует входные данные ДО запроса курса', async () => {
    const getKztPerTokenMock = vi.fn().mockResolvedValue('459.60000000');
    const source: RateSource = { name: 'test', getKztPerToken: getKztPerTokenMock };
    const provider = new RateProvider([source], 0);

    await expect(
      createQuote({
        amountKzt: 'invalid',
        token: 'USDC',
        cluster: 'mainnet',
        rateProvider: provider,
      }),
    ).rejects.toThrow(ConfigError);

    expect(getKztPerTokenMock).not.toHaveBeenCalled();
  });

  it('замораживает возвращённый объект котировки', async () => {
    const quote = await createQuote({
      amountKzt: '10000',
      token: 'USDC',
      cluster: 'mainnet',
      rateProvider: providerWith('459.60000000'),
    });

    expect(() => {
      (quote as any).amountToken = '999.999999';
    }).toThrow();
  });

  it('отвергает недоступный источник курса', async () => {
    const source: RateSource = {
      name: 'failing',
      getKztPerToken: async () => {
        throw new Error('Network error');
      },
    };
    const provider = new RateProvider([source], 0);

    await expect(
      createQuote({
        amountKzt: '10000',
        token: 'USDC',
        cluster: 'mainnet',
        rateProvider: provider,
      }),
    ).rejects.toThrow(RateUnavailableError);
  });

  it('отвергает нулевой срок жизни', async () => {
    await expect(
      createQuote({
        amountKzt: '10000',
        token: 'USDC',
        cluster: 'mainnet',
        rateProvider: providerWith('459.60000000'),
        ttlMs: 0,
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('отвергает отрицательный срок жизни', async () => {
    await expect(
      createQuote({
        amountKzt: '10000',
        token: 'USDC',
        cluster: 'mainnet',
        rateProvider: providerWith('459.60000000'),
        ttlMs: -1000,
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('отвергает нулевую сумму', async () => {
    await expect(
      createQuote({
        amountKzt: '0',
        token: 'USDC',
        cluster: 'mainnet',
        rateProvider: providerWith('459.60000000'),
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('отвергает нулевую сумму в других форматах', async () => {
    for (const zeroForm of ['0.00', '0.0']) {
      await expect(
        createQuote({
          amountKzt: zeroForm,
          token: 'USDC',
          cluster: 'mainnet',
          rateProvider: providerWith('459.60000000'),
        }),
      ).rejects.toThrow(ConfigError);
    }
  });
});
