import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PaymentRequest, PaymentStatus, Quote } from '@solanapaykz/core';
import type { PaymentCheckerClient } from '../src/checker.js';
import type { Config } from '../src/config.js';
import { openDatabase, type NewOrder, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import { signFields } from '../src/signature.js';
import { createServer, type ЗависимостиСервера } from '../src/http/server.js';
import type { PaymentClient } from '../src/tilda/inbound.js';

const секрет = 'секрет-заказа';

const config: Config = {
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  rpcUrl: 'https://api.devnet.solana.com',
  cluster: 'devnet',
  token: 'USDC',
  shopName: 'Цветы Астана',
  markupPercent: 0,
  quoteTtlSeconds: 900,
  lateWindowSeconds: 86400,
  orderSecret: секрет,
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

/** Тело заказа Tilda, подписанное тестовым секретом — как в tests/inbound.test.ts. */
function телоЗаказа(изменения: Record<string, string> = {}): Record<string, string> {
  const поля: Record<string, string> = {
    order_id: '10868059:42',
    amount: '15000',
    currency: 'KZT',
    timestamp: '1789200000',
    test_mode: '0',
    description: 'Букет «Астана»',
    products: '[{"name":"Букет","quantity":1,"price":15000}]',
    email: 'k@example.kz',
    notify_url: config.tildaNotifyUrl,
    ...изменения,
  };
  return { ...поля, signature: signFields(поля, секрет, 'order') };
}

/**
 * Фейковый клиент SDK — как в tests/inbound.test.ts: без него тесты били бы
 * по сети (курс с Binance, RPC) и превратили бы секундный набор в
 * медленный.
 *
 * `checkPayment` нужен с задачи 7 (`GET /api/status/:token` сам запускает
 * проверку платежа, см. src/http/routes-page.ts) — здесь всегда отвечает
 * «платежа пока нет», ни один тест этого файла не про оплату, а про сам
 * маршрут: реальную проверку платежа проверяют tests/checker.test.ts.
 */
function фейковыйКлиент(): PaymentClient & PaymentCheckerClient {
  let счётчик = 0;
  return {
    async createQuote({ amountKzt, token }): Promise<Quote> {
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
    },
    async createPaymentRequest(quote): Promise<PaymentRequest> {
      счётчик += 1;
      return {
        quote,
        url: `solana:пример-${счётчик}`,
        reference: `метка-${счётчик}`,
        qrSvg: '<svg></svg>',
      };
    },
    async checkPayment(): Promise<PaymentStatus> {
      return { status: 'pending' };
    },
  };
}

const образецНовогоЗаказа: NewOrder = {
  tildaOrderId: '10868059:99',
  token: 'a'.repeat(32),
  amountKzt: '15000',
  currency: 'KZT',
  amountToken: '32.640000',
  tokenSymbol: 'USDC',
  cluster: 'devnet',
  recipient: config.recipient,
  reference: 'секретная-метка',
  rate: '459.55',
  rateSource: 'synthetic',
  paymentUrl: 'solana:пример-заморожен',
  quoteJson: '{}',
  createdAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 900,
  testMode: false,
  tildaSignature: 'подпись',
  txSignature: null,
  customerEmail: 'k@example.kz',
  description: 'Букет',
  productsJson: '[{"name":"Букет","quantity":1,"price":15000}]',
};

let каталог: string;
let store: Store;
let журнал: string[];
let server: Server;
let базовыйUrl: string;

beforeEach(async () => {
  каталог = mkdtempSync(join(tmpdir(), 'spkz-http-'));
  store = openDatabase(join(каталог, 'orders.sqlite'));
  журнал = [];

  const deps: ЗависимостиСервера = {
    config,
    store,
    client: фейковыйКлиент(),
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

/** Простой HTTP-клиент для тестов поверх глобального fetch. */
async function запрос(
  метод: 'GET' | 'POST',
  путь: string,
  тело?: Record<string, string>,
): Promise<{ status: number; headers: Headers; body: string }> {
  const init: RequestInit = { method: метод, redirect: 'manual' };
  if (тело) {
    init.body = new URLSearchParams(тело).toString();
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  }
  const ответ = await fetch(базовыйUrl + путь, init);
  const текст = await ответ.text();
  return { status: ответ.status, headers: ответ.headers, body: текст };
}

describe('POST /tilda/pay', () => {
  it('с верной подписью уводит на страницу оплаты', async () => {
    const ответ = await запрос('POST', '/tilda/pay', телоЗаказа());
    expect(ответ.status).toBe(303);
    expect(ответ.headers.get('location')).toMatch(/^\/pay\/[0-9a-f]{32}$/);
  });

  it('заводит заказ в хранилище с состоянием «ожидает»', async () => {
    await запрос('POST', '/tilda/pay', телоЗаказа());
    const заказ = store.findByTildaOrderId('10868059:42');
    expect(заказ).not.toBeNull();
    expect(заказ?.state).toBe('ожидает');
  });

  it('с подделанной подписью не создаёт заказ и отвечает 400', async () => {
    const тело = { ...телоЗаказа(), amount: '1' };
    const ответ = await запрос('POST', '/tilda/pay', тело);
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('10868059:42')).toBeNull();
  });

  it('с неверной валютой отвечает 400 и не создаёт заказ', async () => {
    const поля: Record<string, string> = {
      order_id: '10868059:43',
      amount: '15000',
      currency: 'USD',
      timestamp: '1789200000',
      test_mode: '0',
    };
    const тело = { ...поля, signature: signFields(поля, секрет, 'order') };
    const ответ = await запрос('POST', '/tilda/pay', тело);
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('10868059:43')).toBeNull();
  });

  it('повторный запрос с тем же номером заказа возвращает ту же страницу оплаты', async () => {
    const первый = await запрос('POST', '/tilda/pay', телоЗаказа());
    const второй = await запрос('POST', '/tilda/pay', телоЗаказа());
    expect(второй.headers.get('location')).toBe(первый.headers.get('location'));
  });

  it('слишком большое тело отвечает 413, а не рвёт соединение', async () => {
    // Ревью проверило это сырым запросом на 10 МБ и получило разрыв
    // связи: req.destroy() рвал TCP-соединение раньше, чем успевал уйти
    // ответ 413. Здесь — тот же сценарий через fetch: если бы обрыв
    // случился до ответа, fetch бросил бы сетевую ошибку вместо
    // возврата объекта ответа с этим статусом.
    const огромноеТело = 'description=' + 'а'.repeat(300_000);
    const ответ = await fetch(базовыйUrl + '/tilda/pay', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: огромноеТело,
    });
    expect(ответ.status).toBe(413);
    expect(await ответ.text()).toContain('слишком велико');
  });
});

describe('GET /pay/:token', () => {
  it('чужой (но существующий формат) ключ отвечает 404 тем же телом, что и несуществующий', async () => {
    const а = await запрос('GET', '/pay/' + 'a'.repeat(32));
    const б = await запрос('GET', '/pay/' + 'b'.repeat(32));
    expect(а.status).toBe(404);
    expect(б.status).toBe(404);
    expect(а.body).toBe(б.body);
  });

  it('экранирует описание заказа: оно приходит из незаверенной части запроса Tilda', async () => {
    const заказ = store.createOrder({
      ...образецНовогоЗаказа,
      token: 'c'.repeat(32),
      tildaOrderId: '10868059:100',
      description: '<script>alert(1)</script>',
    });
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.status).toBe(200);
    expect(ответ.body).not.toContain('<script>alert(1)</script>');
    expect(ответ.body).toContain('&lt;script&gt;');
  });

  it('экранирует названия товаров из состава корзины', async () => {
    const заказ = store.createOrder({
      ...образецНовогоЗаказа,
      token: 'd'.repeat(32),
      tildaOrderId: '10868059:101',
      productsJson: JSON.stringify([{ name: '<img src=x onerror=alert(1)>', quantity: 1 }]),
    });
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.body).not.toContain('<img src=x onerror=alert(1)>');
    expect(ответ.body).toContain('&lt;img');
  });

  it('заказу в состоянии «ожидает» показывает QR', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: 'e'.repeat(32), tildaOrderId: '10868059:102' });
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.status).toBe(200);
    expect(ответ.body).toContain('<svg');
    expect(ответ.body).toContain('32.640000');
  });

  it('оплаченному заказу QR не показывает — это приглашение заплатить второй раз', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: 'f'.repeat(32), tildaOrderId: '10868059:103' });
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись-транзакции' });
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.status).toBe(200);
    expect(ответ.body).not.toContain('<svg');
    expect(ответ.body).toContain('Оплата получена');
  });

  it('отменённому (просроченному) заказу QR не показывает', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '1'.repeat(32), tildaOrderId: '10868059:104' });
    store.updateState(заказ.id, 'просрочен');
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.body).not.toContain('<svg');
    expect(ответ.body).toContain('Срок оплаты истёк');
  });

  it('отдаётся с CSP default-src \'self\' и X-Content-Type-Options: nosniff', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '2'.repeat(32), tildaOrderId: '10868059:105' });
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(ответ.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('X-Frame-Options: DENY и Strict-Transport-Security на странице оплаты (правка финального ревью, задача 7)', async () => {
    // Проверено ревью в настоящем браузере: и страница оплаты, и список
    // заказов встраивались рамкой со стороннего сайта — подмена вида
    // поверх страницы оплаты была рабочим приёмом обмана (clickjacking).
    // Заголовки общие для всех маршрутов (см. server.ts), поэтому тест
    // не привязан к конкретному пути.
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '3'.repeat(32), tildaOrderId: '10868059:114' });
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.headers.get('x-frame-options')).toBe('DENY');
    expect(ответ.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
  });

  it('не содержит встроенного <script>: под CSP default-src \'self\' без unsafe-inline браузер его не исполнит', async () => {
    // Реальный браузер это ловит, а fetch в Node — нет: он не применяет
    // CSP и молча «выполнил» бы даже запрещённый политикой скрипт (найдено
    // ревью в настоящем браузере). Данные для checkout.js передаются
    // атрибутами контейнера, а не встроенным <script>, — тест не
    // подтверждает исполнение в браузере, а лишь фиксирует, что инструмент,
    // который его сломал в прошлый раз, снова не появился в разметке.
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '7'.repeat(32), tildaOrderId: '10868059:109' });
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.body).not.toMatch(/<script>/);
    expect(ответ.body).toContain('<script src="/assets/checkout.js"></script>');
    expect(ответ.body).toContain('data-status-url="/api/status/');
    expect(ответ.body).toMatch(/data-seconds-left="\d+"/);
  });
});

describe('GET /pay/:token — возврат на страницу магазина (задача 4 финального ревью)', () => {
  const конфигСВозвратом: Config = {
    ...config,
    successUrl: 'https://shop.example.kz/thank-you',
    failureUrl: 'https://shop.example.kz/sorry',
  };

  /** Отдельный сервер с настроенными successUrl/failureUrl — по умолчанию (в общем `config` этого файла) их нет. */
  async function серверСВозвратом(): Promise<{ базовыйUrl: string; закрыть: () => Promise<void> }> {
    const deps: ЗависимостиСервера = {
      config: конфигСВозвратом,
      store,
      client: фейковыйКлиент(),
      log: createLog(() => {}),
    };
    const сервер = createServer(deps);
    await new Promise<void>((resolve) => сервер.listen(0, '127.0.0.1', resolve));
    const адрес = сервер.address() as AddressInfo;
    return {
      базовыйUrl: `http://127.0.0.1:${адрес.port}`,
      закрыть: () => new Promise<void>((resolve) => сервер.close(() => resolve())),
    };
  }

  it('оплаченный заказ уводит на config.successUrl, а не на страницу итога', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '4'.repeat(32), tildaOrderId: '10868059:110' });
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись' });
    const { базовыйUrl, закрыть } = await серверСВозвратом();
    try {
      const ответ = await fetch(`${базовыйUrl}/pay/${заказ.token}`, { redirect: 'manual' });
      expect(ответ.status).toBe(302);
      expect(ответ.headers.get('location')).toBe('https://shop.example.kz/thank-you');
    } finally {
      await закрыть();
    }
  });

  it('уведомлённый заказ тоже уводит на config.successUrl', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '5'.repeat(32), tildaOrderId: '10868059:111' });
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись' });
    store.markNotified(заказ.id, true, 1);
    const { базовыйUrl, закрыть } = await серверСВозвратом();
    try {
      const ответ = await fetch(`${базовыйUrl}/pay/${заказ.token}`, { redirect: 'manual' });
      expect(ответ.status).toBe(302);
      expect(ответ.headers.get('location')).toBe('https://shop.example.kz/thank-you');
    } finally {
      await закрыть();
    }
  });

  it('просроченный заказ уводит на config.failureUrl', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '6'.repeat(32), tildaOrderId: '10868059:112' });
    store.updateState(заказ.id, 'просрочен');
    const { базовыйUrl, закрыть } = await серверСВозвратом();
    try {
      const ответ = await fetch(`${базовыйUrl}/pay/${заказ.token}`, { redirect: 'manual' });
      expect(ответ.status).toBe(302);
      expect(ответ.headers.get('location')).toBe('https://shop.example.kz/sorry');
    } finally {
      await закрыть();
    }
  });

  it('«не сошлось», «поздний» и «ошибка настроек» не редиректят — это не однозначный успех или отказ', async () => {
    const состояния = ['не сошлось', 'поздний', 'ошибка настроек'] as const;
    const { базовыйUrl, закрыть } = await серверСВозвратом();
    try {
      for (const [индекс, состояние] of состояния.entries()) {
        const заказ = store.createOrder({
          ...образецНовогоЗаказа,
          token: `8${индекс}`.padEnd(32, '0'),
          tildaOrderId: `10868059:20${индекс}`,
        });
        store.updateState(заказ.id, состояние, состояние === 'не сошлось' || состояние === 'поздний' ? { txSignature: 'подпись' } : {});
        const ответ = await fetch(`${базовыйUrl}/pay/${заказ.token}`, { redirect: 'manual' });
        expect(ответ.status).toBe(200);
      }
    } finally {
      await закрыть();
    }
  });

  it('без настроенных successUrl/failureUrl (обычный config этого файла) — прежнее поведение, страница итога', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '9'.repeat(32), tildaOrderId: '10868059:113' });
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись' });
    // Используем общий server/базовыйUrl этого файла (config без successUrl).
    const ответ = await запрос('GET', `/pay/${заказ.token}`);
    expect(ответ.status).toBe(200);
    expect(ответ.body).toContain('Оплата получена');
  });
});

describe('GET /api/status/:token', () => {
  it('несуществующий токен отвечает 404', async () => {
    const ответ = await запрос('GET', '/api/status/' + '3'.repeat(32));
    expect(ответ.status).toBe(404);
  });

  it('ответ не содержит ни суммы, ни адреса получателя, ни метки платежа', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '4'.repeat(32), tildaOrderId: '10868059:106' });
    const ответ = await запрос('GET', `/api/status/${заказ.token}`);
    expect(ответ.body).not.toContain(заказ.recipient);
    expect(ответ.body).not.toContain(заказ.reference);
    expect(ответ.body).not.toContain(заказ.amountToken);
  });

  it('отдаёт состояние, текст и secondsLeft заказа, ожидающего оплаты', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '5'.repeat(32), tildaOrderId: '10868059:107' });
    const ответ = await запрос('GET', `/api/status/${заказ.token}`);
    const тело = JSON.parse(ответ.body);
    expect(тело.state).toBe('ожидает');
    expect(typeof тело.message).toBe('string');
    expect(тело.secondsLeft).toBeGreaterThan(0);
  });

  it('для оплаченного заказа secondsLeft — 0, состояние «оплачен»', async () => {
    const заказ = store.createOrder({ ...образецНовогоЗаказа, token: '6'.repeat(32), tildaOrderId: '10868059:108' });
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись-транзакции' });
    const ответ = await запрос('GET', `/api/status/${заказ.token}`);
    const тело = JSON.parse(ответ.body);
    expect(тело.state).toBe('оплачен');
    expect(тело.secondsLeft).toBe(0);
  });
});

describe('GET /api/status/:token — кеш ответа опроса (правка финального ревью)', () => {
  // Опрос из вкладки покупателя идёт раз в 5 секунд без ограничений и без
  // кеша вызывал полную проверку платежа НА КАЖДЫЙ запрос — находка ревью.
  // Здесь считаем вызовы checkPayment, чтобы увидеть кеш по факту, а не
  // только по коду ответа.
  let каталог2: string;
  let store2: Store;
  let server2: Server;
  let базовыйUrl2: string;
  let вызововПроверки: number;

  beforeEach(async () => {
    каталог2 = mkdtempSync(join(tmpdir(), 'spkz-http-poll-cache-'));
    store2 = openDatabase(join(каталог2, 'orders.sqlite'));
    вызововПроверки = 0;

    const считающийКлиент: PaymentClient & PaymentCheckerClient = {
      ...фейковыйКлиент(),
      async checkPayment(): Promise<PaymentStatus> {
        вызововПроверки += 1;
        return { status: 'pending' };
      },
    };

    const deps: ЗависимостиСервера = {
      config,
      store: store2,
      client: считающийКлиент,
      log: createLog(() => {}),
      тест: { кешОпросаMs: 60_000 },
    };

    server2 = createServer(deps);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const адрес = server2.address() as AddressInfo;
    базовыйUrl2 = `http://127.0.0.1:${адрес.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
    rmSync(каталог2, { recursive: true, force: true });
  });

  it('повторный опрос того же токена в пределах кеша не запускает вторую проверку платежа', async () => {
    const заказ = store2.createOrder({ ...образецНовогоЗаказа, token: '90'.repeat(16), tildaOrderId: '10868059:111' });

    const первый = await fetch(`${базовыйUrl2}/api/status/${заказ.token}`);
    expect(первый.status).toBe(200);
    expect(вызововПроверки).toBe(1);

    const второй = await fetch(`${базовыйUrl2}/api/status/${заказ.token}`);
    expect(второй.status).toBe(200);
    // Тот же кешированный ответ — checkPayment не вызывался снова.
    expect(вызововПроверки).toBe(1);
    expect(await первый.text()).toBe(await второй.text());
  });

  it('опрос ДРУГОГО токена не берётся из чужого кеша', async () => {
    const заказА = store2.createOrder({ ...образецНовогоЗаказа, token: '91'.repeat(16), tildaOrderId: '10868059:112' });
    const заказБ = store2.createOrder({ ...образецНовогоЗаказа, token: '92'.repeat(16), tildaOrderId: '10868059:113' });

    await fetch(`${базовыйUrl2}/api/status/${заказА.token}`);
    expect(вызововПроверки).toBe(1);

    await fetch(`${базовыйUrl2}/api/status/${заказБ.token}`);
    expect(вызововПроверки).toBe(2);
  });

  it('после истечения кеша следующий опрос снова проверяет платёж', async () => {
    const каталог3 = mkdtempSync(join(tmpdir(), 'spkz-http-poll-cache-ttl-'));
    const store3 = openDatabase(join(каталог3, 'orders.sqlite'));
    let вызовов3 = 0;
    const считающийКлиент3: PaymentClient & PaymentCheckerClient = {
      ...фейковыйКлиент(),
      async checkPayment(): Promise<PaymentStatus> {
        вызовов3 += 1;
        return { status: 'pending' };
      },
    };
    const server3 = createServer({
      config,
      store: store3,
      client: считающийКлиент3,
      log: createLog(() => {}),
      тест: { кешОпросаMs: 1 }, // истекает почти сразу
    });
    await new Promise<void>((resolve) => server3.listen(0, '127.0.0.1', resolve));
    const адрес3 = server3.address() as AddressInfo;
    const базовыйUrl3 = `http://127.0.0.1:${адрес3.port}`;

    try {
      const заказ = store3.createOrder({ ...образецНовогоЗаказа, token: '93'.repeat(16), tildaOrderId: '10868059:114' });
      await fetch(`${базовыйUrl3}/api/status/${заказ.token}`);
      expect(вызовов3).toBe(1);

      await new Promise((r) => setTimeout(r, 20)); // дождаться истечения кеша (1 мс)
      await fetch(`${базовыйUrl3}/api/status/${заказ.token}`);
      expect(вызовов3).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server3.close(() => resolve()));
      rmSync(каталог3, { recursive: true, force: true });
    }
  });
});

describe('GET /api/status/:token — опрос не ждёт дольше тайм-аута', () => {
  // Основная защита от долгого ответа — то, что checkOrder запускает
  // notifyTilda, но не ждёт её (см. checker.ts, случай «оплачен»): ответ
  // покупателю уходит сразу после того, как заказ помечен «оплачен», и
  // никогда не зависит от того, сколько попыток потребуется, чтобы
  // достучаться до Tilda. Poll-тайм-аут (ТАЙМАУТ_ОПРОСА_ПРОВЕРКИ_MS_ПО_УМОЛЧАНИЮ
  // в src/http/routes-page.ts) — вторая, страховочная линия обороны на
  // случай, если зависнет само обращение к узлу Solana (checkPayment) —
  // именно его checkOrder дожидается напрямую. Проверяем страховку: узел
  // «висит» намного дольше тайм-аута опроса, а ответ всё равно приходит
  // вовремя — по состоянию, какое успело сложиться к этому моменту.
  let каталог2: string;
  let store2: Store;
  let server2: Server;
  let базовыйUrl2: string;

  beforeEach(async () => {
    каталог2 = mkdtempSync(join(tmpdir(), 'spkz-http-timeout-'));
    store2 = openDatabase(join(каталог2, 'orders.sqlite'));

    const клиентСМедленнымУзлом: PaymentClient & PaymentCheckerClient = {
      ...фейковыйКлиент(),
      // Реально отвечает — но намного позже тайм-аута опроса. Не «никогда»
      // намеренно: checkOrder внутри опроса всё равно продолжает работать в
      // фоне (его никто не отменяет, см. src/http/routes-page.ts) и должен
      // рано или поздно снять внутренний лок заказа (checker.ts) — вечно
      // висящий checkPayment оставил бы этот лок навсегда и мог бы задеть
      // другой заказ с тем же числовым id в другом тесте этого файла.
      async checkPayment(): Promise<PaymentStatus> {
        await new Promise((r) => setTimeout(r, 300));
        return { status: 'pending' };
      },
    };

    const deps: ЗависимостиСервера = {
      config,
      store: store2,
      client: клиентСМедленнымУзлом,
      log: createLog(() => {}),
      тест: { таймаутОпросаMs: 20 },
    };

    server2 = createServer(deps);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const адрес = server2.address() as AddressInfo;
    базовыйUrl2 = `http://127.0.0.1:${адрес.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server2.close(() => resolve()));
    rmSync(каталог2, { recursive: true, force: true });
  });

  it('при медленном узле отвечает по тайм-ауту, а не ждёт checkPayment', async () => {
    const заказ = store2.createOrder({ ...образецНовогоЗаказа, token: '8'.repeat(32), tildaOrderId: '10868059:110' });

    const начало = Date.now();
    const ответ = await fetch(`${базовыйUrl2}/api/status/${заказ.token}`);
    const тело = (await ответ.json()) as { state: string };
    const затрачено = Date.now() - начало;

    // checkPayment отвечает через 300 мс, тайм-аут опроса — 20 мс: с
    // большим запасом проверяем, что ответ пришёл быстро, а не после
    // полного ожидания узла.
    expect(затрачено).toBeLessThan(300);
    // checkOrder не успел ничего решить к моменту тайм-аута (checkPayment
    // ещё не ответил) — заказ остаётся в том состоянии, в каком был до
    // опроса.
    expect(тело.state).toBe('ожидает');

    // Даём повисшему в фоне checkOrder реально завершиться и снять свой
    // внутренний лок (checker.ts, занятыеЗаказы) — иначе он остался бы
    // висеть до конца процесса и мог бы задеть заказ с тем же числовым id
    // в другом тесте этого файла.
    await new Promise((r) => setTimeout(r, 350));
  });
});

describe('статические файлы', () => {
  it('отдаёт /assets/checkout.js', async () => {
    const ответ = await запрос('GET', '/assets/checkout.js');
    expect(ответ.status).toBe(200);
    expect(ответ.headers.get('content-type')).toContain('javascript');
    expect(ответ.body).toContain('data-status-url');
  });

  it('отдаёт /assets/checkout.css', async () => {
    const ответ = await запрос('GET', '/assets/checkout.css');
    expect(ответ.status).toBe(200);
    expect(ответ.headers.get('content-type')).toContain('text/css');
    expect(ответ.body).toContain('.solanapaykz');
  });

  it('отдаёт /assets/admin.js — перезагружает список заказов, восстановленный из bfcache браузера', async () => {
    // Правка ревью: Cache-Control: no-store не гарантированно исключает
    // страницу из back/forward cache — воспроизведено в настоящем Chrome
    // (см. routes-admin.ts). pageshow/persisted — вторая линия обороны.
    const ответ = await запрос('GET', '/assets/admin.js');
    expect(ответ.status).toBe(200);
    expect(ответ.headers.get('content-type')).toContain('javascript');
    expect(ответ.body).toContain('pageshow');
    expect(ответ.body).toContain('event.persisted');
  });
});

describe('неизвестные маршруты', () => {
  it('отвечают 404', async () => {
    const ответ = await запрос('GET', '/что-то-несуществующее');
    expect(ответ.status).toBe(404);
  });
});

describe('необработанный отказ асинхронного обработчика (находка финального ревью)', () => {
  it('падение GET /pay/:token отвечает 500, а не роняет процесс', async () => {
    // До правки вызов обработатьСтраницуОплаты в server.ts был без await и
    // без void — его отказ не попадал в общий catch обработатьЗапрос и
    // становился необработанным отказом промиса, а это в Node 22 валит
    // процесс целиком (вместе с приёмом заказов и фоновой проверкой
    // платежей). Ломаем findByToken, чтобы обработчик страницы оплаты
    // бросил исключение, и проверяем, что сервер этот процесс переживает —
    // тем же приёмом, что и соседний тест на 413 в этом файле: если бы
    // процесс упал, второй запрос ниже не получил бы ответа вовсе.
    const ломающийсяStore: Store = {
      ...store,
      findByToken: () => {
        throw new Error('нарочно сломан тестом');
      },
    };
    const тестовыеDeps: ЗависимостиСервера = {
      config,
      store: ломающийсяStore,
      client: фейковыйКлиент(),
      log: createLog((строка) => журнал.push(строка)),
    };
    const тестовыйСервер = createServer(тестовыеDeps);
    await new Promise<void>((resolve) => тестовыйСервер.listen(0, '127.0.0.1', resolve));
    const адрес = тестовыйСервер.address() as AddressInfo;
    try {
      const ответ = await fetch(`http://127.0.0.1:${адрес.port}/pay/${'d'.repeat(32)}`);
      expect(ответ.status).toBe(500);

      // Процесс жив — соседний маршрут того же сервера, вообще не
      // трогающий сломанный store, отвечает как обычно.
      const второйОтвет = await fetch(`http://127.0.0.1:${адрес.port}/assets/checkout.js`);
      expect(второйОтвет.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => тестовыйСервер.close(() => resolve()));
    }
  });
});
