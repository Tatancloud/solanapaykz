# Оплата по уникальной сумме — план реализации

> **Для исполнителей:** ОБЯЗАТЕЛЬНЫЙ ПОДНАВЫК — superpowers:subagent-driven-development
> либо superpowers:executing-plans. Шаги отмечаются галочками `- [ ]`.

**Цель:** научить сервер Tilda опознавать платёж вторым способом — по сумме,
уникальной на каждый живой заказ, — чтобы платить могли кошельки, которые не
читают ссылку Solana Pay и потому не проставляют метку `reference`.

**Устройство:** при создании заказа сумма докручивается вверх по одной
минимальной единице токена, пока не станет свободной среди живых заказов, и
становится суммой заказа целиком (она же в QR). Отдельный сканер раз в минуту
читает новые поступления на кошелёк магазина через собственный тонкий клиент
JSON-RPC и ищет живой заказ с ровно такой суммой. Найденный платёж закрывает
заказ той же дорогой, что и платёж по метке: `decide()` → `применитьРешение`.
Не опознанные поступления складываются в отдельную таблицу и показываются в
админке.

**Технологии:** Node.js 22.13+, TypeScript 5.7, vitest 3.2, встроенный
`node:sqlite`, встроенный `fetch`, `@solanapaykz/core` (локальная ссылка
`file:..`). Новых зависимостей не добавляется.

**Спека:** `process/superpowers/specs/2026-09-17-oplata-po-unikalnoy-summe-design.md`
— читать вместе с этим планом.

## Глобальные ограничения

- Совпадение суммы — **только точное**, по целым минимальным единицам
  (лампорты для SOL, микро-USDC для USDC). Никакого допуска, никакого
  «примерно столько же».
- Суммы в минимальных единицах хранятся и сравниваются **строками**
  (`BigInt.toString()`), как и остальные деньги в проекте. Числа с плавающей
  точкой в деньгах не используются нигде.
- Докрутка суммы идёт **только вверх**: покупатель не должен платить меньше
  посчитанного.
- Одна транзакция закрывает **не более одного** заказа.
- Транзакция засчитывается заказу, только если она **не старше** заказа
  (`blockTime >= order.createdAt`).
- Переплата по сумме **не засчитывается** — идёт в неопознанные. Путь по
  метке (`checkPayment` в SDK) ведёт себя как прежде и не меняется.
- Весь способ целиком включается одной настройкой `enableAmountMatching`,
  по умолчанию **выключен**. При выключенной настройке нет ни докрутки сумм,
  ни сканера, ни блока с адресом на странице оплаты.
- Сбой сети или узла Solana **не меняет** состояние заказа и не двигает
  курсор сканера.
- Секреты и адрес узла (в нём ключ API) не попадают в журнал — пользоваться
  существующим `createLog` с маскировкой (`секретыНастроек` в `server.ts`).
- Тексты для покупателя, сообщения об ошибках, имена и комментарии — на
  русском, как во всём сервере.
- Страница оплаты отдаётся с `Content-Security-Policy: default-src 'self'` —
  встроенные `<script>` и `onclick` запрещены и молча не исполняются. Весь
  новый код страницы идёт в `public/checkout.js`.

**Рабочий каталог:** `tilda-server/` в корне репозитория (кроме задачи 1, где
меняется корневой пакет SDK).
**Тесты:** `npm test` внутри `tilda-server/`. Зависимости ставить командой
`npm install --include=dev` — на сервере `NODE_ENV=production`, и без флага
devDependencies молча не ставятся.
**Ветка:** вся работа в `feat/unique-amount` (уже создана, в ней лежит спека).
Коммит после каждой задачи.

---

### Задача 1: SDK — экспорт преобразования единиц и своя метка платежа

Серверу нужно переводить десятичную сумму заказа в целые минимальные единицы
и обратно. Эти функции уже есть в `@solanapaykz/core`, но наружу не выведены.
Повторять их в сервере нельзя — две копии одной формулы разойдутся, ровно это
уже находило ревью с `KZT_DECIMALS` (см. комментарий в `src/index.ts`).

Второе: `createPaymentRequest` сейчас сама генерирует метку платежа внутри и
отдаёт её в ответе. При подборе уникальной суммы порядок обратный — метка
нужна ДО того, как построена ссылка: заказ вставляется в базу первым (сумму
подбирает база), и только потом от подобранной суммы строится ссылка. Второй
вызов `createPaymentRequest` выдал бы НОВУЮ метку, разойдясь с той, что уже
записана в заказе, поэтому метку нужно уметь передать снаружи.

**Файлы:**
- Изменить: `src/index.ts`, `src/payment/request.ts`
- Тест: `tests/index.test.ts`, `tests/payment.test.ts`

**Интерфейсы:**
- Отдаёт наружу: `parseDecimalToUnits(value: string, decimals: number, options?: { allowTruncation?: boolean }): bigint`,
  `formatUnits(units: bigint, decimals: number): string`,
  `resolveToken(cluster: Cluster, token: TokenSymbol): TokenInfo`,
  `type TokenInfo = { readonly mint?: string; readonly decimals: number }`,
  `generateReference(): string`.
- Расширяет: `PaymentRequestOptions.reference?: string` — готовая метка;
  без неё поведение прежнее (метка генерируется внутри).

- [ ] **Шаг 1: тест на экспорт**

В `tests/index.test.ts` (создать, если файла нет):

```ts
import { describe, expect, it } from 'vitest';
import { formatUnits, parseDecimalToUnits, resolveToken } from '../src/index.js';

describe('публичные экспорты пакета', () => {
  it('переводят десятичную сумму в минимальные единицы и обратно', () => {
    expect(parseDecimalToUnits('0.002300000', 9)).toBe(2_300_000n);
    expect(formatUnits(2_300_001n, 9)).toBe('0.002300001');
  });

  it('отдают точность и mint токена по сети', () => {
    expect(resolveToken('mainnet', 'SOL').decimals).toBe(9);
    expect(resolveToken('mainnet', 'SOL').mint).toBeUndefined();
    expect(resolveToken('mainnet', 'USDC')).toEqual({
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
    });
  });
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запуск: `cd /var/www/solanapaykz && npx vitest run tests/index.test.ts`
Ожидается: FAIL — `formatUnits`/`parseDecimalToUnits`/`resolveToken` не
экспортируются из `src/index.js`.

- [ ] **Шаг 3: добавить экспорты**

В `src/index.ts`, рядом с существующим экспортом `KZT_DECIMALS`:

```ts
/**
 * Преобразование десятичной суммы в целые минимальные единицы токена и
 * обратно — публичный экспорт по той же причине, что и `KZT_DECIMALS`
 * выше: сервер Tilda сравнивает суммы поступлений с суммами заказов в
 * целых единицах (оплата по уникальной сумме), и вторая копия этой
 * формулы у него молча разошлась бы с этой.
 */
export { formatUnits, parseDecimalToUnits } from './money.js';
/**
 * Точность и mint токена в конкретной сети — нужны тому же сравнению:
 * лампорты и микро-USDC считаются по `decimals`, а поступления USDC
 * ищутся по `mint` токен-аккаунта получателя.
 */
export { resolveToken } from './config.js';
export type { TokenInfo } from './config.js';
```

- [ ] **Шаг 4: тест на готовую метку платежа**

В `tests/payment.test.ts`:

```ts
it('использует переданную метку, а не генерирует свою', async () => {
  const метка = generateReference();
  const запрос = await createPaymentRequest(котировка(), {
    recipient: 'A4dSmSbNkJbPxnv3k3BH351xZm5iwvpubqevDHAaBM4P',
    reference: метка,
  });

  expect(запрос.reference).toBe(метка);
  expect(запрос.url).toContain(`reference=${метка}`);
});

it('без переданной метки генерирует свою, как раньше', async () => {
  const первый = await createPaymentRequest(котировка(), { recipient: 'A4dSmSbNkJbPxnv3k3BH351xZm5iwvpubqevDHAaBM4P' });
  const второй = await createPaymentRequest(котировка(), { recipient: 'A4dSmSbNkJbPxnv3k3BH351xZm5iwvpubqevDHAaBM4P' });

  expect(первый.reference).not.toBe(второй.reference);
});
```

- [ ] **Шаг 5: реализовать готовую метку**

В `src/payment/request.ts`:

```ts
// в PaymentRequestOptions, после recipient:
  /**
   * Готовая метка платежа. Нужна тем, кто записывает метку в свой заказ
   * РАНЬШЕ, чем строит ссылку, — например, серверу Tilda с оплатой по
   * уникальной сумме: там заказ вставляется в базу первым (сумму
   * подбирает база), и второй вызов с собственной меткой разошёлся бы с
   * той, что уже записана в заказе. Без этого поля метка, как и прежде,
   * создаётся внутри.
   */
  reference?: string;
```

```ts
// вместо безусловной генерации:
  const reference = options.reference ?? generateReference();
```

Невалидную переданную метку `address(reference)` ниже по коду отвергнет сам —
отдельной проверки не нужно, но убедиться, что ошибка приводится к
`ConfigError`, как у `recipient`.

В `src/index.ts` добавить экспорт:

```ts
export { generateReference } from './payment/request.js';
```

- [ ] **Шаг 6: тесты и сборка**

Запуск: `cd /var/www/solanapaykz && npm test && npm run build`
Ожидается: PASS, сборка без ошибок.

- [ ] **Шаг 7: коммит**

```bash
cd /var/www/solanapaykz
git add src tests
git commit -m "feat(sdk): преобразование единиц наружу и готовая метка платежа опцией"
```

---

### Задача 2: настройка `enableAmountMatching`

**Файлы:**
- Изменить: `tilda-server/src/config.ts` (интерфейс `Config`, `ИЗВЕСТНЫЕ_КЛЮЧИ`,
  `ПО_УМОЛЧАНИЮ`, разбор, возвращаемый объект)
- Изменить: `tilda-server/config.example.json`
- Тест: `tilda-server/tests/config.test.ts`

**Интерфейсы:**
- Потребляет: ничего.
- Отдаёт: `Config.enableAmountMatching: boolean` (по умолчанию `false`).

- [ ] **Шаг 1: написать падающий тест**

В `tilda-server/tests/config.test.ts` добавить:

```ts
describe('enableAmountMatching', () => {
  it('по умолчанию выключен', () => {
    expect(loadConfig(минимальныеНастройки()).enableAmountMatching).toBe(false);
  });

  it('принимает true', () => {
    const c = loadConfig({ ...минимальныеНастройки(), enableAmountMatching: true });
    expect(c.enableAmountMatching).toBe(true);
  });

  it('отвергает не-булево значение', () => {
    expect(() => loadConfig({ ...минимальныеНастройки(), enableAmountMatching: 'да' })).toThrow(
      /enableAmountMatching/,
    );
  });
});
```

`минимальныеНастройки()` — уже существующий в этом файле помощник; если он
называется иначе, использовать тот, которым пользуются соседние тесты.

- [ ] **Шаг 2: убедиться, что тест падает**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/config.test.ts -t enableAmountMatching`
Ожидается: FAIL — поля нет, а неизвестный ключ отвергается проверкой опечаток.

- [ ] **Шаг 3: реализовать**

В `src/config.ts`:

```ts
// в интерфейс Config, рядом с enableFormWebhook:
  /**
   * Оплата по уникальной сумме: докрутка суммы заказа до неповторимой,
   * наблюдение за поступлениями на кошелёк магазина и показ адреса с
   * суммой на странице оплаты. Три части одного способа, поэтому одна
   * настройка: докрутка без наблюдения бесполезна, а показ адреса без
   * наблюдения вреден — покупатель отправит деньги, которых никто не
   * ждёт.
   *
   * По умолчанию выключено. При включении кошелёк магазина стоит держать
   * только под магазин: сервер смотрит на ВСЕ поступления адреса, и
   * посторонние переводы лягут в список неопознанных.
   */
  enableAmountMatching: boolean;
```

```ts
// в ИЗВЕСТНЫЕ_КЛЮЧИ — после 'enableFormWebhook':
  'enableAmountMatching',
```

```ts
// в ПО_УМОЛЧАНИЮ — после enableFormWebhook:
  enableAmountMatching: false,
```

```ts
// разбор — сразу после блока enableFormWebhook:
  // --- enableAmountMatching ---
  let enableAmountMatching: boolean = ПО_УМОЛЧАНИЮ.enableAmountMatching;
  if (raw.enableAmountMatching !== undefined) {
    if (typeof raw.enableAmountMatching === 'boolean') {
      enableAmountMatching = raw.enableAmountMatching;
    } else {
      проблемы.push('enableAmountMatching: должен быть true или false');
    }
  }
```

```ts
// в возвращаемый объект — после enableFormWebhook:
    enableAmountMatching,
```

- [ ] **Шаг 4: прогнать тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/config.test.ts`
Ожидается: PASS.

- [ ] **Шаг 5: описать настройку в примере**

В `tilda-server/config.example.json` перед закрывающей скобкой:

```json
  "_комментарий_сумма": "Оплата по уникальной сумме — запасной способ опознать платёж для кошельков и бирж, которые не читают ссылку Solana Pay и не проставляют метку платежа. При включении сумма каждого заказа докручивается вверх на несколько минимальных единиц токена до неповторимой, страница оплаты показывает адрес и точную сумму, а сервер следит за поступлениями на кошелёк магазина и опознаёт платёж по сумме. ВАЖНО: кошелёк магазина при этом стоит держать ТОЛЬКО под магазин — сервер смотрит на все поступления адреса, и посторонние переводы попадут в список неопознанных (а при совпадении суммы до последнего знака могут закрыть чужой заказ). Биржи удерживают комиссию из суммы перевода, поэтому платёж с биржи почти всегда приходит меньше ожидаемого и в список неопознанных. По умолчанию выключено.",
  "enableAmountMatching": false
```

- [ ] **Шаг 6: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src/config.ts tilda-server/tests/config.test.ts tilda-server/config.example.json
git commit -m "feat(tilda): настройка enableAmountMatching, по умолчанию выключена"
```

---

### Задача 3: схема базы версии 5 и механизм миграций

Сейчас `openDatabase` при чужой версии просто отказывается открывать файл:
миграций не писали, потому что боевой базы не было. Она есть
(`/app/tilda-server/data/orders.sqlite` в контейнере), поэтому механизм
миграций появляется здесь.

**Файлы:**
- Изменить: `tilda-server/src/db.ts` (`СХЕМА`, `ВЕРСИЯ_СХЕМЫ`, `openDatabase`,
  `Order`, `NewOrder`, `СтрокаЗаказа`, отображение строки в заказ)
- Тест: `tilda-server/tests/db.test.ts`

**Интерфейсы:**
- Потребляет: `parseDecimalToUnits`, `resolveToken` из задачи 1.
- Отдаёт: `Order.amountUnits: string`, `Order.uniqueAmount: 0 | 1`; таблицы
  `matched_signatures`, `unmatched_receipts`, `scan_state`; версия схемы 5;
  функция `мигрировать(db, изВерсии)` внутри `db.ts` (не экспортируется).

- [ ] **Шаг 1: написать падающий тест миграции**

В `tilda-server/tests/db.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';

it('переносит базу версии 4 в версию 5, не теряя заказов', () => {
  const путь = `${каталогДляТестов()}/старая.sqlite`;

  // База версии 4 — ровно та схема, что была до этой задачи.
  const старая = new DatabaseSync(путь);
  старая.exec(СХЕМА_ВЕРСИИ_4);
  старая.exec(`
    INSERT INTO orders (
      tilda_order_id, token, state, amount_kzt, currency, amount_token, token_symbol,
      cluster, recipient, reference, rate, rate_source, payment_url, quote_json,
      created_at, expires_at, test_mode, notify_attempts, notified_ok
    ) VALUES (
      'T-1', '${'a'.repeat(32)}', 'ожидает', '90.00', 'KZT', '0.000420000', 'SOL',
      'mainnet', 'A4dSmSbNkJbPxnv3k3BH351xZm5iwvpubqevDHAaBM4P', 'Ref111', '210000.00',
      'binance', 'solana:...', '{}', 1000, 2000, 0, 0, 0
    )
  `);
  старая.exec('PRAGMA user_version = 4');
  старая.close();

  const store = openDatabase(путь);
  const заказ = store.findByTildaOrderId('T-1');

  expect(заказ).not.toBeNull();
  // 0.000420000 SOL = 420 000 лампортов — посчитано при миграции из amount_token.
  expect(заказ?.amountUnits).toBe('420000');
  expect(заказ?.uniqueAmount).toBe(0);
});
```

`СХЕМА_ВЕРСИИ_4` — константа теста: скопировать в неё текущий текст `СХЕМА`
из `src/db.ts` ДО правок этой задачи (обе таблицы, `orders` и
`admin_session`, и индекс). Копия намеренная: тест обязан проверять переход
с реальной старой схемы, а не с той, что получится после правок.

- [ ] **Шаг 2: убедиться, что тест падает**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/db.test.ts -t "версии 4"`
Ожидается: FAIL — `openDatabase` бросает «создана версией схемы 4, а сервер
ожидает версию 4» либо, после смены константы, «…ожидает версию 5. Миграций
пока нет».

- [ ] **Шаг 3: расширить схему**

В `src/db.ts`, в константу `СХЕМА`, добавить к `orders` две колонки и три
новые таблицы:

```sql
-- в CREATE TABLE orders, после amount_token:
  amount_units    TEXT    NOT NULL DEFAULT '0',
  unique_amount   INTEGER NOT NULL DEFAULT 0,
```

```sql
-- Сумма заказа в целых минимальных единицах токена строкой: сравнение
-- десятичных строк («0.0023» и «0.00230» — одно число и две разные
-- строки) не годится ни для проверки уникальности, ни для сопоставления
-- с поступлением. Уникальный индекс — частичный, только по живым
-- состояниям: сумма закрытого заказа свободна и может достаться новому.
CREATE UNIQUE INDEX IF NOT EXISTS orders_amount_units_live
  ON orders (amount_units, token_symbol, cluster)
  WHERE unique_amount = 1
    AND state IN ('ожидает', 'просрочен', 'не сошлось');

-- Транзакции, уже закрывшие какой-то заказ. Первичный ключ по подписи —
-- единственная настоящая защита от того, что одна транзакция закроет два
-- заказа: проверка «есть ли уже такая» перед записью оставляет гонку.
CREATE TABLE IF NOT EXISTS matched_signatures (
  signature   TEXT    NOT NULL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders (id),
  matched_at  INTEGER NOT NULL
);

-- Поступления на кошелёк магазина, не подошедшие ни одному заказу.
-- Продавец видит их в списке заказов: это чужие деньги, и молчать о них
-- нельзя.
CREATE TABLE IF NOT EXISTS unmatched_receipts (
  signature     TEXT    NOT NULL PRIMARY KEY,
  amount_units  TEXT    NOT NULL,
  token_symbol  TEXT    NOT NULL,
  block_time    INTEGER,
  reason        TEXT    NOT NULL,
  seen_at       INTEGER NOT NULL,
  mailed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS unmatched_seen ON unmatched_receipts (seen_at DESC);

-- Одна строка на весь сервер: докуда сканер разобрал историю поступлений.
-- CHECK(id = 1) — по образцу admin_session: вторая строка была бы
-- бессмысленной и молча перестала бы на что-либо влиять.
CREATE TABLE IF NOT EXISTS scan_state (
  id              INTEGER NOT NULL CHECK (id = 1),
  last_signature  TEXT,
  last_block_time INTEGER,
  PRIMARY KEY (id)
);
INSERT OR IGNORE INTO scan_state (id, last_signature, last_block_time) VALUES (1, NULL, NULL);
```

- [ ] **Шаг 4: поднять версию и написать миграцию**

```ts
/**
 * Версия 5 (была 4): оплата по уникальной сумме — колонки
 * `amount_units`/`unique_amount` у заказа и таблицы `matched_signatures`,
 * `unmatched_receipts`, `scan_state`. Боевая база с заказами к этому
 * моменту УЖЕ существует (сервер работает на pay.kabyldau.digital),
 * поэтому здесь впервые появляется настоящая миграция, а не отказ
 * открывать файл чужой версии.
 */
const ВЕРСИЯ_СХЕМЫ = 5;

/**
 * Переносит открытый файл базы с версии `изВерсии` на `ВЕРСИЯ_СХЕМЫ`.
 *
 * Всё — одной транзакцией: половина применённой миграции хуже, чем
 * отказ стартовать, потому что следующая попытка увидит базу в
 * состоянии, которого нет ни в одной версии.
 *
 * `amount_units` существующим заказам считается здесь же, из
 * `amount_token` и точности их собственного токена: в SQL этого не
 * сделать, а оставить пустым нельзя — сопоставление по сумме молча
 * промахивалось бы мимо старых заказов.
 */
function мигрировать(db: БазаSQLite, изВерсии: number): void {
  if (изВерсии !== 4) {
    throw new Error(
      `Не умею переносить базу с версии ${изВерсии} на ${ВЕРСИЯ_СХЕМЫ}. ` +
        'Обновляйте сервер последовательно, не перепрыгивая версии.',
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE orders ADD COLUMN amount_units TEXT NOT NULL DEFAULT '0'`);
    db.exec('ALTER TABLE orders ADD COLUMN unique_amount INTEGER NOT NULL DEFAULT 0');
    // Новые таблицы и индексы добавляет общая СХЕМА ниже по коду
    // (`CREATE ... IF NOT EXISTS`), повторять их здесь нельзя: две копии
    // одного DDL разойдутся.
    const заказы = db.prepare('SELECT id, amount_token, token_symbol, cluster FROM orders').all() as Array<{
      id: number;
      amount_token: string;
      token_symbol: string;
      cluster: string;
    }>;
    const обновить = db.prepare('UPDATE orders SET amount_units = ? WHERE id = ?');
    for (const з of заказы) {
      const { decimals } = resolveToken(з.cluster as Cluster, з.token_symbol as TokenSymbol);
      обновить.run(parseDecimalToUnits(з.amount_token, decimals).toString(), з.id);
    }
    db.exec(`PRAGMA user_version = ${ВЕРСИЯ_СХЕМЫ}`);
    db.exec('COMMIT');
  } catch (е) {
    db.exec('ROLLBACK');
    throw new Error(`Миграция базы с версии ${изВерсии} на ${ВЕРСИЯ_СХЕМЫ} не удалась: ${(е as Error).message}`);
  }
}
```

В `openDatabase` заменить отказ на вызов миграции:

```ts
  if (версияБазы !== 0 && версияБазы !== ВЕРСИЯ_СХЕМЫ) {
    try {
      мигрировать(db, версияБазы);
    } catch (е) {
      db.close();
      throw е;
    }
  }
```

Импорт в начале файла:

```ts
import { parseDecimalToUnits, resolveToken } from '@solanapaykz/core';
```

- [ ] **Шаг 5: добавить поля в `Order` и отображение строки**

```ts
// в интерфейс Order, после amountToken:
  /**
   * Сумма заказа в целых минимальных единицах токена, строкой
   * (`BigInt.toString()`). По ней идёт сопоставление поступления с
   * заказом и проверка уникальности: сравнивать десятичные строки нельзя
   * — «0.0023» и «0.00230» это одно число и две разные строки.
   */
  amountUnits: string;
  /**
   * 1, если сумма заказа уникальна среди живых заказов, и платёж по ней
   * можно опознать без метки. 0 — если уникальную сумму подобрать не
   * удалось (исчерпан потолок докрутки) либо способ был выключен при
   * создании заказа: такому заказу страница покажет только QR.
   */
  uniqueAmount: 0 | 1;
```

В `СтрокаЗаказа` добавить `amount_units: string; unique_amount: number;`, в
отображение строки в заказ — `amountUnits: р.amount_units,
uniqueAmount: р.unique_amount === 1 ? 1 : 0,`, в карту имён колонок —
`amountUnits: 'amount_units', uniqueAmount: 'unique_amount',`, а в
`INSERT` — обе колонки и оба параметра.

- [ ] **Шаг 6: прогнать тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npm test`
Ожидается: PASS, включая новый тест миграции. Существующие тесты, создающие
заказы, потребуют полей `amountUnits`/`uniqueAmount` в `NewOrder` — добавить
их в помощники тестов, а не ослаблять типы.

- [ ] **Шаг 7: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src/db.ts tilda-server/tests/db.test.ts
git commit -m "feat(tilda): схема версии 5 и первая настоящая миграция базы"
```

---

### Задача 4: подбор уникальной суммы при создании заказа

**Файлы:**
- Изменить: `tilda-server/src/db.ts` (метод `createOrder`)
- Изменить: `tilda-server/src/tilda/inbound.ts` (создание заказа)
- Тест: `tilda-server/tests/db.test.ts`, `tilda-server/tests/inbound.test.ts`

**Интерфейсы:**
- Потребляет: `Order.amountUnits`, `Order.uniqueAmount` (задача 3).
- Отдаёт: `Store.createOrder(o: NewOrder, подбор?: ПодборСуммы): Order`, где

```ts
export interface ПодборСуммы {
  /** Сколько минимальных единиц можно добавить сверх посчитанной суммы. */
  потолокДобавки: number;
  /** Точность токена — чтобы вернуть десятичную сумму заказа пересчитанной. */
  decimals: number;
}
```

Подбор идёт внутри той же транзакции, что и вставка заказа: `createOrder` с
`подбор` пробует вставить заказ с суммой `amountUnits`, `amountUnits + 1`, …
и останавливается на первой, которую приняла база. Уникальность держит
частичный индекс `orders_amount_units_live` (задача 3), а не проверка
«свободна ли» перед вставкой: между проверкой и вставкой — гонка.

- [ ] **Шаг 1: написать падающий тест**

```ts
it('подбирает свободную сумму, когда посчитанная занята живым заказом', () => {
  const store = openDatabase(':memory:');
  const первый = store.createOrder(заказНа('T-1', { amountUnits: '420000', uniqueAmount: 1 }), {
    потолокДобавки: 10_000,
    decimals: 9,
  });
  const второй = store.createOrder(заказНа('T-2', { amountUnits: '420000', uniqueAmount: 1 }), {
    потолокДобавки: 10_000,
    decimals: 9,
  });

  expect(первый.amountUnits).toBe('420000');
  expect(второй.amountUnits).toBe('420001');
  // Десятичная сумма заказа пересчитана из подобранных единиц — покупателю
  // показывается ровно то, что ждёт сопоставление.
  expect(второй.amountToken).toBe('0.000420001');
  expect(второй.uniqueAmount).toBe(1);
});

it('освобождает сумму, когда заказ закрыт', () => {
  const store = openDatabase(':memory:');
  const первый = store.createOrder(заказНа('T-1', { amountUnits: '420000', uniqueAmount: 1 }), подбор());
  store.updateState(первый.id, 'уведомлён');
  const второй = store.createOrder(заказНа('T-2', { amountUnits: '420000', uniqueAmount: 1 }), подбор());

  expect(второй.amountUnits).toBe('420000');
});

it('при исчерпании потолка заводит заказ без уникальной суммы', () => {
  const store = openDatabase(':memory:');
  store.createOrder(заказНа('T-1', { amountUnits: '420000', uniqueAmount: 1 }), { потолокДобавки: 0, decimals: 9 });
  const второй = store.createOrder(заказНа('T-2', { amountUnits: '420000', uniqueAmount: 1 }), {
    потолокДобавки: 0,
    decimals: 9,
  });

  expect(второй.uniqueAmount).toBe(0);
  expect(второй.amountUnits).toBe('420000');
});
```

`заказНа(номер, поля)` и `подбор()` — помощники этого файла; если таких нет,
написать рядом с существующими помощниками теста.

- [ ] **Шаг 2: убедиться, что тест падает**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/db.test.ts -t "свободную сумму"`
Ожидается: FAIL — `createOrder` принимает один аргумент и суммы не подбирает.

- [ ] **Шаг 3: реализовать подбор**

В `src/db.ts`, в `createOrder`:

```ts
  function createOrder(o: NewOrder, подбор?: ПодборСуммы): Order {
    if (!подбор || o.uniqueAmount !== 1) {
      return вставитьЗаказ(o);
    }

    const база = BigInt(o.amountUnits);
    for (let добавка = 0; добавка <= подбор.потолокДобавки; добавка += 1) {
      const units = база + BigInt(добавка);
      try {
        return вставитьЗаказ({
          ...o,
          amountUnits: units.toString(),
          amountToken: formatUnits(units, подбор.decimals),
        });
      } catch (е) {
        if (этоЗанятаяСумма(е)) continue;
        throw е;
      }
    }

    // Потолок исчерпан — заводим заказ без уникальной суммы. Отказать
    // покупателю в оплате из-за нехватки лампортов было бы хуже: платёж
    // по метке (QR) у такого заказа работает как прежде.
    return вставитьЗаказ({ ...o, uniqueAmount: 0 });
  }

/** Нарушение частичного уникального индекса сумм — не дубль номера Tilda. */
function этоЗанятаяСумма(е: unknown): boolean {
  return (
    этоОшибкаSQLite(е) &&
    е.errcode === SQLITE_CONSTRAINT_UNIQUE &&
    е.message.includes('orders.amount_units')
  );
}
```

`вставитьЗаказ` — существующее тело `createOrder` (вставка + чтение
записанной строки), вынесенное во вложенную функцию без изменений.

- [ ] **Шаг 4: прогнать тесты базы**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/db.test.ts`
Ожидается: PASS.

- [ ] **Шаг 5: подключить подбор к созданию заказа**

В `src/tilda/inbound.ts`, в месте создания заказа (сейчас: `createQuote` →
`createPaymentRequest` → `store.createOrder`):

```ts
  const quote = await deps.client.createQuote({ amountKzt: order.amountKzt, token: deps.config.token });
  const { decimals } = resolveToken(quote.cluster, quote.token);

  // Заказ заводится ПЕРЕД построением ссылки: уникальную сумму подбирает
  // база (частичный индекс), и до вставки неизвестно, какая сумма
  // досталась этому заказу. Ссылка и QR строятся от суммы, поэтому
  // дописываются следующим шагом.
  // Метка платежа создаётся здесь, а не внутри createPaymentRequest
  // (задача 1): заказ вставляется первым, потому что уникальную сумму
  // подбирает база, а ссылка строится от подобранной суммы. Второй вызов
  // createPaymentRequest со своей меткой разошёлся бы с меткой заказа.
  const reference = generateReference();

  const черновик: NewOrder = {
    // Поля ниже — без изменений, ровно как в нынешнем `новыйЗаказ`:
    tildaOrderId: order.orderId,
    token: randomBytes(16).toString('hex'),
    amountKzt: quote.amountKzt,
    currency: order.currency,
    tokenSymbol: quote.token,
    cluster: quote.cluster,
    recipient: deps.config.recipient,
    rate: quote.rate,
    rateSource: quote.rateSource,
    createdAt: Math.floor(Date.parse(quote.createdAt) / 1000),
    expiresAt: Math.floor(Date.parse(quote.expiresAt) / 1000),
    testMode: order.testMode,
    tildaSignature: order.signature,
    txSignature: null,
    customerEmail: order.email,
    description: order.description,
    productsJson: order.products ? JSON.stringify(order.products) : null,
    // Новое и изменённое:
    amountToken: quote.amountToken,
    amountUnits: parseDecimalToUnits(quote.amountToken, decimals).toString(),
    uniqueAmount: deps.config.enableAmountMatching ? 1 : 0,
    reference,
    paymentUrl: '',                    // достраивается ниже
    quoteJson: JSON.stringify(quote),
  };

  const заказ = deps.store.createOrder(черновик, {
    потолокДобавки: ПОТОЛОК_ДОБАВКИ_ЕДИНИЦ,
    decimals,
  });

  // Сумма могла измениться при подборе — ссылка строится от суммы заказа,
  // а не от суммы котировки, иначе QR просил бы не ту сумму, что ждёт
  // сопоставление.
  const paymentRequest = await deps.client.createPaymentRequest(
    { ...quote, amountToken: заказ.amountToken },
    {
      label: deps.config.shopName || 'Оплата заказа',
      message: `Заказ №${order.orderId}`,
      reference: заказ.reference,
    },
  );
  deps.store.updateState(заказ.id, заказ.state, {
    paymentUrl: paymentRequest.url,
    quoteJson: JSON.stringify({ ...quote, amountToken: заказ.amountToken }),
  });
  return { ...заказ, paymentUrl: paymentRequest.url };
```

**Про пустой `paymentUrl` между вставкой и правкой.** Окно между
`createOrder` и записью ссылки — доли секунды внутри одного обработчика
запроса, но падение процесса ровно в нём оставило бы заказ без ссылки.
Страница оплаты это чинит сама: в `routes-page.ts` перед показом проверить
`order.paymentUrl === ''` и достроить ссылку тем же вызовом
`createPaymentRequest` с меткой и суммой заказа, записав результат. Именно
достроить, а не завести заново: метка и сумма у заказа уже есть, и они —
единственное, что делает ссылку правильной.

Константа рядом с другими в `inbound.ts`:

```ts
/**
 * Сколько минимальных единиц токена разрешено добавить сверх посчитанной
 * суммы, подбирая неповторимую (спека, §4). Десять тысяч лампортов — это
 * 0,00001 SOL, доли тиына; исчерпать их значит держать больше десяти
 * тысяч живых заказов с одинаковой ценой.
 */
const ПОТОЛОК_ДОБАВКИ_ЕДИНИЦ = 10_000;
```

- [ ] **Шаг 6: тест на создание заказа с уникальной суммой**

В `tests/inbound.test.ts`:

```ts
it('при включённом способе заводит заказ с уникальной суммой и ссылкой на неё', async () => {
  const deps = зависимостиСоСпособом({ enableAmountMatching: true });
  const первый = await createPaymentFor(заказTilda('T-1', '90.00'), deps);
  const второй = await createPaymentFor(заказTilda('T-2', '90.00'), deps);

  expect(первый.amountUnits).not.toBe(второй.amountUnits);
  expect(второй.paymentUrl).toContain(`amount=${второй.amountToken}`);
  expect(второй.uniqueAmount).toBe(1);
});

it('при выключенном способе суммы не докручиваются', async () => {
  const deps = зависимостиСоСпособом({ enableAmountMatching: false });
  const первый = await createPaymentFor(заказTilda('T-1', '90.00'), deps);
  const второй = await createPaymentFor(заказTilda('T-2', '90.00'), deps);

  expect(первый.amountUnits).toBe(второй.amountUnits);
  expect(второй.uniqueAmount).toBe(0);
});
```

- [ ] **Шаг 7: прогнать все тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npm test`
Ожидается: PASS.

- [ ] **Шаг 8: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src tilda-server/tests
git commit -m "feat(tilda): уникальная сумма заказа подбирается базой при создании"
```

---

### Задача 5: блок «адрес и сумма» на странице оплаты

Решение заказчика: блок показывается сразу всем, рядом с QR (спека, §2).
Только при включённом способе и только у заказа с `uniqueAmount = 1`.

**Файлы:**
- Изменить: `tilda-server/src/http/html.ts` (`страницаОплаты`)
- Изменить: `tilda-server/src/http/routes-page.ts` (передать признак способа)
- Изменить: `tilda-server/public/checkout.js` (кнопки «скопировать»)
- Тест: `tilda-server/tests/http.test.ts`

**Интерфейсы:**
- Потребляет: `Config.enableAmountMatching` (задача 2), `Order.uniqueAmount`
  (задача 3).
- Отдаёт: `страницаОплаты(order, секундОсталось, qrSvg, показатьАдрес: boolean)`.

- [ ] **Шаг 1: написать падающий тест**

```ts
it('показывает адрес и точную сумму, когда способ включён', async () => {
  const ответ = await открытьСтраницуОплаты({ enableAmountMatching: true, uniqueAmount: 1 });

  expect(ответ.body).toContain('A4dSmSbNkJbPxnv3k3BH351xZm5iwvpubqevDHAaBM4P');
  expect(ответ.body).toContain('ровно эту сумму');
  expect(ответ.body).toContain('data-copy="amount"');
});

it('не показывает адрес, когда способ выключен', async () => {
  const ответ = await открытьСтраницуОплаты({ enableAmountMatching: false, uniqueAmount: 0 });

  expect(ответ.body).not.toContain('A4dSmSbNkJbPxnv3k3BH351xZm5iwvpubqevDHAaBM4P');
});
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/http.test.ts -t "адрес"`
Ожидается: FAIL — блока нет.

- [ ] **Шаг 3: реализовать блок**

В `src/http/html.ts`, в `страницаОплаты`, после блока с QR:

```ts
  // Показывается только при включённом способе и только заказу с
  // подобранной уникальной суммой: без наблюдения за поступлениями
  // перевод по адресу никто не опознает, и приглашать к нему покупателя
  // значит приглашать отправить деньги в никуда.
  const блокАдреса = показатьАдрес
    ? `
  <details class="solanapaykz__manual" open>
    <summary>Кошелёк не читает код QR? Переведите вручную</summary>
    <p class="solanapaykz__warn">
      Сумму нужно отправить <strong>ровно эту сумму</strong>, до последнего знака —
      по ней платёж и опознаётся. Перевод на другую сумму придётся разбирать вручную.
    </p>
    <p class="solanapaykz__field">
      <span class="solanapaykz__label">Адрес:</span>
      <code id="solanapaykz-address">${экранироватьHtml(order.recipient)}</code>
      <button type="button" class="solanapaykz__copy" data-copy="address"
              data-target="solanapaykz-address">Скопировать</button>
    </p>
    <p class="solanapaykz__field">
      <span class="solanapaykz__label">Сумма:</span>
      <code id="solanapaykz-amount">${экранироватьHtml(order.amountToken)}</code>
      <span>${экранироватьHtml(order.tokenSymbol)}</span>
      <button type="button" class="solanapaykz__copy" data-copy="amount"
              data-target="solanapaykz-amount">Скопировать</button>
    </p>
    <p class="solanapaykz__hint">Сеть: Solana ${экранироватьHtml(order.cluster === 'mainnet' ? 'основная' : 'тестовая (devnet)')}.</p>
  </details>`
    : '';
```

Вставить `${блокАдреса}` в разметку сразу после `solanapaykz__hint` с текстом
про сканирование, до таймера.

- [ ] **Шаг 4: передать признак**

В `src/http/routes-page.ts`, в месте вызова `страницаОплаты`:

```ts
  const показатьАдрес = deps.config.enableAmountMatching && заказ.uniqueAmount === 1;
  ответ = страницаОплаты(заказ, секундОсталосьСейчас(заказ), qrSvg, показатьАдрес);
```

- [ ] **Шаг 5: кнопки «скопировать»**

В `public/checkout.js` (встроенный скрипт запрещён политикой CSP — см.
глобальные ограничения):

```js
// Копирование адреса и суммы. navigator.clipboard доступен только на
// https или localhost; страница оплаты всегда https, но на случай отказа
// (запрет в настройках браузера) остаётся выделение текста — поэтому при
// ошибке подсказываем выделить вручную, а не молчим.
document.querySelectorAll('.solanapaykz__copy').forEach(function (кнопка) {
  кнопка.addEventListener('click', function () {
    var поле = document.getElementById(кнопка.dataset.target);
    if (!поле) return;
    var текст = поле.textContent.trim();
    var готово = function () {
      var было = кнопка.textContent;
      кнопка.textContent = 'Скопировано';
      setTimeout(function () { кнопка.textContent = было; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(текст).then(готово, function () {
        кнопка.textContent = 'Выделите и скопируйте вручную';
      });
    } else {
      кнопка.textContent = 'Выделите и скопируйте вручную';
    }
  });
});
```

- [ ] **Шаг 6: прогнать тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npm test`
Ожидается: PASS.

- [ ] **Шаг 7: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src/http tilda-server/public/checkout.js tilda-server/tests/http.test.ts
git commit -m "feat(tilda): адрес и точная сумма на странице оплаты"
```

---

### Задача 6: тонкий клиент JSON-RPC

**Файлы:**
- Создать: `tilda-server/src/solana-rpc.ts`
- Тест: `tilda-server/tests/solana-rpc.test.ts`

**Интерфейсы:**
- Отдаёт:

```ts
export interface ПодписьВИстории {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

export interface SolanaRpc {
  /** Подписи по адресу, от новых к старым. `until` — до какой уже разобранной подписи. */
  getSignaturesForAddress(адрес: string, params: { limit: number; until?: string }): Promise<ПодписьВИстории[]>;
  /** Транзакция в разборе jsonParsed либо `null`, если узел ещё не раздаёт её тело. */
  getTransaction(signature: string): Promise<ТранзакцияJson | null>;
  /** Адреса токен-аккаунтов владельца по этому mint (для USDC). */
  getTokenAccountsByOwner(владелец: string, mint: string): Promise<string[]>;
}

export function создатьRpc(url: string, fetchФн?: typeof fetch): SolanaRpc;

/**
 * Положительное изменение баланса наблюдаемого адреса в этой транзакции, в
 * целых минимальных единицах строкой; `null`, если поступления не было.
 */
export function поступлениеИзТранзакции(
  tx: ТранзакцияJson,
  параметры: { адрес: string; mint?: string },
): string | null;
```

- [ ] **Шаг 1: написать падающие тесты**

```ts
import { describe, expect, it } from 'vitest';
import { поступлениеИзТранзакции, создатьRpc } from '../src/solana-rpc.js';

describe('поступлениеИзТранзакции', () => {
  it('видит приход SOL как разницу балансов адреса', () => {
    const tx = {
      meta: { err: null, preBalances: [1_000_000_000, 500_000], postBalances: [999_000_000, 920_000], preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: 'Покупатель' }, { pubkey: 'Магазин' }] } },
      blockTime: 1_700_000_000,
    };

    expect(поступлениеИзТранзакции(tx as never, { адрес: 'Магазин' })).toBe('420000');
  });

  it('не считает поступлением уход средств', () => {
    const tx = {
      meta: { err: null, preBalances: [920_000], postBalances: [500_000], preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: 'Магазин' }] } },
      blockTime: 1,
    };

    expect(поступлениеИзТранзакции(tx as never, { адрес: 'Магазин' })).toBeNull();
  });

  it('видит приход USDC по владельцу и mint', () => {
    const tx = {
      meta: {
        err: null,
        preBalances: [], postBalances: [],
        preTokenBalances: [{ owner: 'Магазин', mint: 'USDCmint', uiTokenAmount: { amount: '1000000' } }],
        postTokenBalances: [{ owner: 'Магазин', mint: 'USDCmint', uiTokenAmount: { amount: '1180000' } }],
      },
      transaction: { message: { accountKeys: [] } },
      blockTime: 1,
    };

    expect(поступлениеИзТранзакции(tx as never, { адрес: 'Магазин', mint: 'USDCmint' })).toBe('180000');
  });

  it('пропускает провалившуюся транзакцию', () => {
    const tx = {
      meta: { err: { InstructionError: [0, 'Custom'] }, preBalances: [0], postBalances: [420_000], preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: 'Магазин' }] } },
      blockTime: 1,
    };

    expect(поступлениеИзТранзакции(tx as never, { адрес: 'Магазин' })).toBeNull();
  });
});

describe('создатьRpc', () => {
  it('шлёт один JSON-RPC запрос и отдаёт результат', async () => {
    const вызовы: Array<{ method: string; params: unknown }> = [];
    const подменаFetch = (async (_url: string, опции: { body: string }) => {
      const тело = JSON.parse(опции.body);
      вызовы.push({ method: тело.method, params: тело.params });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ signature: 'ПодписьA', blockTime: 5, err: null }] }));
    }) as unknown as typeof fetch;

    const rpc = создатьRpc('https://узел.invalid', подменаFetch);
    const подписи = await rpc.getSignaturesForAddress('Магазин', { limit: 100, until: 'ПодписьБ' });

    expect(подписи).toEqual([{ signature: 'ПодписьA', blockTime: 5, err: null }]);
    expect(вызовы[0]?.method).toBe('getSignaturesForAddress');
    expect(вызовы[0]?.params).toEqual(['Магазин', { limit: 100, until: 'ПодписьБ', commitment: 'finalized' }]);
  });

  it('превращает ошибку узла в исключение, а не в пустой результат', async () => {
    const подменаFetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Too many requests' } }))) as unknown as typeof fetch;

    const rpc = создатьRpc('https://узел.invalid', подменаFetch);

    await expect(rpc.getTransaction('ПодписьA')).rejects.toThrow(/Too many requests/);
  });
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/solana-rpc.test.ts`
Ожидается: FAIL — модуля нет.

- [ ] **Шаг 3: реализовать**

`src/solana-rpc.ts`:

```ts
/**
 * Тонкий клиент JSON-RPC Solana на встроенном `fetch`.
 *
 * Зачем свой, когда есть SDK: `SolanaPayKZ` держит узел внутри себя и
 * наружу не отдаёт, а нужны здесь три метода, которых у него нет. Тянуть
 * ради них `@solana/kit` в зависимости сервера — лишний вес и лишняя
 * версия к сопровождению; своё здесь — три запроса и разбор ответа.
 *
 * Ошибка узла (в том числе исчерпание квоты) поднимается исключением, а
 * не превращается в пустой результат: сканер обязан отличить «поступлений
 * нет» от «узел не ответил» — во втором случае курсор двигать нельзя.
 */
export function создатьRpc(url: string, fetchФн: typeof fetch = fetch): SolanaRpc {
  let счётчик = 0;

  async function вызвать<T>(method: string, params: unknown[]): Promise<T> {
    счётчик += 1;
    const ответ = await fetchФн(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: счётчик, method, params }),
    });
    if (!ответ.ok) {
      throw new Error(`Узел Solana ответил ${ответ.status} на ${method}`);
    }
    const тело = (await ответ.json()) as { result?: T; error?: { message: string } };
    if (тело.error) {
      throw new Error(`Узел Solana отказал на ${method}: ${тело.error.message}`);
    }
    return тело.result as T;
  }

  return {
    getSignaturesForAddress(адрес, params) {
      return вызвать('getSignaturesForAddress', [
        адрес,
        {
          limit: params.limit,
          ...(params.until ? { until: params.until } : {}),
          commitment: 'finalized',
        },
      ]);
    },
    getTransaction(signature) {
      return вызвать('getTransaction', [
        signature,
        { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
      ]);
    },
    async getTokenAccountsByOwner(владелец, mint) {
      const результат = await вызвать<{ value: Array<{ pubkey: string }> }>('getTokenAccountsByOwner', [
        владелец,
        { mint },
        { commitment: 'finalized', encoding: 'jsonParsed' },
      ]);
      return результат.value.map((с) => с.pubkey);
    },
  };
}

/**
 * Поступление на наблюдаемый адрес: для SOL — прирост баланса самого
 * адреса, для токена — прирост его токен-баланса по нужному mint.
 *
 * Провалившиеся транзакции (`meta.err`) пропускаются: их изменения
 * балансов откачены, деньги не пришли.
 */
export function поступлениеИзТранзакции(
  tx: ТранзакцияJson,
  параметры: { адрес: string; mint?: string },
): string | null {
  if (tx.meta?.err) return null;

  if (параметры.mint) {
    const было = сумма(tx.meta?.preTokenBalances, параметры);
    const стало = сумма(tx.meta?.postTokenBalances, параметры);
    const дельта = стало - было;
    return дельта > 0n ? дельта.toString() : null;
  }

  const ключи = tx.transaction?.message?.accountKeys ?? [];
  const индекс = ключи.findIndex((к) => (typeof к === 'string' ? к : к.pubkey) === параметры.адрес);
  if (индекс < 0) return null;

  const было = BigInt(tx.meta?.preBalances?.[индекс] ?? 0);
  const стало = BigInt(tx.meta?.postBalances?.[индекс] ?? 0);
  const дельта = стало - было;
  return дельта > 0n ? дельта.toString() : null;
}
```

Типы `ТранзакцияJson`, `SolanaRpc`, `ПодписьВИстории` и помощник `сумма`
описать в том же файле; полей узла брать ровно столько, сколько нужно —
чужой формат не копировать целиком.

- [ ] **Шаг 4: прогнать тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/solana-rpc.test.ts`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src/solana-rpc.ts tilda-server/tests/solana-rpc.test.ts
git commit -m "feat(tilda): тонкий клиент JSON-RPC для чтения поступлений"
```

---

### Задача 7: сканер поступлений

**Файлы:**
- Создать: `tilda-server/src/scanner.ts`
- Изменить: `tilda-server/src/db.ts` (методы курсора и поиска по сумме)
- Изменить: `tilda-server/src/http/server.ts` (запуск сканера)
- Тест: `tilda-server/tests/scanner.test.ts`, `tilda-server/tests/db.test.ts`

**Интерфейсы:**
- Потребляет: `SolanaRpc`, `поступлениеИзТранзакции` (задача 6);
  `Order.amountUnits` (задача 3).
- Отдаёт:

```ts
// db.ts
  /** Живые заказы с ровно такой суммой (состояния и окно — как в listPending). */
  findLiveOrdersByAmountUnits(params: {
    amountUnits: string;
    tokenSymbol: TokenSymbol;
    cluster: Cluster;
    lateWindowSeconds: number;
    now: number;
  }): Order[];
  /** Помечает транзакцию использованной. `false` — уже была использована. */
  claimSignature(signature: string, orderId: number, at: number): boolean;
  scanCursor(): { signature: string; blockTime: number | null } | null;
  setScanCursor(курсор: { signature: string; blockTime: number | null }): void;

// scanner.ts
export interface ScannerDeps {
  config: Config;
  store: Store;
  rpc: SolanaRpc;
  log: Log;
  закрытьЗаказ: (order: Order, signature: string) => Promise<unknown>;
  тест?: { потолокПодписей?: number };
}
export async function сканироватьОдинРаз(deps: ScannerDeps): Promise<void>;
export function startScanner(deps: ScannerDeps): () => void;
```

- [ ] **Шаг 1: написать падающие тесты сканера**

```ts
it('закрывает заказ, когда поступление совпало по сумме', async () => {
  const { store, deps, закрытые } = стенд({ поступления: [{ signature: 'ПодписьA', blockTime: 2000, amountUnits: '420001' }] });
  store.createOrder(заказНа('T-1', { amountUnits: '420001', uniqueAmount: 1, createdAt: 1000 }), подбор());

  await сканироватьОдинРаз(deps);

  expect(закрытые).toEqual([{ tildaOrderId: 'T-1', signature: 'ПодписьA' }]);
});

it('не закрывает заказ транзакцией старше самого заказа', async () => {
  const { store, deps, закрытые } = стенд({ поступления: [{ signature: 'ПодписьA', blockTime: 500, amountUnits: '420001' }] });
  store.createOrder(заказНа('T-1', { amountUnits: '420001', uniqueAmount: 1, createdAt: 1000 }), подбор());

  await сканироватьОдинРаз(deps);

  expect(закрытые).toEqual([]);
  expect(store.listUnmatched(10)[0]?.reason).toBe('транзакция старше заказа');
});

it('одну транзакцию засчитывает только одному заказу', async () => {
  const { store, deps, закрытые } = стенд({
    поступления: [{ signature: 'ПодписьA', blockTime: 2000, amountUnits: '420001' }],
  });
  store.createOrder(заказНа('T-1', { amountUnits: '420001', uniqueAmount: 1, createdAt: 1000 }), подбор());

  await сканироватьОдинРаз(deps);
  await сканироватьОдинРаз(deps);

  expect(закрытые).toHaveLength(1);
});

it('двигает курсор только по разобранному', async () => {
  const { store, deps } = стенд({ поступления: [{ signature: 'ПодписьA', blockTime: 2000, amountUnits: '1' }] });

  await сканироватьОдинРаз(deps);

  expect(store.scanCursor()?.signature).toBe('ПодписьA');
});

it('при отказе узла не двигает курсор', async () => {
  const { store, deps } = стенд({ отказУзла: true });

  await сканироватьОдинРаз(deps);

  expect(store.scanCursor()).toBeNull();
});

it('на первом запуске запоминает голову истории и ничего не разбирает', async () => {
  const { store, deps, закрытые } = стенд({
    первыйЗапуск: true,
    поступления: [{ signature: 'Старая', blockTime: 1, amountUnits: '420001' }],
  });
  store.createOrder(заказНа('T-1', { amountUnits: '420001', uniqueAmount: 1, createdAt: 0 }), подбор());

  await сканироватьОдинРаз(deps);

  expect(закрытые).toEqual([]);
  expect(store.scanCursor()?.signature).toBe('Старая');
});
```

`стенд(...)` — помощник файла: собирает базу в памяти, подменный `SolanaRpc`
с заданными поступлениями, журнал-заглушку и `закрытьЗаказ`, пишущий в
массив `закрытые`.

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/scanner.test.ts`
Ожидается: FAIL — модуля нет.

- [ ] **Шаг 3: методы базы**

В `src/db.ts` (запросы рядом с существующими):

```ts
  const живыеПоСумме = db.prepare(`
    SELECT * FROM orders
    WHERE amount_units = ? AND token_symbol = ? AND cluster = ? AND unique_amount = 1
      AND (
        (state = 'ожидает'    AND expires_at + ? >= ?)
        OR (state = 'просрочен'  AND created_at + ? >= ?)
        OR (state = 'не сошлось' AND created_at + ? >= ?)
      )
    ORDER BY created_at ASC
  `);
  const занятьПодпись = db.prepare(
    'INSERT OR IGNORE INTO matched_signatures (signature, order_id, matched_at) VALUES (?, ?, ?)',
  );
  const прочитатьКурсор = db.prepare('SELECT last_signature, last_block_time FROM scan_state WHERE id = 1');
  const записатьКурсор = db.prepare('UPDATE scan_state SET last_signature = ?, last_block_time = ? WHERE id = 1');
```

`claimSignature` возвращает `занятьПодпись.run(...).changes === 1`: вставку
либо приняли (подпись свободна), либо проигнорировали (уже занята) — это и
есть защита от двойного зачёта, и держит её первичный ключ, а не проверка
перед вставкой.

- [ ] **Шаг 4: реализовать сканер**

`src/scanner.ts` — по шагам спеки §5–6:

```ts
/** Интервал обхода поступлений — тот же, что у фоновой проверки заказов. */
const ИНТЕРВАЛ_СКАНИРОВАНИЯ_MS = 60_000;
/** Сколько новых подписей разбираем за один проход (спека, §5). */
const ПОТОЛОК_ПОДПИСЕЙ_ЗА_ПРОХОД = 100;

export async function сканироватьОдинРаз(deps: ScannerDeps): Promise<void> {
  if (!deps.config.enableAmountMatching) return;

  const наблюдаемый = await наблюдаемыйАдрес(deps);   // сам кошелёк или его токен-аккаунт
  const курсор = deps.store.scanCursor();

  let подписи: ПодписьВИстории[];
  try {
    подписи = await deps.rpc.getSignaturesForAddress(наблюдаемый.адрес, {
      limit: ПОТОЛОК_ПОДПИСЕЙ_ЗА_ПРОХОД,
      ...(курсор ? { until: курсор.signature } : {}),
    });
  } catch (е) {
    // Узел не ответил — это не «поступлений нет». Курсор не двигаем,
    // разберём в следующем проходе.
    deps.log.warn('Не удалось прочитать поступления: узел Solana недоступен или отказал', {
      сообщение: (е as Error).message,
    });
    return;
  }

  if (подписи.length === 0) return;

  // Первый запуск: запоминаем голову истории и уходим. Разбор всей прошлой
  // истории сжёг бы квоту узла и всё равно не нашёл бы заказов — их тогда
  // ещё не было (спека, §5).
  if (!курсор) {
    deps.store.setScanCursor({ signature: подписи[0]!.signature, blockTime: подписи[0]!.blockTime });
    return;
  }

  // Узел отдаёт от новых к старым — разбираем в обратном порядке, чтобы
  // курсор двигался строго по разобранному.
  for (const запись of [...подписи].reverse()) {
    if (запись.err) { продвинуть(запись); continue; }
    const tx = await deps.rpc.getTransaction(запись.signature);
    if (tx === null) return;   // тело ещё не раздаётся — вернёмся к этой подписи позже, курсор не двигаем
    const сумма = поступлениеИзТранзакции(tx, { адрес: наблюдаемый.адрес, ...(наблюдаемый.mint ? { mint: наблюдаемый.mint } : {}) });
    if (сумма !== null) await разобратьПоступление({ signature: запись.signature, blockTime: запись.blockTime, amountUnits: сумма }, deps);
    продвинуть(запись);
  }
}
```

`разобратьПоступление` выполняет правила §6 спеки по порядку: поиск живых
заказов с этой суммой → отсев по `blockTime < order.createdAt` → `claimSignature`
→ `deps.закрытьЗаказ`. Любой отказ на этом пути — запись в
`unmatched_receipts` с причиной («нет заказа с такой суммой», «подошло
несколько заказов», «транзакция старше заказа», «транзакция уже
использована»). Ошибки сети внутри `закрытьЗаказ` не должны рвать проход:
ловить, писать в журнал, оставлять подпись занятой (заказ уже помечен
оплаченным — повторное уведомление довезёт существующий механизм
`довезтиУведомление`).

`наблюдаемыйАдрес` для `token === 'SOL'` отдаёт сам `config.recipient` без
`mint`; для `USDC` — первый токен-аккаунт из `getTokenAccountsByOwner`, а
если их нет, пишет в журнал и уходит: токен-аккаунта нет, значит USDC этому
кошельку ещё никто не присылал.

`startScanner` — по образцу `startChecker`: `setInterval`, `unref`,
перехват падения прохода целиком в журнал, возврат функции остановки.

- [ ] **Шаг 5: подключить к запуску сервера**

В `src/http/server.ts`, в `запуститьСервер`, рядом с `startChecker`:

```ts
  const остановитьСканер = config.enableAmountMatching
    ? startScanner({
        config,
        store,
        rpc: создатьRpc(config.rpcUrl),
        log,
        закрытьЗаказ: (order, signature) => подтвердитьПлатёжПоСумме(order, signature, { config, store, client, log }),
      })
    : () => {};
```

и вызвать `остановитьСканер()` в `остановить()` рядом с `остановитьОбход()`.

- [ ] **Шаг 6: прогнать тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npm test`
Ожидается: PASS.

- [ ] **Шаг 7: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src tilda-server/tests
git commit -m "feat(tilda): сканер поступлений на кошелёк магазина"
```

---

### Задача 8: закрытие заказа платежом, найденным по сумме

**Файлы:**
- Изменить: `tilda-server/src/checker.ts`
- Тест: `tilda-server/tests/checker.test.ts`

**Интерфейсы:**
- Потребляет: `decide` (`decision.ts`, не меняется), `применитьРешение`
  (существующая внутренняя функция `checker.ts`).
- Отдаёт: `подтвердитьПлатёжПоСумме(order: Order, signature: string, deps: CheckerDeps): Promise<Decision>`.

- [ ] **Шаг 1: написать падающие тесты**

```ts
it('переводит ожидающий заказ в «оплачен» и уведомляет Tilda', async () => {
  const { store, deps, уведомления } = стенд();
  const заказ = store.createOrder(заказНа('T-1', { amountUnits: '420001', uniqueAmount: 1 }), подбор());

  const решение = await подтвердитьПлатёжПоСумме(заказ, 'ПодписьA', deps);

  expect(решение.action).toBe('оплачен');
  expect(store.findByToken(заказ.token)?.state).toBe('оплачен');
  expect(store.findByToken(заказ.token)?.txSignature).toBe('ПодписьA');
  expect(уведомления).toHaveLength(1);
});

it('просроченный заказ закрывает как «поздний», а не как оплаченный', async () => {
  const { store, deps } = стенд();
  const заказ = store.createOrder(заказНа('T-1', { amountUnits: '420001', uniqueAmount: 1 }), подбор());
  store.updateState(заказ.id, 'просрочен');

  const решение = await подтвердитьПлатёжПоСумме(store.findByToken(заказ.token)!, 'ПодписьA', deps);

  expect(решение.action).toBe('поздний');
});

it('не трогает заказ, уже закрытый другим путём', async () => {
  const { store, deps, уведомления } = стенд();
  const заказ = store.createOrder(заказНа('T-1', { amountUnits: '420001', uniqueAmount: 1 }), подбор());
  store.updateState(заказ.id, 'уведомлён');

  const решение = await подтвердитьПлатёжПоСумме(заказ, 'ПодписьA', deps);

  expect(решение.action).toBe('ждать');
  expect(уведомления).toHaveLength(0);
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `cd /var/www/solanapaykz/tilda-server && npx vitest run tests/checker.test.ts -t "по сумме"`
Ожидается: FAIL — функции нет.

- [ ] **Шаг 3: реализовать**

```ts
/**
 * Закрывает заказ платежом, найденным сканером по уникальной сумме.
 *
 * Отличие от `checkOrder` одно: факт платежа уже установлен — сканер
 * прочитал транзакцию и видел приход нужной суммы на кошелёк магазина,
 * повторно спрашивать блокчейн незачем. Всё остальное — та же дорога:
 * та же блокировка `занятыеЗаказы` (иначе опрос из вкладки покупателя и
 * сканер закрыли бы один заказ дважды и отправили два уведомления), то же
 * перечитывание заказа перед решением, тот же `decide()` и то же
 * `применитьРешение` — с уведомлением Tilda и письмом продавцу.
 */
export async function подтвердитьПлатёжПоСумме(
  order: Order,
  signature: string,
  deps: CheckerDeps,
): Promise<Decision> {
  if (занятыеЗаказы.has(order.id)) {
    return { action: 'ждать', note: 'Заказ уже проверяется другим вызовом — подтверждение пропущено.' };
  }

  занятыеЗаказы.add(order.id);
  try {
    const свежий = deps.store.findByToken(order.token) ?? order;
    const решение = decide({
      status: { status: 'confirmed', signature, amountPaid: свежий.amountToken, truncated: false },
      orderState: свежий.state,
      expiresAt: свежий.expiresAt,
      createdAt: свежий.createdAt,
      lateWindowSeconds: deps.config.lateWindowSeconds,
      now: Math.floor(Date.now() / 1000),
    });
    применитьРешение(свежий, решение, deps);
    return решение;
  } finally {
    занятыеЗаказы.delete(order.id);
  }
}
```

- [ ] **Шаг 4: прогнать тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npm test`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src/checker.ts tilda-server/tests/checker.test.ts
git commit -m "feat(tilda): платёж по уникальной сумме закрывает заказ той же дорогой"
```

---

### Задача 9: неопознанные поступления — хранение, показ, письмо

**Файлы:**
- Изменить: `tilda-server/src/db.ts` (методы списка неопознанных)
- Изменить: `tilda-server/src/http/routes-admin.ts` (раздел в списке заказов)
- Изменить: `tilda-server/src/mailer.ts` (письмо о неопознанном поступлении)
- Изменить: `tilda-server/src/scanner.ts` (вызов письма)
- Тест: `tilda-server/tests/db.test.ts`, `tests/admin.test.ts`, `tests/mailer.test.ts`

**Интерфейсы:**
- Отдаёт:

```ts
// db.ts
export interface UnmatchedReceipt {
  signature: string;
  amountUnits: string;
  tokenSymbol: TokenSymbol;
  blockTime: number | null;
  reason: string;
  seenAt: number;
  mailedAt: number | null;
}
  recordUnmatched(поступление: Omit<UnmatchedReceipt, 'mailedAt'>): void;
  listUnmatched(limit: number): UnmatchedReceipt[];
  markUnmatchedMailed(signature: string, at: number): void;
  /** Момент последнего письма о неопознанном поступлении — для ограничения частоты. */
  lastUnmatchedMailAt(): number | null;

// mailer.ts
export async function sendUnmatchedMail(
  поступление: UnmatchedReceipt,
  deps: MailerDeps,
): Promise<boolean>;
```

- [ ] **Шаг 1: написать падающие тесты**

```ts
// db.test.ts
it('хранит неопознанные поступления, новые первыми', () => {
  const store = openDatabase(':memory:');
  store.recordUnmatched({ signature: 'A', amountUnits: '100', tokenSymbol: 'SOL', blockTime: 10, reason: 'нет заказа с такой суммой', seenAt: 10 });
  store.recordUnmatched({ signature: 'Б', amountUnits: '200', tokenSymbol: 'SOL', blockTime: 20, reason: 'нет заказа с такой суммой', seenAt: 20 });

  expect(store.listUnmatched(10).map((п) => п.signature)).toEqual(['Б', 'A']);
});

// admin.test.ts
it('показывает неопознанные поступления в списке заказов', async () => {
  const { store, запрос } = стендАдминки();
  store.recordUnmatched({ signature: 'ПодписьA', amountUnits: '420000', tokenSymbol: 'SOL', blockTime: 10, reason: 'нет заказа с такой суммой', seenAt: 10 });

  const ответ = await запрос('/admin', { сессия: true });

  expect(ответ.body).toContain('Неопознанные поступления');
  expect(ответ.body).toContain('0.000420000');
  expect(ответ.body).toContain('ПодписьA');
});

// mailer.test.ts
it('шлёт не больше одного письма о неопознанных поступлениях в час', async () => {
  const { store, deps, письма } = стендПочты();
  store.recordUnmatched({ signature: 'A', amountUnits: '1', tokenSymbol: 'SOL', blockTime: 0, reason: 'нет заказа с такой суммой', seenAt: 0 });
  store.recordUnmatched({ signature: 'Б', amountUnits: '2', tokenSymbol: 'SOL', blockTime: 60, reason: 'нет заказа с такой суммой', seenAt: 60 });

  await sendUnmatchedMail(store.listUnmatched(10)[1]!, deps);
  await sendUnmatchedMail(store.listUnmatched(10)[0]!, deps);

  expect(письма).toHaveLength(1);
});
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `cd /var/www/solanapaykz/tilda-server && npm test`
Ожидается: FAIL по всем трём — методов и письма нет.

- [ ] **Шаг 3: реализовать хранение**

В `src/db.ts` — запросы к `unmatched_receipts` (таблица создана в задаче 3):
вставка `INSERT OR IGNORE` (повторная обработка той же подписи не должна
плодить строки), выборка `ORDER BY seen_at DESC LIMIT ?`, `UPDATE … SET
mailed_at = ?`, `SELECT MAX(mailed_at) …`.

- [ ] **Шаг 4: показать в админке**

В `src/http/routes-admin.ts` — отдельная таблица под списком заказов:

```ts
/**
 * Сумма поступления человеку: в базе она в минимальных единицах (по ним
 * идёт сопоставление), а продавцу нужна привычная запись токена.
 */
function суммаПоступления(п: UnmatchedReceipt): string {
  const { decimals } = resolveToken(config.cluster, п.tokenSymbol);
  return `${formatUnits(BigInt(п.amountUnits), decimals)} ${п.tokenSymbol}`;
}
```

Раздел показывать всегда, когда способ включён, и с пояснением, когда список
пуст («Пока ничего — это нормально»): пустая таблица без объяснения читается
как поломка.

- [ ] **Шаг 5: письмо**

`sendUnmatchedMail` — по образцу `sendMerchantMail`: то же построение письма,
тот же `MailerDeps`, та же запись исхода. Ограничение частоты — проверка
`lastUnmatchedMailAt()` перед отправкой:

```ts
/** Не чаще одного письма о неопознанных поступлениях в час (спека, §7). */
const МИНИМАЛЬНЫЙ_ИНТЕРВАЛ_ПИСЬМА_SECONDS = 3600;
```

Текст письма: сумма, дата, ссылка на транзакцию (`ссылкаНаТранзакцию`,
уже есть в `mailer.ts`), причина и прямая ссылка на список заказов. Ни в
коем случае не утверждать, что деньги потеряны: они у продавца, разобраться
нужно вручную.

- [ ] **Шаг 6: вызвать из сканера**

В `разобратьПоступление` (задача 7) после `recordUnmatched` — попытка
письма; её отказ не должен ронять проход (ловить и писать в журнал).

- [ ] **Шаг 7: прогнать тесты**

Запуск: `cd /var/www/solanapaykz/tilda-server && npm test`
Ожидается: PASS.

- [ ] **Шаг 8: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/src tilda-server/tests
git commit -m "feat(tilda): список неопознанных поступлений и письмо продавцу"
```

---

### Задача 10: документация

**Файлы:**
- Изменить: `tilda-server/README.md`
- Изменить: `docs/ru/tilda.md`, `docs/tilda.md`
- Изменить: `process/TODO.md`

- [ ] **Шаг 1: раздел в README сервера**

Раздел «Оплата по уникальной сумме»: что это, когда включать, чем платят
покупатели без Solana Pay, требование отдельного кошелька, поведение с
биржами (комиссия!), где смотреть неопознанные поступления.

- [ ] **Шаг 2: те же разделы в публичной документации**

`docs/ru/tilda.md` и `docs/tilda.md` — русская и английская страницы. Тексты
писать по существу, без обещаний, которых способ не даёт: платёж с биржи
почти всегда придёт с удержанной комиссией и в список неопознанных.

- [ ] **Шаг 3: отметить в TODO**

В `process/TODO.md` — новый подпункт этапа 3 с состоянием.

- [ ] **Шаг 4: коммит**

```bash
cd /var/www/solanapaykz
git add tilda-server/README.md docs process/TODO.md
git commit -m "docs: оплата по уникальной сумме — настройка, ограничения, неопознанные поступления"
```

---

### Задача 11: сборка, развёртывание, живая проверка

- [ ] **Шаг 1: полный прогон тестов и сборка**

```bash
cd /var/www/solanapaykz && npm test && npm run build
cd /var/www/solanapaykz/tilda-server && npm test && npm run build
```
Ожидается: оба пакета — PASS, сборка без ошибок.

- [ ] **Шаг 2: резервная копия боевой базы**

```bash
docker exec solanapaykz_tilda_server sh -c 'cp /app/tilda-server/data/orders.sqlite /app/tilda-server/data/orders.sqlite.bak-$(date +%F)'
```
Миграция необратима, а заказы в базе настоящие.

- [ ] **Шаг 3: включить способ в настройках**

В `tilda-server/config.json` — `"enableAmountMatching": true`. Файл в
`.gitignore`, не коммитить.

- [ ] **Шаг 4: пересобрать и перезапустить контейнер**

```bash
cd /var/www/solanapaykz/tilda-server
docker compose up -d --build
docker logs --tail 30 solanapaykz_tilda_server
```
Ожидается: в журнале «Сервер запущен», без сообщений о миграции с ошибкой.

- [ ] **Шаг 5: живая проверка**

Создать тестовый заказ на демо-странице Tilda, открыть страницу оплаты,
проверить: сумма уникальна (создать два заказа на одну цену — суммы должны
различаться), блок с адресом виден, кнопки «скопировать» работают. Затем
перевести точную сумму с кошелька заказчика вручную (не по QR) и убедиться,
что в течение минуты заказ перешёл в «оплачен», Tilda получила уведомление,
продавцу ушло письмо.

- [ ] **Шаг 6: проверка неопознанного**

Перевести на тот же кошелёк сумму, отличающуюся на один лампорт, и убедиться,
что она появилась в разделе «Неопознанные поступления» и пришло письмо.

- [ ] **Шаг 7: отчёт заказчику**

Написать в Telegram: что включено, что проверено настоящим платежом, что
осталось (плагин WooCommerce — следующим этапом).

---

## Самопроверка плана

Проверено против спеки:

- §2 (показ адреса всем) — задача 5; §3 (два пути) — задачи 7–8; §4
  (подбор суммы, потолок, атомарность) — задачи 3–4; §5 (наблюдение,
  первый запуск, потолки, тонкий клиент RPC) — задачи 6–7; §6 (правила
  сопоставления) — задача 7; §7 (неопознанные, письмо раз в час) — задача
  9; §8 (настройка) — задача 2; §10 (схема и миграция) — задача 3; §11
  (проверка) — тесты в каждой задаче; §12 (порядок) — порядок задач.
- Порядок «заказ → ссылка» в задаче 4 опирается на две правки SDK из
  задачи 1: готовую метку опцией и экспорт `generateReference`. Задача 1
  обязана быть выполнена первой.
- Тесты задач 4 и 5 требуют, чтобы помощники существующих тестов
  (`заказНа`, стенды в `inbound.test.ts` и `http.test.ts`) умели задавать
  `amountUnits`, `uniqueAmount` и `enableAmountMatching`. Расширять
  помощники, а не ослаблять типы.
