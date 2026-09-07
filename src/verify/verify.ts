import type { Address, GetSignaturesForAddressApi, GetTransactionApi, Rpc } from '@solana/kit';
import { address } from '@solana/kit';
import {
  FindReferenceError,
  ValidateTransferError,
  findReference,
  validateTransfer,
  type ConfirmedSignatureInfo,
} from '@solana/pay';
import type { Cluster } from '../config.js';
import { resolveToken } from '../config.js';
import { ConfigError } from '../errors.js';
import { assertValidQuote, isQuoteExpired, type Quote } from '../quote/quote.js';

export type PaymentStatus =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'confirmed';
      signature: string;
      /**
       * Сумма из котировки, подтверждённая как полученная. `validateTransfer`
       * сравнивает сумму перевода как «не меньше ожидаемой», а не точным
       * равенством — переплата тоже проходит проверку успешно. Значит это
       * поле показывает ожидаемую сумму, а не фактически списанную: если
       * продавцу нужен точный размер поступления, следует смотреть саму
       * транзакцию по `signature`.
       */
      amountPaid: string;
    }
  | {
      status: 'mismatch';
      signature: string;
      /**
       * Текст ошибки `@solana/pay` — предназначен для диагностики и логов, а
       * не для показа покупателю: может содержать технические детали вида
       * «Solana error #…; Decode this error by running…».
       */
      reason: string;
    };

export interface CheckPaymentParams {
  reference: string;
  quote: Quote;
  recipient: string;
  /**
   * Кластер клиента (тот, с которым сконфигурирован SolanaPayKZ). Сверяется
   * с quote.cluster — котировка из чужого кластера (например, devnet при
   * клиенте в mainnet) иначе даёт вечный mismatch по чужой монете вместо
   * явной ошибки конфигурации.
   */
  cluster: Cluster;
}

type PaymentRpc = Rpc<GetSignaturesForAddressApi & GetTransactionApi>;

/**
 * Ищет транзакцию по метке и проверяет её.
 *
 * Поиск и проверка выполняются функциями @solana/pay, а не самописным кодом:
 * ошибка в этой проверке означает принятый чужой или заниженный платёж.
 */
export async function checkPayment(
  rpc: PaymentRpc,
  params: CheckPaymentParams,
): Promise<PaymentStatus> {
  const { reference, quote, recipient, cluster } = params;

  // Котировка приходит от продавца (из его БД) — проверяем её целостность
  // раньше любого другого действия, включая сравнение адресов и сеть.
  assertValidQuote(quote);

  if (quote.cluster !== cluster) {
    throw new ConfigError(
      `Кластер котировки (${quote.cluster}) не совпадает с кластером клиента ` +
      `(${cluster}). Котировка из другого кластера — это ошибка конфигурации, ` +
      'а не платёж, который нужно проверять.',
    );
  }

  // Преобразование адресов — вне сетевых вызовов и до них. Невалидный адрес
  // получателя или метки — это ошибка конфигурации продавца, а не результат
  // проверки платежа: она должна всплыть сразу и отдельно, а не
  // маскироваться под mismatch внутри catch, обёрнутого вокруг сети.
  // @solana/kit бросает свой SolanaError — приводим к ConfigError, чтобы
  // тип ошибки на невалидный адрес был одинаковым везде в SDK (конструктор
  // SolanaPayKZ уже бросает ConfigError на невалидный recipient).
  let referenceAddress: Address;
  let recipientAddress: ReturnType<typeof address>;
  try {
    referenceAddress = address(reference) as Address;
  } catch (error) {
    throw new ConfigError(`Некорректная метка платежа (reference): ${reference}`, { cause: error });
  }
  try {
    recipientAddress = address(recipient);
  } catch (error) {
    throw new ConfigError(`Некорректный адрес получателя: ${recipient}`, { cause: error });
  }

  let found: ConfirmedSignatureInfo;
  try {
    found = await findReference(rpc, referenceAddress, {
      commitment: 'finalized',
    });
  } catch (error) {
    if (error instanceof FindReferenceError) {
      // Платежа пока нет. Просрочка котировки отличает «ещё ждём» от «уже поздно».
      return isQuoteExpired(quote) ? { status: 'expired' } : { status: 'pending' };
    }
    throw error;
  }

  const { mint } = resolveToken(quote.cluster, quote.token);

  try {
    await validateTransfer(
      rpc,
      found.signature,
      {
        recipient: recipientAddress,
        amount: Number(quote.amountToken),
        ...(mint ? { splToken: address(mint) } : {}),
        reference: referenceAddress,
      },
      { commitment: 'finalized' },
    );
  } catch (error) {
    if (error instanceof ValidateTransferError) {
      return {
        status: 'mismatch',
        signature: found.signature,
        reason: error.message,
      };
    }
    // Сбой сети/RPC внутри validateTransfer — не то же самое, что
    // несовпадение платежа: пробрасываем наружу, как и для findReference,
    // иначе временный сбой сети будет выглядеть как поддельный платёж.
    throw error;
  }

  // Платёж, пришедший после истечения котировки, всё равно подтверждается:
  // транзакция необратима. Решение о нём принимает продавец.
  return { status: 'confirmed', signature: found.signature, amountPaid: quote.amountToken };
}
