/**
 * Маршрутизация HTTP-запросов и создание сервера.
 *
 * Своего роутера нет намеренно: маршрутов пять, ни один не пересекается по
 * префиксу с другим, а зависимость вроде express тянула бы за собой куда
 * больше, чем даёт здесь выигрыша.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChecker, type PaymentCheckerClient } from '../checker.js';
import { loadConfig, type Config } from '../config.js';
import { openDatabase, type Store } from '../db.js';
import { createLog, type Log } from '../log.js';
import { создатьКлиент } from '../payments.js';
import type { PaymentClient } from '../tilda/inbound.js';
import type { Отправка } from '../tilda/notify.js';
import { страница404 } from './html.js';
import { createAdminRoutes } from './routes-admin.js';
import { обработатьTildaPay } from './routes-pay.js';
import { обработатьСтатус, обработатьСтраницуОплаты } from './routes-page.js';
import { обработатьTildaWebhook } from './routes-webhook.js';

/**
 * Тестовые крюки этого модуля — не для боевого кода. Собраны в одно
 * необязательное поле (`ЗависимостиСервера.тест`), а не рядом с настоящими
 * зависимостями: боевому бутстрапу, который однажды соберёт `ЗависимостиСервера`
 * из настроек, неоткуда взять значение для поля `тест` — у настроек такого
 * не бывает.
 */
export interface ЗависимостиСервераТест {
  /** Подменяет реальную отправку HTTP внутри `notifyTilda` (см. `checker.ts`). */
  отправка?: Отправка;
  /** Паузы между попытками уведомления (см. `tilda/notify.ts`). */
  задержкиMs?: readonly number[];
  /**
   * Сколько максимум ждать `checkOrder` на одном опросе, прежде чем
   * ответить по текущей записи в базе, не дожидаясь его возврата (см.
   * `routes-page.ts`). По умолчанию 8 секунд.
   */
  таймаутОпросаMs?: number;
}

/**
 * Всё, что нужно маршрутам: полные настройки (подпись, секреты), хранилище
 * заказов и клиент SDK — не весь `SolanaPayKZ`, чтобы в тестах его было чем
 * подменить без сети и RPC. `PaymentClient` (задача 5) даёт котировку и
 * платёжный запрос для `/tilda/pay`; `PaymentCheckerClient` (задача 7) —
 * проверку платежа для `/api/status/:token`, который теперь сам запускает
 * проверку на каждый опрос из вкладки покупателя.
 */
export interface ЗависимостиСервера {
  config: Config;
  store: Store;
  client: PaymentClient & PaymentCheckerClient;
  log: Log;
  /** Только для тестов. */
  тест?: ЗависимостиСервераТест;
}

// dist/http/server.js и src/http/server.ts лежат на одной глубине от корня
// пакета — путь до public/ одинаков что при разработке (vite-node из src),
// что при сборке (запуск из dist).
const КАТАЛОГ_ЭТОГО_ФАЙЛА = dirname(fileURLToPath(import.meta.url));
const КАТАЛОГ_PUBLIC = join(КАТАЛОГ_ЭТОГО_ФАЙЛА, '..', '..', 'public');

const ПУТЬ_СТРАНИЦЫ_ОПЛАТЫ = /^\/pay\/([0-9a-f]{32})$/;
const ПУТЬ_СТАТУСА = /^\/api\/status\/([0-9a-f]{32})$/;

const ЗАГОЛОВКИ_БЕЗОПАСНОСТИ = {
  'content-security-policy': "default-src 'self'",
  'x-content-type-options': 'nosniff',
} as const;

function отдатьСтатическийФайл(res: http.ServerResponse, имяФайла: string, contentType: string): void {
  let тело: Buffer;
  try {
    тело = readFileSync(join(КАТАЛОГ_PUBLIC, имяФайла));
  } catch {
    res.writeHead(404, { ...ЗАГОЛОВКИ_БЕЗОПАСНОСТИ, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Файл не найден');
    return;
  }
  res.writeHead(200, {
    ...ЗАГОЛОВКИ_БЕЗОПАСНОСТИ,
    'content-type': contentType,
    // Файл — часть развёрнутого кода сервера, не заказа: короткий кеш
    // безопасен и снимает часть нагрузки с раздачи статики при опросе.
    'cache-control': 'public, max-age=300',
  });
  res.end(тело);
}

export function createServer(deps: ЗависимостиСервера): http.Server {
  // Один счётчик попыток входа на сервер, не на запрос — см. заголовок
  // `routes-admin.ts`. Фабрика вызывается здесь, а не на верхнем уровне
  // модуля: тесты создают сервер заново на каждый прогон (см. `http.test.ts`,
  // `admin.test.ts`), и каждому должен достаться свой, ещё пустой счётчик.
  const admin = createAdminRoutes();

  return http.createServer((req, res) => {
    for (const [имя, значение] of Object.entries(ЗАГОЛОВКИ_БЕЗОПАСНОСТИ)) {
      res.setHeader(имя, значение);
    }

    void обработатьЗапрос(req, res, deps, admin).catch((е) => {
      deps.log.error('Необработанная ошибка при обработке HTTP-запроса', {
        сообщение: (е as Error).message,
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      if (!res.writableEnded) {
        res.end('Внутренняя ошибка сервера');
      }
    });
  });
}

async function обработатьЗапрос(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ЗависимостиСервера,
  admin: ReturnType<typeof createAdminRoutes>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const метод = req.method ?? 'GET';

  if (метод === 'POST' && url.pathname === '/tilda/pay') {
    await обработатьTildaPay(req, res, deps);
    return;
  }

  // Выключен по умолчанию (`config.enableFormWebhook`, см. `../config.ts`):
  // не под условием внутри самого обработчика, а здесь, в маршрутизации —
  // выключенный вход обязан вести себя как несуществующий маршрут (404), а
  // не отвечать чем-то, что выдаёт сам факт его существования постороннему,
  // который его прощупывает.
  if (метод === 'POST' && url.pathname === '/tilda/webhook' && deps.config.enableFormWebhook) {
    await обработатьTildaWebhook(req, res, deps);
    return;
  }

  if (метод === 'GET' && url.pathname === '/admin') {
    admin.список(req, res, deps);
    return;
  }

  if (метод === 'GET' && url.pathname === '/admin/login') {
    admin.формаВхода(req, res, deps);
    return;
  }

  if (метод === 'POST' && url.pathname === '/admin/login') {
    await admin.вход(req, res, deps);
    return;
  }

  if (метод === 'POST' && url.pathname === '/admin/logout') {
    admin.выход(req, res, deps);
    return;
  }

  if (метод === 'GET' && url.pathname === '/assets/checkout.js') {
    отдатьСтатическийФайл(res, 'checkout.js', 'text/javascript; charset=utf-8');
    return;
  }

  if (метод === 'GET' && url.pathname === '/assets/checkout.css') {
    отдатьСтатическийФайл(res, 'checkout.css', 'text/css; charset=utf-8');
    return;
  }

  if (метод === 'GET' && url.pathname === '/assets/admin.js') {
    отдатьСтатическийФайл(res, 'admin.js', 'text/javascript; charset=utf-8');
    return;
  }

  if (метод === 'GET') {
    const совпадениеОплаты = ПУТЬ_СТРАНИЦЫ_ОПЛАТЫ.exec(url.pathname);
    if (совпадениеОплаты) {
      обработатьСтраницуОплаты(совпадениеОплаты[1]!, res, deps);
      return;
    }

    const совпадениеСтатуса = ПУТЬ_СТАТУСА.exec(url.pathname);
    if (совпадениеСтатуса) {
      await обработатьСтатус(совпадениеСтатуса[1]!, res, deps);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(страница404());
}

/* ------------------------------- запуск ------------------------------- */

/**
 * Известные секреты настроек — передаются в журнал (`createLog`), чтобы он
 * вырезал их значения из готовой строки записи независимо от того, под
 * каким именем поля они всплыли (см. заголовок `../log.ts`, третий барьер).
 * `rpcUrl` сюда не входит: это не секрет, а адрес узла, и от него журнал и
 * так оставляет только схему и хост (второй барьер `../log.ts`).
 */
function секретыНастроек(config: Config): string[] {
  return [config.orderSecret, config.notifySecret, config.adminPassword, config.smtp.pass];
}

/**
 * Путь к файлу настроек: первый аргумент командной строки, а без него —
 * `config.json` в текущем рабочем каталоге (см. `README.md` и
 * `docker-compose.yml` — там он смонтирован read-only ровно туда).
 */
function путьКНастройкам(): string {
  return process.argv[2] ?? join(process.cwd(), 'config.json');
}

/**
 * Читает настройки, поднимает хранилище, HTTP-сервер и фоновый обход —
 * то есть действительно запускает процесс, а не только собирает функции,
 * которые кто-то другой вызовет (см. системную заметку задачи 9: до этой
 * функции сервер не имел точки запуска вовсе — ни хранилище, ни обход, ни
 * чтение настроек с диска никто не вызывал).
 *
 * Тестовые крюки (`ЗависимостиСервераТест`) сюда никогда не попадают: их
 * неоткуда взять из файла настроек на диске — у `Config` (см.
 * `../config.ts`) такого поля нет и быть не может.
 */
export async function запуститьСервер(): Promise<{ server: http.Server; остановить: () => Promise<void> }> {
  const путь = путьКНастройкам();

  let config: Config;
  try {
    const сырыеНастройки: unknown = JSON.parse(readFileSync(путь, 'utf8'));
    config = loadConfig(сырыеНастройки);
  } catch (е) {
    throw new Error(`Не удалось запустить сервер: настройки «${путь}»: ${(е as Error).message}`);
  }

  const log = createLog((строка) => process.stdout.write(строка + '\n'), секретыНастроек(config));
  const store = openDatabase(config.databasePath);
  const client = создатьКлиент(config);

  const server = createServer({ config, store, client, log });
  const остановитьОбход = startChecker({ config, store, client, log });

  // По умолчанию только loopback (см. `config.listenHost`) — обратный
  // прокси (nginx) достаёт до процесса либо с того же хоста напрямую, либо
  // через Docker (`docker-compose.yml`: порт публикуется наружу только на
  // `127.0.0.1` хоста, а внутри своей сети моста процесс слушает `0.0.0.0`,
  // см. комментарий у `Config.listenHost` в `../config.ts`). Изоляция от
  // внешней сети в обоих случаях обеспечивается СНАРУЖИ процесса — либо
  // самим loopback-биндом, либо публикацией порта только на loopback хоста.
  await new Promise<void>((res, rej) => {
    server.listen(config.listenPort, config.listenHost, () => res());
    server.once('error', rej);
  });
  log.info('Сервер запущен', { port: config.listenPort, host: config.listenHost });

  let остановлен = false;
  async function остановить(): Promise<void> {
    if (остановлен) return;
    остановлен = true;
    остановитьОбход();
    await new Promise<void>((res) => server.close(() => res()));
  }

  return { server, остановить };
}

/**
 * Запускается, только если этот файл выполняется напрямую
 * (`node dist/http/server.js`, см. `package.json` → `scripts.start`), а не
 * когда его импортируют тесты (им нужны только `createServer` и типы, без
 * побочных эффектов чтения настроек и открытия сокета).
 */
const этоТочкаВхода =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (этоТочкаВхода) {
  запуститьСервер()
    .then(({ остановить }) => {
      const наСигнал = (сигнал: string) => {
        process.stdout.write(`Получен сигнал ${сигнал}, завершаем работу\n`);
        void остановить().then(() => process.exit(0));
      };
      process.on('SIGTERM', () => наСигнал('SIGTERM'));
      process.on('SIGINT', () => наСигнал('SIGINT'));
    })
    .catch((е: unknown) => {
      process.stderr.write(`${(е as Error).message}\n`);
      process.exitCode = 1;
    });
}
