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
  currency: 'KZT',
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
  testMode: false,
  tildaSignature: 'подпись',
  txSignature: null,
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

  it('сохраняет признак тестового режима — восстановить его позже неоткуда', () => {
    const боевой = store.createOrder({ ...образец, tildaOrderId: 't:1', token: 'т-боевой', testMode: false });
    const тестовый = store.createOrder({ ...образец, tildaOrderId: 't:2', token: 'т-тестовый', testMode: true });
    expect(store.findByToken('т-боевой')?.testMode).toBe(false);
    expect(store.findByToken('т-тестовый')?.testMode).toBe(true);
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

  it('меняет состояние и сохраняет подпись транзакции, не трогая подпись Tilda', () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись-транзакции' });
    const после = store.findByToken('ткн-1');
    expect(после?.state).toBe('оплачен');
    expect(после?.txSignature).toBe('подпись-транзакции');
    // Две подписи — разные вещи и разные столбцы: подпись заказа от Tilda
    // доказывает, что заказ пришёл от неё, подпись транзакции указывает на
    // платёж в блокчейне. Один столбец на обе означал бы, что оплата стирает
    // доказательство происхождения заказа.
    expect(после?.tildaSignature).toBe('подпись');
  });

  it('paidAt пусто у нового заказа и сохраняется при переходе в «оплачен»', () => {
    const о = store.createOrder(образец);
    expect(о.paidAt).toBeNull();
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись-транзакции', paidAt: 12345 });
    expect(store.findByToken('ткн-1')?.paidAt).toBe(12345);
  });

  it('listPending отдаёт ожидающие, старые первыми, и не отдаёт завершённые', () => {
    store.createOrder({ ...образец, tildaOrderId: 'a:1', token: 'т1', createdAt: 300 });
    store.createOrder({ ...образец, tildaOrderId: 'a:2', token: 'т2', createdAt: 100 });
    const третий = store.createOrder({ ...образец, tildaOrderId: 'a:3', token: 'т3', createdAt: 200 });
    store.updateState(третий.id, 'уведомлён');

    const список = store.listPending(10, 86400, 86400, 1_000_000);
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

    const список = store.listPending(10, 500, 86400, 1200);
    expect(список.map((o) => o.tildaOrderId)).toEqual(['b:1']);
  });

  it('listPending отдаёт «не сошлось» в пределах окна поздних платежей и не отдаёт за его пределами (правка финального ревью, задача 2)', () => {
    // Раньше «не сошлось» вообще не входило в выборку — первое же
    // расхождение (например, чужая транзакция по той же метке или
    // протухший повтор кошелька, найденные раньше настоящего платежа)
    // делало заказ непроверяемым навсегда. Окно то же самое, что и у
    // «просрочен»: свежий (createdAt 1000) укладывается, древний
    // (createdAt 100) — нет.
    const свежий = store.createOrder({ ...образец, tildaOrderId: 'м:1', token: 'тм1', createdAt: 1000 });
    store.updateState(свежий.id, 'не сошлось', { txSignature: 'подпись-м' });
    const древний = store.createOrder({ ...образец, tildaOrderId: 'м:2', token: 'тм2', createdAt: 100 });
    store.updateState(древний.id, 'не сошлось', { txSignature: 'подпись-м' });

    const список = store.listPending(10, 500, 86400, 1200);
    expect(список.map((o) => o.tildaOrderId)).toEqual(['м:1']);
  });

  it('listPending не отдаёт «ожидает», если окно поздних платежей сверх срока цены уже истекло (правка финального ревью)', () => {
    // Раньше «ожидает» не была ограничена по времени вовсе — заказ,
    // застрявший в этом состоянии (например, из-за расхождения настроек,
    // см. checker.ts), навсегда занимал бы место в limit фонового обхода.
    // окно — 500 секунд, «сейчас» — 1200: свежий (expiresAt 1000) ещё
    // укладывается (1000 + 500 = 1500 >= 1200), древний (expiresAt 100) —
    // нет (100 + 500 = 600 < 1200).
    const свежий = store.createOrder({ ...образец, tildaOrderId: 'п:1', token: 'тп1', expiresAt: 1000 });
    const древний = store.createOrder({ ...образец, tildaOrderId: 'п:2', token: 'тп2', expiresAt: 100 });
    expect(свежий.state).toBe('ожидает');
    expect(древний.state).toBe('ожидает');

    const список = store.listPending(10, 500, 86400, 1200);
    expect(список.map((o) => o.tildaOrderId)).toEqual(['п:1']);
  });

  it('listPending никогда не отдаёт заказ в «ошибка настроек» — ждёт человека, а не проверки', () => {
    const о = store.createOrder({ ...образец, tildaOrderId: 'н:1', token: 'тн1' });
    store.updateState(о.id, 'ошибка настроек');

    const список = store.listPending(10, 86400, 86400, 1_000_000);
    expect(список.map((з) => з.tildaOrderId)).not.toContain('н:1');
  });

  it('listPending отдаёт оплаченный неуведомленный заказ в пределах окна повтора и не отдаёт уведомлённый', () => {
    const неуведомлённый = store.createOrder({ ...образец, tildaOrderId: 'c:1', token: 'тс1', createdAt: 100 });
    store.updateState(неуведомлённый.id, 'оплачен', { txSignature: 'подпись', paidAt: 100 });

    const уведомлённый = store.createOrder({ ...образец, tildaOrderId: 'c:2', token: 'тс2', createdAt: 200 });
    store.updateState(уведомлённый.id, 'оплачен', { txSignature: 'подпись', paidAt: 200 });
    // markNotified(true, ...) сам переводит заказ в «уведомлён» —
    // отдельный updateState не нужен, см. тест атомарности ниже.
    store.markNotified(уведомлённый.id, true, 1);

    const список = store.listPending(10, 86400, 86400, 1000);
    expect(список.map((o) => o.tildaOrderId)).toEqual(['c:1']);
  });

  it('listPending не отдаёт оплаченный неуведомленный заказ, если окно повтора уведомления истекло', () => {
    // окно — 500 секунд, «сейчас» — 1200: как и с «просрочен» выше, заказ,
    // по которому Tilda никогда не ответит «OK», не должен занимать место
    // в limit фонового обхода вечно.
    const заказ = store.createOrder({ ...образец, tildaOrderId: 'c:3', token: 'тс3', createdAt: 100 });
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись', paidAt: 100 });

    const список = store.listPending(10, 86400, 500, 1200);
    expect(список).toEqual([]);
  });

  it('считает попытки уведомления и помнит исход последней', () => {
    const о = store.createOrder(образец);
    store.markNotified(о.id, false, 1);
    store.markNotified(о.id, true, 2);
    const после = store.findByToken('ткн-1');
    expect(после?.notifyAttempts).toBe(2);
    expect(после?.notifiedOk).toBe(1);
  });

  it('markNotified при успехе одной записью переводит заказ в «уведомлён»', () => {
    // Раздельные markNotified + updateState оставляли бы окно между двумя
    // записями — падение процесса ровно в нём оставляло бы заказ
    // уведомлённым (notifiedOk=1), но не переведённым в state='уведомлён':
    // такая комбинация не проходит ни в decide(), ни в ветку довоза
    // уведомления (там нужен notifiedOk=0), и заказ выпадал бы из
    // автоматики молча.
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись', paidAt: 100 });

    store.markNotified(о.id, true, 1);

    const после = store.findByToken('ткн-1');
    expect(после?.state).toBe('уведомлён');
    expect(после?.notifiedOk).toBe(1);
  });

  it('markNotified при неуспехе не трогает состояние заказа', () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись', paidAt: 100 });

    store.markNotified(о.id, false, 1);

    const после = store.findByToken('ткн-1');
    expect(после?.state).toBe('оплачен');
    expect(после?.notifiedOk).toBe(0);
  });

  it('новый заказ создаётся без сбоя письма продавцу (mailFailedAt/mailError = null)', () => {
    const о = store.createOrder(образец);
    expect(о.mailFailedAt).toBeNull();
    expect(о.mailError).toBeNull();
  });

  it('recordMailOutcome записывает сбой письма и не трогает state заказа', () => {
    const о = store.createOrder(образец);
    store.updateState(о.id, 'оплачен', { txSignature: 'подпись' });

    store.recordMailOutcome(о.id, { at: 1_789_200_777, message: 'SMTP недоступен' });

    const после = store.findByToken('ткн-1')!;
    expect(после.mailFailedAt).toBe(1_789_200_777);
    expect(после.mailError).toBe('SMTP недоступен');
    expect(после.state).toBe('оплачен'); // не задето записью об исходе письма
  });

  it('recordMailOutcome(id, null) снимает ранее записанный сбой', () => {
    const о = store.createOrder(образец);
    store.recordMailOutcome(о.id, { at: 100, message: 'сбой' });
    store.recordMailOutcome(о.id, null);

    const после = store.findByToken('ткн-1')!;
    expect(после.mailFailedAt).toBeNull();
    expect(после.mailError).toBeNull();
  });

  it('сбой письма переживает повторное открытие того же файла базы («перезапуск сервера»)', () => {
    const путь = join(каталог, 'mail-outcome.sqlite');
    const первый = openDatabase(путь);
    const о = первый.createOrder({ ...образец, tildaOrderId: 'm:1', token: 'ткн-перезапуск' });
    первый.recordMailOutcome(о.id, { at: 100, message: 'нет связи с SMTP' });

    const второй = openDatabase(путь);
    const заново = второй.findByToken('ткн-перезапуск');
    expect(заново?.mailError).toBe('нет связи с SMTP');
    expect(заново?.mailFailedAt).toBe(100);
  });

  it('sessionGeneration начинается с 0, bumpSessionGeneration увеличивает и возвращает новое значение', () => {
    expect(store.sessionGeneration()).toBe(0);
    expect(store.bumpSessionGeneration()).toBe(1);
    expect(store.sessionGeneration()).toBe(1);
    expect(store.bumpSessionGeneration()).toBe(2);
  });

  it('поколение сессий переживает повторное открытие того же файла базы («перезапуск сервера»)', () => {
    // Иначе перезапуск сервера ровно в момент, когда админ понадеялся на
    // «выйти» после утечки куки, оживил бы старый токен обратно.
    const путь = join(каталог, 'session-generation.sqlite');
    const первый = openDatabase(путь);
    первый.bumpSessionGeneration();
    первый.bumpSessionGeneration();

    const второй = openDatabase(путь);
    expect(второй.sessionGeneration()).toBe(2);
  });

  it('busyTimeoutMs заставляет проигравшего в гонке ждать освобождения блокировки, а не падать мгновенно', () => {
    // busy_timeout — свойство отдельного соединения, а не файла базы:
    // прочитать его через PRAGMA с ДРУГОГО соединения нельзя, оно всегда
    // покажет 0. Поэтому проверяем поведение настоящего соединения
    // хранилища напрямую: держим эксклюзивную блокировку и никогда её
    // не отпускаем — если хранилище действительно ждёт, вставка займёт
    // заметно больше нуля.
    //
    // Значение здесь — 200 мс, а не боевые 5000: смысл проверки (мгновенный
    // отказ без ожидания vs отказ после ожидания) от конкретного числа не
    // зависит, а прогон всего набора тестов не должен платить настоящие
    // пять секунд за одну проверку — иначе медленный набор через полгода
    // станут запускать реже, потом пропускать, потом уберут вовсе, и
    // проверка перестанет от чего-либо защищать.
    const путь = join(каталог, 'таймаут.sqlite');
    const хранилище = openDatabase(путь, 200);
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
    expect(прошло).toBeGreaterThanOrEqual(150);
  });

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

  it('отказывается открывать базу другой версии схемы, а не падает молча на первой вставке', () => {
    // CREATE TABLE IF NOT EXISTS на файле с чужой версией ничего не делает —
    // без явной проверки версии сервер бы упал на первой же вставке в
    // несуществующую колонку, без единого внятного сообщения о причине.
    const путь = join(каталог, 'чужая-версия.sqlite');
    const чужая = new DatabaseSync(путь);
    чужая.exec('PRAGMA user_version = 999');
    чужая.close();

    expect(() => openDatabase(путь)).toThrow(/версией схемы/);
  });

  it('открывает новый файл (версия 0) и повторно — свою же версию — без ошибок', () => {
    const путь = join(каталог, 'своя-версия.sqlite');
    expect(() => openDatabase(путь)).not.toThrow();
    // Повторное открытие того же файла — версия уже проставлена и совпадает
    // с ожидаемой, это штатный случай (перезапуск сервера), а не отказ.
    expect(() => openDatabase(путь)).not.toThrow();
  });
});
