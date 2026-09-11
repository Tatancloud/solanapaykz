/**
 * `GET /admin` — список заказов под паролем; `GET /admin/login` — форма
 * входа; `POST /admin/login` — проверка пароля и выдача сессии;
 * `POST /admin/logout` — выход.
 *
 * Список — не украшение поверх писем продавцу (`../mailer.ts`): Tilda не
 * даёт пометить заказ оплаченным иначе как нашим уведомлением, и часть
 * заказов неизбежно застрянет — платёж есть, а Tilda о нём не знает, сумма
 * не сошлась, платёж пришёл после истечения цены. Это разбирает человек, и
 * ему нужна картина целиком, а не лента писем. Отметка «Tilda подтвердила»/
 * «Tilda не подтвердила» обязательна: без неё нечем заметить, что заказ
 * оплачен, а магазин об этом не знает.
 *
 * Безопасность входа:
 * - пароль сравнивается постоянным временем (`timingSafeEqual`);
 * - попытки входа ограничены — пять за пятнадцать минут на адрес,
 *   независимо от того, верным или неверным был очередной пароль;
 * - сессия — подписанная кука на 12 часов, ключ подписи — `adminPassword`
 *   из настроек (секрет уже существует и известен только серверу; отдельного
 *   секрета сессии заводить незачем, а утечка `adminPassword` и без того
 *   даёт вход напрямую, так что переиспользование не добавляет риска);
 * - кука — `HttpOnly`, `Secure`, `SameSite=Strict`.
 *
 * Всё, что в разметку списка попадает из заказа (номер, суммы, состояние,
 * подпись транзакции), экранируется через `экранироватьHtml` — те же
 * значения, что видит покупатель на странице оплаты, и по той же причине
 * (см. заголовок `html.ts`): формально они «наши», но подпись транзакции,
 * например, приходит из ответа RPC-узла, а не изнутри проекта.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Order } from '../db.js';
import { сбойОтправки, ссылкаНаТранзакцию } from '../mailer.js';
import { экранироватьHtml } from './html.js';
import { прочитатьТело, разобратьUrlencoded, ТелоСлишкомБольшое } from './routes-pay.js';
import type { ЗависимостиСервера } from './server.js';

const ЗАГОЛОВКИ_HTML = { 'content-type': 'text/html; charset=utf-8' } as const;
const ЗАГОЛОВКИ_ТЕКСТ = { 'content-type': 'text/plain; charset=utf-8' } as const;

const ИМЯ_КУКИ = 'admin_session';
const СРОК_СЕССИИ_СЕК = 12 * 60 * 60;

/* ---------------------------- сессия ---------------------------- */

/** Подписанный токен сессии: `<истекает-unix-сек>.<hex-hmac>`. Разделитель безопасен: первая часть — только цифры. */
function токенСессии(секрет: string, истекает: number): string {
  const подпись = createHmac('sha256', секрет).update(String(истекает)).digest('hex');
  return `${истекает}.${подпись}`;
}

function сессияДействительна(значение: string | undefined, секрет: string, сейчасСек: number): boolean {
  if (!значение) return false;
  const точка = значение.indexOf('.');
  if (точка < 0) return false;

  const истекаетСтрока = значение.slice(0, точка);
  const подпись = значение.slice(точка + 1);
  if (!/^\d+$/.test(истекаетСтрока)) return false;

  const ожидаемая = createHmac('sha256', секрет).update(истекаетСтрока).digest('hex');
  const а = Buffer.from(подпись, 'utf8');
  const б = Buffer.from(ожидаемая, 'utf8');
  if (а.length !== б.length || !timingSafeEqual(а, б)) return false;

  return Number(истекаетСтрока) > сейчасСек;
}

function прочитатьКуку(req: IncomingMessage, имя: string): string | undefined {
  const заголовок = req.headers.cookie;
  if (!заголовок) return undefined;
  for (const часть of заголовок.split(';')) {
    const равно = часть.indexOf('=');
    if (равно < 0) continue;
    if (часть.slice(0, равно).trim() === имя) return часть.slice(равно + 1).trim();
  }
  return undefined;
}

function естьСессия(req: IncomingMessage, deps: ЗависимостиСервера): boolean {
  const значение = прочитатьКуку(req, ИМЯ_КУКИ);
  return сессияДействительна(значение, deps.config.adminPassword, Math.floor(Date.now() / 1000));
}

/** `Secure` — кука уходит только по HTTPS; `HttpOnly` — недоступна из JS на странице; `SameSite=Strict` — не уходит с чужого сайта. Всё три — по заданию. */
function кукаВхода(значение: string): string {
  return `${ИМЯ_КУКИ}=${значение}; Path=/; Max-Age=${СРОК_СЕССИИ_СЕК}; HttpOnly; Secure; SameSite=Strict`;
}

const КУКА_ВЫХОДА = `${ИМЯ_КУКИ}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/* ------------------------- пароль, попытки ------------------------- */

function паролиСовпадают(введённый: string, ожидаемый: string): boolean {
  const а = Buffer.from(введённый, 'utf8');
  const б = Buffer.from(ожидаемый, 'utf8');
  // timingSafeEqual бросает на буферах разной длины — сравнение длины не
  // сравнением содержимого постоянным временем не является, но короче
  // ожидаемого пароль всё равно был бы отвергнут после полного сравнения;
  // ранний выход здесь экономит лишь на заведомо неверном пароле другой
  // длины, а не выдаёт ничего о содержимом (как и в `signature.ts`).
  if (а.length !== б.length) return false;
  return timingSafeEqual(а, б);
}

const ОКНО_ПОПЫТОК_MS = 15 * 60 * 1000;
const МАКСИМУМ_ПОПЫТОК = 5;

interface ЗаписьПопыток {
  count: number;
  windowStart: number;
}

function ipЗапроса(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'неизвестный-адрес';
}

/* ---------------------------- разметка ---------------------------- */

function обёртка(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${экранироватьHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

function страницаВхода(): string {
  return обёртка(
    'Вход',
    `<h1>Вход в список заказов</h1>
<form method="post" action="/admin/login">
  <label>Пароль <input type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">Войти</button>
</form>`,
  );
}

/** «Tilda подтвердила» / «Tilda не подтвердила» — обязательная отметка, см. заголовок файла. */
function отметкаTilda(order: Order): string {
  return order.notifiedOk === 1 ? 'Tilda подтвердила' : 'Tilda не подтвердила';
}

function транзакцияСсылкой(order: Order): string {
  if (!order.txSignature) return '—';
  const url = ссылкаНаТранзакцию(order.txSignature, order.cluster);
  return `<a href="${экранироватьHtml(url)}">${экранироватьHtml(order.txSignature)}</a>`;
}

/**
 * Если недавняя отправка письма продавцу по этому заказу провалилась —
 * видимая строка об этом (см. `../mailer.ts`, `сбойОтправки`). Неудача
 * письма не меняет состояние заказа, но обязана быть заметна человеку,
 * иначе она пройдёт мимо: почта не источник правды о платеже, и без этой
 * строки некому напомнить продавцу вручную проверить заказ.
 */
function строкаСбояПисьма(order: Order): string {
  const сбой = сбойОтправки(order.token);
  return сбой ? `Письмо не отправлено: ${экранироватьHtml(сбой.сообщение)}` : '';
}

function датаЗаказа(createdAtСек: number): string {
  return new Date(createdAtСек * 1000).toISOString();
}

function строкаЗаказа(order: Order): string {
  return `<tr>
<td>${экранироватьHtml(order.tildaOrderId)}</td>
<td>${экранироватьHtml(датаЗаказа(order.createdAt))}</td>
<td>${экранироватьHtml(order.amountKzt)} ₸ / ${экранироватьHtml(order.amountToken)} ${экранироватьHtml(order.tokenSymbol)}</td>
<td>${экранироватьHtml(order.state)}</td>
<td>${транзакцияСсылкой(order)}</td>
<td>${экранироватьHtml(отметкаTilda(order))}</td>
<td>${строкаСбояПисьма(order)}</td>
</tr>`;
}

/** Сколько последних заказов показывать. Список — рабочий инструмент разбора спорных случаев, а не архив: старые заказы, которые давно закрыты (уведомлён), человеку здесь искать незачем. */
const КОЛИЧЕСТВО_ЗАКАЗОВ_В_СПИСКЕ = 200;

function страницаСписка(заказы: Order[]): string {
  const строки = заказы.map(строкаЗаказа).join('');
  return обёртка(
    'Заказы',
    `<h1>Заказы</h1>
<form method="post" action="/admin/logout"><button type="submit">Выйти</button></form>
<table>
<thead>
<tr><th>Номер</th><th>Дата</th><th>Сумма</th><th>Состояние</th><th>Транзакция</th><th>Tilda</th><th>Письмо</th></tr>
</thead>
<tbody>${строки}</tbody>
</table>`,
  );
}

/* --------------------------- обработчики --------------------------- */

export interface AdminRoutes {
  список(req: IncomingMessage, res: ServerResponse, deps: ЗависимостиСервера): void;
  формаВхода(req: IncomingMessage, res: ServerResponse, deps: ЗависимостиСервера): void;
  вход(req: IncomingMessage, res: ServerResponse, deps: ЗависимостиСервера): Promise<void>;
  выход(req: IncomingMessage, res: ServerResponse): void;
}

/**
 * Создаёт обработчики маршрутов `/admin*` со своим собственным счётчиком
 * попыток входа. Счётчик — состояние процесса (сервер один на процесс, как
 * и `занятыеЗаказы` в `../checker.ts`): фабрика вызывается один раз в
 * `createServer`, так что на сервер приходится ровно один счётчик, а не по
 * одному на каждый запрос.
 */
export function createAdminRoutes(): AdminRoutes {
  const попыткиВхода = new Map<string, ЗаписьПопыток>();

  /** Свежа ли запись счётчика для адреса — окно истекает, счётчик обнуляется, а не копится вечно. */
  function записьВОкне(ip: string, сейчасMs: number): ЗаписьПопыток | undefined {
    const запись = попыткиВхода.get(ip);
    if (!запись || сейчасMs - запись.windowStart > ОКНО_ПОПЫТОК_MS) return undefined;
    return запись;
  }

  function лимитИсчерпан(ip: string, сейчасMs: number): boolean {
    const запись = записьВОкне(ip, сейчасMs);
    return запись !== undefined && запись.count >= МАКСИМУМ_ПОПЫТОК;
  }

  function отметитьНеудачу(ip: string, сейчасMs: number): void {
    const запись = записьВОкне(ip, сейчасMs);
    if (запись) {
      запись.count += 1;
    } else {
      попыткиВхода.set(ip, { count: 1, windowStart: сейчасMs });
    }
  }

  function сброситьПопытки(ip: string): void {
    попыткиВхода.delete(ip);
  }

  function список(req: IncomingMessage, res: ServerResponse, deps: ЗависимостиСервера): void {
    if (!естьСессия(req, deps)) {
      res.writeHead(303, { location: '/admin/login' });
      res.end();
      return;
    }
    const заказы = deps.store.listRecent(КОЛИЧЕСТВО_ЗАКАЗОВ_В_СПИСКЕ);
    res.writeHead(200, ЗАГОЛОВКИ_HTML);
    res.end(страницаСписка(заказы));
  }

  function формаВхода(req: IncomingMessage, res: ServerResponse, deps: ЗависимостиСервера): void {
    // Уже вошедшего незачем гонять через форму пароля второй раз.
    if (естьСессия(req, deps)) {
      res.writeHead(303, { location: '/admin' });
      res.end();
      return;
    }
    res.writeHead(200, ЗАГОЛОВКИ_HTML);
    res.end(страницаВхода());
  }

  async function вход(req: IncomingMessage, res: ServerResponse, deps: ЗависимостиСервера): Promise<void> {
    const ip = ipЗапроса(req);
    const сейчасMs = Date.now();

    // Лимит проверяется ДО чтения тела и ДО сравнения пароля: пятый и все
    // последующие запросы в окне отвергаются одинаково, независимо от
    // того, верный в них пароль или нет (см. тест «после пяти неудачных
    // попыток» — шестой запрос с ВЕРНЫМ паролем всё равно получает 429).
    if (лимитИсчерпан(ip, сейчасMs)) {
      res.writeHead(429, ЗАГОЛОВКИ_ТЕКСТ);
      res.end('Слишком много попыток входа. Попробуйте позже.');
      return;
    }

    let тело: string;
    try {
      тело = await прочитатьТело(req);
    } catch (е) {
      if (е instanceof ТелоСлишкомБольшое) {
        res.writeHead(413, ЗАГОЛОВКИ_ТЕКСТ);
        res.end('Тело запроса слишком велико', () => req.destroy());
        return;
      }
      throw е;
    }

    const поля = разобратьUrlencoded(тело);
    const введённыйПароль = поля.password ?? '';

    if (!паролиСовпадают(введённыйПароль, deps.config.adminPassword)) {
      отметитьНеудачу(ip, сейчасMs);
      // Ни введённого, ни ожидаемого пароля — в журнал: сам факт неудачи и
      // адрес достаточны для наблюдения за подбором.
      deps.log.warn('Неудачная попытка входа в список заказов', { ip });
      res.writeHead(401, ЗАГОЛОВКИ_ТЕКСТ);
      // Одна и та же фраза на любую причину отказа — без намёка, что
      // именно не сошлось (по заданию).
      res.end('Не удалось войти. Проверьте пароль.');
      return;
    }

    сброситьПопытки(ip);
    const истекаетСек = Math.floor(сейчасMs / 1000) + СРОК_СЕССИИ_СЕК;
    const токен = токенСессии(deps.config.adminPassword, истекаетСек);
    res.writeHead(303, { location: '/admin', 'set-cookie': кукаВхода(токен) });
    res.end();
  }

  function выход(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(303, { location: '/admin/login', 'set-cookie': КУКА_ВЫХОДА });
    res.end();
  }

  return { список, формаВхода, вход, выход };
}
