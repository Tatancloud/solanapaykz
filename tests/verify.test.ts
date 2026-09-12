import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { checkPayment, SIGNATURE_LIMIT } from '../src/verify/verify.js';
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
  return { ...actual, validateTransfer: vi.fn() };
});

const { validateTransfer, ValidateTransferError } = await import('@solana/pay');

/** Одна запись из ответа getSignaturesForAddress — только то, что нам нужно. */
function signatureEntry(signature: string) {
  return { signature } as never;
}

/**
 * RPC-заглушка: getSignaturesForAddress отдаёт заранее заданный список подписей
 * (в порядке «от новых к старым», как настоящий узел), getTransaction отдаёт
 * тело транзакции по подписи или null, если его пока нет — оба вызова
 * реализуют не sdk @solana/pay, а сам checkPayment, поэтому мокать нужно их,
 * а не библиотечную findReference (её здесь больше нет).
 */
function fakeRpc(options: { signatures: string[]; bodies?: Record<string, unknown> }) {
  const getSignaturesForAddress = vi.fn(() => ({
    send: () => Promise.resolve(options.signatures.map(signatureEntry)),
  }));
  const getTransaction = vi.fn((signature: string) => ({
    send: () => Promise.resolve(options.bodies?.[signature] ?? null),
  }));
  return { getSignaturesForAddress, getTransaction } as never;
}

const TX_BODY = { meta: { err: null } };

describe('проверка платежа', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('возвращает pending, когда по метке нет ни одной подписи', async () => {
    const rpc = fakeRpc({ signatures: [] });

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });
    expect(status).toEqual({ status: 'pending', truncated: false });
    expect(validateTransfer).not.toHaveBeenCalled();
  });

  it('возвращает expired, когда срок вышел и подписей нет', async () => {
    const rpc = fakeRpc({ signatures: [] });

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });
    expect(status).toEqual({ status: 'expired', truncated: false });
  });

  it('возвращает confirmed, когда единственный кандидат проходит проверку', async () => {
    const rpc = fakeRpc({ signatures: ['sig123'], bodies: { sig123: TX_BODY } });
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });
    expect(status).toEqual({
      status: 'confirmed',
      signature: 'sig123',
      amountPaid: '21.758051',
      truncated: false,
    });
  });

  it('первая (по времени) транзакция провалилась (meta.err), вторая успешна — платёж засчитан', async () => {
    // Узел отдаёт подписи от новых к старым: sig-new — самая свежая,
    // sig-old — самая старая. Кошелёк сначала отправил sig-old — она
    // протухла (например, не хватило на комиссию), — и лишь потом успешно
    // повторил платёж как sig-new. Перебор идёт от старых к новым: sig-old
    // проверяется первой и отбраковывается, sig-new — вторая и подтверждает
    // платёж.
    const rpc = fakeRpc({
      signatures: ['sig-new', 'sig-old'],
      bodies: { 'sig-new': TX_BODY, 'sig-old': TX_BODY },
    });
    vi.mocked(validateTransfer)
      .mockRejectedValueOnce(new ValidateTransferError('транзакция завершилась с ошибкой'))
      .mockResolvedValueOnce({} as never);

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    expect(status).toMatchObject({ status: 'confirmed', signature: 'sig-new' });
    // Перебор идёт от старых к новым — старая подпись проверяется первой.
    expect(vi.mocked(validateTransfer).mock.calls[0]?.[1]).toBe('sig-old');
    expect(vi.mocked(validateTransfer).mock.calls[1]?.[1]).toBe('sig-new');
  });

  it('первая (по времени) транзакция посторонняя (не та сумма), вторая наша — засчитан', async () => {
    // sig-old — чужая или заниженная транзакция по той же метке, отправленная
    // раньше настоящего платежа (sig-new). Найти её первой и остановиться на
    // ней — и есть ошибка findReference, которую эта правка устраняет.
    const rpc = fakeRpc({
      signatures: ['sig-new', 'sig-old'],
      bodies: { 'sig-new': TX_BODY, 'sig-old': TX_BODY },
    });
    vi.mocked(validateTransfer)
      .mockRejectedValueOnce(new ValidateTransferError('amount not transferred'))
      .mockResolvedValueOnce({} as never);

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    expect(status).toMatchObject({ status: 'confirmed', signature: 'sig-new' });
  });

  it('тела первой транзакции нет, вторая успешна — засчитан, а не mismatch', async () => {
    // sig-old (старейшая) уже в истории по метке, но узел ещё не раздаёт её
    // тело для finalized — это ожидание, а не несовпадение: validateTransfer
    // для неё вообще не должен вызываться.
    const rpc = fakeRpc({
      signatures: ['sig-new', 'sig-old'],
      bodies: { 'sig-new': TX_BODY }, // sig-old намеренно отсутствует
    });
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    expect(status).toMatchObject({ status: 'confirmed', signature: 'sig-new' });
    // Единственный вызов validateTransfer — по sig-new; sig-old пропущен
    // как ожидание, а не отдан на проверку и не засчитан в mismatch.
    expect(validateTransfer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(validateTransfer).mock.calls[0]?.[1]).toBe('sig-new');
  });

  it('ни один кандидат не подошёл — mismatch от самой ранней транзакции', async () => {
    const rpc = fakeRpc({
      signatures: ['sig-new', 'sig-old'],
      bodies: { 'sig-new': TX_BODY, 'sig-old': TX_BODY },
    });
    vi.mocked(validateTransfer)
      .mockRejectedValueOnce(new ValidateTransferError('ошибка по sig-old'))
      .mockRejectedValueOnce(new ValidateTransferError('ошибка по sig-new'));

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    // Самая ранняя, а не последняя из проверенных.
    expect(status).toMatchObject({
      status: 'mismatch',
      signature: 'sig-old',
      reason: 'ошибка по sig-old',
    });
  });

  it('все кандидаты — подписи без тела: pending, а не expired, даже если цена истекла', async () => {
    // «Подпись есть, тела нет» — это ожидание независимо от истечения
    // котировки: узел ещё может догнать и раздать ту же транзакцию, а
    // объявленный раньше времени expired закрыл бы заказ преждевременно.
    const rpc = fakeRpc({ signatures: ['sig-old'], bodies: {} });

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    expect(status).toEqual({ status: 'pending', truncated: false });
    expect(validateTransfer).not.toHaveBeenCalled();
  });

  it('выборка усечена — видно в результате (truncated: true)', async () => {
    // Ровно SIGNATURE_LIMIT подписей — узел мог отдать больше, историю по
    // метке целиком мы не видим. Самая старая (последняя после переворота)
    // сразу проходит проверку, чтобы не гонять тысячу лишних моков.
    const signatures = Array.from({ length: SIGNATURE_LIMIT }, (_, i) => `sig-${i}`);
    const oldest = signatures[signatures.length - 1] as string;
    const rpc = fakeRpc({ signatures, bodies: { [oldest]: TX_BODY } });
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    expect(status).toMatchObject({ status: 'confirmed', signature: oldest, truncated: true });
  });

  it('выборка не усечена (меньше лимита) — truncated: false', async () => {
    const rpc = fakeRpc({ signatures: ['sig123'], bodies: { sig123: TX_BODY } });
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    expect(status).toMatchObject({ truncated: false });
  });

  it('передаёт в validateTransfer правильные получателя, сумму, монету и метку', async () => {
    const rpc = fakeRpc({ signatures: ['sig123'], bodies: { sig123: TX_BODY } });
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    const call = vi.mocked(validateTransfer).mock.calls[0];
    // Второй позиционный аргумент validateTransfer — проверяемая подпись.
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
    const rpc = fakeRpc({ signatures: ['sig456'], bodies: { sig456: TX_BODY } });
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    const status = await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });
    // Транзакция в блокчейне необратима — отменить её SDK не может.
    expect(status.status).toBe('confirmed');
  });

  it('запрашивает подтверждение уровня finalized у getSignaturesForAddress, getTransaction и validateTransfer', async () => {
    const rpc = fakeRpc({ signatures: ['sig'], bodies: { sig: TX_BODY } });
    vi.mocked(validateTransfer).mockResolvedValueOnce({} as never);

    await checkPayment(rpc, {
      reference: REFERENCE,
      quote: quoteFixture(),
      recipient: RECIPIENT,
      cluster: 'mainnet',
    });

    expect((rpc as any).getSignaturesForAddress.mock.calls[0]?.[1]).toMatchObject({
      commitment: 'finalized',
      limit: SIGNATURE_LIMIT,
    });
    expect((rpc as any).getTransaction.mock.calls[0]?.[1]).toMatchObject({ commitment: 'finalized' });
    expect(vi.mocked(validateTransfer).mock.calls[0]?.[3]).toEqual({ commitment: 'finalized' });
  });

  it('пробрасывает сбой сети из getSignaturesForAddress, а не превращает его в несовпадение', async () => {
    const rpc = {
      getSignaturesForAddress: vi.fn(() => ({ send: () => Promise.reject(new Error('сеть недоступна')) })),
      getTransaction: vi.fn(),
    } as never;

    await expect(
      checkPayment(rpc, {
        reference: REFERENCE,
        quote: quoteFixture(),
        recipient: RECIPIENT,
        cluster: 'mainnet',
      }),
    ).rejects.toThrow('сеть недоступна');
  });

  it('пробрасывает сбой сети из getTransaction (проверка тела кандидата)', async () => {
    const rpc = {
      getSignaturesForAddress: vi.fn(() => ({ send: () => Promise.resolve([signatureEntry('sig')]) })),
      getTransaction: vi.fn(() => ({ send: () => Promise.reject(new Error('узел недоступен')) })),
    } as never;

    await expect(
      checkPayment(rpc, {
        reference: REFERENCE,
        quote: quoteFixture(),
        recipient: RECIPIENT,
        cluster: 'mainnet',
      }),
    ).rejects.toThrow('узел недоступен');
  });

  it('пробрасывает ошибку validateTransfer, если это не ValidateTransferError', async () => {
    const rpc = fakeRpc({ signatures: ['sig999'], bodies: { sig999: TX_BODY } });
    vi.mocked(validateTransfer).mockRejectedValueOnce(new Error('сеть недоступна'));

    // Сбой сети/RPC внутри validateTransfer — не то же самое, что несовпадение
    // платежа: он должен пробрасываться наружу, а не превращаться в mismatch,
    // иначе временный сбой сети будет выглядеть как поддельный платёж.
    await expect(
      checkPayment(rpc, {
        reference: REFERENCE,
        quote: quoteFixture(),
        recipient: RECIPIENT,
        cluster: 'mainnet',
      }),
    ).rejects.toThrow('сеть недоступна');
  });

  it('выбрасывает ConfigError сразу для невалидного recipient, не обращаясь к блокчейну', async () => {
    const rpc = fakeRpc({ signatures: [] });

    await expect(
      checkPayment(rpc, {
        reference: REFERENCE,
        quote: quoteFixture(),
        recipient: 'не-валидный-адрес',
        cluster: 'mainnet',
      }),
    ).rejects.toThrow(ConfigError);

    // Ошибка конфигурации всплывает раньше любого сетевого вызова.
    expect((rpc as any).getSignaturesForAddress).not.toHaveBeenCalled();
    expect(validateTransfer).not.toHaveBeenCalled();
  });

  it('выбрасывает ConfigError сразу для невалидного reference, не обращаясь к блокчейну', async () => {
    const rpc = fakeRpc({ signatures: [] });

    await expect(
      checkPayment(rpc, {
        reference: 'не-валидная-метка',
        quote: quoteFixture(),
        recipient: RECIPIENT,
        cluster: 'mainnet',
      }),
    ).rejects.toThrow(ConfigError);

    expect((rpc as any).getSignaturesForAddress).not.toHaveBeenCalled();
    expect(validateTransfer).not.toHaveBeenCalled();
  });

  describe('сверка кластера котировки с кластером клиента', () => {
    it('выбрасывает ConfigError, когда кластер котировки не совпадает с кластером клиента', async () => {
      const rpc = fakeRpc({ signatures: [] });

      await expect(
        checkPayment(rpc, {
          reference: REFERENCE,
          quote: quoteFixture({ cluster: 'devnet' }),
          recipient: RECIPIENT,
          cluster: 'mainnet',
        }),
      ).rejects.toThrow(ConfigError);

      expect((rpc as any).getSignaturesForAddress).not.toHaveBeenCalled();
      expect(validateTransfer).not.toHaveBeenCalled();
    });

    it('не бросает ошибку, когда кластеры совпадают', async () => {
      const rpc = fakeRpc({ signatures: [] });

      const status = await checkPayment(rpc, {
        reference: REFERENCE,
        quote: quoteFixture({ cluster: 'mainnet' }),
        recipient: RECIPIENT,
        cluster: 'mainnet',
      });
      expect(status).toEqual({ status: 'pending', truncated: false });
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
      const rpc = fakeRpc({ signatures: [] });

      await expect(
        checkPayment(rpc, {
          reference: REFERENCE,
          quote: quoteFixture({ amountToken }),
          recipient: RECIPIENT,
          cluster: 'mainnet',
        }),
      ).rejects.toThrow(ConfigError);

      expect((rpc as any).getSignaturesForAddress).not.toHaveBeenCalled();
      expect(validateTransfer).not.toHaveBeenCalled();
    });
  });
});
