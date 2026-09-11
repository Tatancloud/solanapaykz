import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentStatus } from '@solanapaykz/core';
import {
  checkOrder,
  startChecker,
  обходОдинРаз,
  type CheckerDeps,
  type PaymentCheckerClient,
  type WalkDeps,
} from '../src/checker.js';
import type { Config } from '../src/config.js';
import { openDatabase, type NewOrder, type Order, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import type { Отправка } from '../src/tilda/notify.js';

const config: Config = {
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  rpcUrl: 'https://api.devnet.solana.com',
  cluster: 'devnet',
  token: 'USDC',
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
};

const образец: NewOrder = {
  tildaOrderId: '10868059:42',
  token: 'ткн-1',
  amountKzt: '15000',
  amountToken: '32.640000',
  tokenSymbol: 'USDC',
  cluster: 'devnet',
  recipient: config.recipient,
  reference: 'метка-1',
  rate: '459.55',
  rateSource: 'synthetic',
  paymentUrl: 'solana:пример',
  quoteJson: JSON.stringify({ cluster: 'devnet', token: 'USDC' }),
  createdAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 900,
  testMode: false,
  tildaSignature: 'подпись-заказа',
  txSignature: null,
  customerEmail: null,
  description: null,
  productsJson: null,
};

/** Клиент, у которого проверка платежа всегда падает — имитация недоступного узла. */
function клиентКоторыйПадает(): PaymentCheckerClient {
  return {
    async checkPayment() {
      throw new Error('узел недоступен');
    },
  };
}

/** Клиент, у которого платёж пока не найден. */
function клиентОжидающий(): PaymentCheckerClient {
  return {
    async checkPayment(): Promise<PaymentStatus> {
      return { status: 'pending' };
    },
  };
}

/** Клиент с уже подтверждённым платежом по заданной подписью транзакции. */
function клиентСПлатежом(подпись: string): PaymentCheckerClient {
  return {
    async checkPayment(): Promise<PaymentStatus> {
      return { status: 'confirmed', signature: подпись, amountPaid: '32.640000' };
    },
  };
}

/** Отправка уведомления, которая всегда успешна, и считает, сколько раз её вызвали. */
function счётчикОтправок(): { отправка: Отправка; значение: number } {
  const результат = { значение: 0 } as { отправка: Отправка; значение: number };
  результат.отправка = async () => {
    результат.значение += 1;
    return { status: 200, body: 'OK' };
  };
  return результат;
}

/**
 * `checkOrder` запускает уведомление Tilda, но не ждёт его (см. checker.ts,
 * случай «оплачен» в `применитьРешение`) — иначе опрос из вкладки
 * покупателя завис бы на время всех повторов `notifyTilda` (найдено
 * проверкой в настоящем браузере). Тестам, которым нужно увидеть состояние
 * заказа ПОСЛЕ того, как эта фоновая отправка завершится, приходится явно
 * пропустить вперёд микрозадачи и минимальный таймер.
 */
function дождатьсяФоновыхЗадач(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('checkOrder', () => {
  let каталог: string;
  let store: Store;
  let журнал: string[];
  let deps: CheckerDeps;

  beforeEach(() => {
    каталог = mkdtempSync(join(tmpdir(), 'spkz-checker-'));
    store = openDatabase(join(каталог, 'orders.sqlite'));
    журнал = [];
    deps = {
      config,
      store,
      client: клиентОжидающий(),
      log: createLog((строка) => журнал.push(строка)),
      задержкиMs: [1, 1, 1, 1],
      // По умолчанию отправка ничего не подтверждает: часть тестов этого
      // блока доводит заказ до «оплачен», что запускает notifyTilda
      // изнутри checkOrder, — без подмены она бы била по настоящей сети на
      // tildaNotifyUrl. Отдельные тесты про сам факт и счёт уведомлений
      // подменяют это своим (успешным) отправителем явно.
      отправка: async () => ({ status: 503, body: 'сервис недоступен' }),
    };
  });

  afterEach(() => {
    rmSync(каталог, { recursive: true, force: true });
  });

  it('сбой узла не меняет состояние заказа', async () => {
    const о = store.createOrder(образец);
    const решение = await checkOrder(о, { ...deps, client: клиентКоторыйПадает() });
    expect(решение.action).toBe('ждать');
    expect(store.findByToken(о.token)?.state).toBe('ожидает');
  });

  it('расхождение сети в настройках и в заказе не трогает заказ', async () => {
    const о = store.createOrder({ ...образец, cluster: 'mainnet' });
    const решение = await checkOrder(о, { ...deps, config: { ...config, cluster: 'devnet' } });
    expect(решение.action).toBe('ждать');
    expect(store.findByToken(о.token)?.state).toBe('ожидает');
    // Регистронезависимо: сообщение начинается с «Сеть», но само слово
    // проверяем как есть — по заданию журнал должен упомянуть про сеть.
    expect(журнал.some((строка) => строка.toLowerCase().includes('сеть'))).toBe(true);
  });

  it('подтверждённый платёж переводит заказ в «оплачен» и сохраняет подпись — сразу, не дожидаясь уведомления', async () => {
    const о = store.createOrder(образец);
    await checkOrder(о, { ...deps, client: клиентСПлатежом('подпись-1') });
    // Проверяем ровно то, что успевает случиться СИНХРОННО с записью
    // решения: checkOrder возвращается сразу после этого, не дожидаясь
    // уведомления Tilda (см. checker.ts) — если бы состояние здесь
    // зависело от исхода отправки, этот тест либо не мог бы пройти без
    // дождатьсяФоновыхЗадач(), либо (при неуспешной отправке) не увидел бы
    // «оплачен» вовсе.
    const после = store.findByToken(о.token);
    expect(после?.state).toBe('оплачен');
    expect(после?.txSignature).toBe('подпись-1');
    await дождатьсяФоновыхЗадач(); // не оставляем фоновую отправку висеть после теста
  });

  it('подтверждённый платёж отправляет ровно одно уведомление Tilda и переводит заказ в «уведомлён»', async () => {
    const { отправка } = счётчикОтправок();
    const о = store.createOrder(образец);
    await checkOrder(о, { ...deps, client: клиентСПлатежом('подпись-1'), отправка });
    // Уведомление запускается, но не ожидается (см. checker.ts) — итоговое
    // состояние появляется в базе чуть позже возврата checkOrder.
    await дождатьсяФоновыхЗадач();
    const после = store.findByToken(о.token);
    expect(после?.state).toBe('уведомлён');
    expect(после?.notifiedOk).toBe(1);
  });

  it('один платёж не порождает двух уведомлений', async () => {
    // Не деструктурировать `счётчикОтправок()` на отдельные `{ отправка,
    // значение }` — `значение` мутируется на исходном объекте по ссылке
    // при каждом вызове `отправка`, а деструктуризация скопировала бы его
    // текущее (нулевое) значение один раз и не увидела бы дальнейший счёт.
    const счётчик = счётчикОтправок();
    const о = store.createOrder(образец);
    await checkOrder(о, { ...deps, client: клиентСПлатежом('подпись-1'), отправка: счётчик.отправка });
    await checkOrder(store.findByToken(о.token)!, {
      ...deps,
      client: клиентСПлатежом('подпись-1'),
      отправка: счётчик.отправка,
    });
    await дождатьсяФоновыхЗадач();
    expect(счётчик.значение).toBe(1);
  });

  it('защита «одно уведомление на платёж» срабатывает до начала отправки, а не после её завершения', async () => {
    // Отправка нарочно никогда не отвечает сама — только когда её явно
    // отпустят в конце теста. Если бы вторая проверка того же заказа
    // ждала ИСХОДА первой отправки, чтобы решить, слать ли повторно, —
    // она застряла бы здесь навсегда. Она не должна ждать исход вовсе:
    // решение принимается по состоянию заказа («оплачен»/«уведомлён» вне
    // белого списка decide()), которое записано в базу ДО первого вызова
    // notifyTilda, то есть до того, как эта отправка вообще началась.
    let вызовПроверкиПлатежа = 0;
    let вызовОтправки = 0;
    let отпустить: (() => void) | undefined;
    const зависающаяОтправка: Отправка = () =>
      new Promise((resolve) => {
        вызовОтправки += 1;
        отпустить = () => resolve({ status: 200, body: 'OK' });
      });
    const клиент: PaymentCheckerClient = {
      async checkPayment() {
        вызовПроверкиПлатежа += 1;
        return { status: 'confirmed', signature: 'подпись-зависшего-теста', amountPaid: '32.640000' };
      },
    };

    const о = store.createOrder(образец);
    await checkOrder(о, { ...deps, client: клиент, отправка: зависающаяОтправка });

    // Отправка от первого вызова всё ещё висит (мы её не отпустили), но
    // заказ уже «оплачен» в базе — второй вызов обязан остановиться на
    // этом, не трогая ни блокчейн, ни отправку повторно.
    await checkOrder(store.findByToken(о.token)!, { ...deps, client: клиент, отправка: зависающаяОтправка });

    expect(вызовПроверкиПлатежа).toBe(1);
    expect(вызовОтправки).toBe(1);

    отпустить?.();
    await дождатьсяФоновыхЗадач();
  });

  it('несовпадение суммы переводит в «не сошлось» и не уведомляет Tilda', async () => {
    const { отправка } = счётчикОтправок();
    const клиентСНесовпадением: PaymentCheckerClient = {
      async checkPayment() {
        return { status: 'mismatch', signature: 'подпись-2', reason: 'сумма меньше' };
      },
    };
    const о = store.createOrder(образец);
    await checkOrder(о, { ...deps, client: клиентСНесовпадением, отправка });
    const после = store.findByToken(о.token);
    expect(после?.state).toBe('не сошлось');
    expect(после?.txSignature).toBe('подпись-2');
    expect(после?.notifyAttempts).toBe(0);
  });

  it('второй параллельный вызов на том же заказе не проверяет платёж повторно', async () => {
    let вызовов = 0;
    const медленныйКлиент: PaymentCheckerClient = {
      async checkPayment() {
        вызовов += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { status: 'confirmed', signature: 'подпись-3', amountPaid: '32.640000' };
      },
    };
    const о = store.createOrder(образец);
    const [а, б] = await Promise.all([
      checkOrder(о, { ...deps, client: медленныйКлиент }),
      checkOrder(о, { ...deps, client: медленныйКлиент }),
    ]);
    // Ровно один из двух параллельных вызовов реально проверяет платёж —
    // второй, встретив занятый лок, сразу отвечает «ждать», не трогая RPC.
    expect(вызовов).toBe(1);
    expect([а.action, б.action].sort()).toEqual(['ждать', 'оплачен']);
    await дождатьсяФоновыхЗадач(); // не оставляем фоновую отправку висеть после теста
  });
});

describe('обходОдинРаз', () => {
  let каталог: string;
  let store: Store;
  let журнал: string[];
  let deps: WalkDeps;

  beforeEach(() => {
    каталог = mkdtempSync(join(tmpdir(), 'spkz-checker-walk-'));
    store = openDatabase(join(каталог, 'orders.sqlite'));
    журнал = [];
    deps = {
      config,
      store,
      client: клиентОжидающий(),
      log: createLog((строка) => журнал.push(строка)),
    };
  });

  afterEach(() => {
    rmSync(каталог, { recursive: true, force: true });
  });

  it('обход берёт только незакрытые заказы, старые первыми', async () => {
    store.createOrder({ ...образец, tildaOrderId: 'a:1', token: 'т1', createdAt: 300 });
    store.createOrder({ ...образец, tildaOrderId: 'a:2', token: 'т2', createdAt: 100 });
    const закрытый = store.createOrder({ ...образец, tildaOrderId: 'a:3', token: 'т3', createdAt: 200 });
    store.updateState(закрытый.id, 'уведомлён');

    const обойдённые: string[] = [];
    await обходОдинРаз({ ...deps, наЗаказ: (o: Order) => void обойдённые.push(o.tildaOrderId) });

    expect(обойдённые).toEqual(['a:2', 'a:1']);
  });

  it('падение проверки одного заказа не прерывает обход остальных', async () => {
    store.createOrder({ ...образец, tildaOrderId: 'b:1', token: 'к1', createdAt: 100 });
    store.createOrder({ ...образец, tildaOrderId: 'b:2', token: 'к2', createdAt: 200 });

    const обойдённые: string[] = [];
    await обходОдинРаз({
      ...deps,
      наЗаказ: (o: Order) => {
        обойдённые.push(o.tildaOrderId);
        if (o.tildaOrderId === 'b:1') throw new Error('узел недоступен');
      },
    });

    expect(обойдённые).toEqual(['b:1', 'b:2']);
  });

  it('без переопределения наЗаказ реально вызывает checkOrder на каждом отобранном заказе', async () => {
    const о = store.createOrder(образец);
    await обходОдинРаз({
      ...deps,
      client: клиентСПлатежом('подпись-обхода'),
      // Без этого notifyTilda внутри checkOrder попыталась бы настоящий
      // сетевой запрос на tildaNotifyUrl и честно ждала бы тайм-аут.
      отправка: async () => ({ status: 200, body: 'OK' }),
      задержкиMs: [1, 1, 1, 1],
    });
    // checkOrder внутри обхода запускает уведомление, но не ждёт его.
    await дождатьсяФоновыхЗадач();
    expect(store.findByToken(о.token)?.state).toBe('уведомлён');
  });
});

describe('startChecker', () => {
  let каталог: string;
  let store: Store;
  let deps: WalkDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    каталог = mkdtempSync(join(tmpdir(), 'spkz-checker-start-'));
    store = openDatabase(join(каталог, 'orders.sqlite'));
    deps = {
      config,
      store,
      client: клиентОжидающий(),
      log: createLog(() => {}),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(каталог, { recursive: true, force: true });
  });

  it('запускает обход раз в 60 секунд и останавливается функцией остановки', async () => {
    let проходов = 0;
    const стоп = startChecker({
      ...deps,
      наЗаказ: () => {
        проходов += 1;
      },
    });

    store.createOrder(образец);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(проходов).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(проходов).toBe(2);

    стоп();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(проходов).toBe(2);
  });
});
