import { describe, expect, it } from 'vitest';
import { поступлениеИзТранзакции, создатьRpc, type ТранзакцияJson } from '../src/solana-rpc.js';

/** Ответ узла как объект `Response` — ровно то, что вернул бы `fetch`. */
function ответ(тело: unknown): Response {
  return new Response(JSON.stringify(тело), { headers: { 'content-type': 'application/json' } });
}

function транзакция(части: Partial<ТранзакцияJson>): ТранзакцияJson {
  return {
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: { message: { accountKeys: [] } },
    ...части,
  } as ТранзакцияJson;
}

describe('поступлениеИзТранзакции', () => {
  it('видит приход SOL как прирост баланса наблюдаемого адреса', () => {
    const tx = транзакция({
      meta: {
        err: null,
        preBalances: [1_000_000_000, 500_000],
        postBalances: [999_000_000, 920_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      transaction: { message: { accountKeys: [{ pubkey: 'Покупатель' }, { pubkey: 'Магазин' }] } },
    });

    expect(поступлениеИзТранзакции(tx, { адрес: 'Магазин' })).toBe('420000');
  });

  it('не считает поступлением уход средств с адреса', () => {
    const tx = транзакция({
      meta: {
        err: null,
        preBalances: [920_000],
        postBalances: [500_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      transaction: { message: { accountKeys: [{ pubkey: 'Магазин' }] } },
    });

    expect(поступлениеИзТранзакции(tx, { адрес: 'Магазин' })).toBeNull();
  });

  it('молчит, когда наблюдаемого адреса в транзакции нет вовсе', () => {
    const tx = транзакция({
      meta: {
        err: null,
        preBalances: [1],
        postBalances: [2],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      transaction: { message: { accountKeys: [{ pubkey: 'Чужой' }] } },
    });

    expect(поступлениеИзТранзакции(tx, { адрес: 'Магазин' })).toBeNull();
  });

  it('видит приход токена по владельцу и mint, а не по балансу самого адреса', () => {
    const tx = транзакция({
      meta: {
        err: null,
        preBalances: [],
        postBalances: [],
        preTokenBalances: [{ owner: 'Магазин', mint: 'USDCmint', uiTokenAmount: { amount: '1000000' } }],
        postTokenBalances: [{ owner: 'Магазин', mint: 'USDCmint', uiTokenAmount: { amount: '1180000' } }],
      },
    });

    expect(поступлениеИзТранзакции(tx, { адрес: 'Магазин', mint: 'USDCmint' })).toBe('180000');
  });

  it('считает приход токена и на счёт, которого до этой транзакции не было', () => {
    // Первый платёж USDC магазину: токен-счёт создаётся той же
    // транзакцией, в preTokenBalances его нет вовсе — «было» здесь ноль,
    // а не «поступления не было».
    const tx = транзакция({
      meta: {
        err: null,
        preBalances: [],
        postBalances: [],
        preTokenBalances: [],
        postTokenBalances: [{ owner: 'Магазин', mint: 'USDCmint', uiTokenAmount: { amount: '180000' } }],
      },
    });

    expect(поступлениеИзТранзакции(tx, { адрес: 'Магазин', mint: 'USDCmint' })).toBe('180000');
  });

  it('не путает чужой токен со своим', () => {
    const tx = транзакция({
      meta: {
        err: null,
        preBalances: [],
        postBalances: [],
        preTokenBalances: [],
        postTokenBalances: [{ owner: 'Магазин', mint: 'ЧужойMint', uiTokenAmount: { amount: '999' } }],
      },
    });

    expect(поступлениеИзТранзакции(tx, { адрес: 'Магазин', mint: 'USDCmint' })).toBeNull();
  });

  it('пропускает провалившуюся транзакцию: её изменения балансов откачены', () => {
    const tx = транзакция({
      meta: {
        err: { InstructionError: [0, 'Custom'] },
        preBalances: [0],
        postBalances: [420_000],
        preTokenBalances: [],
        postTokenBalances: [],
      },
      transaction: { message: { accountKeys: [{ pubkey: 'Магазин' }] } },
    });

    expect(поступлениеИзТранзакции(tx, { адрес: 'Магазин' })).toBeNull();
  });
});

describe('создатьRpc', () => {
  it('шлёт один JSON-RPC запрос и отдаёт его результат', async () => {
    const вызовы: Array<{ method: string; params: unknown }> = [];
    const подмена = (async (_url: string | URL, опции?: RequestInit) => {
      вызовы.push(JSON.parse(String(опции?.body)) as { method: string; params: unknown });
      return ответ({
        jsonrpc: '2.0',
        id: 1,
        result: [{ signature: 'ПодписьA', blockTime: 5, err: null }],
      });
    }) as unknown as typeof fetch;

    const rpc = создатьRpc('https://узел.invalid', подмена);
    const подписи = await rpc.getSignaturesForAddress('Магазин', { limit: 100, until: 'ПодписьБ' });

    expect(подписи).toEqual([{ signature: 'ПодписьA', blockTime: 5, err: null }]);
    expect(вызовы[0]?.method).toBe('getSignaturesForAddress');
    expect(вызовы[0]?.params).toEqual([
      'Магазин',
      { limit: 100, until: 'ПодписьБ', commitment: 'finalized' },
    ]);
  });

  it('без курсора не шлёт until вовсе, а не шлёт его пустым', async () => {
    let параметры: unknown;
    const подмена = (async (_url: string | URL, опции?: RequestInit) => {
      параметры = (JSON.parse(String(опции?.body)) as { params: unknown }).params;
      return ответ({ jsonrpc: '2.0', id: 1, result: [] });
    }) as unknown as typeof fetch;

    await создатьRpc('https://узел.invalid', подмена).getSignaturesForAddress('Магазин', { limit: 10 });

    expect(параметры).toEqual(['Магазин', { limit: 10, commitment: 'finalized' }]);
  });

  it('превращает ошибку узла в исключение, а не в пустой результат', async () => {
    // Исчерпание квоты платного узла обязано отличаться от «поступлений
    // нет»: во втором случае сканер двинул бы курсор и пропустил платежи.
    const подмена = (async () =>
      ответ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32005, message: 'Too many requests' },
      })) as unknown as typeof fetch;

    await expect(создатьRpc('https://узел.invalid', подмена).getTransaction('ПодписьA')).rejects.toThrow(
      /Too many requests/,
    );
  });

  it('ошибку HTTP тоже превращает в исключение', async () => {
    const подмена = (async () => new Response('gateway timeout', { status: 504 })) as unknown as typeof fetch;

    await expect(создатьRpc('https://узел.invalid', подмена).getTransaction('ПодписьA')).rejects.toThrow(
      /504/,
    );
  });

  it('отдаёт адреса токен-счетов владельца', async () => {
    const подмена = (async () =>
      ответ({
        jsonrpc: '2.0',
        id: 1,
        result: { value: [{ pubkey: 'ТокенСчёт1' }, { pubkey: 'ТокенСчёт2' }] },
      })) as unknown as typeof fetch;

    const счета = await создатьRpc('https://узел.invalid', подмена).getTokenAccountsByOwner(
      'Магазин',
      'USDCmint',
    );

    expect(счета).toEqual(['ТокенСчёт1', 'ТокенСчёт2']);
  });
});
