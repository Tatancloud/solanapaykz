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

    const заказ = store.findByTildaOrderId('482910');
    expect(заказ).not.toBeNull();
    expect(заказ?.state).toBe('ожидает');
    expect(заказ?.amountKzt).toBe('15000');
  });

  it('без подписи вообще: tildaSignature — пустая строка, а не что-то похожее на настоящую подпись', async () => {
    await вебхук(телоЗаявки());
    const заказ = store.findByTildaOrderId('482910');
    expect(заказ?.tildaSignature).toBe('');
  });

  it('записывает Email покупателя из заглавного поля', async () => {
    await вебхук(телоЗаявки());
    const заказ = store.findByTildaOrderId('482910');
    expect(заказ?.customerEmail).toBe('asel@example.kz');
  });

  it('складывает имя и телефон в описание — иначе им негде появиться в списке заказов', async () => {
    await вебхук(телоЗаявки());
    const заказ = store.findByTildaOrderId('482910');
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
    expect(store.findByTildaOrderId('482910')).toBeNull();
  });

  it('с суммой не в том формате (запятая, буквы) отвечает 400', async () => {
    const ответ = await вебхук(телоЗаявки({ Payment: '15 000,00' }));
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('482910')).toBeNull();
  });

  it('с нулевой или отрицательной суммой отвечает 400', async () => {
    const ответ = await вебхук(телоЗаявки({ Payment: '0' }));
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('482910')).toBeNull();
  });

  it('с суммой выше потолка отвечает 400', async () => {
    const ответ = await вебхук(телоЗаявки({ Payment: '999999999' }));
    expect(ответ.status).toBe(400);
    expect(store.findByTildaOrderId('482910')).toBeNull();
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
