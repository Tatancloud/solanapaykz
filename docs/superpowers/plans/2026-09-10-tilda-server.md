# Сервер приёма оплаты для Tilda — план реализации

> **Для исполнителей:** ОБЯЗАТЕЛЬНЫЙ ПОДНАВЫК — superpowers:subagent-driven-development
> либо superpowers:executing-plans. Шаги отмечаются галочками `- [ ]`.

**Цель:** сервер, позволяющий магазину на Tilda принимать оплату в USDC или
SOL на Solana с пересчётом из тенге; деньги идут напрямую покупатель →
продавец.

**Устройство:** Node.js на TypeScript слушает локальный адрес за nginx.
Принимает подписанный POST от Tilda, замораживает цену, показывает страницу с
QR, проверяет платёж в блокчейне и шлёт Tilda подписанное уведомление об
оплате. Расчёты и проверка берутся из `@solanapaykz/core` — пакета первого
этапа, а не пишутся заново.

**Технологии:** Node.js 22, TypeScript 5.7, vitest 2.1, `@solanapaykz/core`
(локальная ссылка на корень репозитория), встроенный `node:sqlite`,
встроенный `node:http`, `nodemailer` для почты, Docker Compose, nginx с
сертификатом Let's Encrypt.

**Спека:** `docs/superpowers/specs/2026-09-10-tilda-server-design.md`
**Протокол Tilda:** `docs/tilda-protokol.md` — собран из личного кабинета,
в публичной документации его нет. Сверяться по нему.

## Глобальные ограничения

- Сумма заказа берётся **только** из подписанного запроса Tilda. Никогда из
  браузера, никогда из параметров адресной строки.
- Подпись — HMAC-SHA-256, секрет как ключ. Сравнение постоянного времени
  (`crypto.timingSafeEqual`).
- Курс запрашивается один раз при создании заказа. Сумма, адрес получателя,
  метка платежа и сеть замораживаются в записи заказа и не пересчитываются.
- Сбой сети или узла Solana **не меняет** статус заказа.
- Несовпадение суммы **не отменяет** и **не подтверждает** заказ.
- Расхождение сети в настройках и в заказе — ошибка настройки: заказ не
  трогаем, пишем в журнал.
- Секреты не попадают в журнал. От адреса узла Solana в сообщениях остаются
  только схема и хост.
- Приватные ключи не создаются, не хранятся и не запрашиваются.
- Тексты для покупателя, сообщения об ошибках и комментарии — на русском.
- Каждая задача — отдельная ветка `feat/tilda-<имя>`, слияние в `main`.

**Рабочий каталог:** `tilda-server/` в корне репозитория.
**Тесты:** `npm test` внутри `tilda-server/`. Зависимости ставить командой
`npm install --include=dev` — на этом сервере `NODE_ENV=production`, и без
флага npm молча пропустит devDependencies.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `src/config.ts` | чтение и проверка настроек, отказ при неполных |
| `src/log.ts` | журнал; вырезает секреты и путь из адреса узла |
| `src/db.ts` | схема SQLite, запросы к заказам |
| `src/signature.ts` | подпись Tilda в обе стороны |
| `src/decision.ts` | чистая логика состояний, без сети и базы |
| `src/payments.ts` | обёртка над `@solanapaykz/core` |
| `src/tilda/inbound.ts` | разбор POST от Tilda: оба входа |
| `src/tilda/notify.ts` | отправка уведомления с повторами |
| `src/checker.ts` | фоновый обход заказов |
| `src/mailer.ts` | письмо продавцу |
| `src/http/server.ts` | маршрутизация и запуск |
| `src/http/routes-pay.ts` | `/tilda/pay`, `/tilda/webhook` |
| `src/http/routes-page.ts` | `/pay/:token`, `/api/status/:token` |
| `src/http/routes-admin.ts` | список заказов, вход по паролю |
| `src/http/html.ts` | разметка страниц |
| `public/checkout.js` | отсчёт и опрос статуса |
| `public/checkout.css` | оформление страницы оплаты |
| `tools/fake-tilda.ts` | имитатор Tilda для проверки всего пути |

---

### Задача 1: Каркас, настройки, журнал

**Файлы:**
- Создать: `tilda-server/package.json`, `tsconfig.json`, `vitest.config.ts`,
  `.gitignore`, `config.example.json`
- Создать: `tilda-server/src/config.ts`, `tilda-server/src/log.ts`
- Тесты: `tilda-server/tests/config.test.ts`, `tilda-server/tests/log.test.ts`

**Интерфейсы:**
- Отдаёт: `loadConfig(raw: unknown): Config` — бросает `ConfigError` со
  списком всех недостающих и неверных полей сразу, а не первого попавшегося.
- Отдаёт: `type Config` с полями: `recipient: string`, `rpcUrl: string`,
  `cluster: 'mainnet' | 'devnet'`, `token: 'USDC' | 'SOL'`,
  `markupPercent: number`, `quoteTtlSeconds: number`,
  `lateWindowSeconds: number`, `orderSecret: string`, `notifySecret: string`,
  `tildaNotifyUrl: string`, `publicUrl: string`, `adminPassword: string`,
  `smtp: { host: string; port: number; user: string; pass: string; from: string }`,
  `merchantEmail: string`, `databasePath: string`, `listenPort: number`.
- Отдаёт: `redactUrl(url: string): string` — оставляет схему и хост.
- Отдаёт: `createLog(вывод: (s: string) => void, секреты?: readonly string[])`
  и готовый `log` с методами `info`, `warn`, `error` — пишут строкой JSON.
- **Журнал обязан быть настоящей гарантией, а не видимостью.** Вырезание
  только по имени поля недостаточно: адрес узла Solana с ключом провайдера
  внутри лежит в поле `rpcUrl`, которое не похоже ни на `secret`, ни на
  `password`, а секрет, попавший в текст сообщения через интерполяцию, именем
  поля не ловится вовсе. Три слоя:
  1. любая строка, похожая на адрес, прогоняется через `redactUrl` —
     в поле, в массиве, внутри текста сообщения;
  2. журнал знает сами значения секретов (передаются при создании из
     настроек) и вырезает их где угодно в готовой строке; строки короче
     8 символов в этот список не берутся, иначе замена изуродует вывод;
  3. вырезание по имени ключа — как дешёвый дополнительный слой для
     случаев, когда значение журналу не передали.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-scaffold
```

- [ ] **Шаг 2: Создать каркас проекта**

`tilda-server/package.json`:

```json
{
  "name": "@solanapaykz/tilda-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.5.0" },
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json",
    "start": "node --experimental-sqlite dist/http/server.js"
  },
  "dependencies": {
    "@solanapaykz/core": "file:..",
    "nodemailer": "6.9.16"
  },
  "devDependencies": {
    "@types/node": "22.10.2",
    "@types/nodemailer": "6.4.17",
    "typescript": "5.7.2",
    "vitest": "2.1.8"
  }
}
```

`tilda-server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`tilda-server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // node:sqlite в Node 22 доступен только под флагом.
    poolOptions: { threads: { execArgv: ['--experimental-sqlite'] } },
  },
});
```

`tilda-server/.gitignore`:

```
node_modules/
dist/
config.json
*.sqlite
*.sqlite-journal
```

- [ ] **Шаг 3: Написать падающий тест на настройки**

`tilda-server/tests/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const полные = {
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  rpcUrl: 'https://api.devnet.solana.com',
  cluster: 'devnet',
  token: 'USDC',
  orderSecret: 'секрет-заказа',
  notifySecret: 'секрет-уведомления',
  tildaNotifyUrl: 'https://tilda.cc/payment/notify/xxx',
  publicUrl: 'https://pay.kabyldau.digital',
  adminPassword: 'длинный-пароль-админа',
  smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'p', from: 'shop@example.kz' },
  merchantEmail: 'merchant@example.kz',
  databasePath: '/data/orders.sqlite',
  listenPort: 8080,
};

describe('loadConfig', () => {
  it('принимает полный набор и подставляет значения по умолчанию', () => {
    const c = loadConfig(полные);
    expect(c.markupPercent).toBe(0);
    expect(c.quoteTtlSeconds).toBe(900);
    expect(c.lateWindowSeconds).toBe(86400);
  });

  it('перечисляет ВСЕ недостающие поля разом, а не первое', () => {
    let сообщение = '';
    try {
      loadConfig({ cluster: 'devnet' });
    } catch (e) {
      сообщение = (e as Error).message;
    }
    expect(сообщение).toContain('recipient');
    expect(сообщение).toContain('rpcUrl');
    expect(сообщение).toContain('adminPassword');
  });

  it('отвергает неизвестную сеть', () => {
    expect(() => loadConfig({ ...полные, cluster: 'testnet' })).toThrow(/cluster/);
  });

  it('отвергает адрес узла без схемы https', () => {
    expect(() => loadConfig({ ...полные, rpcUrl: 'api.devnet.solana.com' })).toThrow(/rpcUrl/);
  });

  it('отвергает пустой секрет: подпись без секрета бессмысленна', () => {
    expect(() => loadConfig({ ...полные, orderSecret: '' })).toThrow(/orderSecret/);
  });

  it('отвергает наценку вне разумных границ', () => {
    expect(() => loadConfig({ ...полные, markupPercent: -1 })).toThrow(/markupPercent/);
    expect(() => loadConfig({ ...полные, markupPercent: 101 })).toThrow(/markupPercent/);
  });
});
```

- [ ] **Шаг 4: Убедиться, что тест падает**

```bash
cd tilda-server && npm install --include=dev && npm test
```
Ожидается: падение с «Cannot find module '../src/config.js'».

- [ ] **Шаг 5: Написать `src/config.ts`**

Требования к реализации:
- собирает список всех проблем и бросает одну ошибку со всеми сразу;
- `cluster` только `mainnet` или `devnet`, по умолчанию `devnet`;
- `token` только `USDC` или `SOL`, по умолчанию `USDC`;
- `rpcUrl`, `publicUrl`, `tildaNotifyUrl` обязаны начинаться с `https://`;
- `markupPercent` число от 0 до 100 включительно, по умолчанию 0;
- `quoteTtlSeconds` целое от 60 до 3600, по умолчанию 900;
- `lateWindowSeconds` целое от 0 до 604800, по умолчанию 86400;
- секреты и пароль — непустые строки длиной не меньше 8 **символов**, а не
  байтов: шесть кириллических букв дают около 30 бит против почти 38 у восьми
  латинских, то есть счёт в байтах ослабляет правило, а не усиливает;
- неизвестные ключи верхнего уровня отвергаются с перечислением имён:
  опечатка `markupPercnt` вместо `markupPercent` иначе молча оставит наценку
  нулевой, и продавец узнает об этом из выручки;
- `listenPort` целое от 1 до 65535, по умолчанию 8080.

- [ ] **Шаг 6: Написать падающий тест на журнал**

`tilda-server/tests/log.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createLog, redactUrl } from '../src/log.js';

describe('redactUrl', () => {
  it('оставляет только схему и хост', () => {
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=8f3c9d')).toBe(
      'https://mainnet.helius-rpc.com',
    );
    expect(redactUrl('https://x.quiknode.pro/секретный-токен/')).toBe('https://x.quiknode.pro');
  });

  it('не падает на мусоре и не возвращает его целиком', () => {
    expect(redactUrl('не-адрес-вовсе')).toBe('<адрес скрыт>');
  });
});

describe('createLog', () => {
  it('вырезает значения секретов', () => {
    const строки: string[] = [];
    const log = createLog((s) => строки.push(s));
    log.info('старт', { orderSecret: 'абв', adminPassword: 'гдеё', orderId: '1:2' });
    const запись = строки[0] ?? '';
    expect(запись).not.toContain('абв');
    expect(запись).not.toContain('гдеё');
    expect(запись).toContain('1:2');
  });
});
```

- [ ] **Шаг 7: Написать `src/log.ts` и убедиться, что всё зелёное**

```bash
cd tilda-server && npm test
```
Ожидается: все тесты проходят.

- [ ] **Шаг 8: Пример настроек**

`tilda-server/config.example.json` — все поля с пояснениями в поле
`"_комментарий"` рядом с каждым разделом, секреты заменены на `ЗАПОЛНИТЕ`.

- [ ] **Шаг 9: Коммит и слияние**

```bash
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: каркас сервера для Tilda, настройки и журнал"
git checkout main && git merge --no-ff feat/tilda-scaffold && git push origin main
```

---

### Задача 2: Подпись Tilda в обе стороны

**Файлы:**
- Создать: `tilda-server/src/signature.ts`
- Тест: `tilda-server/tests/signature.test.ts`

**Интерфейсы:**
- Потребляет: ничего из предыдущих задач.
- Отдаёт: `signFields(fields: Record<string, string>, secret: string): string`
  — HMAC-SHA-256 в нижнем регистре hex.
- Отдаёт: `verifySignature(fields: Record<string, string>, signature: string, secret: string): boolean`
  — сравнение постоянного времени, поле `signature` в подсчёт не входит.

**Правило составления строки для подписи** (оно же вписывается в настройки
шаблона Tilda в режиме «Особые правила»): склеить через `|` значения ровно
этих полей, ровно в этом порядке:

```
{{order_id}}|{{amount}}|{{currency}}|{{timestamp}}|{{test_mode}}
```

Секрет в строку не подставляется — он служит ключом HMAC.

**Почему список явный, а не «все поля».** Tilda умеет режим «Все поля»:
взять всё, отсортировать, склеить через разделитель. Он опасен из-за
неоднозначности склейки: значения `{a: "1|2", b: "3"}` и `{a: "1", b: "2|3"}`
дают одну и ту же строку `1|2|3`, то есть одну и ту же подпись для разных
данных. В нашем случае в заказе есть поля со свободным текстом — описание и
названия товаров, — которые покупатель может менять: Tilda перенаправляет
его POST-формой из **его же браузера**, а значит любое поле доступно правке
до того, как дойдёт до нас.

Явный список решает это радикально: в подпись входят только поля со строгим
форматом, где символа `|` быть не может. Свободный текст в подпись не входит
вовсе.

**Следствие, которое обязан помнить исполнитель:** поля, не входящие в
подпись (`description`, `products`, `email`, `phone`, `customer_name`,
`notify_url`, `success_url`, `failure_url`), **не заверены** и не должны
влиять ни на одно денежное решение. Их можно показать покупателю и записать в
заказ, но нельзя считать по ним сумму, выбирать монету или адрес получателя.

- [ ] **Шаг 1: Создать ветку**

```bash
cd /var/www/solanapaykz && git checkout -b feat/tilda-signature
```

- [ ] **Шаг 2: Написать падающий тест**

`tilda-server/tests/signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signFields, verifySignature } from '../src/signature.js';

const секрет = 'секрет-для-подписи';

const заказ = {
  order_id: '10868059:42',
  amount: '15000',
  currency: 'KZT',
  timestamp: '1789200000',
  test_mode: '0',
};

describe('signFields', () => {
  it('считает HMAC-SHA-256 от значений в фиксированном порядке', () => {
    const ожидаемая = createHmac('sha256', секрет)
      .update('10868059:42|15000|KZT|1789200000|0')
      .digest('hex');
    expect(signFields(заказ, секрет)).toBe(ожидаемая);
  });

  it('не зависит от порядка ключей во входном объекте', () => {
    const переставленный = {
      test_mode: '0',
      currency: 'KZT',
      order_id: '10868059:42',
      timestamp: '1789200000',
      amount: '15000',
    };
    expect(signFields(переставленный, секрет)).toBe(signFields(заказ, секрет));
  });

  it('не зависит от полей вне списка подписи', () => {
    const с_текстом = { ...заказ, description: 'Букет «Астана» | доставка', products: '[]' };
    expect(signFields(с_текстом, секрет)).toBe(signFields(заказ, секрет));
  });

  it('другой секрет даёт другую подпись', () => {
    expect(signFields(заказ, секрет)).not.toBe(signFields(заказ, 'другой-секрет'));
  });

  it('отвергает разделитель внутри поля подписи: это признак подделки', () => {
    expect(() => signFields({ ...заказ, amount: '150|00' }, секрет)).toThrow(/Разделитель/);
  });

  it('отсутствующее поле подписи считается пустым, а не пропускается', () => {
    const без_времени = { ...заказ, timestamp: '' };
    const ожидаемая = createHmac('sha256', секрет)
      .update('10868059:42|15000|KZT||0')
      .digest('hex');
    expect(signFields(без_времени, секрет)).toBe(ожидаемая);
  });
});

describe('verifySignature', () => {
  const поля = заказ;

  it('принимает верную подпись', () => {
    expect(verifySignature(поля, signFields(поля, секрет), секрет)).toBe(true);
  });

  it('отвергает подделанную подпись', () => {
    expect(verifySignature(поля, 'a'.repeat(64), секрет)).toBe(false);
  });

  it('отвергает подпись, снятую с изменённой суммы', () => {
    const подпись = signFields(поля, секрет);
    expect(verifySignature({ ...поля, amount: '1' }, подпись, секрет)).toBe(false);
  });

  it('не роняет проверку, если в поле подписи подсунут разделитель', () => {
    const подпись = signFields(поля, секрет);
    expect(verifySignature({ ...поля, amount: '1|5' }, подпись, секрет)).toBe(false);
  });

  it('отвергает подпись неверной длины, не бросая исключение', () => {
    expect(verifySignature(поля, 'коротко', секрет)).toBe(false);
    expect(verifySignature(поля, '', секрет)).toBe(false);
  });

  it('не различает регистр шестнадцатеричной записи', () => {
    const подпись = signFields(поля, секрет);
    expect(verifySignature(поля, подпись.toUpperCase(), секрет)).toBe(true);
  });
});
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
cd tilda-server && npm test -- signature
```
Ожидается: падение с «Cannot find module '../src/signature.js'».

- [ ] **Шаг 4: Написать `src/signature.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Поле, в котором приходит и уходит сама подпись. */
export const ПОЛЕ_ПОДПИСИ = 'signature';

/**
 * Поля, входящие в подпись, в фиксированном порядке. Все со строгим
 * форматом: символа-разделителя внутри значения быть не может.
 *
 * Свободный текст (описание, названия товаров, контакты) в подпись НЕ
 * входит намеренно: покупатель правит POST-форму в своём браузере, а склейка
 * значений через разделитель неоднозначна — «1|2» и «3» дают ту же строку,
 * что «1» и «2|3».
 */
export const ПОЛЯ_ПОДПИСИ = ['order_id', 'amount', 'currency', 'timestamp', 'test_mode'] as const;

const РАЗДЕЛИТЕЛЬ = '|';

/**
 * Строка для подписи. Секрет в неё не подставляется: он служит ключом HMAC.
 * Варианты Tilda, где секрет склеивается со значениями, уязвимы к удлинению
 * сообщения — HMAC снимает этот вопрос.
 */
function строкаДляПодписи(fields: Record<string, string>): string {
  return ПОЛЯ_ПОДПИСИ.map((имя) => {
    const значение = fields[имя] ?? '';

    // Разделитель внутри значения сделал бы разбор неоднозначным. Поля
    // подписи имеют строгий формат, поэтому это признак подделки, а не
    // законный случай: пусть подпись не сойдётся.
    if (значение.includes(РАЗДЕЛИТЕЛЬ)) {
      throw new Error(`Разделитель внутри поля подписи «${имя}»`);
    }

    return значение;
  }).join(РАЗДЕЛИТЕЛЬ);
}

export function signFields(fields: Record<string, string>, secret: string): string {
  return createHmac('sha256', secret).update(строкаДляПодписи(fields), 'utf8').digest('hex');
}

export function verifySignature(
  fields: Record<string, string>,
  signature: string,
  secret: string,
): boolean {
  let ожидаемая: string;

  try {
    ожидаемая = signFields(fields, secret);
  } catch {
    // Разделитель внутри поля подписи. Проверка обязана вернуть «не сошлось»,
    // а не уронить обработчик: иначе подделанное поле становится способом
    // положить приём заказов.
    return false;
  }

  const пришедшая = signature.trim().toLowerCase();

  // timingSafeEqual бросает исключение на буферах разной длины, поэтому
  // длину проверяем заранее — иначе подделка неверной длины роняла бы вход.
  if (пришедшая.length !== ожидаемая.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(пришедшая, 'utf8'), Buffer.from(ожидаемая, 'utf8'));
}
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

```bash
cd tilda-server && npm test
```

- [ ] **Шаг 6: Коммит и слияние**

```bash
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: подпись Tilda через HMAC-SHA-256 в обе стороны"
git checkout main && git merge --no-ff feat/tilda-signature && git push origin main
```

---

### Задача 3: Хранилище заказов

**Файлы:**
- Создать: `tilda-server/src/db.ts`
- Тест: `tilda-server/tests/db.test.ts`

**Интерфейсы:**
- Потребляет: `Config` из задачи 1.
- Отдаёт: `openDatabase(path: string): Store`.
- Отдаёт: `type NewOrder` — все поля `Order`, кроме `id`, `state`,
  `notifyAttempts` и `notifiedOk`: их проставляет само хранилище.
- Отдаёт: `interface Store` с методами:
  - `createOrder(o: NewOrder): Order` — бросает `DuplicateOrderError`, если
    заказ с таким `tildaOrderId` уже есть;
  - `findByTildaOrderId(id: string): Order | null`;
  - `findByToken(token: string): Order | null`;
  - `listRecent(limit: number): Order[]` — новые первыми;
  - `listPending(limit: number, lateWindowSeconds: number, now: number): Order[]`
    — `ожидает` без ограничения по времени плюс `просрочен`, у которых
    `created_at + lateWindowSeconds >= now`; старые первыми. Окно отсекается
    **в запросе**, а не вызывающим: фоновый обход берёт по 30 заказов, и если
    мёртвые записи остаются в выборке навсегда, они занимают всё окно, а новые
    заказы перестают проверяться — молча. Это находка ревью плагина;
  - `updateState(id: number, state: OrderState, fields?: Partial<Order>): void`;
  - `markNotified(id: number, ok: boolean, attempt: number): void`.
- Отдаёт: `type OrderState = 'ожидает' | 'оплачен' | 'уведомлён' | 'не сошлось' | 'поздний' | 'просрочен'`.
- Отдаёт: `interface Order` — `id: number`, `tildaOrderId: string`,
  `token: string` (случайный ключ страницы оплаты), `state: OrderState`,
  `amountKzt: string`, `amountToken: string`, `tokenSymbol: 'USDC' | 'SOL'`,
  `cluster: 'mainnet' | 'devnet'`, `recipient: string`, `reference: string`,
  `rate: string`, `rateSource: string`, `paymentUrl: string`,
  `quoteJson: string`, `createdAt: number`, `expiresAt: number`,
  `tildaSignature: string | null` (подпись заказа от Tilda — для разбора
  споров), `txSignature: string | null` (подпись транзакции Solana),
  `notifyUrl: string | null`,
  `notifyAttempts: number`, `notifiedOk: 0 | 1`, `customerEmail: string | null`,
  `description: string | null`, `productsJson: string | null`.

Почему не ORM: таблица одна, запросов восемь. Слой отображения здесь дороже
самого кода и прячет то, что нужно видеть.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-store
```

- [ ] **Шаг 2: Написать падающий тест**

`tilda-server/tests/db.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuplicateOrderError, openDatabase, type NewOrder, type Store } from '../src/db.js';

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
  tildaSignature: 'подпись',
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

  it('listPending отдаёт ожидающие, старые первыми, и не отдаёт завершённые', () => {
    store.createOrder({ ...образец, tildaOrderId: 'a:1', token: 'т1', createdAt: 300 });
    store.createOrder({ ...образец, tildaOrderId: 'a:2', token: 'т2', createdAt: 100 });
    const третий = store.createOrder({ ...образец, tildaOrderId: 'a:3', token: 'т3', createdAt: 200 });
    store.updateState(третий.id, 'уведомлён');

    const список = store.listPending(10);
    expect(список.map((o) => o.tildaOrderId)).toEqual(['a:2', 'a:1']);
  });

  it('считает попытки уведомления и помнит исход последней', () => {
    const о = store.createOrder(образец);
    store.markNotified(о.id, false, 1);
    store.markNotified(о.id, true, 2);
    const после = store.findByToken('ткн-1');
    expect(после?.notifyAttempts).toBe(2);
    expect(после?.notifiedOk).toBe(1);
  });
});
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
cd tilda-server && npm test -- db
```

- [ ] **Шаг 4: Написать `src/db.ts`**

Схема:

```sql
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
  tilda_signature TEXT,
  tx_signature    TEXT,
  notify_url      TEXT,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  notified_ok     INTEGER NOT NULL DEFAULT 0,
  customer_email  TEXT,
  description     TEXT,
  products_json   TEXT
);
CREATE INDEX IF NOT EXISTS orders_state_created ON orders (state, created_at);
```

Требования:
- открывать через `node:sqlite`, включать `PRAGMA journal_mode = WAL` и
  `PRAGMA foreign_keys = ON`;
- `UNIQUE` на `tilda_order_id` — единственная настоящая защита от двух
  заказов с одним номером; нарушение ограничения превращать в
  `DuplicateOrderError`, а не в голое исключение SQLite;
- суммы и курс хранить **строками**, не числами с плавающей точкой;
- `listPending` отбирает `state IN ('ожидает')` плюс `просрочен`, у которых
  `created_at` укладывается в окно поздних платежей, сортировка
  `created_at ASC`.

- [ ] **Шаг 5: Тесты зелёные, коммит и слияние**

```bash
cd tilda-server && npm test
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: хранилище заказов на встроенном SQLite"
git checkout main && git merge --no-ff feat/tilda-store && git push origin main
```

---

### Задача 4: Логика состояний

**Файлы:**
- Создать: `tilda-server/src/decision.ts`
- Тест: `tilda-server/tests/decision.test.ts`

**Интерфейсы:**
- Потребляет: `OrderState` из задачи 3; `PaymentStatus` из `@solanapaykz/core`.
- Отдаёт: `decide(params: DecideParams): Decision`.
- Отдаёт: `interface DecideParams` — `status: PaymentStatus`,
  `orderState: OrderState`, `expiresAt: number`, `createdAt: number`,
  `lateWindowSeconds: number`, `now: number`.
- Отдаёт: `type Decision` —
  `{ action: 'ждать' } | { action: 'оплачен'; signature: string } |
   { action: 'просрочен' } | { action: 'не сошлось'; signature: string; reason: string } |
   { action: 'поздний'; signature: string }`, у каждого поле `note: string`
  с текстом для заметки продавцу.

Этот модуль не ходит в сеть и не трогает базу. Причина та же, что была в
плагине WooCommerce: здесь легко ошибиться сразу в нескольких случаях —
подтверждённый платёж, платёж после срока, платёж по уже закрытому заказу,
несовпадение суммы, недоступный узел, — а проверить их вживую почти
невозможно: пришлось бы подгадывать сроки и состояния.

**Правила, каждое с ценой ошибки:**

1. Заказ не в состоянии `ожидает` и не `просрочен` — `ждать`. Действуем
   только на незакрытых заказах: белый список, а не чёрный, иначе
   неучтённое состояние провалится в общую логику.
2. `status.status === 'confirmed'` и заказ `ожидает` — `оплачен`.
3. `confirmed` и заказ `просрочен`, но `now - createdAt <= lateWindowSeconds`
   — `поздний`. Деньги уже у продавца; отменять нельзя.
4. `confirmed` и окно поздних платежей вышло — всё равно `поздний`, а не
   `ждать`: платёж существует, и продавец обязан о нём узнать.
5. `mismatch` — `не сошлось`. Никогда не отменять и не подтверждать: транзакция
   есть, но не сходится, это разбирает человек.
6. `pending` и срок не вышел — `ждать`.
7. `pending`, срок вышел, заказ ещё `ожидает` — `просрочен`.
8. `expired` от SDK трактуется как `pending`: решение о просрочке принимаем по
   **нашему** сроку из записи заказа, а не по чужому вычислению. SDK считает
   истечение по своей копии котировки и своим часам; расхождение двух
   источников правды о времени — это ровно та ошибка, которую мы уже
   исправляли в браузерном отсчёте плагина.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-decision
```

- [ ] **Шаг 2: Написать падающий тест**

`tilda-server/tests/decision.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decide } from '../src/decision.js';

const основа = {
  createdAt: 1000,
  expiresAt: 1900,
  lateWindowSeconds: 86400,
  now: 1500,
};

describe('decide', () => {
  it('подтверждённый платёж в срок — оплачен', () => {
    const р = decide({
      ...основа,
      orderState: 'ожидает',
      status: { status: 'confirmed', signature: 'п1', amountPaid: '32.64' },
    });
    expect(р.action).toBe('оплачен');
  });

  it('платёж не пришёл, срок не вышел — ждать', () => {
    const р = decide({ ...основа, orderState: 'ожидает', status: { status: 'pending' } });
    expect(р.action).toBe('ждать');
  });

  it('платёж не пришёл, срок вышел — просрочен', () => {
    const р = decide({ ...основа, now: 2000, orderState: 'ожидает', status: { status: 'pending' } });
    expect(р.action).toBe('просрочен');
  });

  it('платёж пришёл после срока, в пределах окна — поздний, НЕ отмена', () => {
    const р = decide({
      ...основа,
      now: 5000,
      orderState: 'просрочен',
      status: { status: 'confirmed', signature: 'п2', amountPaid: '32.64' },
    });
    expect(р.action).toBe('поздний');
  });

  it('платёж пришёл далеко за окном — всё равно поздний: продавец должен узнать', () => {
    const р = decide({
      ...основа,
      now: 1000 + 86400 * 3,
      orderState: 'просрочен',
      status: { status: 'confirmed', signature: 'п3', amountPaid: '32.64' },
    });
    expect(р.action).toBe('поздний');
  });

  it('несовпадение суммы не отменяет и не подтверждает', () => {
    const р = decide({
      ...основа,
      now: 5000,
      orderState: 'ожидает',
      status: { status: 'mismatch', signature: 'п4', reason: 'сумма меньше' },
    });
    expect(р.action).toBe('не сошлось');
  });

  it('уже оплаченный заказ не трогаем даже при повторном подтверждении', () => {
    const р = decide({
      ...основа,
      orderState: 'оплачен',
      status: { status: 'confirmed', signature: 'п5', amountPaid: '32.64' },
    });
    expect(р.action).toBe('ждать');
  });

  it('уведомлённый заказ не трогаем', () => {
    const р = decide({
      ...основа,
      orderState: 'уведомлён',
      status: { status: 'confirmed', signature: 'п6', amountPaid: '32.64' },
    });
    expect(р.action).toBe('ждать');
  });

  it('заказ на ручном разборе не трогаем автоматикой', () => {
    const р = decide({
      ...основа,
      orderState: 'не сошлось',
      status: { status: 'confirmed', signature: 'п7', amountPaid: '32.64' },
    });
    expect(р.action).toBe('ждать');
  });

  it('заметка при несовпадении содержит причину и подпись транзакции', () => {
    const р = decide({
      ...основа,
      now: 5000,
      orderState: 'ожидает',
      status: { status: 'mismatch', signature: 'п8', reason: 'сумма меньше' },
    });
    expect(р.note).toContain('п8');
    expect(р.note).toContain('сумма меньше');
  });

  it('статус expired от SDK на невышедшем сроке всё равно даёт ждать', () => {
    const р = decide({ ...основа, orderState: 'ожидает', status: { status: 'expired' } });
    expect(р.action).toBe('ждать');
  });

  it('платёж пришёл ровно на границе: заказ ещё «ожидает», а срок уже вышел', () => {
    // Браузер опрашивает каждые несколько секунд, поэтому состояние заказа
    // отстаёт от часов. Заказ ещё не помечен просроченным, но срок истёк —
    // это «поздний», а не «оплачен»: цена уже не действует.
    const р = decide({
      ...основа,
      now: 2000,
      orderState: 'ожидает',
      status: { status: 'confirmed', signature: 'п9', amountPaid: '32.64' },
    });
    expect(р.action).toBe('поздний');
  });
});
```

- [ ] **Шаг 3: Убедиться, что тест падает**

```bash
cd tilda-server && npm test -- decision
```

- [ ] **Шаг 4: Написать `src/decision.ts`**

Код ниже прогнан целиком до попадания в план: 12 проверок, ошибок нет.
Переносить как есть, включая комментарии — они объясняют, почему решение
именно такое.

```ts
import type { PaymentStatus } from '@solanapaykz/core';
import type { OrderState } from './db.js';

export interface DecideParams {
  status: PaymentStatus;
  orderState: OrderState;
  expiresAt: number;
  createdAt: number;
  lateWindowSeconds: number;
  now: number;
}

export type Decision =
  | { action: 'ждать'; note: string }
  | { action: 'оплачен'; signature: string; note: string }
  | { action: 'просрочен'; note: string }
  | { action: 'не сошлось'; signature: string; reason: string; note: string }
  | { action: 'поздний'; signature: string; note: string };

export function decide({
  status,
  orderState,
  expiresAt,
  createdAt,
  lateWindowSeconds,
  now,
}: DecideParams): Decision {
  const ждать = (почему: string): Decision => ({ action: 'ждать', note: почему });

  // Белый список, а не чёрный: неучтённое состояние не должно провалиться
  // в общую логику и оказаться отменённым или завершённым.
  if (orderState !== 'ожидает' && orderState !== 'просрочен') {
    return ждать(`Заказ в состоянии «${orderState}» — автоматика его не трогает.`);
  }

  if (status.status === 'confirmed') {
    if (orderState === 'ожидает' && now <= expiresAt) {
      return {
        action: 'оплачен',
        signature: status.signature,
        note: `Платёж получен. Транзакция: ${status.signature}.`,
      };
    }

    // Платёж после истечения цены. Деньги уже у продавца — отменять нельзя
    // ни в пределах окна поздних платежей, ни за ним.
    const заОкном = now - createdAt > lateWindowSeconds;

    return {
      action: 'поздний',
      signature: status.signature,
      note:
        `Платёж получен после истечения цены${заОкном ? ' и за пределами окна поздних платежей' : ''}. ` +
        `Транзакция: ${status.signature}. Проверьте сумму перед отгрузкой.`,
    };
  }

  if (status.status === 'mismatch') {
    // Транзакция есть, но не сходится. Это разбирает человек: автоматика
    // ошибается здесь дороже.
    return {
      action: 'не сошлось',
      signature: status.signature,
      reason: status.reason,
      note:
        `Найдена транзакция ${status.signature}, но она не прошла проверку: ${status.reason}. ` +
        'Проверьте её вручную, прежде чем отгружать заказ.',
    };
  }

  // pending и expired от SDK: о просрочке судим по нашему сроку из записи
  // заказа, а не по чужому вычислению на чужих часах.
  if (orderState === 'ожидает' && now > expiresAt) {
    return { action: 'просрочен', note: 'Срок действия цены истёк, платёж не найден.' };
  }

  return ждать('Платёж пока не найден.');
}
```

- [ ] **Шаг 5: Убедиться, что тесты проходят**

```bash
cd tilda-server && npm test
```

- [ ] **Шаг 6: Коммит и слияние**

```bash
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: логика состояний заказа без обращений к сети и базе"
git checkout main && git merge --no-ff feat/tilda-decision && git push origin main
```

---

### Задача 5: Вход от Tilda и создание заказа

**Файлы:**
- Создать: `tilda-server/src/payments.ts`, `tilda-server/src/tilda/inbound.ts`
- Тест: `tilda-server/tests/inbound.test.ts`

**Интерфейсы:**
- Потребляет: `verifySignature` (задача 2), `Store`, `NewOrder`,
  `DuplicateOrderError` (задача 3), `Config` (задача 1).
- Отдаёт: `parseTildaOrder(body: Record<string, string>): TildaOrder` —
  разбирает поля, не падая на незнакомых.
- Отдаёт: `interface TildaOrder` — `orderId: string`, `amountKzt: string`,
  `currency: string`, `timestamp: string`, `testMode: boolean`,
  `description: string | null`, `products: unknown[] | null`,
  `email: string | null`, `phone: string | null`,
  `customerName: string | null`, `notifyUrl: string | null`,
  `successUrl: string | null`, `failureUrl: string | null`,
  `signature: string`.
- Отдаёт: `проверитьЗаказ(order: TildaOrder, body: Record<string, string>, secret: string): void`
  — сверяет подпись, валюту и формат суммы; бросает при первом несоответствии.
- Отдаёт: `createPaymentFor(order: TildaOrder, deps): Promise<Order>` —
  идемпотентно: для уже известного номера заказа возвращает существующую
  запись, не выпуская новую котировку и новую метку.
- Отдаёт: `class SignatureError`, `class CurrencyError`, `class AmountError`.

**Идемпотентность — главное требование этой задачи.** В плагине WooCommerce
ревью нашло ровно такую ошибку: повторное нажатие «Оплатить» перевыпускало
метку платежа, и уже отправленные деньги теряли связь с заказом. Здесь то же
самое случается, когда покупатель возвращается к оплате или обновляет
страницу: Tilda пришлёт тот же номер заказа. Ответ обязан быть той же
котировкой, той же суммой, той же меткой.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-inbound
```

- [ ] **Шаг 2: Написать падающий тест**

`tilda-server/tests/inbound.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CurrencyError, parseTildaOrder, SignatureError, проверитьЗаказ } from '../src/tilda/inbound.js';
import { signFields } from '../src/signature.js';

const секрет = 'секрет-заказа';

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
    notify_url: 'https://tilda.cc/payment/notify/abc',
    ...изменения,
  };
  return { ...поля, signature: signFields(поля, секрет) };
}

describe('parseTildaOrder', () => {
  it('разбирает обязательные поля', () => {
    const з = parseTildaOrder(телоЗаказа());
    expect(з.orderId).toBe('10868059:42');
    expect(з.amountKzt).toBe('15000');
    expect(з.testMode).toBe(false);
  });

  it('не падает на незнакомых полях: состав запроса Tilda может измениться', () => {
    expect(() => parseTildaOrder({ ...телоЗаказа(), неизвестное_поле: 'что-то' })).not.toThrow();
  });

  it('пустые необязательные поля становятся null, а не пустой строкой', () => {
    const з = parseTildaOrder(телоЗаказа({ email: '', description: '' }));
    expect(з.email).toBeNull();
    expect(з.description).toBeNull();
  });

  it('испорченный JSON состава корзины не роняет разбор', () => {
    const з = parseTildaOrder(телоЗаказа({ products: 'не json' }));
    expect(з.products).toBeNull();
  });
});

describe('проверитьЗаказ', () => {
  it('принимает заказ с верной подписью в тенге', () => {
    expect(() => проверитьЗаказ(парс(телоЗаказа()), телоЗаказа(), секрет)).not.toThrow();
  });

  it('отвергает подделанную сумму', () => {
    const тело = телоЗаказа();
    const подделка = { ...тело, amount: '1' };
    expect(() => проверитьЗаказ(парс(подделка), подделка, секрет)).toThrow(SignatureError);
  });

  it('отвергает чужую валюту: считать в неё мы не умеем', () => {
    const тело = телоЗаказа({ currency: 'USD' });
    expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow(CurrencyError);
  });

  it('отвергает отрицательную и нулевую сумму', () => {
    for (const сумма of ['0', '-100']) {
      const тело = телоЗаказа({ amount: сумма });
      expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow();
    }
  });

  it('отвергает сумму с посторонними символами', () => {
    const тело = телоЗаказа({ amount: '15 000,00' });
    expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow();
  });
});

function парс(тело: Record<string, string>) {
  return parseTildaOrder(тело);
}
```

- [ ] **Шаг 3: Убедиться, что падает; написать `src/tilda/inbound.ts`**

Требования:
- `parseTildaOrder` не бросает на незнакомых полях и на испорченном JSON;
- `проверитьЗаказ` сначала сверяет подпись, и только потом смотрит на
  содержимое: незаверенные данные не должны влиять даже на текст ошибки;
- валюта обязана быть `KZT` — иначе `CurrencyError`; это прямое следствие
  находки в плагине, где расчёт по валюте, отличной от валюты магазина,
  занижал сумму в 460 раз;
- сумма проверяется тем же предикатом, что и в SDK: только цифры и,
  возможно, точка с дробной частью; пробелы, запятые и знак минус
  отвергаются.

- [ ] **Шаг 4: Написать `src/payments.ts`**

Тонкая обёртка над `@solanapaykz/core`:

```ts
import { SolanaPayKZ } from '@solanapaykz/core';
import type { Config } from './config.js';

export function создатьКлиент(config: Config): SolanaPayKZ {
  return new SolanaPayKZ({
    recipient: config.recipient,
    rpcUrl: config.rpcUrl,
    cluster: config.cluster,
    markupPercent: config.markupPercent,
    quoteTtlMs: config.quoteTtlSeconds * 1000,
  });
}
```

Своих расчётов здесь нет и быть не должно: формулы живут в SDK, уже прошли
ревью и сверены с реализацией на PHP на 243 случаях.

- [ ] **Шаг 5: Написать `createPaymentFor` с идемпотентностью**

Порядок:
1. `store.findByTildaOrderId(order.orderId)` — если заказ есть, вернуть его
   **как есть**, ничего не создавая и не пересчитывая;
2. иначе `client.createQuote({ amountKzt, token })`;
3. `client.createPaymentRequest(quote, { label, message })`;
4. случайный ключ страницы: `randomBytes(16).toString('hex')`;
5. `store.createOrder(...)`;
6. если `createOrder` бросил `DuplicateOrderError` — значит параллельный
   запрос успел раньше: перечитать и вернуть его заказ. Проверка «есть ли
   уже» и вставка — это «прочитать, потом записать»; единственная настоящая
   защита здесь — ограничение `UNIQUE` в базе.

- [ ] **Шаг 6: Тест на недоступный курс**

```ts
it('недоступный курс не создаёт заказ: продажа по неизвестному курсу хуже отказа', async () => {
  await expect(createPaymentFor(заказ, { ...deps, client: клиентБезКурса() })).rejects.toThrow();
  expect(store.findByTildaOrderId(заказ.orderId)).toBeNull();
});
```

- [ ] **Шаг 7: Тест на идемпотентность**

```ts
it('повторный запрос с тем же номером не выпускает новую метку', async () => {
  const первый = await createPaymentFor(заказ, deps);
  const второй = await createPaymentFor(заказ, deps);
  expect(второй.id).toBe(первый.id);
  expect(второй.reference).toBe(первый.reference);
  expect(второй.amountToken).toBe(первый.amountToken);
  expect(второй.token).toBe(первый.token);
});
```

- [ ] **Шаг 8: Тесты зелёные, коммит и слияние**

```bash
cd tilda-server && npm test
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: приём заказа от Tilda с проверкой подписи и идемпотентностью"
git checkout main && git merge --no-ff feat/tilda-inbound && git push origin main
```

---

### Задача 6: Страница оплаты

**Файлы:**
- Создать: `tilda-server/src/http/server.ts`, `src/http/routes-pay.ts`,
  `src/http/routes-page.ts`, `src/http/html.ts`
- Создать: `tilda-server/public/checkout.js`, `public/checkout.css`
- Тест: `tilda-server/tests/http.test.ts`

**Интерфейсы:**
- Потребляет: `createPaymentFor`, `проверитьЗаказ`, `parseTildaOrder`
  (задача 5), `Store` (задача 3), `Config` (задача 1).
- Отдаёт: `createServer(deps): http.Server`.
- Маршруты:
  - `POST /tilda/pay` — вход основного пути; отвечает 303 с переходом на
    `/pay/<ключ>`;
  - `GET /pay/:token` — страница оплаты;
  - `GET /api/status/:token` — состояние заказа для опроса;
  - `GET /assets/checkout.js`, `GET /assets/checkout.css`.

QR берётся готовым из SDK — поле `qrSvg` у `PaymentRequest`. Библиотека для
браузера не нужна, рисовать в JavaScript нечего.

**Что отдаёт `/api/status/:token`:** только `state`, человекочитаемый текст и
`secondsLeft`. Ни суммы, ни адреса получателя, ни метки платежа: страница уже
показала их тому, кто знает ключ, а ответ опроса — лишний канал утечки.

**Отсчёт времени** ведётся от `secondsLeft`, полученного с сервера, а не от
абсолютного времени истечения. Часы покупателя могут врать на час: в плагине
это давало «срок оплаты истёк» на живой котировке.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-payment-page
```

- [ ] **Шаг 2: Тест на маршруты**

```ts
it('POST /tilda/pay с верной подписью уводит на страницу оплаты', async () => {
  const ответ = await запрос('POST', '/tilda/pay', телоЗаказа());
  expect(ответ.status).toBe(303);
  expect(ответ.headers.location).toMatch(/^\/pay\/[0-9a-f]{32}$/);
});

it('POST /tilda/pay с подделанной подписью не создаёт заказ', async () => {
  const тело = { ...телоЗаказа(), amount: '1' };
  const ответ = await запрос('POST', '/tilda/pay', тело);
  expect(ответ.status).toBe(400);
  expect(store.findByTildaOrderId('10868059:42')).toBeNull();
});

it('GET /pay/<чужой ключ> отвечает 404 тем же телом, что и несуществующий', async () => {
  const а = await запрос('GET', '/pay/' + 'a'.repeat(32));
  const б = await запрос('GET', '/pay/' + 'b'.repeat(32));
  expect(а.status).toBe(404);
  expect(а.body).toBe(б.body);
});

it('ответ опроса не содержит ни суммы, ни адреса получателя, ни метки', async () => {
  const о = store.createOrder(образец);
  const ответ = await запрос('GET', `/api/status/${о.token}`);
  expect(ответ.body).not.toContain(о.recipient);
  expect(ответ.body).not.toContain(о.reference);
  expect(ответ.body).not.toContain(о.amountToken);
});

it('страница оплаты экранирует описание заказа', async () => {
  const о = store.createOrder({ ...образец, description: '<script>alert(1)</script>' });
  const ответ = await запрос('GET', `/pay/${о.token}`);
  expect(ответ.body).not.toContain('<script>alert(1)</script>');
  expect(ответ.body).toContain('&lt;script&gt;');
});
```

- [ ] **Шаг 3: Написать маршруты и разметку**

Требования:
- всё, что попадает в разметку, экранируется — описание и названия товаров
  приходят из неподписанной части запроса и правятся покупателем;
- страница отдаётся с `Content-Security-Policy: default-src 'self'` и
  `X-Content-Type-Options: nosniff`;
- `/pay/:token` на завершённом заказе показывает итог, а не QR: показывать
  QR оплаченному заказу — приглашение заплатить второй раз;
- ключ страницы сверяется через `timingSafeEqual`, ответ 404 одинаков для
  несуществующего и чужого.

- [ ] **Шаг 4: Написать `public/checkout.js`**

Требования:
- следующий опрос планируется **после** ответа, а не по расписанию: иначе при
  медленном узле запросы накладываются;
- флаг остановки проверяется перед планированием следующего опроса — иначе
  уже отправленный запрос воскресит опрос после остановки;
- после истечения отсчёта опрос продолжается ещё три минуты с честным
  текстом: платёж мог уйти за секунду до конца, а подтверждения ждать до
  минуты;
- при отсутствии `fetch` показать покупателю прямую ссылку, а не пустой блок;
- у блока статуса `role="status"` и `aria-live="polite"`.

- [ ] **Шаг 5: Тесты зелёные, коммит и слияние**

```bash
cd tilda-server && npm test
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: страница оплаты с QR и опросом состояния"
git checkout main && git merge --no-ff feat/tilda-payment-page && git push origin main
```

---

### Задача 7: Проверка платежа, фоновый обход, уведомление Tilda

**Файлы:**
- Создать: `tilda-server/src/checker.ts`, `tilda-server/src/tilda/notify.ts`
- Изменить: `tilda-server/src/http/routes-page.ts` — опрос запускает проверку
- Тест: `tilda-server/tests/checker.test.ts`, `tests/notify.test.ts`

**Интерфейсы:**
- Потребляет: `decide` (задача 4), `Store` (задача 3), `создатьКлиент`
  (задача 5), `signFields` (задача 2).
- Отдаёт: `checkOrder(order: Order, deps): Promise<Decision>` — проверяет
  платёж и применяет решение к записи заказа.
- Отдаёт: `startChecker(deps): () => void` — запускает периодический обход,
  возвращает функцию остановки.
- Отдаёт: `notifyTilda(order: Order, deps): Promise<boolean>` — шлёт
  уведомление, возвращает признак приёма.

**Что уходит в Tilda:** `order_id`, `amount`, `currency`, `timestamp`,
`test_mode`, `status` со значением `paid`, `transaction` с подписью
транзакции Solana, `signature`. Подпись считается тем же правилом и по тем же
пяти полям, что и входящая, но секретом уведомления.

**Успехом считается только `OK` в теле ответа.** Код 200 с чужим телом — не
подтверждение: ровно так мы уже ошибались на доставке сообщений, считая
статус «отправлено» доставкой.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-checker
```

- [ ] **Шаг 2: Тесты проверки и обхода**

```ts
it('сбой узла не меняет состояние заказа', async () => {
  const о = store.createOrder(образец);
  const решение = await checkOrder(о, { ...deps, client: клиентКоторыйПадает() });
  expect(решение.action).toBe('ждать');
  expect(store.findByToken(о.token)?.state).toBe('ожидает');
});

it('расхождение сети в настройках и в заказе не трогает заказ', async () => {
  const о = store.createOrder({ ...образец, cluster: 'mainnet' });
  const решение = await checkOrder(о, { ...deps, config: { ...config, cluster: 'devnet' } });
  expect(решение.action).toBe('ждать');
  expect(store.findByToken(о.token)?.state).toBe('ожидает');
  expect(журнал.последняя()).toContain('сеть');
});

it('подтверждённый платёж переводит заказ в «оплачен» и сохраняет подпись', async () => {
  const о = store.createOrder(образец);
  await checkOrder(о, { ...deps, client: клиентСПлатежом('подпись-1') });
  const после = store.findByToken(о.token);
  expect(после?.state).toBe('оплачен');
  expect(после?.txSignature).toBe('подпись-1');
});

it('один платёж не порождает двух уведомлений', async () => {
  const о = store.createOrder(образец);
  await checkOrder(о, { ...deps, client: клиентСПлатежом('подпись-1') });
  await checkOrder(store.findByToken(о.token)!, { ...deps, client: клиентСПлатежом('подпись-1') });
  expect(счётчикОтправок.значение).toBe(1);
});

it('обход берёт только незакрытые заказы, старые первыми', async () => {
  store.createOrder({ ...образец, tildaOrderId: 'a:1', token: 'т1', createdAt: 300 });
  store.createOrder({ ...образец, tildaOrderId: 'a:2', token: 'т2', createdAt: 100 });
  const закрытый = store.createOrder({ ...образец, tildaOrderId: 'a:3', token: 'т3', createdAt: 200 });
  store.updateState(закрытый.id, 'уведомлён');

  const обойдённые: string[] = [];
  await обходОдинРаз({ ...deps, наЗаказ: (o: Order) => обойдённые.push(o.tildaOrderId) });

  expect(обойдённые).toEqual(['a:2', 'a:1']);
});

it('падение проверки одного заказа не прерывает обход остальных', async () => {
  store.createOrder({ ...образец, tildaOrderId: 'b:1', token: 'к1', createdAt: 100 });
  store.createOrder({ ...образец, tildaOrderId: 'b:2', token: 'к2', createdAt: 200 });

  const обойдённые: string[] = [];
  await обходОдинРаз({
    ...deps,
    наЗаказ: (o: Order) => {
      обойдённые.push(o.tildaOrderId);
      if (o.tildaOrderId === 'b:1') throw new Error('узел недоступен');
    },
  });

  expect(обойдённые).toEqual(['b:1', 'b:2']);
});
```

Тесты уведомления:

```ts
it('подписывает уведомление секретом уведомления, а не секретом заказа', async () => {
  const отправленное = await перехватитьОтправку(() => notifyTilda(заказ, deps));
  expect(отправленное.signature).toBe(signFields(отправленное, config.notifySecret));
  expect(отправленное.signature).not.toBe(signFields(отправленное, config.orderSecret));
});

it('считает успехом только тело OK', async () => {
  expect(await notifyTilda(заказ, { ...deps, отправка: ответ(200, 'OK') })).toBe(true);
  expect(await notifyTilda(заказ, { ...deps, отправка: ответ(200, 'что-то другое') })).toBe(false);
  expect(await notifyTilda(заказ, { ...deps, отправка: ответ(500, 'OK') })).toBe(false);
});

it('повторяет с нарастающими паузами и запоминает число попыток', async () => {
  await notifyTilda(заказ, { ...deps, отправка: падаетДважды() });
  const после = store.findByToken(заказ.token);
  expect(после?.notifyAttempts).toBe(3);
  expect(после?.notifiedOk).toBe(1);
});

it('исчерпав попытки, оставляет заказ оплаченным, но не уведомлённым', async () => {
  await notifyTilda(заказ, { ...deps, отправка: всегдаПадает() });
  const после = store.findByToken(заказ.token);
  expect(после?.state).toBe('оплачен');
  expect(после?.notifiedOk).toBe(0);
});
```

- [ ] **Шаг 3: Написать `src/tilda/notify.ts`**

Требования:
- паузы между попытками 1, 5, 15, 60 секунд, не более пяти попыток;
- тайм-аут одного запроса 10 секунд;
- перед отправкой пометить попытку в базе, а не после: падение процесса
  между отправкой и записью не должно приводить к повторной отправке;
- в журнал писать номер заказа и исход, но не подпись и не секрет.

- [ ] **Шаг 4: Написать `src/checker.ts`**

Требования:
- перед изменением состояния перечитать заказ из базы;
- заказ, по которому идёт проверка, блокировать на время проверки — иначе
  опрос из браузера и фоновый обход могут одновременно перевести его в
  «оплачен» и отправить два уведомления. Блокировка в памяти процесса
  достаточна: процесс один;
- интервал обхода 60 секунд, за один проход не более 30 заказов;
- сбой одного заказа не прерывает обход остальных.

- [ ] **Шаг 5: Тесты зелёные, коммит и слияние**

```bash
cd tilda-server && npm test
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: проверка платежа, фоновый обход и уведомление Tilda"
git checkout main && git merge --no-ff feat/tilda-checker && git push origin main
```

---

### Задача 8: Письмо продавцу и список заказов

**Файлы:**
- Создать: `tilda-server/src/mailer.ts`, `tilda-server/src/http/routes-admin.ts`
- Тест: `tilda-server/tests/mailer.test.ts`, `tests/admin.test.ts`

**Интерфейсы:**
- Потребляет: `Store` (задача 3), `Config` (задача 1).
- Отдаёт: `sendMerchantMail(order: Order, decision: Decision, deps): Promise<boolean>`.
- Отдаёт: маршруты `GET /admin`, `POST /admin/login`, `POST /admin/logout`.

**Письмо** содержит: номер заказа Tilda, сумму в тенге, сумму в токенах,
курс и источник курса, подпись транзакции со ссылкой на обозреватель,
состояние. Не содержит: секретов, адреса узла, ключа страницы оплаты.

**Список заказов** — одна страница: номер, дата, сумма, состояние, подпись
транзакции ссылкой, отметка «Tilda подтвердила» либо «Tilda не подтвердила».
Последнее — не украшение: без него нечем заметить, что заказ оплачен, а
магазин об этом не знает.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-admin
```

- [ ] **Шаг 2: Тесты входа**

```ts
it('без входа список не отдаётся', async () => {
  const ответ = await запрос('GET', '/admin');
  expect(ответ.status).toBe(303);
  expect(ответ.body).not.toContain('10868059:42');
});

it('неверный пароль не пускает и не подсказывает, что именно неверно', async () => {
  const ответ = await запрос('POST', '/admin/login', { password: 'не тот' });
  expect(ответ.status).toBe(401);
  expect(ответ.body).not.toMatch(/пароль верн|такого пользователя/i);
});

it('после пяти неудачных попыток вход отвечает отказом независимо от пароля', async () => {
  for (let i = 0; i < 5; i++) await запрос('POST', '/admin/login', { password: 'не тот' });
  const ответ = await запрос('POST', '/admin/login', { password: config.adminPassword });
  expect(ответ.status).toBe(429);
});

it('кука сессии помечена HttpOnly, Secure и SameSite=Strict', async () => {
  const ответ = await запрос('POST', '/admin/login', { password: config.adminPassword });
  const кука = ответ.headers['set-cookie']?.[0] ?? '';
  expect(кука).toContain('HttpOnly');
  expect(кука).toContain('Secure');
  expect(кука).toContain('SameSite=Strict');
});

it('в списке видно, что заказ оплачен, но Tilda не подтвердила', async () => {
  const о = store.createOrder(образец);
  store.updateState(о.id, 'оплачен');
  store.markNotified(о.id, false, 5);
  const ответ = await запросСВходом('GET', '/admin');
  expect(ответ.body).toContain('Tilda не подтвердила');
});
```

- [ ] **Шаг 3: Написать почту и список**

Требования:
- пароль сравнивается `timingSafeEqual`, ограничение — пять попыток за
  пятнадцать минут на адрес;
- сессия — подписанная кука со сроком 12 часов, ключ из секрета настроек;
- неудача отправки письма записывается в журнал и видна в списке, но
  состояние заказа не меняет: почта не источник правды о платеже;
- все значения в разметке экранируются.

- [ ] **Шаг 4: Тесты зелёные, коммит и слияние**

```bash
cd tilda-server && npm test
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: письмо продавцу и список заказов под паролем"
git checkout main && git merge --no-ff feat/tilda-admin && git push origin main
```

---

### Задача 9: Запасной вход, имитатор Tilda, развёртывание и документация

**Файлы:**
- Создать: `tilda-server/src/http/routes-webhook.ts`
- Создать: `tilda-server/tools/fake-tilda.ts`
- Создать: `tilda-server/Dockerfile`, `docker-compose.yml`, `README.md`
- Создать: `tilda-server/nginx.example.conf`
- Тест: `tilda-server/tests/webhook.test.ts`, `tests/e2e.test.ts`

**Запасной вход** `POST /tilda/webhook`: принимает вебхук формы Tilda.
Отличия от основного входа, которые обязан помнить исполнитель:
- Tilda проверяет доступность запросом с полем `test=test` и ждёт ответ 200
  в течение **пяти секунд** — отвечать сразу, не дожидаясь курса и создания
  заказа;
- поля приходят с заглавной буквы (`Email`, `Name`, `Phone`), номер заявки —
  в `tranid`;
- подписи нет вовсе. Значит уведомить Tilda об оплате нечем, и заказ у неё
  останется «не оплачен». Сумму берём из тела вебхука — другого источника
  нет, но приходит он **на сервер**, а не через браузер покупателя, поэтому
  подмена покупателем исключена;
- при неудаче Tilda повторит дважды с интервалом в минуту — обработчик
  обязан быть идемпотентным по `tranid`.

**Имитатор Tilda** — отдельная программа, которая:
1. шлёт на наш `POST /tilda/pay` подписанное тело заказа;
2. поднимает свой слушатель и принимает наше уведомление;
3. проверяет подпись уведомления **своей** реализацией, а не нашей;
4. умеет отвечать `OK`, отвечать мусором и не отвечать вовсе.

Третий пункт важен: проверка нашей подписи нашим же кодом доказывает только
самосогласованность. Имитатор считает подпись независимо, по описанию
протокола, а не вызовом нашей функции.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout -b feat/tilda-deploy
```

- [ ] **Шаг 2: Сквозной тест через имитатор**

```ts
it('весь путь: заказ от Tilda, оплата, уведомление принято', async () => {
  const имитатор = await запуститьИмитатор({ отвечать: 'OK' });
  await имитатор.оформитьЗаказ({ amount: '15000' });
  await подтвердитьПлатёжВЦепочке();
  await дождаться(() => имитатор.полученныеУведомления.length === 1);
  const у = имитатор.полученныеУведомления[0]!;
  expect(имитатор.подписьВерна(у)).toBe(true);
  expect(у.status).toBe('paid');
  expect(store.findByTildaOrderId(у.order_id)?.state).toBe('уведомлён');
});

it('Tilda отвечает мусором — заказ остаётся оплаченным, но не уведомлённым', async () => {
  const имитатор = await запуститьИмитатор({ отвечать: 'ой' });
  // ...
  expect(store.findByTildaOrderId(номер)?.state).toBe('оплачен');
  expect(store.findByTildaOrderId(номер)?.notifiedOk).toBe(0);
});

it('повторный заказ с тем же номером не создаёт второй записи', async () => {
  const имитатор = await запуститьИмитатор({ отвечать: 'OK' });
  await имитатор.оформитьЗаказ({ amount: '15000' });
  await имитатор.оформитьЗаказ({ amount: '15000' });
  expect(store.listRecent(10)).toHaveLength(1);
});
```

- [ ] **Шаг 3: Развёртывание**

`docker-compose.yml` рядом с уже существующим демо-магазином, свой том для
базы, перезапуск `unless-stopped`. Настройки — файл, смонтированный только на
чтение, права 600 на хосте.

`nginx.example.conf` — `pay.kabyldau.digital`, проксирование на локальный
порт, `client_max_body_size 64k`, передача настоящего адреса клиента.

- [ ] **Шаг 4: `README.md` для продавца**

На русском: что нужно (свой узел Solana, кошелёк, валюта магазина KZT),
как развернуть, как заполнить настройки, как создать интеграцию в Tilda —
пошагово, с точными значениями полей «списка соответствия» и правилом
подписи из задачи 2, — и как проверить тестовым платежом.

Отдельным абзацем: плагин никогда не запрашивает приватные ключи; любой, кто
просит их ввести, — мошенник.

- [ ] **Шаг 5: Поднять на pay.kabyldau.digital**

```bash
sudo certbot --nginx -d pay.kabyldau.digital
```
Проверить: адрес отвечает по HTTPS, `POST /tilda/pay` без подписи даёт 400,
`GET /admin` просит пароль.

- [ ] **Шаг 6: Подать заявку в Tilda**

Только после того, как адрес отвечает. Заполнить форму «Новая платежная
система (для разработчиков)»: название `SolanaPay-KZ`, почта
`ruslan@satybaldin.kz`, API URL `https://pay.kabyldau.digital/tilda/pay`,
соответствие полей и правило подписи — из задачи 2, признак успеха
`status` = `paid`, ответ об успехе `OK`, об ошибке `ERROR`.

**Текст заявки показать заказчику до отправки.** Отправляет заказчик либо я с
его явного разрешения — это действие от его имени на чужой площадке.

- [ ] **Шаг 7: Живая проверка настоящим платежом**

На devnet, настоящим кошельком: оформить заказ через имитатор, оплатить по
QR, убедиться, что заказ прошёл путь «ожидает» → «оплачен» → «уведомлён»,
письмо продавцу ушло, в списке заказов видна подпись транзакции.

Затем то же самое через живую Tilda, если шаблон к этому моменту одобрен.

- [ ] **Шаг 8: Коммит и слияние**

```bash
cd tilda-server && npm test
cd /var/www/solanapaykz
git add tilda-server && git commit -m "feat: запасной вход, имитатор Tilda, развёртывание и документация"
git checkout main && git merge --no-ff feat/tilda-deploy && git push origin main
```
