import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PaymentRequest, PaymentStatus, Quote } from '@solanapaykz/core';
import type { PaymentCheckerClient } from '../src/checker.js';
import type { Config } from '../src/config.js';
import { openDatabase, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import { createServer, type ЗависимостиСервера } from '../src/http/server.js';
import type { PaymentClient } from '../src/tilda/inbound.js';

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
  // По умолчанию выключен (правка финального ревью — лишний неподписанный
  // вход не должен быть открыт продавцу, который им не пользуется) — этот
  // файл целиком про сам вебхук, поэтому включаем его явно.
  enableFormWebhook: true,
};

/**
 * Фейковый клиент SDK со счётчиком вызовов `createQuote` — им доказывается
 * ключевое требование задания: проверка `test=test` не должна касаться ни
 * курса, ни базы (см. заголовок `src/http/routes-webhook.ts`), а не только
 * «быстро ответить» — быстрый ответ можно получить и случайно, если
 * подвернулась быстрая сеть.
 */
function фейковыйКлиент(): PaymentClient & PaymentCheckerClient & { вызововКотировки: number } {
  const результат = { вызововКотировки: 0 } as PaymentClient & PaymentCheckerClient & { вызововКотировки: number };
  let счётчикМетки = 0;
  результат.createQuote = async ({ amountKzt, token }): Promise<Quote> => {
    результат.вызововКотировки += 1;
    return Object.freeze({
      quoteId: 'котировка-1',
      amountKzt,
      amountKztCharged: amountKzt,
      token,
      cluster: 'devnet',
      amountToken: '32.640000',
      rate: '459.55',
      rateSource: 'synthetic',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
  };
  результат.createPaymentRequest = async (quote): Promise<PaymentRequest> => {
    счётчикМетки += 1;
    return { quote, url: `solana:пример-${счётчикМетки}`, reference: `метка-${счётчикМетки}`, qrSvg: '<svg></svg>' };
  };
  результат.checkPayment = async (): Promise<PaymentStatus> => ({ status: 'pending' });
  return результат;
}

let каталог: string;
let store: Store;
let журнал: string[];
let server: Server;
let базовыйUrl: string;
let клиент: ReturnType<typeof фейковыйКлиент>;

beforeEach(async () => {
  каталог = mkdtempSync(join(tmpdir(), 'spkz-webhook-'));
  store = openDatabase(join(каталог, 'orders.sqlite'));
  журнал = [];
  клиент = фейковыйКлиент();

  const deps: ЗависимостиСервера = {
    config,
    store,
    client: клиент,
    log: createLog((строка) => журнал.push(строка)),
  };

  server = createServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const адрес = server.address() as AddressInfo;
  базовыйUrl = `http://127.0.0.1:${адрес.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(каталог, { recursive: true, force: true });
});

async function вебхук(поля: Record<string, string>): Promise<{ status: number; body: string }> {
  const ответ = await fetch(`${базовыйUrl}/tilda/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(поля).toString(),
  });
  return { status: ответ.status, body: await ответ.text() };
}

/** Тело реальной (не проверочной) заявки формы Tilda — поля с заглавной буквы, как в задании. */
function телоЗаявки(изменения: Record<string, string> = {}): Record<string, string> {
  return {
    tranid: '482910',
    formid: '12345',
    Name: 'Асель Тестова',
    Phone: '+77011234567',
    Email: 'asel@example.kz',
    Payment: '15000',
    ...изменения,
  };
}

describe('POST /tilda/webhook — проверка доступности', () => {
  it('на test=test отвечает 200 немедленно, не трогая курс', async () => {
    const ответ = await вебхук({ test: 'test' });
    expect(ответ.status).toBe(200);
    expect(клиент.вызововКотировки).toBe(0);
  });

  it('на test=test не заводит ни одного заказа', async () => {
    await вебхук({ test: 'test' });
    expect(store.listRecent(10)).toHaveLength(0);
  });

  it('игнорирует остальные поля заявки, если test=test уже стоит', async () => {
    // Формально одновременно пришли и test=test, и как будто настоящая
    // заявка — по заданию проверка доступности должна сработать первой и
    // не создавать заказ, даже если остальные поля выглядят валидными.
    const ответ = await вебхук({ ...телоЗаявки(), test: 'test' });
    expect(ответ.status).toBe(200);
    expect(store.listRecent(10)).toHaveLength(0);
  });
});

describe('POST /tilda/webhook — реальная заявка', () => {
  it('с полным набором полей заводит заказ в состоянии «ожидает»', async () => {
    const ответ = await вебхук(телоЗаявки());
    expect(ответ.status).toBe(200);
    expect(ответ.body).toContain('OK');

    const заказ = store.findByTildaOrderId('form:482910');
    expect(заказ).not.toBeNull();
    expect(заказ?.state).toBe('ожидает');
    expect(заказ?.amountKzt).toBe('15000');
  });

  it('без подписи вообще: tildaSignature — пустая строка, а не что-то похожее на настоящую подпись', async () => {
    await вебхук(телоЗаявки());
    const заказ = store.findByTildaOrderId('form:482910');
    expect(заказ?.tildaSignature).toBe('');
  });

  it('записывает Email покупателя из заглавного поля', async () => {
    await вебхук(телоЗаявки());
    const заказ = store.findByTildaOrderId('form:482910');
    expect(заказ?.customerEmail).toBe('asel@example.kz');
  });

  it('складывает имя и телефон в описание — иначе им негде появиться в списке заказов', async () => {
    await вебхук(телоЗаявки());
    const заказ = store.findByTildaOrderId('form:482910');
    expect(заказ?.description).toContain('Асель Тестова');
    expect(заказ?.description).toContain('+77011234567');
  });

  it('без tranid отвечает 400 и не заводит заказ', async () => {
    const { tranid: _tranid, ...остальные } = телоЗаявки();
    const ответ = await вебхук(остальные);
    expect(ответ.status).toBe(400);
    expect(store.listRecent(10)).toHaveLength(0);
  });

  it('без поля Payment отвечает 400 и не заводит заказ', async () => {
    const { Payment: _payment, ...остальные } = телоЗаявки();
    const ответ = await вебхук(остальные);
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('form:482910')).toBeNull();
  });

  it('с суммой не в том формате (запятая, буквы) отвечает 400', async () => {
    const ответ = await вебхук(телоЗаявки({ Payment: '15 000,00' }));
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('form:482910')).toBeNull();
  });

  it('с нулевой или отрицательной суммой отвечает 400', async () => {
    const ответ = await вебхук(телоЗаявки({ Payment: '0' }));
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('form:482910')).toBeNull();
  });

  it('с суммой выше потолка отвечает 400', async () => {
    const ответ = await вебхук(телоЗаявки({ Payment: '999999999' }));
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('form:482910')).toBeNull();
  });

  it('повторная заявка с тем же tranid не создаёт вторую запись — идемпотентность при повторе Tilda', async () => {
    const первый = await вебхук(телоЗаявки());
    const второй = await вебхук(телоЗаявки());
    const третий = await вебхук(телоЗаявки());
    expect(первый.status).toBe(200);
    expect(второй.status).toBe(200);
    expect(третий.status).toBe(200);
    expect(store.listRecent(10)).toHaveLength(1);
    // Котировка запрашивается один раз при создании — повторные заявки Tilda
    // (два повтора раз в минуту при неудаче) возвращают уже существующий
    // заказ, не создавая новый запрос курса (createPaymentFor, задача 5).
    expect(клиент.вызововКотировки).toBe(1);
  });

  it('два разных tranid — два разных заказа', async () => {
    await вебхук(телоЗаявки({ tranid: '1' }));
    await вебхук(телоЗаявки({ tranid: '2' }));
    expect(store.listRecent(10)).toHaveLength(2);
  });
});

describe('POST /tilda/webhook — разбор суммы терпимый (путь не проверен настоящим заказом Tilda)', () => {
  it('берёт сумму из payment как JSON-объекта корзины ({ amount: ... })', async () => {
    const { Payment: _payment, ...безPayment } = телоЗаявки();
    const ответ = await вебхук({ ...безPayment, payment: JSON.stringify({ amount: 25000, orderid: 7 }) });
    expect(ответ.status).toBe(200);
    expect(store.findByTildaOrderId('form:482910')?.amountKzt).toBe('25000');
  });

  it('payment как JSON со строковым amount тоже подходит', async () => {
    const { Payment: _payment, ...безPayment } = телоЗаявки();
    const ответ = await вебхук({ ...безPayment, payment: JSON.stringify({ amount: '12345.50' }) });
    expect(ответ.status).toBe(200);
    expect(store.findByTildaOrderId('form:482910')?.amountKzt).toBe('12345.50');
  });

  it('JSON в payment имеет приоритет над полем Payment, если оба присутствуют', async () => {
    const ответ = await вебхук({ ...телоЗаявки({ Payment: '1' }), payment: JSON.stringify({ amount: 9999 }) });
    expect(ответ.status).toBe(200);
    expect(store.findByTildaOrderId('form:482910')?.amountKzt).toBe('9999');
  });

  it('если payment не JSON или без amount — падает обратно на поле Payment', async () => {
    const ответ = await вебхук({ ...телоЗаявки(), payment: 'не json вовсе' });
    expect(ответ.status).toBe(200);
    expect(store.findByTildaOrderId('form:482910')?.amountKzt).toBe('15000');
  });

  it('падает обратно на голое поле amount, если Payment/payment отсутствуют', async () => {
    const { Payment: _payment, ...безPayment } = телоЗаявки();
    const ответ = await вебхук({ ...безPayment, amount: '7777' });
    expect(ответ.status).toBe(200);
    expect(store.findByTildaOrderId('form:482910')?.amountKzt).toBe('7777');
  });

  it('когда ни один вариант не подошёл — отказывает и пишет ВСЁ тело запроса в журнал для разбора', async () => {
    const { Payment: _payment, ...безPayment } = телоЗаявки();
    const ответ = await вебхук({ ...безPayment, payment: JSON.stringify({ totalcost: 15000 }) });
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('form:482910')).toBeNull();

    const записьСТелом = журнал.find((строка) => строка.includes('телоЗапроса'));
    expect(записьСТелом).toBeDefined();
    // "totalcost" — то самое поле из тела, которого не было в известных
    // вариантах; оно обязано быть видно в журнале, а не потеряно.
    expect(записьСТелом).toContain('totalcost');
  });
});

describe('POST /tilda/webhook — конфликт номеров (правка финального ревью)', () => {
  it('повтор tranid с ДРУГИМ Payment получает отказ, а не тихую подмену суммы существующего заказа', async () => {
    const первый = await вебхук(телоЗаявки({ tranid: 'к:1', Payment: '15000' }));
    expect(первый.status).toBe(200);

    const второй = await вебхук(телоЗаявки({ tranid: 'к:1', Payment: '1' }));
    expect(второй.status).toBe(409);

    // Исходная сумма не должна была измениться под влиянием второй заявки.
    expect(store.findByTildaOrderId('form:к:1')?.amountKzt).toBe('15000');
  });
});

describe('POST /tilda/webhook — выключен по умолчанию (правка финального ревью)', () => {
  it('без config.enableFormWebhook отвечает 404, как несуществующий маршрут', async () => {
    const каталогВыкл = mkdtempSync(join(tmpdir(), 'spkz-webhook-off-'));
    const storeВыкл = openDatabase(join(каталогВыкл, 'orders.sqlite'));
    const serverВыкл = createServer({
      config: { ...config, enableFormWebhook: false },
      store: storeВыкл,
      client: фейковыйКлиент(),
      log: createLog(() => {}),
    });
    await new Promise<void>((resolve) => serverВыкл.listen(0, '127.0.0.1', resolve));
    const адрес = serverВыкл.address() as AddressInfo;
    try {
      const ответ = await fetch(`http://127.0.0.1:${адрес.port}/tilda/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ test: 'test' }).toString(),
      });
      expect(ответ.status).toBe(404);
      expect(storeВыкл.listRecent(10)).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => serverВыкл.close(() => resolve()));
      rmSync(каталогВыкл, { recursive: true, force: true });
    }
  });
});

describe('POST /tilda/webhook — длина номера заявки ограничена (находка 8)', () => {
  it('отвергает tranid длиннее 255 символов и не заводит заказ', async () => {
    const огромныйTranid = '1'.repeat(3000);
    const ответ = await вебхук(телоЗаявки({ tranid: огромныйTranid }));
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId(`form:${огромныйTranid}`)).toBeNull();
  });

  it('tranid ровно на потолке длины (255) по-прежнему принимается', async () => {
    const tranid = '2'.repeat(255);
    const ответ = await вебхук(телоЗаявки({ tranid }));
    expect(ответ.status).toBe(200);
    expect(store.findByTildaOrderId(`form:${tranid}`)).not.toBeNull();
  });
});

describe('POST /tilda/webhook — журнал не пишет тело запроса целиком (находка 8)', () => {
  it('запись в журнал при неопознанной сумме обрезана, а не содержит поле целиком', async () => {
    const { Payment: _payment, ...безPayment } = телоЗаявки();
    const огромноеЧужоеПоле = 'x'.repeat(10_000);
    const ответ = await вебхук({
      ...безPayment,
      payment: JSON.stringify({ totalcost: 15000 }),
      постороннееПоле: огромноеЧужоеПоле,
    });
    expect(ответ.status).toBe(400);

    const записьСТелом = журнал.find((строка) => строка.includes('телоЗапроса'));
    expect(записьСТелом).toBeDefined();
    // Обрезано заметно короче исходного гигантского поля — не переписано
    // в журнал целиком.
    expect(записьСТелом!.length).toBeLessThan(огромноеЧужоеПоле.length);
  });
});

describe('POST /tilda/webhook — частота создания новых заказов ограничена (находка 8)', () => {
  it('после потолка новых заказов дальнейшие НОВЫЕ tranid отвергаются 429, а повтор существующего — нет', async () => {
    // Потолок — 20 новых заказов за минуту (createWebhookRoutes, тот же
    // сервер этого файла на каждый it() создаётся заново, значит и
    // ограничитель — свой, ещё пустой).
    for (let i = 0; i < 20; i++) {
      const ответ = await вебхук(телоЗаявки({ tranid: `лимит:${i}` }));
      expect(ответ.status).toBe(200);
    }

    const двадцатьПервый = await вебхук(телоЗаявки({ tranid: 'лимит:20' }));
    expect(двадцатьПервый.status).toBe(429);
    expect(store.findByTildaOrderId('form:лимит:20')).toBeNull();

    // Повтор уже существующего tranid — идемпотентный, не в счёт лимита.
    const повтор = await вебхук(телоЗаявки({ tranid: 'лимит:0' }));
    expect(повтор.status).toBe(200);
  });
});
