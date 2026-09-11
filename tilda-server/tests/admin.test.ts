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
import { createServer, type ЗависимостиСервера } from '../src/http/server.js';
import { клиентскийАдрес } from '../src/http/routes-admin.js';
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
  smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'секрет-smtp-пароля-админ', from: 'shop@example.kz' },
  merchantEmail: 'merchant@example.kz',
  databasePath: ':memory:',
  listenPort: 0,
  listenHost: '127.0.0.1',
  trustedProxyAddresses: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
};

/** Фейковый клиент SDK — тесты этого файла не про оплату, сеть не нужна (см. tests/http.test.ts). */
function фейковыйКлиент(): PaymentClient & PaymentCheckerClient {
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
      return { quote, url: 'solana:пример', reference: 'метка-1', qrSvg: '<svg></svg>' };
    },
    async checkPayment(): Promise<PaymentStatus> {
      return { status: 'pending' };
    },
  };
}

const образец: NewOrder = {
  tildaOrderId: '10868059:42',
  token: 'a'.repeat(32),
  amountKzt: '15000',
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
  productsJson: null,
};

let каталог: string;
let store: Store;
let журнал: string[];
let server: Server;
let базовыйUrl: string;

beforeEach(async () => {
  каталог = mkdtempSync(join(tmpdir(), 'spkz-admin-'));
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

/** Простой HTTP-клиент для тестов поверх глобального fetch — как в tests/http.test.ts. */
async function запрос(
  метод: 'GET' | 'POST',
  путь: string,
  опции: { тело?: Record<string, string>; кука?: string; xForwardedFor?: string } = {},
): Promise<{ status: number; headers: Headers; body: string }> {
  const init: RequestInit = { method: метод, redirect: 'manual' };
  const заголовки: Record<string, string> = {};
  if (опции.тело) {
    init.body = new URLSearchParams(опции.тело).toString();
    заголовки['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (опции.кука) {
    заголовки['cookie'] = опции.кука;
  }
  if (опции.xForwardedFor) {
    заголовки['x-forwarded-for'] = опции.xForwardedFor;
  }
  if (Object.keys(заголовки).length > 0) init.headers = заголовки;

  const ответ = await fetch(базовыйUrl + путь, init);
  const текст = await ответ.text();
  return { status: ответ.status, headers: ответ.headers, body: текст };
}

/** Куку сессии, полученную из Set-Cookie, для использования в последующих запросах (только имя=значение, без атрибутов). */
function кукаИзОтвета(headers: Headers): string {
  const строки = headers.getSetCookie();
  const сессия = строки.find((с) => с.startsWith('admin_session='));
  if (!сессия) throw new Error('Set-Cookie с admin_session не найден в ответе');
  return сессия.split(';')[0]!;
}

/** Логинится верным паролем и возвращает результат запроса к `путь` с полученной сессией. */
async function запросСВходом(
  метод: 'GET' | 'POST',
  путь: string,
): Promise<{ status: number; headers: Headers; body: string }> {
  const вход = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
  const кука = кукаИзОтвета(вход.headers);
  return запрос(метод, путь, { кука });
}

describe('GET /admin — без входа', () => {
  it('без входа список не отдаётся: перенаправляет и не содержит данных заказов', async () => {
    store.createOrder(образец);
    const ответ = await запрос('GET', '/admin');
    expect(ответ.status).toBe(303);
    expect(ответ.body).not.toContain('10868059:42');
  });

  it('перенаправляет на форму входа', async () => {
    const ответ = await запрос('GET', '/admin');
    expect(ответ.headers.get('location')).toBe('/admin/login');
  });
});

describe('GET /admin/login', () => {
  it('отдаёт форму пароля без утечки текущего admin-пароля', async () => {
    const ответ = await запрос('GET', '/admin/login');
    expect(ответ.status).toBe(200);
    expect(ответ.body).toContain('<form');
    expect(ответ.body).not.toContain(config.adminPassword);
  });
});

describe('POST /admin/login', () => {
  it('неверный пароль не пускает и не подсказывает, что именно неверно', async () => {
    const ответ = await запрос('POST', '/admin/login', { тело: { password: 'не тот' } });
    expect(ответ.status).toBe(401);
    expect(ответ.body).not.toMatch(/пароль верн|такого пользователя/i);
  });

  it('неверный пароль не выдаёт куку сессии', async () => {
    const ответ = await запрос('POST', '/admin/login', { тело: { password: 'не тот' } });
    expect(ответ.headers.getSetCookie()).toHaveLength(0);
  });

  it('верный пароль пускает и уводит на /admin', async () => {
    const ответ = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    expect(ответ.status).toBe(303);
    expect(ответ.headers.get('location')).toBe('/admin');
  });

  it('кука сессии помечена HttpOnly, Secure и SameSite=Strict', async () => {
    const ответ = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    const кука = ответ.headers.getSetCookie()[0] ?? '';
    expect(кука).toContain('HttpOnly');
    expect(кука).toContain('Secure');
    expect(кука).toContain('SameSite=Strict');
  });

  it('после пяти неудачных попыток вход отвечает отказом независимо от пароля', async () => {
    for (let i = 0; i < 5; i++) {
      await запрос('POST', '/admin/login', { тело: { password: 'не тот' } });
    }
    const ответ = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    expect(ответ.status).toBe(429);
  });

  it('после исчерпания лимита кука сессии по-прежнему не выдаётся', async () => {
    for (let i = 0; i < 5; i++) {
      await запрос('POST', '/admin/login', { тело: { password: 'не тот' } });
    }
    const ответ = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    expect(ответ.headers.getSetCookie()).toHaveLength(0);
  });
});

describe('POST /admin/logout', () => {
  it('отвечает перенаправлением и снимает куку сессии (Max-Age=0)', async () => {
    const вход = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    const кука = кукаИзОтвета(вход.headers);

    const выход = await запрос('POST', '/admin/logout', { кука });
    expect(выход.status).toBe(303);
    expect(выход.headers.get('location')).toBe('/admin/login');
    const кукаВыхода = выход.headers.getSetCookie()[0] ?? '';
    expect(кукаВыхода).toContain('admin_session=;');
    expect(кукаВыхода).toContain('Max-Age=0');
  });

  it('без куки (клиент, честно удаливший её по Max-Age=0) список снова недоступен', async () => {
    const ответ = await запрос('GET', '/admin');
    expect(ответ.status).toBe(303);
  });

  it('после выхода СТАРЫЙ токен (например, утёкший и специально присланный снова) тоже отклоняется', async () => {
    // Выход увеличивает поколение сессий в базе (Store.bumpSessionGeneration) —
    // токен несёт номер поколения на момент выдачи, и старое поколение
    // проверку больше не проходит, даже если кука не была удалена нигде,
    // кроме как логическим Max-Age=0 (см. заголовок routes-admin.ts).
    const вход = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    const кука = кукаИзОтвета(вход.headers);

    await запрос('POST', '/admin/logout', { кука });

    const попыткаСоСтаройКукой = await запрос('GET', '/admin', { кука });
    expect(попыткаСоСтаройКукой.status).toBe(303);
    expect(попыткаСоСтаройКукой.headers.get('location')).toBe('/admin/login');
  });

  it('выход не мешает войти заново тем же паролем', async () => {
    const первыйВход = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    await запрос('POST', '/admin/logout', { кука: кукаИзОтвета(первыйВход.headers) });

    const второйВход = await запрос('POST', '/admin/login', { тело: { password: config.adminPassword } });
    expect(второйВход.status).toBe(303);
    expect(второйВход.headers.get('location')).toBe('/admin');

    const списокСНовойСессией = await запрос('GET', '/admin', { кука: кукаИзОтвета(второйВход.headers) });
    expect(списокСНовойСессией.status).toBe(200);
  });
});

describe('GET /admin — с валидной сессией', () => {
  it('показывает заказ: номер, состояние', async () => {
    store.createOrder(образец);
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.status).toBe(200);
    expect(ответ.body).toContain('10868059:42');
    expect(ответ.body).toContain('ожидает');
  });

  it('в списке видно, что заказ оплачен, но Tilda не подтвердила', async () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись-транзакции-тест' });
    store.markNotified(о.id, false, 5);
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.body).toContain('Tilda не подтвердила');
  });

  it('для уведомлённого заказа показывает «Tilda подтвердила»', async () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись-транзакции-тест' });
    store.markNotified(о.id, true, 1);
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.body).toContain('Tilda подтвердила');
  });

  it('подпись транзакции показана ссылкой на обозреватель', async () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись-транзакции-тест' });
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.body).toContain('href="https://explorer.solana.com/tx/подпись-транзакции-тест?cluster=devnet"');
  });

  it('экранирует значения заказа в разметке (описание в список не попадает, но номер заказа — попадает и обязан быть экранирован)', async () => {
    // tildaOrderId входит в подпись Tilda (signature.ts, ПОЛЯ_ПОДПИСИ) и не
    // может быть подделан без пересчёта подписи секретом — но список
    // экранирует его безусловно, той же функцией, что и остальные поля: не
    // потому что этот конкретный тест нашёл дыру, а потому что различать
    // «заверенные» и «незаверенные» поля прямо в разметке — источник именно
    // таких дыр в будущем.
    store.createOrder({ ...образец, tildaOrderId: '<b>10868059:42</b>' });
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.body).not.toContain('<b>10868059:42</b>');
    expect(ответ.body).toContain('&lt;b&gt;');
  });

  it('не отдаёт секретов настроек и ключ страницы оплаты', async () => {
    store.createOrder(образец);
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.body).not.toContain(config.orderSecret);
    expect(ответ.body).not.toContain(config.notifySecret);
    expect(ответ.body).not.toContain(config.adminPassword);
    expect(ответ.body).not.toContain(config.smtp.pass);
    expect(ответ.body).not.toContain(образец.token);
  });

  it('видна неудача отправки письма продавцу, но состояние заказа не меняется, и переживает перезапуск сервера', async () => {
    const { sendMerchantMail } = await import('../src/mailer.js');
    const о = store.createOrder({ ...образец, tildaOrderId: '10868059:200', token: 'c'.repeat(32) });
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись-х' });

    const свежий = store.findByTildaOrderId('10868059:200')!;
    const успех = await sendMerchantMail(
      свежий,
      { action: 'оплачен', signature: 'подпись-х', note: 'Платёж получен.' },
      {
        config: { smtp: config.smtp, merchantEmail: config.merchantEmail },
        store,
        log: createLog(() => {}),
        тест: { отправка: async () => { throw new Error('SMTP недоступен'); } },
      },
    );
    expect(успех).toBe(false);

    // «Перезапуск сервера»: открываем тот же файл базы заново отдельным
    // Store, как это делает процесс при рестарте (openDatabase в
    // http/server.ts бутстрапе). Сбой письма — в базе, а не в памяти
    // процесса, поэтому виден и здесь, а не только через переменную `store`
    // текущего теста.
    const путьКБазе = join(каталог, 'orders.sqlite');
    const storeПослеПерезапуска = openDatabase(путьКБазе);
    expect(storeПослеПерезапуска.findByTildaOrderId('10868059:200')!.mailError).toBe('SMTP недоступен');

    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.body).toContain('Письмо не отправлено');
    expect(ответ.body).toContain('SMTP недоступен');
    // Само состояние заказа при этом не изменилось неудачей письма.
    expect(store.findByTildaOrderId('10868059:200')!.state).toBe('оплачен');
  });

  it('отдаётся с Cache-Control: no-store — правка ревью: без него «Назад» браузера после «Выйти» показывал список из кеша', async () => {
    store.createOrder(образец);
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.headers.get('cache-control')).toBe('no-store');
  });

  it('подключает /assets/admin.js — вторая линия обороны от bfcache сверх Cache-Control (см. заголовок файла)', async () => {
    store.createOrder(образец);
    const ответ = await запросСВходом('GET', '/admin');
    expect(ответ.body).toContain('<script src="/assets/admin.js"></script>');
  });
});

describe('GET /admin/login и POST /admin/login — Cache-Control: no-store', () => {
  it('форма входа отдаётся с Cache-Control: no-store', async () => {
    const ответ = await запрос('GET', '/admin/login');
    expect(ответ.headers.get('cache-control')).toBe('no-store');
  });

  it('ответ на неверный пароль тоже с Cache-Control: no-store', async () => {
    const ответ = await запрос('POST', '/admin/login', { тело: { password: 'не тот' } });
    expect(ответ.headers.get('cache-control')).toBe('no-store');
  });
});

describe('ограничение попыток входа считает по клиенту, а не всегда по сокету (правка ревью)', () => {
  // За обратным прокси (nginx, задача 9) TCP-сокет для всех посетителей —
  // один и тот же (сам прокси); без разделения по X-Forwarded-For пять
  // неверных паролей от ЛЮБОГО постороннего закрывали бы вход всем
  // остальным на пятнадцать минут. Тесты этого файла подключаются к
  // серверу через 127.0.0.1 — то есть и есть тот самый доверенный
  // loopback-сокет, — поэтому X-Forwarded-For здесь честно проверяется по
  // рабочему коду, а не только юнит-тестом чистой функции ниже.

  it('пять неудачных попыток от одного X-Forwarded-For блокируют шестую (даже с верным паролем) для ЭТОГО адреса', async () => {
    for (let i = 0; i < 5; i++) {
      await запрос('POST', '/admin/login', { тело: { password: 'не тот' }, xForwardedFor: '1.2.3.4' });
    }
    const ответ = await запрос('POST', '/admin/login', {
      тело: { password: config.adminPassword },
      xForwardedFor: '1.2.3.4',
    });
    expect(ответ.status).toBe(429);
  });

  it('лимит не разделяется на всех посетителей разом: другой X-Forwarded-For не заблокирован', async () => {
    for (let i = 0; i < 5; i++) {
      await запрос('POST', '/admin/login', { тело: { password: 'не тот' }, xForwardedFor: '1.2.3.4' });
    }
    // Шестая попытка от адреса 1.2.3.4 уже исчерпала лимит (проверено выше);
    // адрес 5.6.7.8 — другой клиент, и лимит на него не действует, даже
    // проходя через тот же самый доверенный сокет.
    const ответ = await запрос('POST', '/admin/login', {
      тело: { password: config.adminPassword },
      xForwardedFor: '5.6.7.8',
    });
    expect(ответ.status).toBe(303);
  });
});

describe('клиентскийАдрес (правка ревью — доверие X-Forwarded-For только от loopback)', () => {
  it('с loopback-сокетом и X-Forwarded-For возвращает адрес из заголовка', () => {
    expect(клиентскийАдрес('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(клиентскийАдрес('::1', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('с НЕ-loopback сокетом игнорирует заголовок — это либо прямое обращение в обход прокси, либо прокси не на этом хосте', () => {
    expect(клиентскийАдрес('203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
  });

  it('из цепочки в X-Forwarded-For берёт самый левый (исходного клиента), а не адрес самого прокси', () => {
    expect(клиентскийАдрес('127.0.0.1', '203.0.113.7, 198.51.100.1')).toBe('203.0.113.7');
  });

  it('без заголовка (или loopback без него) возвращает адрес сокета', () => {
    expect(клиентскийАдрес('127.0.0.1', undefined)).toBe('127.0.0.1');
  });

  it('без адреса сокета вовсе возвращает заглушку, а не падает', () => {
    expect(клиентскийАдрес(undefined, undefined)).toBe('неизвестный-адрес');
  });
});

describe('клиентскийАдрес с настраиваемым списком доверенных прокси (задача 9 — network_mode: host заменён настройкой)', () => {
  it('доверяет адресу из переданного списка (например, шлюзу моста Docker), даже если это не loopback', () => {
    expect(клиентскийАдрес('172.21.0.1', '203.0.113.7', ['172.21.0.1'])).toBe('203.0.113.7');
  });

  it('без своего списка список по умолчанию (loopback) продолжает работать как раньше', () => {
    expect(клиентскийАдрес('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('со своим списком loopback больше НЕ доверенный, если его туда не включили', () => {
    expect(клиентскийАдрес('127.0.0.1', '203.0.113.7', ['172.21.0.1'])).toBe('127.0.0.1');
  });
});
