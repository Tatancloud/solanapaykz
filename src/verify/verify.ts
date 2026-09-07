import type { Address, GetSignaturesForAddressApi, GetTransactionApi, Rpc } from '@solana/kit';
import { address } from '@solana/kit';
import {
  FindReferenceError,
  findReference,
  validateTransfer,
  type ConfirmedSignatureInfo,
} from '@solana/pay';
import { resolveToken } from '../config.js';
import { isQuoteExpired, type Quote } from '../quote/quote.js';

export type PaymentStatus =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'confirmed'; signature: string; amountPaid: string }
  | { status: 'mismatch'; signature: string; reason: string };

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

  let found: ConfirmedSignatureInfo;
  try {
    found = await findReference(rpc, address(reference) as Address, {
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
        recipient: address(recipient),
        amount: Number(quote.amountToken),
        ...(mint ? { splToken: address(mint) } : {}),
        reference: address(reference),
      },
      { commitment: 'finalized' },
    );
  } catch (error) {
    return {
      status: 'mismatch',
      signature: found.signature,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // Платёж, пришедший после истечения котировки, всё равно подтверждается:
  // транзакция необратима. Решение о нём принимает продавец.
  return { status: 'confirmed', signature: found.signature, amountPaid: quote.amountToken };
}
