import type { Address, GetSignaturesForAddressApi, GetTransactionApi, Rpc } from '@solana/kit';
import { address } from '@solana/kit';
import { ValidateTransferError, validateTransfer } from '@solana/pay';
import type { Cluster } from '../config.js';
import { resolveToken } from '../config.js';
import { ConfigError } from '../errors.js';
import { assertValidQuote, isQuoteExpired, type Quote } from '../quote/quote.js';

/**
 * Solana JSON-RPC не отдаёт больше 1000 подписей за один запрос
 * `getSignaturesForAddress` — это одновременно и жёсткий потолок узла, и
 * значение, которое мы просим явно, а не значение по умолчанию клиента
 * (оно рассчитано на другие сценарии и заметно меньше). Кошелёк повторяет
 * отправку при протухшем blockhash или нехватке лампортов на комиссию, и
 * провалившаяся попытка ложится в историю по метке раньше состоявшегося
 * платежа; посторонний может засорять открытую в QR метку собственными
 * дешёвыми транзакциями. Взято с тем же запасом, что и в переносе этой же
 * проверки на PHP — см. `demo-shop/plugin/includes/Verify.php`,
 * `SIGNATURE_LIMIT`.
 */
export const SIGNATURE_LIMIT = 1000;

export type PaymentStatus =
  | { status: 'pending'; truncated: boolean }
  | { status: 'expired'; truncated: boolean }
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
      truncated: boolean;
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
      truncated: boolean;
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
 * Ищет платёж по метке и проверяет его.
 *
 * Раньше поиск шёл через `@solana/pay`'s `findReference` — она возвращает
 * только САМУЮ СТАРУЮ транзакцию по метке. Метка на платёж не обязательно
 * ссылается ровно одной транзакцией: кошелёк мог отправить несколько
 * неудачных попыток раньше состоявшегося платежа, узел мог ещё не
 * раздавать тело только что появившейся в истории подписи, посторонний мог
 * намусорить в метку собственными транзакциями. Во всех этих случаях самая
 * старая транзакция — не тот платёж, который совершил покупатель, и
 * `findReference` не даёт увидеть более новых кандидатов вовсе.
 *
 * Здесь вместо неё — собственный перебор: подписи запрашиваются напрямую
 * (см. `SIGNATURE_LIMIT`), кандидаты проверяются от самых старых к новым,
 * и первый прошедший проверку и есть подтверждённый платёж. Сама проверка
 * одной транзакции по-прежнему делается `validateTransfer` из `@solana/pay`,
 * не самописным кодом: ошибка в ней означает принятый чужой или заниженный
 * платёж. Перенос той же логики на PHP, откуда она сюда и переносится
 * обратно, — `demo-shop/plugin/includes/Verify.php`.
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

  // Тоже конфигурация продавца, а не сеть: неизвестный токен в кластере
  // котировки должен всплыть раньше любого RPC-запроса.
  const { mint } = resolveToken(quote.cluster, quote.token);

  // Сбой сети/узла здесь не оборачиваем — он должен пробрасываться наружу
  // как есть, а не превращаться в «платёж не сошёлся».
  const signatures = await rpc
    .getSignaturesForAddress(referenceAddress, { limit: SIGNATURE_LIMIT, commitment: 'finalized' })
    .send();

  // Пришло ровно SIGNATURE_LIMIT записей — значит мы упёрлись в потолок
  // одного запроса и не видим всю историю по метке целиком (см. комментарий
  // у SIGNATURE_LIMIT). Молчать об этом нельзя: признак идёт наружу вместе
  // с любым исходом ниже, а что с ним делать — решает вызывающий код.
  const truncated = signatures.length === SIGNATURE_LIMIT;

  if (signatures.length === 0) {
    // Платежа пока нет вовсе. Просрочка котировки отличает «ещё ждём» от
    // «уже поздно».
    return isQuoteExpired(quote) ? { status: 'expired', truncated } : { status: 'pending', truncated };
  }

  // По спецификации Solana Pay метка уникальна на платёж, но история по
  // адресу-метке этого не гарантирует (см. комментарий к функции) — поэтому
  // нужный платёж ищем перебором, а не берём первую попавшуюся запись. Узел
  // отдаёт подписи от новых к старым — переворачиваем, чтобы проверять
  // кандидатов в хронологическом порядке и не останавливаться, пока не
  // найдём состоявшийся платёж или не переберём всё.
  const candidates = [...signatures].reverse();

  let earliestMismatch: PaymentStatus | undefined;
  let earliestPendingSignature: string | undefined;

  for (const candidate of candidates) {
    const signature = candidate.signature;

    // Подпись уже видна в истории по метке, но её тело для нужного уровня
    // подтверждения узел ещё не раздаёт — узел не догнал собственную же
    // историю подписей. Проверяем сами (а не через validateTransfer,
    // которая на отсутствующей транзакции просто бросает свою ошибку и не
    // различает эту причину от несовпадения) именно затем, чтобы не
    // перепутать «узел не догнал» с «транзакция не подходит».
    const body = await rpc
      .getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
        encoding: 'base64',
      })
      .send();

    if (body === null) {
      // Запоминаем самую раннюю такую подпись и продолжаем: более новый
      // кандидат ещё может оказаться состоявшимся платежом.
      earliestPendingSignature ??= signature;
      continue;
    }

    try {
      await validateTransfer(
        rpc,
        signature,
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
        // Первое несовпадение запоминаем и продолжаем: это может быть
        // протухший повтор кошелька или чужая транзакция, а не платёж
        // покупателя — более новый кандидат ещё может подтвердиться.
        earliestMismatch ??= { status: 'mismatch', signature, reason: error.message, truncated };
        continue;
      }
      // Сбой сети/RPC внутри validateTransfer — не то же самое, что
      // несовпадение платежа: пробрасываем наружу, иначе временный сбой
      // сети будет выглядеть как поддельный платёж.
      throw error;
    }

    // Первый кандидат, прошедший проверку, и есть платёж. Более новые
    // кандидаты по той же метке (если есть) дальше не рассматриваем — это
    // либо чужие транзакции, либо повторная отправка того же платежа.
    return { status: 'confirmed', signature, amountPaid: quote.amountToken, truncated };
  }

  if (earliestPendingSignature !== undefined) {
    // Платёж мог быть отправлен и ещё не проиндексирован узлом — это не то
    // же самое, что «подписей по метке нет вовсе», поэтому не считаем
    // котировку просроченной из-за одной только истёкшей цены: узел вот-вот
    // догонит, и этот же кандидат при следующей проверке может подтвердиться.
    return { status: 'pending', truncated };
  }

  // Ни один кандидат не прошёл проверку — возвращаем самое раннее
  // несовпадение, как и раньше. earliestMismatch здесь всегда определён:
  // signatures непуст, а каждый кандидат либо стал earliestPendingSignature,
  // либо подтвердился (мы бы уже вернули результат), либо попал сюда как
  // несовпадение. Резервная ветка — на случай изменений выше.
  return earliestMismatch ?? (isQuoteExpired(quote) ? { status: 'expired', truncated } : { status: 'pending', truncated });
}
