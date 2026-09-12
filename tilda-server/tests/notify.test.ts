import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, type NewOrder, type Order, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import { signFields } from '../src/signature.js';
import { notifyTilda, прочитатьТелоСОграничением, type NotifyDeps, type Отправка } from '../src/tilda/notify.js';

const config = {
  notifySecret: 'секрет-уведомления',
  orderSecret: 'секрет-заказа',
  tildaNotifyUrl: 'https://tilda.cc/payment/notify/abc',
};

const образецНовогоЗаказа: NewOrder = {
  tildaOrderId: '10868059:42',
  token: 'a'.repeat(32),
  amountKzt: '15000',
  currency: 'KZT',
  amountToken: '32.640000',
  tokenSymbol: 'USDC',
  cluster: 'devnet',
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  reference: 'секретная-метка',
  rate: '459.55',
  rateSource: 'synthetic',
  paymentUrl: 'solana:пример',
  quoteJson: '{}',
  createdAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 900,
  testMode: false,
  tildaSignature: 'подпись-заказа',
  txSignature: 'подпись-транзакции-1',
  customerEmail: null,
  description: null,
  productsJson: null,
};

/** Готовый ответ на отправку — без сети, без ожидания. */
function ответ(status: number, body: string): Отправка {
  return async () => ({ status, body });
}

/** Отвечает неуспехом дважды подряд, затем — успехом. */
/** Отвечает неуспехом заданное число раз подряд, затем — успехом. */
function падаетНРаз(раз: number): Отправка {
  let вызов = 0;
  return async () => {
    вызов += 1;
    return вызов <= раз ? { status: 500, body: 'ошибка' } : { status: 200, body: 'OK' };
  };
}

/** Никогда не отвечает успехом. */
function всегдаПадает(): Отправка {
  return async () => ({ status: 500, body: 'ошибка сервера' });
}

/** Перехватывает поля, реально переданные в отправку, минуя сеть. */
async function перехватитьОтправку(
  вызвать: (отправка: Отправка) => Promise<unknown>,
): Promise<Record<string, string>> {
  let перехваченные: Record<string, string> | null = null;
  const отправка: Отправка = async (_url, поля) => {
    перехваченные = поля;
    return { status: 200, body: 'OK' };
  };
  await вызвать(отправка);
  if (!перехваченные) throw new Error('отправка ни разу не была вызвана');
  return перехваченные;
}

describe('notifyTilda', () => {
  let каталог: string;
  let store: Store;
  let журнал: string[];
  let заказ: Order;
  let deps: NotifyDeps;

  beforeEach(() => {
    каталог = mkdtempSync(join(tmpdir(), 'spkz-notify-'));
    store = openDatabase(join(каталог, 'orders.sqlite'));
    журнал = [];
    заказ = store.createOrder(образецНовогоЗаказа);
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись-транзакции-1', paidAt: 1_700_000_000 });
    заказ = store.findByToken(заказ.token)!;
    deps = {
      config,
      store,
      log: createLog((строка) => журнал.push(строка)),
      тест: {
        // Настоящие паузы (1, 5, 15, 60 секунд) — для боя; здесь достаточно
        // проверить сам факт повтора и счётчик попыток, а не честно ждать
        // почти полторы минуты в каждом прогоне тестов. Само расписание пауз
        // проверяется отдельным тестом ниже, через `подождать`, а не через
        // эти маленькие числа.
        задержкиMs: [1, 1, 1, 1],
      },
    };
  });

  afterEach(() => {
    rmSync(каталог, { recursive: true, force: true });
  });

  /** deps с подменённой отправкой — остальные крюки (задержкиMs) сохраняются. */
  function сОтправкой(отправка: Отправка): NotifyDeps {
    return { ...deps, тест: { ...deps.тест, отправка } };
  }

  it('подписывает уведомление секретом уведомления, а не секретом заказа', async () => {
    const отправленное = await перехватитьОтправку((отправка) => notifyTilda(заказ, сОтправкой(отправка)));
    expect(отправленное.signature).toBe(signFields(отправленное, config.notifySecret, 'notify'));
    expect(отправленное.signature).not.toBe(signFields(отправленное, config.orderSecret, 'notify'));
  });

  it('подписывает уведомление с ролью notify — даже с секретом заказа (гипотетически) подпись заказа не подошла бы', async () => {
    // Правка финального ревью: метка роли в строке подписи (см.
    // signature.ts) делает подписи заказа и уведомления невзаимозаменяемыми
    // независимо от настроек секретов — вторая, самостоятельная линия
    // обороны сверх запрета равенства секретов в loadConfig.
    const отправленное = await перехватитьОтправку((отправка) => notifyTilda(заказ, сОтправкой(отправка)));
    expect(отправленное.signature).not.toBe(signFields(отправленное, config.notifySecret, 'order'));
  });

  it('несёт order_id, amount, currency, test_mode, status «paid» и подпись транзакции', async () => {
    const отправленное = await перехватитьОтправку((отправка) => notifyTilda(заказ, сОтправкой(отправка)));
    expect(отправленное.order_id).toBe(заказ.tildaOrderId);
    expect(отправленное.amount).toBe(заказ.amountKzt);
    expect(отправленное.currency).toBe('KZT');
    expect(отправленное.test_mode).toBe('0');
    expect(отправленное.status).toBe('paid');
    expect(отправленное.transaction).toBe(заказ.txSignature);
  });

  it('передаёт test_mode «1» для тестового заказа Tilda — «0» здесь зашитой константой не прошло бы', async () => {
    // testMode замораживается при создании заказа (не меняется updateState),
    // поэтому для тестового случая заводим отдельный заказ, а не правим этот.
    const тестовый = store.createOrder({ ...образецНовогоЗаказа, tildaOrderId: 't:1', token: 'т'.repeat(32), testMode: true });
    store.updateState(тестовый.id, 'оплачен', { txSignature: 'подпись-теста', paidAt: 1_700_000_000 });
    const заказТест = store.findByToken(тестовый.token)!;

    const отправленное = await перехватитьОтправку((отправка) => notifyTilda(заказТест, сОтправкой(отправка)));
    expect(отправленное.test_mode).toBe('1');
  });

  it('считает успехом только тело OK', async () => {
    expect(await notifyTilda(заказ, сОтправкой(ответ(200, 'OK')))).toBe(true);
    expect(await notifyTilda(заказ, сОтправкой(ответ(200, 'что-то другое')))).toBe(false);
    expect(await notifyTilda(заказ, сОтправкой(ответ(500, 'OK')))).toBe(false);
  });

  it('повторяет с растущими паузами по всему расписанию 1/5/15/60 секунд', async () => {
    // Не через реальное ожидание (это честно ждало бы 81 секунду) и не
    // через подмену задержкиMs на маленькие числа (это не доказало бы,
    // что расписание именно растущее) — через `подождать`: он получает те
    // же самые значения, что пошли бы в реальный `setTimeout`, но не ждёт
    // их. Четыре провала подряд — чтобы увидеть все четыре паузы
    // расписания целиком, а не только первые две.
    const запрошенныеПаузы: number[] = [];
    const результат = await notifyTilda(заказ, {
      config,
      store,
      log: createLog(() => {}),
      тест: {
        отправка: падаетНРаз(4),
        подождать: async (ms) => {
          запрошенныеПаузы.push(ms);
        },
      },
    });
    expect(результат).toBe(true);
    expect(запрошенныеПаузы).toEqual([1000, 5000, 15000, 60000]);
  });

  it('номер попытки в записи продолжает order.notifyAttempts, а не начинается заново с 1', async () => {
    // Заказ уже пережил три более ранних попытки в прошлых вызовах
    // notifyTilda (например, обход довозил уведомление и оно не удалось) —
    // счёт обязан продолжиться, а не обнулиться в этом, новом вызове.
    store.markNotified(заказ.id, false, 3);
    const заказСТремяПопытками = store.findByToken(заказ.token)!;

    await notifyTilda(заказСТремяПопытками, сОтправкой(ответ(200, 'OK')));

    expect(store.findByToken(заказ.token)?.notifyAttempts).toBe(4);
  });

  it('максимумПопыток ограничивает число попыток одним вызовом', async () => {
    let вызовов = 0;
    const результат = await notifyTilda(
      заказ,
      сОтправкой(async () => {
        вызовов += 1;
        return { status: 500, body: 'ошибка' };
      }),
      { максимумПопыток: 1 },
    );
    expect(результат).toBe(false);
    expect(вызовов).toBe(1);
    expect(store.findByToken(заказ.token)?.notifyAttempts).toBe(1);
  });

  it('исчерпав попытки, оставляет заказ оплаченным, но не уведомлённым', async () => {
    const результат = await notifyTilda(заказ, сОтправкой(всегдаПадает()));
    expect(результат).toBe(false);
    const после = store.findByToken(заказ.token);
    // Состояние заказа notifyTilda не трогает вовсе — им управляет
    // src/checker.ts после получения результата (см. tests/checker.test.ts).
    expect(после?.state).toBe('оплачен');
    expect(после?.notifiedOk).toBe(0);
    expect(после?.notifyAttempts).toBe(5);
  });

  it('помечает попытку в базе ДО отправки: падение процесса не приведёт к повторной отправке при перечтении', async () => {
    let попытокЗамеченоВБазеВнутриОтправки = 0;
    const отправка: Отправка = async () => {
      // На момент вызова самой отправки заказ уже должен быть помечен как
      // «попытка была» — иначе неудачное завершение процесса ровно здесь
      // (после ухода запроса, до записи исхода) осталось бы незамеченным.
      попытокЗамеченоВБазеВнутриОтправки = store.findByToken(заказ.token)?.notifyAttempts ?? 0;
      return { status: 200, body: 'OK' };
    };
    await notifyTilda(заказ, сОтправкой(отправка));
    expect(попытокЗамеченоВБазеВнутриОтправки).toBe(1);
  });

  it('не пишет в журнал ни подпись, ни секрет уведомления', async () => {
    await notifyTilda(заказ, сОтправкой(всегдаПадает()));
    const отправленное = await перехватитьОтправку((отправка) => notifyTilda(заказ, сОтправкой(отправка)));
    const весьЖурнал = журнал.join('\n');
    expect(весьЖурнал).not.toContain(отправленное.signature);
    expect(весьЖурнал).not.toContain(config.notifySecret);
  });

  it('падение сети (исключение внутри отправки) — тоже неуспех, а не необработанный сбой', async () => {
    const отправка: Отправка = async () => {
      throw new Error('сеть недоступна');
    };
    await expect(notifyTilda(заказ, сОтправкой(отправка))).resolves.toBe(false);
  });

  it('отказывается отправлять уведомление без подписи транзакции', async () => {
    store.updateState(заказ.id, 'оплачен', { txSignature: null });
    заказ = store.findByToken(заказ.token)!;

    let отправкаВызвана = false;
    const отправка: Отправка = async () => {
      отправкаВызвана = true;
      return { status: 200, body: 'OK' };
    };

    const результат = await notifyTilda(заказ, сОтправкой(отправка));

    expect(результат).toBe(false);
    expect(отправкаВызвана).toBe(false);
    expect(журнал.some((строка) => строка.includes('без подписи транзакции'))).toBe(true);
  });
});

describe('notifyTilda — настоящая сеть (без подмены отправки)', () => {
  let каталог: string;
  let store: Store;
  let заказ: Order;
  let сервер: Server;
  let базовыйUrl: string;
  let ответноеТело = 'OK';
  let ответныйСтатус = 200;

  beforeEach(async () => {
    каталог = mkdtempSync(join(tmpdir(), 'spkz-notify-net-'));
    store = openDatabase(join(каталог, 'orders.sqlite'));
    заказ = store.createOrder(образецНовогоЗаказа);
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись-транзакции-1', paidAt: 1_700_000_000 });
    заказ = store.findByToken(заказ.token)!;

    ответноеТело = 'OK';
    ответныйСтатус = 200;
    сервер = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(ответныйСтатус, { 'content-type': 'text/plain' });
        res.end(ответноеТело);
      });
    });
    await new Promise<void>((resolve) => сервер.listen(0, '127.0.0.1', resolve));
    const адрес = сервер.address() as AddressInfo;
    базовыйUrl = `http://127.0.0.1:${адрес.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => сервер.close(() => resolve()));
    rmSync(каталог, { recursive: true, force: true });
  });

  it('настоящий HTTP: тело "OK" принимается', async () => {
    ответноеТело = 'OK';
    const результат = await notifyTilda(заказ, {
      config: { ...config, tildaNotifyUrl: базовыйUrl },
      store,
      log: createLog(() => {}),
      тест: { задержкиMs: [1, 1, 1, 1] },
    });
    expect(результат).toBe(true);
  });

  it('настоящий HTTP: тело "OKAY" не принимается', async () => {
    ответноеТело = 'OKAY';
    const результат = await notifyTilda(заказ, {
      config: { ...config, tildaNotifyUrl: базовыйUrl },
      store,
      log: createLog(() => {}),
      тест: { задержкиMs: [1, 1, 1, 1] },
    });
    expect(результат).toBe(false);
  });

});

describe('прочитатьТелоСОграничением', () => {
  // Через настоящую сеть — дорого и медленно (тело в сотни килобайт заметно
  // замедлило бы общий прогон); через `Response`/`ReadableStream` напрямую,
  // без сети, — быстро и проверяет именно этот предел.
  //
  // Выяснено при отладке: тот же сценарий через настоящий локальный
  // HTTP-сервер занимал больше 3 секунд именно ВНУТРИ vitest — тот же код,
  // запущенный тем же Node вне vitest, укладывался примерно в 100 мс,
  // то есть внутри vitest он медленнее раз в тридцать. Причина не
  // выяснена до конца (подозрение на особенности пула соединений undici
  // при отменённом через `ReadableStream.cancel()` чтении тела), но
  // разбираться дальше не стали — обход через прямую проверку потока ниже
  // и быстрый, и детерминированный. Если кто-то снова наткнётся на
  // необъяснимо медленный тест с настоящей сетью внутри vitest — это уже
  // известная особенность, а не повод искать заново.
  function ответСоСтримом(куски: string[]): Response {
    const поток = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const кусок of куски) controller.enqueue(new TextEncoder().encode(кусок));
        controller.close();
      },
    });
    return new Response(поток);
  }

  it('укладывающееся в лимит тело читает целиком', async () => {
    const тело = await прочитатьТелоСОграничением(ответСоСтримом(['O', 'K']), 10_000);
    expect(тело).toBe('OK');
  });

  it('тело, превышающее лимит, обрывается, а не буферизуется целиком', async () => {
    // Без отдельного предела по объёму тайм-аут запроса ограничивал бы
    // только время ответа, а не его размер — ответ не от Tilda мог бы
    // буферизоваться в память сколь угодно долго.
    const куски = Array.from({ length: 20 }, () => 'x'.repeat(1000)); // 20 000 байт
    const тело = await прочитатьТелоСОграничением(ответСоСтримом(куски), 10_000);
    expect(тело.length).toBeLessThanOrEqual(11_000); // чуть больше лимита — обрыв на границе куска, не точно по байту
    expect(тело.length).toBeLessThan(20_000);
  });
});
