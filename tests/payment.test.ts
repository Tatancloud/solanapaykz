import { describe, expect, it } from 'vitest';
import { ConfigError, QuoteExpiredError } from '../src/errors.js';
import { createPaymentRequest, generateReference } from '../src/payment/request.js';
import type { Quote } from '../src/quote/quote.js';

// Валидный Solana-адрес продавца, специально НЕ совпадающий с mint USDC
// (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v из config.ts) — тест должен
// уметь отличить перепутанные местами получателя и монету.
const RECIPIENT = '11111111111111111111111111111111';
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function quoteFixture(overrides: Partial<Quote> = {}): Quote {
  const now = Date.now();
  return {
    quoteId: '11111111-2222-3333-4444-555555555555',
    amountKzt: '10000',
    amountKztCharged: '10000.00',
    token: 'USDC',
    cluster: 'mainnet',
    amountToken: '21.758051',
    rate: '459.60000000',
    rateSource: 'binance',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 900_000).toISOString(),
    ...overrides,
  };
}

describe('генерация reference', () => {
  it('возвращает валидный адрес base58', () => {
    const ref = generateReference();
    expect(ref).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it('каждый вызов даёт новый reference', () => {
    expect(generateReference()).not.toBe(generateReference());
  });
});

describe('создание платёжного запроса', () => {
  it('собирает URL по спецификации Solana Pay', async () => {
    const request = await createPaymentRequest(quoteFixture(), {
      recipient: RECIPIENT,
      label: 'Магазин',
      message: 'Заказ №123',
    });

    expect(request.url).toContain(`solana:${RECIPIENT}`);
    expect(request.url).toContain('amount=21.758051');
    expect(request.url).toContain(`spl-token=${USDC_MINT_MAINNET}`);
    expect(request.url).toContain(`reference=${request.reference}`);
    // Получатель и mint — разные адреса: тест ловит перепутанные местами
    // получателя платежа и служебный адрес монеты.
    expect(RECIPIENT).not.toBe(USDC_MINT_MAINNET);
  });

  it('для SOL не добавляет spl-token', async () => {
    const quote = quoteFixture({ token: 'SOL', amountToken: '0.209387074' });
    const request = await createPaymentRequest(quote, { recipient: RECIPIENT });
    expect(request.url).not.toContain('spl-token');
  });

  it('рисует QR строкой SVG и делает это в Node', async () => {
    const request = await createPaymentRequest(quoteFixture(), { recipient: RECIPIENT });
    expect(request.qrSvg.startsWith('<svg')).toBe(true);
    expect(request.qrSvg.length).toBeGreaterThan(500);
  });

  it('отказывается работать с просроченной котировкой', async () => {
    const expired = quoteFixture({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(createPaymentRequest(expired, { recipient: RECIPIENT }))
      .rejects.toThrow(QuoteExpiredError);
  });

  describe('проверяет котировку до любых других действий (чужая база)', () => {
    it('отвергает amountToken === null', async () => {
      const quote = quoteFixture({ amountToken: null as unknown as string });
      await expect(createPaymentRequest(quote, { recipient: RECIPIENT }))
        .rejects.toThrow(ConfigError);
    });

    it('отвергает amountToken === undefined', async () => {
      const quote = quoteFixture({ amountToken: undefined as unknown as string });
      await expect(createPaymentRequest(quote, { recipient: RECIPIENT }))
        .rejects.toThrow(ConfigError);
    });

    it('отвергает amountToken === пустая строка', async () => {
      const quote = quoteFixture({ amountToken: '' });
      await expect(createPaymentRequest(quote, { recipient: RECIPIENT }))
        .rejects.toThrow(ConfigError);
    });

    it('отвергает amountToken === "0"', async () => {
      const quote = quoteFixture({ amountToken: '0' });
      await expect(createPaymentRequest(quote, { recipient: RECIPIENT }))
        .rejects.toThrow(ConfigError);
    });

    it('отвергает amountToken === "abc"', async () => {
      const quote = quoteFixture({ amountToken: 'abc' });
      await expect(createPaymentRequest(quote, { recipient: RECIPIENT }))
        .rejects.toThrow(ConfigError);
    });

    it('отвергает отрицательный amountToken', async () => {
      const quote = quoteFixture({ amountToken: '-5' });
      await expect(createPaymentRequest(quote, { recipient: RECIPIENT }))
        .rejects.toThrow(ConfigError);
    });
  });
});
