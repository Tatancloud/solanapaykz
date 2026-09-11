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
  signature: string | null;
  notifyUrl: string | null;
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
export type NewOrder = Omit<Order, 'id' | 'state' | 'notifyAttempts' | 'notifiedOk'>;

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
   * Заказы, требующие внимания фонового обходчика: «ожидает» без
   * ограничения по времени плюс «просрочен», но только те, что ещё
   * укладываются в окно поздних платежей (`createdAt + lateWindowSeconds
   * >= now`) — старые первыми. Безнадёжно просроченные заказы (окно уже
   * истекло) в выборку не попадают: иначе они навсегда занимают место в
   * `limit`, и фоновый обход, идущий от старых к новым, перестаёт
   * доходить до свежих заказов.
   */
  listPending(limit: number, lateWindowSeconds: number, now: number): Order[];
  updateState(id: number, state: OrderState, fields?: Partial<Order>): void;
  /** Фиксирует попытку уведомления продавца: её номер и исход. */
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
  signature       TEXT,
  notify_url      TEXT,
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
  signature: string | null;
  notify_url: string | null;
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
    signature: р.signature,
    notifyUrl: р.notify_url,
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
  signature: 'signature',
  notifyUrl: 'notify_url',
  notifyAttempts: 'notify_attempts',
  notifiedOk: 'notified_ok',
  customerEmail: 'customer_email',
  description: 'description',
  productsJson: 'products_json',
};

/** Является ли ошибка нарушением `UNIQUE` на колонке `tilda_order_id`. */
function этоДубльНомераTilda(е: unknown): boolean {
  return (
    е instanceof Error &&
    (е as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' &&
    е.message.includes('orders.tilda_order_id')
  );
}

/** Открывает (создаёт при отсутствии) файл базы и возвращает хранилище заказов. */
export function openDatabase(путь: string): Store {
  const db: БазаSQLite = new DatabaseSync(путь);

  // WAL — чтобы фоновый обходчик (задача 6) мог читать, пока HTTP-сервер
  // пишет, без блокировки всего файла; foreign_keys — на будущее, если
  // таблица заказов обрастёт связанными таблицами.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(СХЕМА);

  const вставить = db.prepare(`
    INSERT INTO orders (
      tilda_order_id, token, state, amount_kzt, amount_token, token_symbol,
      cluster, recipient, reference, rate, rate_source, payment_url,
      quote_json, created_at, expires_at, signature, notify_url,
      notify_attempts, notified_ok, customer_email, description, products_json
    ) VALUES (
      @tilda_order_id, @token, @state, @amount_kzt, @amount_token, @token_symbol,
      @cluster, @recipient, @reference, @rate, @rate_source, @payment_url,
      @quote_json, @created_at, @expires_at, @signature, @notify_url,
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
        signature: o.signature,
        notify_url: o.notifyUrl,
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

  function listPending(limit: number, lateWindowSeconds: number, now: number): Order[] {
    const строки = ожидающие.all(lateWindowSeconds, now, limit) as СтрокаЗаказа[];
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
    db.prepare('UPDATE orders SET notify_attempts = ?, notified_ok = ? WHERE id = ?').run(
      attempt,
      ok ? 1 : 0,
      id,
    );
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
