/**
 * Сквозной тест всего пути (задача 9): реальный HTTP-сервер (`createServer`)
 * плюс независимый имитатор Tilda (`tools/fake-tilda.ts`) — заказ уходит и
 * возвращается настоящими HTTP-запросами, а не прямыми вызовами внутренних
 * функций. Единственное, что подменено, — проверка платежа в блокчейне
 * (`PaymentCheckerClient.checkPayment`): реальный узел Solana здесь не
 * нужен и не должен быть нужен — это подтверждено во всех остальных тестах
 * проекта (см. `tests/checker.test.ts`).
 *
 * Оплата «в цепочке» имитируется переключением `управляемыйКлиент` в режим
 * «платёж найден» — `checkOrder` вызывается тем же путём, что и в бою:
 * опросом `GET /api/status/:token`, который делает `public/checkout.js` из
 * вкладки покупателя (см. `src/http/routes-page.ts`).
 */
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
import { запуститьИмитатор, type Имитатор } from '../tools/fake-tilda.js';

const секретЗаказа = 'секрет-заказа-е2е-тест';
const секретУведомления = 'секрет-уведомления-е2е-тест';

function базовыйConfig(notifyUrl: string): Config {
  return {
    recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    rpcUrl: 'https://api.devnet.solana.com',
    cluster: 'devnet',
    token: 'USDC',
    shopName: 'Цветы Астана',
    markupPercent: 0,
    quoteTtlSeconds: 900,
    lateWindowSeconds: 86400,
    orderSecret: секретЗаказа,
    notifySecret: секретУведомления,
    tildaNotifyUrl: notifyUrl,
    publicUrl: 'https://pay.example.kz',
    adminPassword: 'длинный-пароль-админа',
    smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'p', from: 'shop@example.kz' },
    merchantEmail: 'merchant@example.kz',
    databasePath: ':memory:',
    listenPort: 0,
    listenHost: '127.0.0.1',
    trustedProxyAddresses: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
  };
}

/**
 * Клиент SDK, у которого проверка платежа управляется тестом:
 * `подтвердить(signature)` переключает его в «платёж найден» с заданной
 * подписью транзакции — тот же приём, что и `клиентСПлатежом` в
 * `tests/checker.test.ts`, только с возможностью переключить состояние уже
 * после того, как заказ создан (здесь заказ создаётся имитатором, а не
 * напрямую через `store.createOrder`).
 */
function управляемыйКлиент(): PaymentClient & PaymentCheckerClient & { подтвердить(signature: string): void } {
  let подпись: string | null = null;
  let счётчикМетки = 0;
  return {
    подтвердить(signature: string) {
      подпись = signature;
    },
    async createQuote({ amountKzt, token }): Promise<Quote> {
      return Object.freeze({
        quoteId: 'котировка-е2е',
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
      счётчикМетки += 1;
      return {
        quote,
        url: `solana:пример-е2е-${счётчикМетки}`,
        reference: `метка-е2е-${счётчикМетки}`,
        qrSvg: '<svg></svg>',
      };
    },
    async checkPayment(): Promise<PaymentStatus> {
      return подпись ? { status: 'confirmed', signature: подпись, amountPaid: '32.640000' } : { status: 'pending' };
    },
  };
}

/** Опрашивает `/api/status/:token` (как это делает `checkout.js`), пока запись в базе не придёт к ожидаемому состоянию или не истечёт время. */
async function дождаться(проверка: () => boolean, таймаутMs = 5000): Promise<void> {
  const конец = Date.now() + таймаутMs;
  for (;;) {
    if (проверка()) return;
    if (Date.now() > конец) {
      throw new Error('дождаться: условие не выполнилось за отведённое время');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

let каталог: string;
let store: Store;
let server: Server;
let адресСервера: string;
let имитатор: Имитатор;
let клиент: ReturnType<typeof управляемыйКлиент>;

async function поднятьВсё(отвечатьТестом: 'OK' | 'мусор' | 'без ответа' = 'OK'): Promise<void> {
  имитатор = await запуститьИмитатор({ секретЗаказа, секретУведомления, отвечать: отвечатьТестом });

  каталог = mkdtempSync(join(tmpdir(), 'spkz-e2e-'));
  store = openDatabase(join(каталог, 'orders.sqlite'));
  клиент = управляемыйКлиент();

  const deps: ЗависимостиСервера = {
    config: базовыйConfig(имитатор.notifyUrl),
    store,
    client: клиент,
    log: createLog(() => {}),
  };

  server = createServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const адрес = server.address() as AddressInfo;
  адресСервера = `http://127.0.0.1:${адрес.port}`;
  имитатор.адресСервера = адресСервера;
}

/** Опрашивает наш `/api/status/:token`, запуская тем самым настоящий `checkOrder` — ровно так, как это делает браузер покупателя. */
async function опроситьСтатус(token: string): Promise<void> {
  await fetch(`${адресСервера}/api/status/${token}`);
}

afterEach(async () => {
  await имитатор.остановить();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(каталог, { recursive: true, force: true });
});

describe('сквозной путь через имитатор Tilda', () => {
  it('весь путь: заказ от Tilda, оплата, уведомление принято', async () => {
    await поднятьВсё('OK');

    const оформление = await имитатор.оформитьЗаказ({ amount: '15000' });
    expect(оформление.status).toBe(303);
    expect(оформление.token).not.toBeNull();
    const token = оформление.token!;

    expect(store.findByToken(token)?.state).toBe('ожидает');

    клиент.подтвердить('подпись-транзакции-е2е-1');
    // Триггер проверки — опрос статуса, как в бою; уведомление запускается
    // фоном (см. checker.ts, случай «оплачен»), поэтому дожидаемся его
    // результата отдельно, а не результата самого опроса.
    await опроситьСтатус(token);

    await дождаться(() => имитатор.полученныеУведомления.length === 1);

    const у = имитатор.полученныеУведомления[0]!;
    expect(имитатор.подписьВерна(у)).toBe(true);
    expect(у.status).toBe('paid');
    expect(у.transaction).toBe('подпись-транзакции-е2е-1');

    await дождаться(() => store.findByToken(token)?.state === 'уведомлён');
    expect(store.findByToken(token)?.notifiedOk).toBe(1);
  });

  it('Tilda отвечает мусором — заказ остаётся оплаченным, но не уведомлённым', async () => {
    await поднятьВсё('мусор');

    const { token } = await имитатор.оформитьЗаказ({ amount: '15000' });
    клиент.подтвердить('подпись-транзакции-е2е-2');
    await опроситьСтатус(token!);

    // Мусорный ответ (код 200, тело не «OK») тоже не должен пройти
    // незамеченным для имитатора — доводим до конца хотя бы одну попытку
    // прежде, чем проверять состояние заказа.
    await дождаться(() => имитатор.полученныеУведомления.length >= 1);

    await дождаться(() => store.findByToken(token!)?.state === 'оплачен');
    const заказ = store.findByToken(token!);
    expect(заказ?.state).toBe('оплачен');
    expect(заказ?.notifiedOk).toBe(0);
    expect(заказ?.txSignature).toBe('подпись-транзакции-е2е-2');
  });

  it('повторный заказ с тем же номером не создаёт второй записи', async () => {
    await поднятьВсё('OK');

    const orderId = '10868059:та-же-заявка';
    const первый = await имитатор.оформитьЗаказ({ amount: '15000', orderId });
    const второй = await имитатор.оформитьЗаказ({ amount: '15000', orderId });

    expect(первый.token).toBe(второй.token);
    expect(store.listRecent(10)).toHaveLength(1);
  });

  // Третий режим ответа имитатора («без ответа», см. `tools/fake-tilda.ts`)
  // здесь намеренно не проверяется отдельным тестом: настоящий отправитель
  // уведомления (`реальнаяОтправка` в `src/tilda/notify.ts`) ждёт ответа до
  // десяти секунд, прежде чем сдаться, — такой тест был бы честным, но
  // раздул бы время прогона всего набора в несколько раз ради сценария,
  // уже покрытого `tests/notify.test.ts` на подменённой (не настоящей по
  // сети) отправке. Сама возможность «не отвечать вовсе» у имитатора есть
  // и годится для ручной проверки (шаг 7 задания) и для будущих тестов,
  // которым такая цена оправдана.
});
