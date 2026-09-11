/**
 * `GET /pay/:token` — страница оплаты, которую видит покупатель, и
 * `GET /api/status/:token` — состояние заказа для опроса из `checkout.js`.
 *
 * Оба маршрута принимают на вход только `token`: случайный ключ страницы
 * оплаты (задача 5, `randomBytes(16).toString('hex')`), а не номер заказа —
 * подобрать чужой перебором номеров здесь нельзя в принципе.
 */
import type { ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { toString as qrCodeToString } from 'qrcode';
import type { Order } from '../db.js';
import { страница404, страницаИтога, страницаОплаты, страницаСообщения, текстСостояния } from './html.js';
import type { ЗависимостиСервера } from './server.js';

const ЗАГОЛОВКИ_HTML = { 'content-type': 'text/html; charset=utf-8' } as const;
const ЗАГОЛОВКИ_JSON = { 'content-type': 'application/json; charset=utf-8' } as const;

/**
 * Ищет заказ по ключу страницы. Помимо точного совпадения, которое уже
 * гарантирует `WHERE token = ?` в `Store` (задача 3), сверяет найденный
 * токен со входным через `timingSafeEqual` — по заданию. Само по себе
 * равенство здесь уже установлено запросом к базе, так что эта проверка не
 * отсекает ничего нового; но она не даёт будущей замене реализации `Store`
 * (например, поиском без учёта регистра или по префиксу) тихо превратить
 * точное совпадение в примерное.
 *
 * Ответ на несуществующий и на чужой (но существующий) ключ обязан быть
 * одинаковым — оба идут через один и тот же `null`.
 */
function найтиЗаказПоТокену(token: string, store: ЗависимостиСервера['store']): Order | null {
  const заказ = store.findByToken(token);
  if (!заказ) return null;

  const а = Buffer.from(token, 'utf8');
  const б = Buffer.from(заказ.token, 'utf8');
  if (а.length !== б.length || !timingSafeEqual(а, б)) return null;

  return заказ;
}

/** Секунд до истечения цены — на момент этого запроса, не на момент создания заказа. */
function секундОсталосьСейчас(order: Order): number {
  return Math.max(0, order.expiresAt - Math.floor(Date.now() / 1000));
}

export async function обработатьСтраницуОплаты(
  token: string,
  res: ServerResponse,
  deps: ЗависимостиСервера,
): Promise<void> {
  const заказ = найтиЗаказПоТокену(token, deps.store);
  if (!заказ) {
    res.writeHead(404, ЗАГОЛОВКИ_HTML);
    res.end(страница404());
    return;
  }

  // Заказу, который больше не ждёт оплаты (оплачен, отменён, разбирается
  // вручную), QR не показываем — это приглашение заплатить второй раз.
  if (заказ.state !== 'ожидает') {
    res.writeHead(200, ЗАГОЛОВКИ_HTML);
    res.end(страницаИтога(заказ));
    return;
  }

  let qrSvg: string;
  try {
    // QR строится из уже замороженной платёжной ссылки (`paymentUrl`),
    // сохранённой при создании заказа (задача 5) — не заново через SDK:
    // повторный вызов SDK выпустил бы новую случайную метку платежа
    // (`reference`), и деньги, отправленные по старому QR, перестали бы
    // находиться при проверке.
    qrSvg = await qrCodeToString(заказ.paymentUrl, { type: 'svg', margin: 1, width: 320 });
  } catch (е) {
    deps.log.error('Не удалось построить QR-код для страницы оплаты', {
      tildaOrderId: заказ.tildaOrderId,
      сообщение: (е as Error).message,
    });
    res.writeHead(200, ЗАГОЛОВКИ_HTML);
    res.end(
      страницаСообщения(
        заказ,
        'Оплата временно недоступна: не удалось построить QR-код. Свяжитесь с магазином.',
      ),
    );
    return;
  }

  res.writeHead(200, ЗАГОЛОВКИ_HTML);
  res.end(страницаОплаты(заказ, секундОсталосьСейчас(заказ), qrSvg));
}

export function обработатьСтатус(token: string, res: ServerResponse, deps: ЗависимостиСервера): void {
  const заказ = найтиЗаказПоТокену(token, deps.store);
  if (!заказ) {
    res.writeHead(404, ЗАГОЛОВКИ_JSON);
    res.end(JSON.stringify({ error: 'Заказ не найден' }));
    return;
  }

  // Ни суммы, ни адреса получателя, ни метки платежа: страница уже
  // показала их тому, кто знает ключ, а ответ опроса — лишний канал
  // утечки (см. задание).
  res.writeHead(200, ЗАГОЛОВКИ_JSON);
  res.end(
    JSON.stringify({
      state: заказ.state,
      message: текстСостояния(заказ.state),
      secondsLeft: заказ.state === 'ожидает' ? секундОсталосьСейчас(заказ) : 0,
    }),
  );
}
