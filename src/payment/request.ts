import { address, getAddressDecoder } from '@solana/kit';
import { encodeURL } from '@solana/pay';
import QRCode from 'qrcode';
import { resolveToken } from '../config.js';
import { ConfigError, QuoteExpiredError } from '../errors.js';
import { assertValidQuote, isQuoteExpired, type Quote } from '../quote/quote.js';

export interface PaymentRequestOptions {
  /** Solana-адрес продавца. */
  recipient: string;
  /**
   * Готовая метка платежа. Нужна тому, кто записывает метку в свой заказ
   * РАНЬШЕ, чем строит ссылку. Так делает сервер Tilda с оплатой по
   * уникальной сумме: заказ вставляется в базу первым, потому что
   * уникальную сумму подбирает сама база (частичный уникальный индекс —
   * единственная защита от двух заказов с одной суммой), и только потом
   * от подобранной суммы строится ссылка. Второй вызов со своей,
   * сгенерированной внутри меткой разошёлся бы с меткой, уже записанной
   * в заказе, и платёж по такой ссылке не нашёлся бы никогда.
   *
   * Без этого поля метка, как и прежде, создаётся внутри.
   */
  reference?: string;
  label?: string;
  message?: string;
  memo?: string;
  /** Размер QR в пикселях. */
  qrSize?: number;
}

export interface PaymentRequest {
  readonly quote: Quote;
  readonly url: string;
  /** Метка для поиска транзакции. Продавец обязан сохранить её с заказом. */
  readonly reference: string;
  readonly qrSvg: string;
}

/**
 * Создаёт случайную метку платежа.
 *
 * Это просто 32 случайных байта в виде адреса — пара ключей не генерируется,
 * приватного ключа не существует. Требование безопасности ТЗ соблюдено.
 */
export function generateReference(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return getAddressDecoder().decode(bytes);
}

export async function createPaymentRequest(
  quote: Quote,
  options: PaymentRequestOptions,
): Promise<PaymentRequest> {
  // Котировка приходит от продавца (из его БД) — проверяем её целостность
  // раньше любого другого действия. См. assertValidQuote.
  assertValidQuote(quote);

  if (isQuoteExpired(quote)) {
    throw new QuoteExpiredError(
      `Котировка ${quote.quoteId} просрочена (истекла ${quote.expiresAt})`,
    );
  }

  const reference = options.reference ?? generateReference();
  const { mint } = resolveToken(quote.cluster, quote.token);

  // @solana/kit бросает свой SolanaError на невалидный адрес — приводим к
  // ConfigError, чтобы тип ошибки на невалидный recipient был одинаковым
  // везде в SDK (checkPayment уже делает то же самое).
  let recipientAddress: ReturnType<typeof address>;
  try {
    recipientAddress = address(options.recipient);
  } catch (error) {
    throw new ConfigError(`Некорректный адрес получателя: ${options.recipient}`, { cause: error });
  }

  // Своя метка приходит снаружи (см. `reference` в опциях) — значит может
  // быть чем угодно, и опечатка в ней должна называться ошибкой настроек
  // так же, как опечатка в адресе получателя выше, а не всплывать
  // неразобранным SolanaError из глубины encodeURL.
  let referenceAddress: ReturnType<typeof address>;
  try {
    referenceAddress = address(reference);
  } catch (error) {
    throw new ConfigError(`Некорректная метка платежа (reference): ${reference}`, { cause: error });
  }

  // encodeURL принимает amount типом number — это граница библиотеки.
  // Внутренние расчёты ведутся в целых единицах, здесь происходит
  // единственное преобразование к number.
  const url = encodeURL({
    recipient: recipientAddress,
    amount: Number(quote.amountToken),
    ...(mint ? { splToken: address(mint) } : {}),
    reference: referenceAddress,
    ...(options.label ? { label: options.label } : {}),
    ...(options.message ? { message: options.message } : {}),
    ...(options.memo ? { memo: options.memo } : {}),
  });

  const qrSvg = await QRCode.toString(url.toString(), {
    type: 'svg',
    margin: 1,
    width: options.qrSize ?? 320,
  });

  return { quote, url: url.toString(), reference, qrSvg };
}
