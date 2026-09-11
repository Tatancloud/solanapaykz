import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DuplicateOrderError, openDatabase, этоДубльНомераTilda, type NewOrder, type Store } from '../src/db.js';

let каталог: string;
let store: Store;

const образец: NewOrder = {
  tildaOrderId: '10868059:42',
  token: 'ткн-1',
  amountKzt: '15000',
  amountToken: '32.640000',
  tokenSymbol: 'USDC',
  cluster: 'devnet',
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  reference: 'метка-1',
  rate: '459.55',
  rateSource: 'binance',
  paymentUrl: 'solana:9WzDX...',
  quoteJson: '{}',
  createdAt: 1789200000,
  expiresAt: 1789200900,
  signature: 'подпись',
  notifyUrl: 'https://tilda.cc/notify/x',
  customerEmail: 'k@example.kz',
  description: 'Букет',
  productsJson: '[]',
};

beforeEach(() => {
  каталог = mkdtempSync(join(tmpdir(), 'spkz-'));
  store = openDatabase(join(каталог, 'orders.sqlite'));
});

afterEach(() => {
  rmSync(каталог, { recursive: true, force: true });
});

describe('Store', () => {
  it('создаёт заказ и находит его по номеру Tilda и по ключу страницы', () => {
    const создан = store.createOrder(образец);
    expect(создан.state).toBe('ожидает');
    expect(store.findByTildaOrderId('10868059:42')?.id).toBe(создан.id);
    expect(store.findByToken('ткн-1')?.id).toBe(создан.id);
  });

  it('не заводит второй заказ с тем же номером Tilda', () => {
    store.createOrder(образец);
    expect(() => store.createOrder({ ...образец, token: 'ткн-2' })).toThrow(DuplicateOrderError);
  });

  it('не заводит два заказа с одним ключом страницы', () => {
    store.createOrder(образец);
    expect(() => store.createOrder({ ...образец, tildaOrderId: '10868059:43' })).toThrow();
  });

  it('переживает закрытие и открытие файла', () => {
    const путь = join(каталог, 'снова.sqlite');
    const первый = openDatabase(путь);
    первый.createOrder(образец);
    const второй = openDatabase(путь);
    expect(второй.findByTildaOrderId('10868059:42')).not.toBeNull();
  });

  it('меняет состояние и сохраняет подпись транзакции', () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { signature: 'подпись-транзакции' });
    const после = store.findByToken('ткн-1');
    expect(после?.state).toBe('оплачен');
    expect(после?.signature).toBe('подпись-транзакции');
  });

  it('listPending отдаёт ожидающие, старые первыми, и не отдаёт завершённые', () => {
    store.createOrder({ ...образец, tildaOrderId: 'a:1', token: 'т1', createdAt: 300 });
    store.createOrder({ ...образец, tildaOrderId: 'a:2', token: 'т2', createdAt: 100 });
    const третий = store.createOrder({ ...образец, tildaOrderId: 'a:3', token: 'т3', createdAt: 200 });
    store.updateState(третий.id, 'уведомлён');

    const список = store.listPending(10, 86400, 1_000_000);
    expect(список.map((o) => o.tildaOrderId)).toEqual(['a:2', 'a:1']);
  });

  it('listPending не отдаёт просроченный заказ, если окно поздних платежей уже истекло', () => {
    // окно — 500 секунд, «сейчас» — 1200: свежий (createdAt 1000) ещё
    // укладывается (1000 + 500 = 1500 >= 1200), древний (createdAt 100) —
    // нет (100 + 500 = 600 < 1200) и не должен попасть в выборку, иначе
    // безнадёжные заказы навсегда занимали бы место в limit фонового
    // обхода и новые заказы молча переставали бы проверяться.
    const свежий = store.createOrder({ ...образец, tildaOrderId: 'b:1', token: 'тб1', createdAt: 1000 });
    store.updateState(свежий.id, 'просрочен');
    const древний = store.createOrder({ ...образец, tildaOrderId: 'b:2', token: 'тб2', createdAt: 100 });
    store.updateState(древний.id, 'просрочен');

    const список = store.listPending(10, 500, 1200);
    expect(список.map((o) => o.tildaOrderId)).toEqual(['b:1']);
  });

  it('считает попытки уведомления и помнит исход последней', () => {
    const о = store.createOrder(образец);
    store.markNotified(о.id, false, 1);
    store.markNotified(о.id, true, 2);
    const после = store.findByToken('ткн-1');
    expect(после?.notifyAttempts).toBe(2);
    expect(после?.notifiedOk).toBe(1);
  });

  it(
    'выставляет busy_timeout при открытии: проигравший в гонке ждёт освобождения блокировки, а не падает мгновенно',
    () => {
      // busy_timeout — свойство отдельного соединения, а не файла базы:
      // прочитать его через PRAGMA с ДРУГОГО соединения нельзя, оно
      // всегда покажет 0. Поэтому проверяем поведение настоящего
      // соединения хранилища напрямую: держим эксклюзивную блокировку и
      // никогда её не отпускаем, значит если хранилище действительно
      // ждёт настроенные 5000 мс (а не падает сразу с «database is
      // locked»), вставка займёт заметно больше нуля — и именно
      // столько, сколько настроено, а не какое-то случайное время.
      const путь = join(каталог, 'таймаут.sqlite');
      const хранилище = openDatabase(путь);
      const держит = new DatabaseSync(путь);
      держит.exec('BEGIN EXCLUSIVE');

      const начало = Date.now();
      let поймана: unknown;
      try {
        хранилище.createOrder({ ...образец, tildaOrderId: 'занято:1', token: 'занято-токен-1' });
      } catch (е) {
        поймана = е;
      } finally {
        держит.exec('COMMIT');
        держит.close();
      }
      const прошло = Date.now() - начало;

      expect(поймана).toBeInstanceOf(Error);
      expect(прошло).toBeGreaterThanOrEqual(4000);
    },
    8000,
  );

  it('не путает «база занята» (SQLITE_BUSY) с нарушением уникальности заказа', () => {
    // Настоящая ошибка от двух реальных соединений SQLite на одном
    // файле, а не выдуманный объект: два процесса на одном файле дают
    // «database is locked», у неё errcode = 5 (SQLITE_BUSY), а не 2067
    // (SQLITE_CONSTRAINT_UNIQUE), и в тексте нет ни таблицы, ни колонки —
    // этому не нужны два процесса, поведение SQLite одинаковое что для
    // двух соединений в одном процессе, что для двух процессов.
    const путь = join(каталог, 'занято.sqlite');
    const держит = new DatabaseSync(путь);
    держит.exec('PRAGMA journal_mode = WAL');
    держит.exec('CREATE TABLE x (a INTEGER)');
    держит.exec('BEGIN EXCLUSIVE');

    const конкурент = new DatabaseSync(путь);
    конкурент.exec('PRAGMA busy_timeout = 50'); // держащий соединение блокировку не отпустит — ждать незачем дольше

    let поймана: unknown;
    try {
      конкурент.exec('INSERT INTO x (a) VALUES (1)');
    } catch (е) {
      поймана = е;
    } finally {
      держит.exec('COMMIT');
      держит.close();
      конкурент.close();
    }

    expect(поймана).toBeInstanceOf(Error);
    expect((поймана as { errcode?: number }).errcode).toBe(5);
    expect((поймана as Error).message).not.toContain('orders.tilda_order_id');
    expect(этоДубльНомераTilda(поймана)).toBe(false);
  });
});
