/**
 * Тонкий клиент JSON-RPC Solana на встроенном `fetch`.
 *
 * Зачем свой, когда есть SDK: `SolanaPayKZ` держит узел внутри себя и
 * наружу не отдаёт, а нужны здесь три метода, которых у него нет —
 * история поступлений на адрес, тело транзакции и токен-счета владельца
 * (см. `scanner.ts`). Тянуть ради них `@solana/kit` в зависимости
 * сервера — лишний вес и лишняя версия к сопровождению; здесь это три
 * запроса и разбор ответа, а в тестах всё подменяется одной функцией.
 *
 * Ошибка узла — в том числе исчерпание квоты платного провайдера —
 * поднимается исключением, а не превращается в пустой результат: сканер
 * обязан отличать «поступлений нет» от «узел не ответил». Во втором
 * случае двигать курсор нельзя, иначе неразобранные платежи будут
 * пропущены навсегда.
 */

/** Запись истории подписей по адресу — ровно те поля, что нам нужны. */
export interface ПодписьВИстории {
  signature: string;
  /** Момент включения в блок, Unix-секунды. `null` у совсем свежих. */
  blockTime: number | null;
  /** Не `null`, если транзакция провалилась. */
  err: unknown;
}

/** Баланс токен-счёта в транзакции (`jsonParsed`). */
interface ТокенБаланс {
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string };
}

/**
 * Транзакция в разборе `jsonParsed` — описаны только поля, которые здесь
 * читаются. Чужой формат целиком не копируем: каждое лишнее поле в этом
 * типе пришлось бы поддерживать при любом изменении узла.
 */
export interface ТранзакцияJson {
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: ТокенБаланс[];
    postTokenBalances?: ТокенБаланс[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
    };
  };
}

export interface SolanaRpc {
  /**
   * Подписи по адресу, от новых к старым. `until` — подпись, до которой
   * уже всё разобрано: узел вернёт только то, что новее неё.
   */
  getSignaturesForAddress(
    адрес: string,
    params: { limit: number; until?: string },
  ): Promise<ПодписьВИстории[]>;
  /** Транзакция либо `null`, если узел ещё не раздаёт её тело на нужном уровне подтверждения. */
  getTransaction(signature: string): Promise<ТранзакцияJson | null>;
  /** Адреса токен-счетов владельца по этому mint. */
  getTokenAccountsByOwner(владелец: string, mint: string): Promise<string[]>;
}

export function создатьRpc(url: string, fetchФн: typeof fetch = fetch): SolanaRpc {
  let счётчик = 0;

  async function вызвать<T>(method: string, params: unknown[]): Promise<T> {
    счётчик += 1;
    const ответ = await fetchФн(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: счётчик, method, params }),
    });

    if (!ответ.ok) {
      // Адрес узла несёт ключ API — в сообщение он не попадает никогда,
      // только метод и код ответа (см. маскировку журнала в log.ts).
      throw new Error(`Узел Solana ответил ${ответ.status} на ${method}`);
    }

    const тело = (await ответ.json()) as { result?: T; error?: { message?: string } };
    if (тело.error) {
      throw new Error(`Узел Solana отказал на ${method}: ${тело.error.message ?? 'без объяснения'}`);
    }
    return тело.result as T;
  }

  return {
    getSignaturesForAddress(адрес, params) {
      return вызвать<ПодписьВИстории[]>('getSignaturesForAddress', [
        адрес,
        {
          limit: params.limit,
          // `until` отсутствует, а не пуст: пустая строка — это не «с
          // начала истории», а невалидная подпись, и узел на неё отвечает
          // ошибкой.
          ...(params.until !== undefined ? { until: params.until } : {}),
          commitment: 'finalized',
        },
      ]);
    },

    getTransaction(signature) {
      return вызвать<ТранзакцияJson | null>('getTransaction', [
        signature,
        {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0,
          encoding: 'jsonParsed',
        },
      ]);
    },

    async getTokenAccountsByOwner(владелец, mint) {
      const результат = await вызвать<{ value: Array<{ pubkey: string }> }>(
        'getTokenAccountsByOwner',
        [владелец, { mint }, { commitment: 'finalized', encoding: 'jsonParsed' }],
      );
      return результат.value.map((счёт) => счёт.pubkey);
    },
  };
}

/** Сумма токен-балансов нужного владельца и mint, в целых единицах. */
function токенБаланс(балансы: ТокенБаланс[] | undefined, владелец: string, mint: string): bigint {
  let итог = 0n;
  for (const баланс of балансы ?? []) {
    if (баланс.owner === владелец && баланс.mint === mint) {
      итог += BigInt(баланс.uiTokenAmount?.amount ?? '0');
    }
  }
  return итог;
}

/**
 * Поступление на наблюдаемый адрес в этой транзакции — прирост баланса в
 * целых минимальных единицах строкой, либо `null`, если прироста не было.
 *
 * Для SOL смотрим на баланс самого адреса, для токена — на токен-баланс
 * нужного mint у нужного владельца: перевод токена идёт между
 * токен-счетами, и владелец в списке участников транзакции может не
 * значиться вовсе.
 *
 * Считается именно РАЗНИЦА, а не сумма переводов из инструкций: перевод
 * может быть разбит на несколько инструкций, часть денег может тут же
 * уйти обратно, а нас интересует только то, что в итоге осело на адресе.
 *
 * Провалившиеся транзакции (`meta.err`) пропускаются: их изменения
 * балансов откачены, деньги не пришли.
 */
export function поступлениеИзТранзакции(
  tx: ТранзакцияJson,
  параметры: { адрес: string; mint?: string },
): string | null {
  if (!tx.meta || tx.meta.err) return null;

  if (параметры.mint !== undefined) {
    const было = токенБаланс(tx.meta.preTokenBalances, параметры.адрес, параметры.mint);
    const стало = токенБаланс(tx.meta.postTokenBalances, параметры.адрес, параметры.mint);
    const дельта = стало - было;
    return дельта > 0n ? дельта.toString() : null;
  }

  const ключи = tx.transaction?.message?.accountKeys ?? [];
  const индекс = ключи.findIndex(
    (ключ) => (typeof ключ === 'string' ? ключ : ключ.pubkey) === параметры.адрес,
  );
  if (индекс < 0) return null;

  const было = BigInt(tx.meta.preBalances?.[индекс] ?? 0);
  const стало = BigInt(tx.meta.postBalances?.[индекс] ?? 0);
  const дельта = стало - было;
  return дельта > 0n ? дельта.toString() : null;
}
