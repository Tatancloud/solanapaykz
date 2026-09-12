import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentStatus } from '@solanapaykz/core';
import { checkOrder, startChecker, обходОдинРаз, type CheckerDeps, type PaymentCheckerClient } from '../src/checker.js';
import type { Config } from '../src/config.js';
import { openDatabase, type NewOrder, type Order, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import type { ОтправкаПисьма } from '../src/mailer.js';
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
  listenHost: '127.0.0.1',
  trustedProxyAddresses: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
  enableFormWebhook: false,
};

const образец: NewOrder = {
  tildaOrderId: '10868059:42',
  token: 'ткн-1',
  amountKzt: '15000',
  currency: 'KZT',
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

/** Клиент, который никогда не отвечает — имитация зависшего RPC. */
function клиентКоторыйВисит(): PaymentCheckerClient {
  return {
    checkPayment: () => new Promise(() => {}),
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
 * Отправка письма продавцу, которая всегда успешна и считает вызовы — по
 * умолчанию подставляется в `deps.тест.отправкаПисьма` этого файла: без
 * неё `sendMerchantMail` (вызывается из `применитьРешение` при переходах
 * в «оплачен», «не сошлось», «поздний» — задача 8, правка ревью) била бы
 * по настоящему SMTP на `config.smtp.host`.
 */
function счётчикПисем(): { отправкаПисьма: ОтправкаПисьма; значение: number } {
  const результат = { значение: 0 } as { отправкаПисьма: ОтправкаПисьма; значение: number };
  результат.отправкаПисьма = async () => {
    результат.значение += 1;
    return { messageId: 'test' };
  };
  return результат;
}

/**
 * `checkOrder` запускает уведомление Tilda для только что подтверждённого
 * платежа, но не ждёт его (см. checker.ts, случай «оплачен» в
 * `применитьРешение`) — иначе опрос из вкладки покупателя завис бы на время
 * всех повторов `notifyTilda` (найдено проверкой в настоящем браузере).
 * Тестам, которым нужно увидеть итог ПОСЛЕ того, как эта фоновая отправка
 * завершится, приходится дождаться его явно — не фиксированной паузой
 * (сколько именно нужно ждать, не гарантировано и зависит от загрузки
 * процесса — фиксированные 10 мс однажды уже не хватило), а опросом
 * фактического результата с потолком по времени на случай, если он и
 * правда никогда не наступит.
 */
async function дождатьсяЗавершенияОтправки(store: Store, token: string, таймаутMs = 2000): Promise<void> {
  const конец = Date.now() + таймаутMs;
  for (;;) {
    const заказ = store.findByToken(token);
    if (заказ && (заказ.notifiedOk === 1 || заказ.notifyAttempts >= 5)) return;
    if (Date.now() > конец) {
      throw new Error('дождатьсяЗавершенияОтправки: уведомление не завершилось за отведённое время');
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * То же самое, но для письма продавцу (`отправитьПисьмоПродавцу` в
 * checker.ts тоже не ожидается вызывающим) — общий поллер по условию, а не
 * фиксированной паузой, по той же причине, что и `дождатьсяЗавершенияОтправки`
 * выше: конкретная задержка не гарантирована и зависит от загрузки процесса.
 */
async function дождатьсяУсловия(условие: () => boolean, таймаутMs = 2000): Promise<void> {
  const конец = Date.now() + таймаутMs;
  for (;;) {
    if (условие()) return;
    if (Date.now() > конец) {
      throw new Error('дождатьсяУсловия: условие не выполнилось за отведённое время');
    }
    await new Promise((r) => setTimeout(r, 2));
  }
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
      тест: {
        задержкиMs: [1, 1, 1, 1],
        // По умолчанию отправка ничего не подтверждает: часть тестов этого
        // блока доводит заказ до «оплачен», что запускает notifyTilda
        // изнутри checkOrder, — без подмены она бы била по настоящей сети
        // на tildaNotifyUrl. Отдельные тесты про сам факт и счёт
        // уведомлений подменяют это своим (успешным) отправителем явно.
        отправка: async () => ({ status: 503, body: 'сервис недоступен' }),
        // То же самое для письма продавцу (задача 8, правка ревью —
        // применитьРешение теперь зовёт sendMerchantMail на «оплачен»,
        // «не сошлось» и «поздний»): без подмены оно било бы по
        // настоящему SMTP на config.smtp.host на КАЖДОМ таком тесте этого
        // блока. Успешная заглушка по умолчанию — сам факт письма и его
        // содержимое проверяет tests/mailer.test.ts, а не этот файл;
        // здесь важно только то, что вызов вообще происходит (см. тесты
        // «...отправляет письмо продавцу» ниже).
        отправкаПисьма: async () => ({ messageId: 'test' }),
      },
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

  it('зависший узел не держит блокировку вечно — следующая проверка проходит как обычно', async () => {
    const о = store.createOrder(образец);
    const депыСМаленькимТаймаутом: CheckerDeps = {
      ...deps,
      client: клиентКоторыйВисит(),
      тест: { ...deps.тест, таймаутПроверкиПлатежаMs: 20 },
    };

    const начало = Date.now();
    const решение = await checkOrder(о, депыСМаленькимТаймаутом);
    expect(Date.now() - начало).toBeLessThan(1000);
    expect(решение.action).toBe('ждать');
    expect(store.findByToken(о.token)?.state).toBe('ожидает');

    // Лок снят (checkOrder вернулся) — следующая проверка тем же заказом
    // с работающим клиентом должна реально дойти до checkPayment, а не
    // застрять на «уже проверяется другим вызовом» навсегда.
    const решение2 = await checkOrder(store.findByToken(о.token)!, {
      ...deps,
      client: клиентСПлатежом('подпись-после-зависания'),
    });
    expect(решение2.action).toBe('оплачен');
    await дождатьсяЗавершенияОтправки(store, о.token); // не оставляем фоновую отправку висеть после теста
  });

  it('после быстрого ответа узла не оставляет висящий таймер тайм-аута checkPayment', async () => {
    // Доказано ревью замером: без гашения таймера гонки процесс не мог
    // завершиться тридцать секунд даже после мгновенного ответа узла —
    // жил один незагашенный таймер на каждый вызов.
    vi.useFakeTimers();
    try {
      const о = store.createOrder(образец);
      // клиентОжидающий отвечает мгновенно и оставляет заказ «ожидает» —
      // не запускает notifyTilda и её собственные таймеры пауз, которые
      // иначе попали бы в этот же счёт и исказили бы проверку.
      await checkOrder(о, { ...deps, client: клиентОжидающий() });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

  it('расхождение адреса получателя в настройках и в заказе не трогает заказ', async () => {
    // Продавец сменил кошелёк в настройках после создания заказа: адрес в
    // заказе (старый, тот, что на QR у покупателя) и в настройках (новый)
    // разошлись. Это ошибка конфигурации, а не платёж, который нужно
    // проверять чужим адресом, — заказ не трогаем.
    const о = store.createOrder(образец);
    let checkPaymentВызван = false;
    const депы: CheckerDeps = {
      ...deps,
      client: {
        async checkPayment() {
          checkPaymentВызван = true;
          return { status: 'pending' };
        },
      },
      config: { ...config, recipient: 'ДругойАдресКошелькаПослеСменыНастроек' },
    };

    const решение = await checkOrder(о, депы);

    expect(решение.action).toBe('ждать');
    expect(checkPaymentВызван).toBe(false);
    expect(store.findByToken(о.token)?.state).toBe('ожидает');
    expect(журнал.some((строка) => строка.toLowerCase().includes('адрес'))).toBe(true);
  });

  it('подтверждённый платёж переводит заказ в «оплачен» и сохраняет подпись — сразу, не дожидаясь уведомления', async () => {
    const о = store.createOrder(образец);
    await checkOrder(о, { ...deps, client: клиентСПлатежом('подпись-1') });
    // Проверяем ровно то, что успевает случиться СИНХРОННО с записью
    // решения: checkOrder возвращается сразу после этого, не дожидаясь
    // уведомления Tilda (см. checker.ts).
    const после = store.findByToken(о.token);
    expect(после?.state).toBe('оплачен');
    expect(после?.txSignature).toBe('подпись-1');
    expect(после?.paidAt).not.toBeNull();
    await дождатьсяЗавершенияОтправки(store, о.token); // не оставляем фоновую отправку висеть после теста
  });

  it('оплата отправляет письмо продавцу; повторная проверка того же заказа второго письма не шлёт', async () => {
    const письма = счётчикПисем();
    const о = store.createOrder(образец);

    await checkOrder(о, {
      ...deps,
      client: клиентСПлатежом('подпись-письма-1'),
      тест: { ...deps.тест, отправкаПисьма: письма.отправкаПисьма },
    });
    await дождатьсяУсловия(() => письма.значение >= 1);
    expect(письма.значение).toBe(1);

    // Повторная проверка того же уже «оплаченного» заказа — decide()
    // белым списком пускает «не сошлось»/«поздний»/«оплачен» только для
    // заказов, ещё бывших «ожидает»/«просрочен» (см. заголовок checker.ts);
    // «оплачен» с notifiedOk=0 перехватывает довезтиУведомление раньше
    // применитьРешение — второго письма быть не должно.
    await checkOrder(store.findByToken(о.token)!, {
      ...deps,
      client: клиентСПлатежом('подпись-письма-1'),
      тест: { ...deps.тест, отправкаПисьма: письма.отправкаПисьма },
    });
    await дождатьсяЗавершенияОтправки(store, о.token);
    expect(письма.значение).toBe(1);
  });

  it('платёж после истечения цены переводит в «поздний» и тоже отправляет письмо продавцу', async () => {
    const письма = счётчикПисем();
    // expiresAt в прошлом, state всё ещё «ожидает» — decide() отвечает
    // «поздний» именно на этой комбинации (см. decision.ts).
    const о = store.createOrder({ ...образец, expiresAt: Math.floor(Date.now() / 1000) - 10 });

    await checkOrder(о, {
      ...deps,
      client: клиентСПлатежом('подпись-поздняя'),
      тест: { ...deps.тест, отправкаПисьма: письма.отправкаПисьма },
    });

    expect(store.findByToken(о.token)?.state).toBe('поздний');
    await дождатьсяУсловия(() => письма.значение >= 1);
    expect(письма.значение).toBe(1);
  });

  it('«просрочен» не отправляет письмо продавцу — таких заказов много, и поток писем о них обесценил бы остальные', async () => {
    const письма = счётчикПисем();
    const о = store.createOrder({ ...образец, expiresAt: Math.floor(Date.now() / 1000) - 10 });

    await checkOrder(о, {
      ...deps,
      client: клиентОжидающий(),
      тест: { ...deps.тест, отправкаПисьма: письма.отправкаПисьма },
    });

    expect(store.findByToken(о.token)?.state).toBe('просрочен');
    // Письму, если бы оно отправлялось, хватило бы пары микрозадач, чтобы
    // синхронно вызвать заглушку и увеличить счётчик — ждать здесь нечего,
    // короткая пауза достаточна, чтобы отличить «не будет никогда» от
    // «ещё не успело».
    await new Promise((r) => setTimeout(r, 20));
    expect(письма.значение).toBe(0);
  });

  it('подтверждённый платёж отправляет ровно одно уведомление Tilda и переводит заказ в «уведомлён»', async () => {
    const { отправка } = счётчикОтправок();
    const о = store.createOrder(образец);
    await checkOrder(о, { ...deps, client: клиентСПлатежом('подпись-1'), тест: { ...deps.тест, отправка } });
    // Уведомление запускается, но не ожидается (см. checker.ts) — итоговое
    // состояние появляется в базе чуть позже возврата checkOrder.
    await дождатьсяЗавершенияОтправки(store, о.token);
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
    await checkOrder(о, {
      ...deps,
      client: клиентСПлатежом('подпись-1'),
      тест: { ...deps.тест, отправка: счётчик.отправка },
    });
    await checkOrder(store.findByToken(о.token)!, {
      ...deps,
      client: клиентСПлатежом('подпись-1'),
      тест: { ...deps.тест, отправка: счётчик.отправка },
    });
    await дождатьсяЗавершенияОтправки(store, о.token);
    expect(счётчик.значение).toBe(1);
  });

  it('защита «одно уведомление на платёж» срабатывает до начала отправки, а не после её завершения', async () => {
    // Отправка нарочно никогда не отвечает сама — только когда её явно
    // отпустят в конце теста. Если бы вторая проверка того же заказа
    // ждала ИСХОДА первой отправки, чтобы решить, слать ли повторно, —
    // она застряла бы здесь навсегда. Она не должна ждать исход вовсе:
    // решение принимается по состоянию заказа («оплачен» вне белого
    // списка decide()), которое записано в базу ДО первого вызова
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
    await checkOrder(о, { ...deps, client: клиент, тест: { ...deps.тест, отправка: зависающаяОтправка } });

    // Отправка от первого вызова всё ещё висит (мы её не отпустили), но
    // заказ уже «оплачен» в базе — второй вызов обязан остановиться на
    // этом, не трогая ни блокчейн, ни отправку повторно.
    await checkOrder(store.findByToken(о.token)!, {
      ...deps,
      client: клиент,
      тест: { ...deps.тест, отправка: зависающаяОтправка },
    });

    expect(вызовПроверкиПлатежа).toBe(1);
    expect(вызовОтправки).toBe(1);

    отпустить?.();
    await дождатьсяЗавершенияОтправки(store, о.token);
  });

  it('несовпадение суммы переводит в «не сошлось», не уведомляет Tilda, но отправляет письмо продавцу', async () => {
    const { отправка } = счётчикОтправок();
    const письма = счётчикПисем();
    const клиентСНесовпадением: PaymentCheckerClient = {
      async checkPayment() {
        return { status: 'mismatch', signature: 'подпись-2', reason: 'сумма меньше' };
      },
    };
    const о = store.createOrder(образец);
    await checkOrder(о, {
      ...deps,
      client: клиентСНесовпадением,
      тест: { ...deps.тест, отправка, отправкаПисьма: письма.отправкаПисьма },
    });
    const после = store.findByToken(о.token);
    expect(после?.state).toBe('не сошлось');
    expect(после?.txSignature).toBe('подпись-2');
    expect(после?.notifyAttempts).toBe(0);
    await дождатьсяУсловия(() => письма.значение >= 1);
    expect(письма.значение).toBe(1);
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
    await дождатьсяЗавершенияОтправки(store, о.token); // не оставляем фоновую отправку висеть после теста
  });

  describe('оплаченный, но ещё не уведомлённый заказ', () => {
    function создатьОплаченныйНеуведомлённый(paidAt: number): Order {
      const о = store.createOrder(образец);
      store.updateState(о.id, 'оплачен', { txSignature: 'подпись-предыдущей-попытки', paidAt });
      return store.findByToken(о.token)!;
    }

    it('повторно уведомляет Tilda, не трогая блокчейн повторно', async () => {
      const now = Math.floor(Date.now() / 1000);
      const заказ = создатьОплаченныйНеуведомлённый(now - 10);
      let checkPaymentВызван = false;
      const { отправка } = счётчикОтправок();

      const решение = await checkOrder(заказ, {
        ...deps,
        client: {
          async checkPayment() {
            checkPaymentВызван = true;
            return { status: 'pending' };
          },
        },
        тест: { ...deps.тест, отправка },
      });

      expect(checkPaymentВызван).toBe(false);
      expect(решение.action).toBe('ждать');
      const после = store.findByToken(заказ.token);
      expect(после?.state).toBe('уведомлён');
    });

    it('делает ровно одну попытку за вызов, а число попыток накапливается между вызовами', async () => {
      // Расписание повторов задаёт частота самого обхода (раз в минуту),
      // а не цикл в памяти процесса — переживает перезапуск процесса,
      // чего цикл с паузами в памяти не умеет. Полный цикл (1/5/15/60
      // секунд, до пяти попыток) остаётся только на пути свежей оплаты.
      const заказ = создатьОплаченныйНеуведомлённый(Math.floor(Date.now() / 1000) - 10);
      let вызововОтправки = 0;
      const отправкаКотораяВсегдаПадает: Отправка = async () => {
        вызововОтправки += 1;
        return { status: 500, body: 'ошибка' };
      };

      await checkOrder(заказ, {
        ...deps,
        client: клиентОжидающий(),
        тест: { ...deps.тест, отправка: отправкаКотораяВсегдаПадает },
      });
      expect(вызововОтправки).toBe(1); // одна попытка за вызов, не пять
      expect(store.findByToken(заказ.token)?.notifyAttempts).toBe(1);

      await checkOrder(store.findByToken(заказ.token)!, {
        ...deps,
        client: клиентОжидающий(),
        тест: { ...deps.тест, отправка: отправкаКотораяВсегдаПадает },
      });
      expect(вызововОтправки).toBe(2);
      // Счёт продолжается с прошлого вызова, а не начинается заново с 1 —
      // иначе после двух полных неудачных попыток в базе лежала бы 1, а
      // не 2, и число в итоговой записи журнала не отражало бы историю.
      expect(store.findByToken(заказ.token)?.notifyAttempts).toBe(2);
    });

    it('вне окна повтора, но ещё в пределах запаса выборки, доходит через обход и пишет в журнал уровня error об окончательном провале', async () => {
      // Вызов НАПРЯМУЮ через checkOrder на уже просроченном заказе — не
      // тот путь, каким это происходит в бою: обход отбирает заказы сам
      // (listPending), и предыдущая версия этого теста звала проверку
      // вручную с уже просроченным заказом, а через обход такого вызова
      // не бывает — именно поэтому она не заметила, что условие выборки и
      // условие этой ветки строго дополняли друг друга и обход никогда не
      // проносил заказ через границу окна. Здесь — через `обходОдинРаз`.
      //
      // Окно — 100 секунд, запас выборки — 50: paidAt 120 секунд назад —
      // окно уже истекло (120 > 100, ветка провала сработает), но запас
      // (100 + 50 = 150) ещё не истёк, значит обход всё ещё берёт этот
      // заказ в выборку — ровно тот единственный «лишний шанс», ради
      // которого запас и существует.
      const now = Math.floor(Date.now() / 1000);
      const заказ = создатьОплаченныйНеуведомлённый(now - 120);
      const счётчик = счётчикОтправок();

      await обходОдинРаз({
        ...deps,
        client: клиентОжидающий(),
        тест: {
          ...deps.тест,
          отправка: счётчик.отправка,
          окноПовтораУведомленияSeconds: 100,
          запасВыборкиДляЗаписиОПровалеSeconds: 50,
        },
      });

      const после = store.findByToken(заказ.token);
      expect(после?.state).toBe('оплачен');
      expect(после?.notifiedOk).toBe(0);
      // Ветка провала возвращает решение ДО вызова notifyTilda — отправки
      // не было вовсе, не только неудачной.
      expect(счётчик.значение).toBe(0);

      const записьОшибки = журнал.find((строка) => {
        const запись = JSON.parse(строка) as { level: string; msg: string };
        return запись.level === 'error' && запись.msg.includes('автоматические попытки прекращены');
      });
      expect(записьОшибки).toBeDefined();
    });

    it('за пределами запаса выборки обход больше не видит заказ вовсе', async () => {
      // Продолжение предыдущего теста: после лишнего шанса (запас истёк)
      // заказ выпадает из выборки навсегда — обход просто не находит его,
      // а не заходит в ветку провала снова и снова.
      const now = Math.floor(Date.now() / 1000);
      const заказ = создатьОплаченныйНеуведомлённый(now - 200); // 100 (окно) + 50 (запас) + запас на границу
      const обойдённые: string[] = [];

      await обходОдинРаз({
        ...deps,
        тест: {
          наЗаказ: (o: Order) => void обойдённые.push(o.tildaOrderId),
          окноПовтораУведомленияSeconds: 100,
          запасВыборкиДляЗаписиОПровалеSeconds: 50,
        },
      });

      expect(обойдённые).not.toContain(заказ.tildaOrderId);
    });
  });
});

describe('обходОдинРаз', () => {
  let каталог: string;
  let store: Store;
  let журнал: string[];
  let deps: CheckerDeps;

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
    await обходОдинРаз({ ...deps, тест: { наЗаказ: (o: Order) => void обойдённые.push(o.tildaOrderId) } });

    expect(обойдённые).toEqual(['a:2', 'a:1']);
  });

  it('падение проверки одного заказа не прерывает обход остальных', async () => {
    store.createOrder({ ...образец, tildaOrderId: 'b:1', token: 'к1', createdAt: 100 });
    store.createOrder({ ...образец, tildaOrderId: 'b:2', token: 'к2', createdAt: 200 });

    const обойдённые: string[] = [];
    await обходОдинРаз({
      ...deps,
      тест: {
        наЗаказ: (o: Order) => {
          обойдённые.push(o.tildaOrderId);
          if (o.tildaOrderId === 'b:1') throw new Error('узел недоступен');
        },
      },
    });

    expect(обойдённые).toEqual(['b:1', 'b:2']);
  });

  it('без переопределения наЗаказ реально вызывает checkOrder на каждом отобранном заказе', async () => {
    const о = store.createOrder(образец);
    await обходОдинРаз({
      ...deps,
      client: клиентСПлатежом('подпись-обхода'),
      тест: {
        // Без этого notifyTilda внутри checkOrder попыталась бы настоящий
        // сетевой запрос на tildaNotifyUrl и честно ждала бы тайм-аут.
        отправка: async () => ({ status: 200, body: 'OK' }),
        задержкиMs: [1, 1, 1, 1],
        // То же для письма продавцу — эта проверка переводит заказ в
        // «оплачен» через применитьРешение, значит без подмены реально
        // ушла бы попытка настоящей отправки через SMTP.
        отправкаПисьма: async () => ({ messageId: 'test' }),
      },
    });
    // checkOrder внутри обхода запускает уведомление, но не ждёт его.
    await дождатьсяЗавершенияОтправки(store, о.token);
    expect(store.findByToken(о.token)?.state).toBe('уведомлён');
  });

  it('подбирает оплаченный неуведомленный заказ в пределах окна и доводит уведомление', async () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', {
      txSignature: 'подпись',
      paidAt: Math.floor(Date.now() / 1000) - 10,
    });

    await обходОдинРаз({
      ...deps,
      тест: { отправка: async () => ({ status: 200, body: 'OK' }), задержкиMs: [1, 1, 1, 1] },
    });

    expect(store.findByToken(о.token)?.state).toBe('уведомлён');
  });

  it('прерывает проход по истечении отведённого времени, оставляя заказ доступным для следующего прохода', async () => {
    // Имитация зависшего RPC-провайдера: при исчерпании квоты он не
    // отвечает медленно одному заказу — перестаёт отвечать всем разом.
    // Три заказа, каждая проверка «висит» дольше отведённого на весь
    // проход времени, — обход должен остановиться, а не растянуться на
    // все три.
    store.createOrder({ ...образец, tildaOrderId: 'd:1', token: 'тд1', createdAt: 100 });
    store.createOrder({ ...образец, tildaOrderId: 'd:2', token: 'тд2', createdAt: 200 });
    store.createOrder({ ...образец, tildaOrderId: 'd:3', token: 'тд3', createdAt: 300 });

    const обойдённые: string[] = [];
    await обходОдинРаз({
      ...deps,
      тест: {
        максимальнаяДлительностьОбходаMs: 10,
        наЗаказ: async (o: Order) => {
          обойдённые.push(o.tildaOrderId);
          await new Promise((r) => setTimeout(r, 20));
        },
      },
    });

    // Остановился раньше конца списка — старые первыми, значит первым
    // же в следующем проходе снова окажется тот, до кого не дошла очередь.
    expect(обойдённые.length).toBeLessThan(3);
    expect(обойдённые[0]).toBe('d:1');

    const записьПредупреждения = журнал.find((строка) => {
      const запись = JSON.parse(строка) as { level: string; msg: string };
      return запись.level === 'warn' && запись.msg.includes('Обход прерван по истечении отведённого времени');
    });
    expect(записьПредупреждения).toBeDefined();
  });
});

describe('startChecker', () => {
  let каталог: string;
  let store: Store;
  let deps: CheckerDeps;

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
      тест: {
        наЗаказ: () => {
          проходов += 1;
        },
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
