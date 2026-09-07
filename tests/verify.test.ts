import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPayment } from '../src/verify/verify.js';
import type { Quote } from '../src/quote/quote.js';

const RECIPIENT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REFERENCE = 'DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh';

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

vi.mock('@solana/pay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/pay')>();
  return { ...actual, findReference: vi.fn(), validateTransfer: vi.fn() };
});

const { findReference, validateTransfer, FindReferenceError, ValidateTransferError } =
  await import('@solana/pay');

describe('проверка платежа', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('возвращает pending, когда транзакции ещё нет', async () => {
    vi.mocked(findReference).mockRejectedValueOnce(new FindReferenceError('не найдено'));

    const status = await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
    });
    expect(status).toEqual({ status: 'pending' });
  });

  it('возвращает expired, когда срок вышел и платежа нет', async () => {
    vi.mocked(findReference).mockRejectedValueOnce(new FindReferenceError('не найдено'));

    const status = await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      recipient: RECIPIENT,
    });
    expect(status).toEqual({ status: 'expired' });
  });

  it('возвращает confirmed при успешной проверке', async () => {
    vi.mocked(findReference).mockResolvedValueOnce({ signature: 'sig123' } as never);
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
    });
    expect(status).toEqual({
      status: 'confirmed',
      signature: 'sig123',
      amountPaid: '21.758051',
    });
  });

  it('подтверждает платёж, пришедший после истечения котировки', async () => {
    vi.mocked(findReference).mockResolvedValueOnce({ signature: 'sig456' } as never);
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      recipient: RECIPIENT,
    });
    // Транзакция в блокчейне необратима — отменить её SDK не может.
    expect(status.status).toBe('confirmed');
  });

  it('возвращает mismatch, когда транзакция не проходит проверку', async () => {
    vi.mocked(findReference).mockResolvedValueOnce({ signature: 'sig789' } as never);
    vi.mocked(validateTransfer).mockRejectedValueOnce(
      new ValidateTransferError('сумма не совпадает'),
    );

    const status = await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
    });
    expect(status).toMatchObject({ status: 'mismatch', signature: 'sig789' });
  });

  it('запрашивает подтверждение уровня finalized', async () => {
    vi.mocked(findReference).mockResolvedValueOnce({ signature: 'sig' } as never);
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
    });

    expect(vi.mocked(validateTransfer).mock.calls[0]?.[3])
      .toEqual({ commitment: 'finalized' });
  });

  it('пробрасывает ошибку validateTransfer, если это не ValidateTransferError', async () => {
    vi.mocked(findReference).mockResolvedValueOnce({ signature: 'sig999' } as never);
    vi.mocked(validateTransfer).mockRejectedValueOnce(new Error('сеть недоступна'));

    // Сбой сети/RPC внутри validateTransfer — не то же самое, что несовпадение
    // платежа: он должен пробрасываться наружу, а не превращаться в mismatch,
    // иначе временный сбой сети будет выглядеть как поддельный платёж.
    await expect(
      checkPayment({} as never, {
        reference: REFERENCE,
        quote: quoteFixture(),
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow('сеть недоступна');
  });

  it('выбрасывает ошибку сразу для невалидного recipient, не обращаясь к блокчейну', async () => {
    await expect(
      checkPayment({} as never, {
        reference: REFERENCE,
        quote: quoteFixture(),
        recipient: 'не-валидный-адрес',
      }),
    ).rejects.toThrow();

    // Ошибка конфигурации всплывает раньше любого сетевого вызова.
    expect(findReference).not.toHaveBeenCalled();
    expect(validateTransfer).not.toHaveBeenCalled();
  });
});
