/**
 * Маршрутизация HTTP-запросов и создание сервера.
 *
 * Своего роутера нет намеренно: маршрутов пять, ни один не пересекается по
 * префиксу с другим, а зависимость вроде express тянула бы за собой куда
 * больше, чем даёт здесь выигрыша.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PaymentCheckerClient } from '../checker.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Log } from '../log.js';
import type { PaymentClient } from '../tilda/inbound.js';
import type { Отправка } from '../tilda/notify.js';
import { страница404 } from './html.js';
import { обработатьTildaPay } from './routes-pay.js';
import { обработатьСтатус, обработатьСтраницуОплаты } from './routes-page.js';

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
  return http.createServer((req, res) => {
    for (const [имя, значение] of Object.entries(ЗАГОЛОВКИ_БЕЗОПАСНОСТИ)) {
      res.setHeader(имя, значение);
    }

    void обработатьЗапрос(req, res, deps).catch((е) => {
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
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const метод = req.method ?? 'GET';

  if (метод === 'POST' && url.pathname === '/tilda/pay') {
    await обработатьTildaPay(req, res, deps);
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
