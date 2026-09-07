import { describe, expect, it } from 'vitest';
import { QuoteExpiredError } from '../src/errors.js';
import { createPaymentRequest, generateReference } from '../src/payment/request.js';
import type { Quote } from '../src/quote/quote.js';

const RECIPIENT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
    expect(request.url).toContain('spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(request.url).toContain(`reference=${request.reference}`);
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
});
