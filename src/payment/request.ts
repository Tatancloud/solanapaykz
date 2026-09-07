import { address, getAddressDecoder } from '@solana/kit';
import { encodeURL } from '@solana/pay';
import QRCode from 'qrcode';
import { resolveToken } from '../config.js';
import { QuoteExpiredError } from '../errors.js';
import { assertValidQuote, isQuoteExpired, type Quote } from '../quote/quote.js';

export interface PaymentRequestOptions {
  /** Solana-адрес продавца. */
  recipient: string;
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

  const reference = generateReference();
  const { mint } = resolveToken(quote.cluster, quote.token);

  // encodeURL принимает amount типом number — это граница библиотеки.
  // Внутренние расчёты ведутся в целых единицах, здесь происходит
  // единственное преобразование к number.
  const url = encodeURL({
    recipient: address(options.recipient),
    amount: Number(quote.amountToken),
    ...(mint ? { splToken: address(mint) } : {}),
    reference: address(reference),
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
