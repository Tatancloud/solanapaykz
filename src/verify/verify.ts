import type { Address, GetSignaturesForAddressApi, GetTransactionApi, Rpc } from '@solana/kit';
import { address } from '@solana/kit';
import {
  FindReferenceError,
  ValidateTransferError,
  findReference,
  validateTransfer,
  type ConfirmedSignatureInfo,
} from '@solana/pay';
import { resolveToken } from '../config.js';
import { isQuoteExpired, type Quote } from '../quote/quote.js';

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
  const { reference, quote, recipient } = params;

  // Преобразование адресов — вне сетевых вызовов и до них. Невалидный адрес
  // получателя или метки — это ошибка конфигурации продавца, а не результат
  // проверки платежа: она должна всплыть сразу и отдельно, а не
  // маскироваться под mismatch внутри catch, обёрнутого вокруг сети.
  const referenceAddress = address(reference) as Address;
  const recipientAddress = address(recipient);

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
