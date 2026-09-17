import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDatabase, type NewOrder, type Order, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import { ПРИЧИНЫ, сканироватьОдинРаз, type ScannerDeps } from '../src/scanner.js';
import type { ПодписьВИстории, SolanaRpc, ТранзакцияJson } from '../src/solana-rpc.js';

const МАГАЗИН = 'A4dSmSbNkJbPxnv3k3BH351xZm5iwvpubqevDHAaBM4P';
const СЕЙЧАС = 1_789_300_000;

const config: Config = {
  recipient: МАГАЗИН,
  rpcUrl: 'https://узел.invalid',
  cluster: 'mainnet',
  token: 'SOL',
  shopName: 'Цветы Астана',
  markupPercent: 0,
  quoteTtlSeconds: 900,
  lateWindowSeconds: 86400,
  orderSecret: 'секрет-заказа',
  notifySecret: 'секрет-уведомления',
  tildaNotifyUrl: 'https://tilda.cc/payment/notify/abc',
  publicUrl: 'https://pay.example.kz',
  adminPassword: 'длинный-пароль-админа',
  smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'p', from: 'shop@example.kz' },
  merchantEmail: 'merchant@example.kz',
  databasePath: ':memory:',
  listenPort: 0,
  listenHost: '127.0.0.1',
  trustedProxyAddresses: ['127.0.0.1'],
  enableFormWebhook: false,
  enableAmountMatching: true,
};

const образец: NewOrder = {
  tildaOrderId: '10868059:1',
  token: 'a'.repeat(32),
  amountKzt: '90',
  currency: 'KZT',
  amountToken: '0.000420000',
  tokenSymbol: 'SOL',
  cluster: 'mainnet',
  recipient: МАГАЗИН,
  reference: 'метка-1',
  rate: '210000.00',
  rateSource: 'binance',
  paymentUrl: 'solana:пример',
  quoteJson: '{}',
  createdAt: СЕЙЧАС - 600,
  expiresAt: СЕЙЧАС + 300,
  testMode: false,
  tildaSignature: 'подпись',
  txSignature: null,
  customerEmail: 'k@example.kz',
  description: 'Букет',
  productsJson: '[]',
};

/** Поступление, каким его увидит сканер: подпись, время и сумма в лампортах. */
interface Поступление {
  signature: string;
  blockTime: number | null;
  amountUnits: string;
  /** Провалившаяся транзакция — денег не было. */
  err?: unknown;
  /** Узел ещё не раздаёт тело этой транзакции. */
  безТела?: boolean;
}

/** Подменный узел: отдаёт заданные поступления, считает запросы тел. */
function фейковыйRpc(поступления: Поступление[], отказ = false): SolanaRpc & { запросовТел: number } {
  let запросовТел = 0;
  return {
    get запросовТел() {
      return запросовТел;
    },
    async getSignaturesForAddress(_адрес, params): Promise<ПодписьВИстории[]> {
      if (отказ) throw new Error('Узел Solana отказал на getSignaturesForAddress: Too many requests');
      // Узел отдаёт от новых к старым и только то, что новее `until`.
      const отНовых = [...поступления].reverse();
      const граница = params.until ? отНовых.findIndex((п) => п.signature === params.until) : -1;
      const новые = граница >= 0 ? отНовых.slice(0, граница) : отНовых;
      return новые.slice(0, params.limit).map((п) => ({
        signature: п.signature,
        blockTime: п.blockTime,
        err: п.err ?? null,
      }));
    },
    async getTransaction(signature): Promise<ТранзакцияJson | null> {
      запросовТел += 1;
      const п = поступления.find((к) => к.signature === signature);
      if (!п || п.безТела) return null;
      return {
        blockTime: п.blockTime,
        meta: {
          err: п.err ?? null,
          preBalances: [0, 0],
          postBalances: [0, Number(п.amountUnits)],
          preTokenBalances: [],
          postTokenBalances: [],
        },
        transaction: { message: { accountKeys: [{ pubkey: 'Покупатель' }, { pubkey: МАГАЗИН }] } },
      };
    },
    async getTokenAccountsByOwner(): Promise<string[]> {
      return ['ТокенСчётМагазина'];
    },
  };
}

let каталог: string;
let store: Store;
let закрытые: Array<{ tildaOrderId: string; signature: string }>;
let журнал: string[];
let письма: string[];

function стенд(
  поступления: Поступление[],
  изменения: { отказУзла?: boolean; config?: Partial<Config> } = {},
): ScannerDeps & { rpc: ReturnType<typeof фейковыйRpc> } {
  const rpc = фейковыйRpc(поступления, изменения.отказУзла ?? false);
  return {
    config: { ...config, ...изменения.config },
    store,
    rpc,
    log: createLog((строка) => журнал.push(строка)),
    закрытьЗаказ: async (order: Order, signature: string) => {
      закрытые.push({ tildaOrderId: order.tildaOrderId, signature });
    },
    тест: {
      сейчас: () => СЕЙЧАС,
      // Без подмены `sendUnmatchedMail` бил бы по настоящему SMTP на
      // config.smtp.host в каждом тесте, где поступление не опознано.
      отправкаПисьма: async () => {
        письма.push('письмо');
        return { messageId: 'тест' };
      },
    },
  };
}

/** Заводит заказ с подбором уникальной суммы и отдаёт его. */
function заказ(изменения: Partial<NewOrder> = {}): Order {
  return store.createOrder({ ...образец, ...изменения }, { потолокДобавки: 10_000 });
}

beforeEach(() => {
  каталог = mkdtempSync(join(tmpdir(), 'spkz-scanner-'));
  store = openDatabase(join(каталог, 'orders.sqlite'));
  закрытые = [];
  журнал = [];
  письма = [];
});

afterEach(() => {
  rmSync(каталог, { recursive: true, force: true });
});

/** Ставит курсор так, будто прошлый проход уже был: иначе первый проход только запоминает голову. */
function курсорНа(signature: string, blockTime: number | null = СЕЙЧАС - 1000): void {
  store.setScanCursor({ signature, blockTime });
}

describe('сканироватьОдинРаз', () => {
  it('на первом запуске запоминает голову истории и ничего не разбирает', async () => {
    заказ();
    const deps = стенд([{ signature: 'Старая', blockTime: СЕЙЧАС - 10, amountUnits: '420000' }]);

    await сканироватьОдинРаз(deps);

    expect(закрытые).toEqual([]);
    expect(store.scanCursor()?.signature).toBe('Старая');
    // Тело транзакции не запрашивалось вовсе — именно ради этого первый
    // запуск и не разбирает историю: она сжигает квоту узла.
    expect(deps.rpc.запросовТел).toBe(0);
  });

  it('закрывает заказ, когда поступление совпало по сумме', async () => {
    const з = заказ();
    курсорНа('Начало');
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'ПодписьA', blockTime: СЕЙЧАС - 100, amountUnits: з.amountUnits },
    ]);

    await сканироватьОдинРаз(deps);

    expect(закрытые).toEqual([{ tildaOrderId: з.tildaOrderId, signature: 'ПодписьA' }]);
    expect(store.scanCursor()?.signature).toBe('ПодписьA');
  });

  it('не закрывает заказ поступлением на другую сумму — даже отличающимся на один лампорт', async () => {
    const з = заказ();
    курсорНа('Начало');
    const сумма = (BigInt(з.amountUnits) - 1n).toString();
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'ПодписьA', blockTime: СЕЙЧАС - 100, amountUnits: сумма },
    ]);

    await сканироватьОдинРаз(deps);

    expect(закрытые).toEqual([]);
    expect(store.listUnmatched(10)[0]).toMatchObject({
      signature: 'ПодписьA',
      amountUnits: сумма,
      reason: ПРИЧИНЫ.нетЗаказа,
    });
  });

  it('не закрывает заказ транзакцией старше самого заказа', async () => {
    // Сумма освобождается закрытым заказом и может достаться новому:
    // старый платёж по старой странице не должен закрыть чужой свежий
    // заказ.
    const з = заказ();
    курсорНа('Начало');
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 5000, amountUnits: '1' },
      { signature: 'ПодписьA', blockTime: з.createdAt - 1, amountUnits: з.amountUnits },
    ]);

    await сканироватьОдинРаз(deps);

    expect(закрытые).toEqual([]);
    expect(store.listUnmatched(10)[0]?.reason).toBe(ПРИЧИНЫ.транзакцияСтаршеЗаказа);
  });

  it('одну транзакцию засчитывает только одному заказу', async () => {
    const з = заказ();
    курсорНа('Начало');
    const поступления = [
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'ПодписьA', blockTime: СЕЙЧАС - 100, amountUnits: з.amountUnits },
    ];

    await сканироватьОдинРаз(стенд(поступления));
    // Второй проход с тем же поступлением: курсор откатываем руками,
    // будто узел отдал эту подпись повторно.
    курсорНа('Начало');
    await сканироватьОдинРаз(стенд(поступления));

    expect(закрытые).toHaveLength(1);
    expect(store.listUnmatched(10)[0]?.reason).toBe(ПРИЧИНЫ.подписьУжеИспользована);
  });

  it('при отказе узла не двигает курсор и ничего не теряет', async () => {
    курсорНа('Начало');
    const deps = стенд([], { отказУзла: true });

    await сканироватьОдинРаз(deps);

    expect(store.scanCursor()?.signature).toBe('Начало');
    expect(журнал.join(' ')).toContain('Не удалось прочитать поступления');
  });

  it('останавливается на подписи без тела, не двигая курсор дальше неё', async () => {
    const з = заказ();
    курсорНа('Начало');
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'ПодписьБезТела', blockTime: СЕЙЧАС - 200, amountUnits: '5', безТела: true },
      { signature: 'ПодписьA', blockTime: СЕЙЧАС - 100, amountUnits: з.amountUnits },
    ]);

    await сканироватьОдинРаз(deps);

    // Курсор остался на прежнем месте: к неразобранной подписи вернёмся
    // следующим проходом, а более новую подпись разбирать вперёд неё
    // нельзя — иначе она будет пропущена навсегда.
    expect(store.scanCursor()?.signature).toBe('Начало');
    expect(закрытые).toEqual([]);
  });

  it('пропускает провалившуюся транзакцию, но курсор через неё двигает', async () => {
    курсорНа('Начало');
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'Провал', blockTime: СЕЙЧАС - 100, amountUnits: '420000', err: { InstructionError: [0, 'Custom'] } },
    ]);

    await сканироватьОдинРаз(deps);

    expect(закрытые).toEqual([]);
    expect(store.listUnmatched(10)).toEqual([]);
    expect(store.scanCursor()?.signature).toBe('Провал');
  });

  it('не трогает закрытый заказ: его сумма уже освобождена', async () => {
    const з = заказ();
    store.updateState(з.id, 'уведомлён');
    курсорНа('Начало');
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'ПодписьA', blockTime: СЕЙЧАС - 100, amountUnits: з.amountUnits },
    ]);

    await сканироватьОдинРаз(deps);

    expect(закрытые).toEqual([]);
    expect(store.listUnmatched(10)[0]?.reason).toBe(ПРИЧИНЫ.нетЗаказа);
  });

  it('при выключенном способе не обращается к узлу вовсе', async () => {
    const deps = стенд([{ signature: 'ПодписьA', blockTime: СЕЙЧАС, amountUnits: '420000' }], {
      config: { enableAmountMatching: false },
    });

    await сканироватьОдинРаз(deps);

    expect(store.scanCursor()).toBeNull();
    expect(deps.rpc.запросовТел).toBe(0);
  });

  it('разбирает не больше своего потолка за проход, остальное оставляет следующему', async () => {
    курсорНа('Начало');
    const поступления: Поступление[] = [{ signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' }];
    for (let i = 1; i <= 5; i += 1) {
      поступления.push({ signature: `Подпись${i}`, blockTime: СЕЙЧАС - 500 + i, amountUnits: '7' });
    }
    const базовый = стенд(поступления);
    const deps = { ...базовый, тест: { ...базовый.тест, потолокПодписейЗаПроход: 2 } };

    await сканироватьОдинРаз(deps);

    // Узел отдаёт от новых к старым, потолок обрезает выборку: разобраны
    // две самые новые, курсор встал на самой новой из них.
    expect(deps.rpc.запросовТел).toBe(2);
    expect(store.scanCursor()?.signature).toBe('Подпись5');
  });
});

describe('письмо о неопознанном поступлении', () => {
  it('уходит продавцу, когда поступление не подошло ни одному заказу', async () => {
    курсорНа('Начало');
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'ПодписьЧужая', blockTime: СЕЙЧАС - 100, amountUnits: '777' },
    ]);

    await сканироватьОдинРаз(deps);

    expect(письма).toHaveLength(1);
    expect(store.listUnmatched(10)[0]?.mailedAt).toBe(СЕЙЧАС);
  });

  it('не уходит второй раз в тот же час, но поступление всё равно записано', async () => {
    курсорНа('Начало');
    const deps = стенд([
      { signature: 'Начало', blockTime: СЕЙЧАС - 1000, amountUnits: '1' },
      { signature: 'Чужая1', blockTime: СЕЙЧАС - 200, amountUnits: '777' },
      { signature: 'Чужая2', blockTime: СЕЙЧАС - 100, amountUnits: '778' },
    ]);

    await сканироватьОдинРаз(deps);

    expect(письма).toHaveLength(1);
    expect(store.listUnmatched(10)).toHaveLength(2);
  });
});
