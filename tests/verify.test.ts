import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { checkPayment } from '../src/verify/verify.js';
import type { Quote } from '../src/quote/quote.js';

// Валидный Solana-адрес продавца, специально НЕ совпадающий с mint USDC
// (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v из config.ts).
const RECIPIENT = '11111111111111111111111111111111';
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
      cluster: 'mainnet',
    });
    expect(status).toEqual({ status: 'pending' });
  });

  it('возвращает expired, когда срок вышел и платежа нет', async () => {
    vi.mocked(findReference).mockRejectedValueOnce(new FindReferenceError('не найдено'));

    const status = await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      recipient: RECIPIENT,
      cluster: 'mainnet',
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
      cluster: 'mainnet',
    });
    expect(status).toEqual({
      status: 'confirmed',
      signature: 'sig123',
      amountPaid: '21.758051',
    });
  });

  it('передаёт в validateTransfer правильные получателя, сумму, монету и метку', async () => {
    vi.mocked(findReference).mockResolvedValueOnce({ signature: 'sig123' } as never);
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    const call = vi.mocked(validateTransfer).mock.calls[0];
    // Второй позиционный аргумент validateTransfer — найденная подпись.
    expect(call?.[1]).toBe('sig123');
    // Третий — критерии сверки: та самая строка, где решается «свой платёж
    // или чужой». Если сюда попадёт не то поле (например, amountKzt вместо
    // amountToken), платежи будут молча приниматься или отвергаться неверно.
    expect(call?.[2]).toMatchObject({
      recipient: RECIPIENT,
      amount: Number('21.758051'),
      splToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      reference: REFERENCE,
    });
  });

  it('подтверждает платёж, пришедший после истечения котировки', async () => {
    vi.mocked(findReference).mockResolvedValueOnce({ signature: 'sig456' } as never);
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment({} as never, {
      reference: REFERENCE,
      quote: quoteFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      recipient: RECIPIENT,
      cluster: 'mainnet',
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
      cluster: 'mainnet',
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
      cluster: 'mainnet',
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
        cluster: 'mainnet',
      }),
    ).rejects.toThrow('сеть недоступна');
  });

  it('выбрасывает ConfigError сразу для невалидного recipient, не обращаясь к блокчейну', async () => {
    await expect(
      checkPayment({} as never, {
        reference: REFERENCE,
        quote: quoteFixture(),
        recipient: 'не-валидный-адрес',
        cluster: 'mainnet',
      }),
    ).rejects.toThrow(ConfigError);

    // Ошибка конфигурации всплывает раньше любого сетевого вызова.
    expect(findReference).not.toHaveBeenCalled();
    expect(validateTransfer).not.toHaveBeenCalled();
  });

  it('выбрасывает ConfigError сразу для невалидного reference, не обращаясь к блокчейну', async () => {
    await expect(
      checkPayment({} as never, {
        reference: 'не-валидная-метка',
        quote: quoteFixture(),
        recipient: RECIPIENT,
        cluster: 'mainnet',
      }),
    ).rejects.toThrow(ConfigError);

    expect(findReference).not.toHaveBeenCalled();
    expect(validateTransfer).not.toHaveBeenCalled();
  });

  describe('сверка кластера котировки с кластером клиента', () => {
    it('выбрасывает ConfigError, когда кластер котировки не совпадает с кластером клиента', async () => {
      await expect(
        checkPayment({} as never, {
          reference: REFERENCE,
          quote: quoteFixture({ cluster: 'devnet' }),
          recipient: RECIPIENT,
          cluster: 'mainnet',
        }),
      ).rejects.toThrow(ConfigError);

      expect(findReference).not.toHaveBeenCalled();
      expect(validateTransfer).not.toHaveBeenCalled();
    });

    it('не бросает ошибку, когда кластеры совпадают', async () => {
      vi.mocked(findReference).mockRejectedValueOnce(new FindReferenceError('не найдено'));

      const status = await checkPayment({} as never, {
        reference: REFERENCE,
        quote: quoteFixture({ cluster: 'mainnet' }),
        recipient: RECIPIENT,
        cluster: 'mainnet',
      });
      expect(status).toEqual({ status: 'pending' });
    });
  });

  describe('проверяет котировку до любых других действий (чужая база)', () => {
    it.each([
      ['null', null as unknown as string],
      ['undefined', undefined as unknown as string],
      ['пустая строка', ''],
      ['"0"', '0'],
      ['"abc"', 'abc'],
      ['отрицательное значение', '-5'],
    ])('отвергает amountToken === %s', async (_label, amountToken) => {
      await expect(
        checkPayment({} as never, {
          reference: REFERENCE,
          quote: quoteFixture({ amountToken }),
          recipient: RECIPIENT,
          cluster: 'mainnet',
        }),
      ).rejects.toThrow(ConfigError);

      expect(findReference).not.toHaveBeenCalled();
      expect(validateTransfer).not.toHaveBeenCalled();
    });
  });
});
