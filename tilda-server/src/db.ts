/**
 * Хранилище заказов на встроенном `node:sqlite`.
 *
 * Таблица одна, запросов восемь — ORM здесь дороже самого кода и прячет
 * то, что нужно видеть (см. задание). Курс, суммы и адреса хранятся
 * строками: числа с плавающей точкой в деньгах — источник молчаливых
 * ошибок округления, это ограничение всего проекта, а не прихоть этого
 * файла.
 *
 * `node:sqlite` в Node 22 остаётся экспериментальным модулем, доступным
 * только под флагом `--experimental-sqlite` (передаётся тестовому
 * процессу через `poolOptions.threads.execArgv` в vitest.config.ts).
 */

import { DatabaseSync, type SupportedValueType } from 'node:sqlite';
import type { Cluster, TokenSymbol } from './config.js';

type БазаSQLite = InstanceType<typeof DatabaseSync>;

export type OrderState = 'ожидает' | 'оплачен' | 'уведомлён' | 'не сошлось' | 'поздний' | 'просрочен';

/**
 * Заказ намеренно НЕ хранит адрес уведомлений из запроса Tilda
 * (`notify_url`). Это поле вне подписи (см. заголовок `tilda/inbound.ts`) —
 * покупатель правит POST-форму в своём браузере, и адрес, подставленный им,
 * получил бы от нас POST с признаком `paid` и подписью под секретом
 * уведомлений: готовое поддельное подтверждение оплаты. Уведомления всегда
 * идут по `config.tildaNotifyUrl` — он обязателен, проверен на `https://` и
 * фиксирован для интеграции, а не приходит с каждым заказом.
 */
export interface Order {
  id: number;
  tildaOrderId: string;
  /** Случайный ключ страницы оплаты — по нему покупатель открывает `/pay/:token`. */
  token: string;
  state: OrderState;
  amountKzt: string;
  amountToken: string;
  tokenSymbol: TokenSymbol;
  cluster: Cluster;
  recipient: string;
  reference: string;
  rate: string;
  rateSource: string;
  paymentUrl: string;
  quoteJson: string;
  createdAt: number;
  expiresAt: number;
  /**
   * Признак тестового режима (`test_mode`) из заказа Tilda — входит в
   * подпись, поэтому заверен. Заморожен при создании и хранится, потому что
   * восстановить его позже неоткуда: валюта у нас константа (KZT), время
   * можно взять свежее, а этот флаг — нет. Нужен уведомлению (задача 8):
   * Tilda ждёт его обратно в том же виде, в каком прислала.
   */
  testMode: boolean;
  /**
   * Подпись заказа от Tilda. Пишется при создании и больше не меняется —
   * единственное доказательство, что заказ с такой суммой действительно
   * пришёл от площадки, а не был подделан. Раньше делила один столбец с
   * подписью транзакции Solana — оплата затирала бы это доказательство
   * ровно в споре, где оно нужнее всего; разведены по разным столбцам.
   */
  tildaSignature: string | null;
  /** Подпись транзакции Solana — пусто до оплаты, заполняется при подтверждении. */
  txSignature: string | null;
  /**
   * Момент (Unix-секунды), когда заказ впервые перешёл в «оплачен» —
   * пусто до этого. Нужен, чтобы ограничить повторные попытки уведомить
   * Tilda по времени, а не по числу (`listPending` ниже): без своей
   * метки для этого момента пришлось бы отсчитывать окно повтора от
   * `createdAt`, а заказ может стать «оплачен» почти на исходе своего
   * собственного окна поздних платежей — тогда на повторы уведомления не
   * осталось бы времени вовсе.
   */
  paidAt: number | null;
  notifyAttempts: number;
  notifiedOk: 0 | 1;
  customerEmail: string | null;
  description: string | null;
  productsJson: string | null;
}

/**
 * Данные для создания заказа — всё, кроме того, что проставляет само
 * хранилище: `id` (автоинкремент), начальное `state`, счётчик попыток
 * уведомления и исход последней.
 */
export type NewOrder = Omit<Order, 'id' | 'state' | 'paidAt' | 'notifyAttempts' | 'notifiedOk'>;

/**
 * Заказ с таким номером Tilda уже есть в базе.
 *
 * Единственная настоящая защита от двух заказов с одним номером —
 * ограничение `UNIQUE` в самой базе, а не проверка «есть ли уже такой»
 * перед вставкой: между чтением и записью — гонка. Здесь нарушение этого
 * ограничения превращается в понятную ошибку, а не пробрасывается наружу
 * голым исключением SQLite — вызывающий код (задача 5) опирается именно
 * на этот класс.
 */
export class DuplicateOrderError extends Error {
  readonly tildaOrderId: string;

  constructor(tildaOrderId: string) {
    super(`заказ с номером Tilda «${tildaOrderId}» уже существует`);
    this.name = 'DuplicateOrderError';
    this.tildaOrderId = tildaOrderId;
  }
}

export interface Store {
  /** Заводит заказ. Бросает `DuplicateOrderError`, если `tildaOrderId` уже занят. */
  createOrder(o: NewOrder): Order;
  findByTildaOrderId(id: string): Order | null;
  findByToken(token: string): Order | null;
  /** Последние заказы, новые первыми. */
  listRecent(limit: number): Order[];
  /**
   * Заказы, требующие внимания фонового обходчика — старые первыми:
   * - «ожидает» без ограничения по времени;
   * - «просрочен», но только пока не вышло окно поздних платежей
   *   (`createdAt + lateWindowSeconds >= now`);
   * - «оплачен» с ещё не доставленным уведомлением Tilda
   *   (`notifiedOk = 0`), но только пока не вышло окно повторных попыток
   *   уведомления (`paidAt + notifyRetryWindowSeconds >= now`) — иначе
   *   заказ, по которому Tilda никогда не ответит «OK», занимал бы место
   *   в выборке вечно.
   *
   * Во всех трёх случаях безнадёжные заказы (окно уже истекло) в выборку
   * не попадают: иначе они навсегда занимают место в `limit`, и фоновый
   * обход, идущий от старых к новым, перестаёт доходить до свежих
   * заказов — ровно эта ошибка уже находилась в похожем месте (плагин
   * WooCommerce).
   */
  listPending(limit: number, lateWindowSeconds: number, notifyRetryWindowSeconds: number, now: number): Order[];
  updateState(id: number, state: OrderState, fields?: Partial<Order>): void;
  /**
   * Фиксирует попытку уведомления продавца: её номер и исход. Успех
   * (`ok`) в ОДНОЙ атомарной записи переводит заказ и в `notifiedOk = 1`,
   * и в `state = 'уведомлён'` — раздельные `markNotified` + `updateState`
   * оставляли бы окно между двумя записями, и падение процесса ровно в
   * нём оставило бы заказ уведомлённым, но не переведённым в `уведомлён`:
   * такая комбинация не проходит ни в `decide()`, ни в ветку довоза
   * (`notifiedOk = 1` там не подходит), и заказ выпадал бы из автоматики
   * молча, без единой записи в журнал.
   */
  markNotified(id: number, ok: boolean, attempt: number): void;
}

const СХЕМА = `
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tilda_order_id  TEXT    NOT NULL UNIQUE,
  token           TEXT    NOT NULL UNIQUE,
  state           TEXT    NOT NULL,
  amount_kzt      TEXT    NOT NULL,
  amount_token    TEXT    NOT NULL,
  token_symbol    TEXT    NOT NULL,
  cluster         TEXT    NOT NULL,
  recipient       TEXT    NOT NULL,
  reference       TEXT    NOT NULL,
  rate            TEXT    NOT NULL,
  rate_source     TEXT    NOT NULL,
  payment_url     TEXT    NOT NULL,
  quote_json      TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  test_mode       INTEGER NOT NULL DEFAULT 0,
  tilda_signature TEXT,
  tx_signature    TEXT,
  paid_at         INTEGER,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  notified_ok     INTEGER NOT NULL DEFAULT 0,
  customer_email  TEXT,
  description     TEXT,
  products_json   TEXT
);
CREATE INDEX IF NOT EXISTS orders_state_created ON orders (state, created_at);
`;

/** Сырая строка таблицы `orders` — имена колонок как в SQL, snake_case. */
interface СтрокаЗаказа {
  id: number;
  tilda_order_id: string;
  token: string;
  state: string;
  amount_kzt: string;
  amount_token: string;
  token_symbol: string;
  cluster: string;
  recipient: string;
  reference: string;
  rate: string;
  rate_source: string;
  payment_url: string;
  quote_json: string;
  created_at: number;
  expires_at: number;
  test_mode: number;
  tilda_signature: string | null;
  tx_signature: string | null;
  paid_at: number | null;
  notify_attempts: number;
  notified_ok: number;
  customer_email: string | null;
  description: string | null;
  products_json: string | null;
}

function изСтроки(р: СтрокаЗаказа): Order {
  return {
    id: р.id,
    tildaOrderId: р.tilda_order_id,
    token: р.token,
    state: р.state as OrderState,
    amountKzt: р.amount_kzt,
    amountToken: р.amount_token,
    tokenSymbol: р.token_symbol as TokenSymbol,
    cluster: р.cluster as Cluster,
    recipient: р.recipient,
    reference: р.reference,
    rate: р.rate,
    rateSource: р.rate_source,
    paymentUrl: р.payment_url,
    quoteJson: р.quote_json,
    createdAt: р.created_at,
    expiresAt: р.expires_at,
    testMode: р.test_mode === 1,
    tildaSignature: р.tilda_signature,
    txSignature: р.tx_signature,
    paidAt: р.paid_at,
    notifyAttempts: р.notify_attempts,
    notifiedOk: р.notified_ok === 1 ? 1 : 0,
    customerEmail: р.customer_email,
    description: р.description,
    productsJson: р.products_json,
  };
}

/** Соответствие поля `Order` (camelCase) колонке таблицы (snake_case). Пригодится и для `updateState`. */
const КОЛОНКА: Record<Exclude<keyof Order, 'id'>, string> = {
  tildaOrderId: 'tilda_order_id',
  token: 'token',
  state: 'state',
  amountKzt: 'amount_kzt',
  amountToken: 'amount_token',
  tokenSymbol: 'token_symbol',
  cluster: 'cluster',
  recipient: 'recipient',
  reference: 'reference',
  rate: 'rate',
  rateSource: 'rate_source',
  paymentUrl: 'payment_url',
  quoteJson: 'quote_json',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
  testMode: 'test_mode',
  tildaSignature: 'tilda_signature',
  txSignature: 'tx_signature',
  paidAt: 'paid_at',
  notifyAttempts: 'notify_attempts',
  notifiedOk: 'notified_ok',
  customerEmail: 'customer_email',
  description: 'description',
  productsJson: 'products_json',
};

/**
 * Расширенный код результата SQLite для нарушения `UNIQUE`
 * (`SQLITE_CONSTRAINT` = 19, расширенный = `19 | (8 << 8)` = 2067).
 * Задокументированная числовая константа движка — в отличие от текста
 * сообщения (`err.message`), она не зависит от версии SQLite, локали
 * или формулировки. `node:sqlite` прокидывает её как есть в поле
 * `errcode`.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * Форма ошибки, которую бросает `node:sqlite` при сбое движка. В
 * `@types/node` не описана (там у методов `DatabaseSync`/`StatementSync`
 * тип возврата известен, а тип исключения — нет); проверена на живом
 * Node 22.23: у объекта есть ровно `code` ('ERR_SQLITE_ERROR' на
 * стороне Node), `errcode` и `errstr` (числовой и текстовый код самого
 * SQLite) и обычные `message`/`stack`. Имени колонки/таблицы отдельным
 * полем нет — только внутри текста `message`.
 */
interface ОшибкаSQLite extends Error {
  code: string;
  errcode: number;
  errstr: string;
}

function этоОшибкаSQLite(е: unknown): е is ОшибкаSQLite {
  return е instanceof Error && typeof (е as Partial<ОшибкаSQLite>).errcode === 'number';
}

/**
 * Является ли ошибка нарушением `UNIQUE` на колонке `tilda_order_id`.
 *
 * Основной критерий — код ошибки (`errcode === SQLITE_CONSTRAINT_UNIQUE`),
 * а не текст сообщения: числовой код стабилен между версиями SQLite,
 * текст — нет. Он же надёжно отличает нарушение UNIQUE от «database is
 * locked» (`errcode === 5`, SQLITE_BUSY) — ошибки, которую получает
 * проигравший в гонке при двух процессах на одном файле без
 * `busy_timeout` (устранено PRAGMA ниже, но код ошибки в любом случае не
 * должен путать эти два случая, даже если однажды окно снова откроется).
 *
 * Имя колонки код ошибки не несёт: `node:sqlite` не даёт его отдельным
 * полем (см. `ОшибкаSQLite` выше), поэтому колонку по-прежнему приходится
 * узнавать по подстроке в тексте сообщения — но это уже вторичная,
 * уточняющая проверка после того, как код ошибки подтвердил, что это
 * вообще нарушение UNIQUE, а не какая-то другая ошибка движка.
 */
export function этоДубльНомераTilda(е: unknown): boolean {
  return (
    этоОшибкаSQLite(е) &&
    е.errcode === SQLITE_CONSTRAINT_UNIQUE &&
    е.message.includes('orders.tilda_order_id')
  );
}

/**
 * Версия схемы `orders`, записывается в `PRAGMA user_version` файла базы.
 *
 * `CREATE TABLE IF NOT EXISTS` на файле со старой схемой молча ничего не
 * делает — новые колонки не появляются, а вставка падает позже, на первой
 * попытке записи в несуществующую колонку, без единого внятного сообщения
 * о причине (воспроизведено ревью). `user_version` — штатное поле
 * заголовка файла SQLite специально под это: `openDatabase` сверяет его
 * при открытии и отказывается сразу, если версия чужая, вместо того чтобы
 * упасть на первой вставке.
 *
 * Боевой базы с заказами пока нет, поэтому миграции не реализованы — при
 * несовпадении версий сервер обязан отказаться с понятным сообщением, а
 * не молча повредить данные или упасть в случайном месте. Если версия
 * когда-нибудь изменится, здесь же нужна и миграция.
 *
 * Версия 2 (была 1): добавлена колонка `paid_at` (задача 7, ревью —
 * повторные попытки уведомить Tilda ограничены временем с момента оплаты,
 * а не только числом). Боевой базы по-прежнему нет, поэтому и в этот раз
 * — просто отказ на несовпадении версии, без миграции существующего
 * файла.
 */
const ВЕРСИЯ_СХЕМЫ = 2;

/**
 * Открывает (создаёт при отсутствии) файл базы и возвращает хранилище
 * заказов.
 *
 * @param busyTimeoutMs — сколько ждать освобождения блокировки перед
 *   тем, как сдаться (`PRAGMA busy_timeout`), по умолчанию 5000 мс — для
 *   боя. Параметр, а не зашитое число: тестам нужно значение поменьше,
 *   чтобы проверять сам факт ожидания без реального пятисекундного
 *   ожидания в каждом прогоне; на медленном диске или при большом
 *   обходе бою тоже может понадобиться другое число.
 */
export function openDatabase(путь: string, busyTimeoutMs = 5000): Store {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error('openDatabase: busyTimeoutMs должен быть неотрицательным целым числом миллисекунд');
  }

  const db: БазаSQLite = new DatabaseSync(путь);

  // busy_timeout — штатный приём для WAL при нескольких соединениях на
  // одном файле (перезапуск сервера со старым процессом, ещё не
  // отпустившим файл; имитатор Tilda рядом с работающим сервером).
  // Без него проигравший в гонке получает мгновенный отказ «database is
  // locked» вместо того, чтобы дождаться освобождения блокировки и
  // получить настоящее — и корректно распознаваемое — нарушение UNIQUE.
  // PRAGMA не принимает связанные параметры (`?`) — только литерал в
  // тексте запроса; значение уже проверено выше, что оно целое и
  // неотрицательное, так что подстановка в SQL безопасна.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // WAL — чтобы фоновый обходчик (задача 6) мог читать, пока HTTP-сервер
  // пишет, без блокировки всего файла; foreign_keys — на будущее, если
  // таблица заказов обрастёт связанными таблицами.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Версия 0 — свежий файл (SQLite сам проставляет 0, если её никто не
  // задавал): создаём схему и клеймим версию. Любая другая версия, кроме
  // ожидаемой, — несовместимая база; открывать её поверх было бы молчаливой
  // порчей данных, поэтому отказываемся сразу и закрываем соединение, а не
  // ждём падения на первой вставке.
  const { user_version: версияБазы } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (версияБазы !== 0 && версияБазы !== ВЕРСИЯ_СХЕМЫ) {
    db.close();
    throw new Error(
      `База данных «${путь}» создана версией схемы ${версияБазы}, а сервер ожидает версию ` +
        `${ВЕРСИЯ_СХЕМЫ}. Миграций пока нет: обновите сервер и базу согласованно, не открывайте ` +
        'несовместимые версии одну поверх другой.',
    );
  }

  db.exec(СХЕМА);
  db.exec(`PRAGMA user_version = ${ВЕРСИЯ_СХЕМЫ}`);

  const вставить = db.prepare(`
    INSERT INTO orders (
      tilda_order_id, token, state, amount_kzt, amount_token, token_symbol,
      cluster, recipient, reference, rate, rate_source, payment_url,
      quote_json, created_at, expires_at, test_mode, tilda_signature, tx_signature, paid_at,
      notify_attempts, notified_ok, customer_email, description, products_json
    ) VALUES (
      @tilda_order_id, @token, @state, @amount_kzt, @amount_token, @token_symbol,
      @cluster, @recipient, @reference, @rate, @rate_source, @payment_url,
      @quote_json, @created_at, @expires_at, @test_mode, @tilda_signature, @tx_signature, @paid_at,
      @notify_attempts, @notified_ok, @customer_email, @description, @products_json
    )
  `);
  const найтиПоId = db.prepare('SELECT * FROM orders WHERE id = ?');
  const найтиПоНомеруTilda = db.prepare('SELECT * FROM orders WHERE tilda_order_id = ?');
  const найтиПоТокену = db.prepare('SELECT * FROM orders WHERE token = ?');
  const свежие = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?');
  // «просрочен» ограничен окном поздних платежей прямо в запросе, а не
  // проверкой у вызывающего: фоновый обход берёт фиксированные `limit`
  // штук, старые первыми. Если безнадёжно просроченные заказы оставались
  // бы в выборке навсегда, они забивали бы собой всё окно `limit`, и
  // новые заказы молча переставали бы проверяться — без единой записи в
  // журнал. Ровно эта ошибка уже находилась в похожем месте (плагин
  // WooCommerce) и чинилась тем же способом — исключением безнадёжных
  // заказов из выборки.
  const ожидающие = db.prepare(`
    SELECT * FROM orders
    WHERE state = 'ожидает'
       OR (state = 'просрочен' AND created_at + ? >= ?)
       OR (state = 'оплачен' AND notified_ok = 0 AND paid_at IS NOT NULL AND paid_at + ? >= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `);

  function createOrder(o: NewOrder): Order {
    let результат: { lastInsertRowid: number | bigint };
    try {
      результат = вставить.run({
        tilda_order_id: o.tildaOrderId,
        token: o.token,
        state: 'ожидает',
        amount_kzt: o.amountKzt,
        amount_token: o.amountToken,
        token_symbol: o.tokenSymbol,
        cluster: o.cluster,
        recipient: o.recipient,
        reference: o.reference,
        rate: o.rate,
        rate_source: o.rateSource,
        payment_url: o.paymentUrl,
        quote_json: o.quoteJson,
        created_at: o.createdAt,
        expires_at: o.expiresAt,
        test_mode: o.testMode ? 1 : 0,
        tilda_signature: o.tildaSignature,
        tx_signature: o.txSignature,
        paid_at: null,
        notify_attempts: 0,
        notified_ok: 0,
        customer_email: o.customerEmail,
        description: o.description,
        products_json: o.productsJson,
      });
    } catch (е) {
      if (этоДубльНомераTilda(е)) {
        throw new DuplicateOrderError(o.tildaOrderId);
      }
      // Другое нарушение (например, UNIQUE на token) — не подменяем
      // конкретной ошибкой, которой это не является, но и не пропускаем
      // молча: пробрасываем исходное исключение SQLite дальше.
      throw е;
    }
    const строка = найтиПоId.get(результат.lastInsertRowid) as СтрокаЗаказа;
    return изСтроки(строка);
  }

  function findByTildaOrderId(id: string): Order | null {
    const строка = найтиПоНомеруTilda.get(id) as СтрокаЗаказа | undefined;
    return строка ? изСтроки(строка) : null;
  }

  function findByToken(token: string): Order | null {
    const строка = найтиПоТокену.get(token) as СтрокаЗаказа | undefined;
    return строка ? изСтроки(строка) : null;
  }

  function listRecent(limit: number): Order[] {
    const строки = свежие.all(limit) as СтрокаЗаказа[];
    return строки.map(изСтроки);
  }

  function listPending(
    limit: number,
    lateWindowSeconds: number,
    notifyRetryWindowSeconds: number,
    now: number,
  ): Order[] {
    const строки = ожидающие.all(
      lateWindowSeconds,
      now,
      notifyRetryWindowSeconds,
      now,
      limit,
    ) as СтрокаЗаказа[];
    return строки.map(изСтроки);
  }

  function updateState(id: number, state: OrderState, fields: Partial<Order> = {}): void {
    const колонки: string[] = ['state'];
    const значения: SupportedValueType[] = [state];

    for (const [ключ, значение] of Object.entries(fields)) {
      if (ключ === 'id' || ключ === 'state') continue; // id неизменяем, state задаётся отдельным параметром
      const колонка = (КОЛОНКА as Record<string, string | undefined>)[ключ];
      if (!колонка) {
        throw new Error(`updateState: неизвестное поле заказа «${ключ}»`);
      }
      колонки.push(колонка);
      значения.push(значение as SupportedValueType);
    }

    const sql = `UPDATE orders SET ${колонки.map((к) => `${к} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...значения, id);
  }

  function markNotified(id: number, ok: boolean, attempt: number): void {
    // `state` меняется тем же UPDATE, а не отдельным вызовом: см.
    // комментарий у объявления в интерфейсе `Store` — раздельная запись
    // оставляла бы окно, в которое мог упасть процесс. `okValue`
    // подставляется дважды — и как значение `notified_ok`, и как условие
    // в CASE, — оба раза одним и тем же параметром, второй раз погоды не
    // делает: при `ok = false` CASE оставляет `state` как есть.
    const okValue = ok ? 1 : 0;
    db.prepare(
      `UPDATE orders
       SET notify_attempts = ?,
           notified_ok = ?,
           state = CASE WHEN ? = 1 THEN 'уведомлён' ELSE state END
       WHERE id = ?`,
    ).run(attempt, okValue, okValue, id);
  }

  return {
    createOrder,
    findByTildaOrderId,
    findByToken,
    listRecent,
    listPending,
    updateState,
    markNotified,
  };
}
