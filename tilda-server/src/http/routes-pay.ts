/**
 * `POST /tilda/pay` — вход основного пути: покупатель нажимает «Оплатить»
 * на Tilda, площадка отправляет его браузер сюда POST-формой.
 *
 * Разбор и проверка заказа целиком в `tilda/inbound.ts` (задача 5) — здесь
 * только транспорт: прочитать тело запроса, вызвать проверку и создание
 * платежа, превратить исход в HTTP-ответ.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AmountError,
  createPaymentFor,
  CurrencyError,
  parseTildaOrder,
  SignatureError,
  проверитьЗаказ,
} from '../tilda/inbound.js';
import type { ЗависимостиСервера } from './server.js';

/**
 * Потолок размера тела запроса. Не ограничение самой Tilda (её карта полей
 * многократно меньше), а защита от POST-формы, которую покупатель правит
 * в собственном браузере: `products` в `inbound.ts` и так обрезается на
 * 20 000 символов, но это происходит уже после того, как тело целиком
 * легло в память — здесь читаем безопасный потолок раньше.
 */
const МАКСИМАЛЬНЫЙ_РАЗМЕР_ТЕЛА_БАЙТ = 200_000;

class ТелоСлишкомБольшое extends Error {}

function прочитатьТело(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const части: Buffer[] = [];
    let размер = 0;

    req.on('data', (кусок: Buffer) => {
      размер += кусок.length;
      if (размер > МАКСИМАЛЬНЫЙ_РАЗМЕР_ТЕЛА_БАЙТ) {
        req.destroy();
        reject(new ТелоСлишкомБольшое());
        return;
      }
      части.push(кусок);
    });
    req.on('end', () => resolve(Buffer.concat(части).toString('utf8')));
    req.on('error', reject);
  });
}

/** Тело формы `application/x-www-form-urlencoded` в плоский объект строк. */
function разобратьUrlencoded(тело: string): Record<string, string> {
  const поля: Record<string, string> = {};
  for (const [ключ, значение] of new URLSearchParams(тело)) {
    поля[ключ] = значение;
  }
  return поля;
}

export async function обработатьTildaPay(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ЗависимостиСервера,
): Promise<void> {
  let тело: string;
  try {
    тело = await прочитатьТело(req);
  } catch (е) {
    if (е instanceof ТелоСлишкомБольшое) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Тело запроса слишком велико');
      return;
    }
    throw е;
  }

  const поля = разобратьUrlencoded(тело);
  const заказ = parseTildaOrder(поля);

  try {
    проверитьЗаказ(заказ, поля, deps.config.orderSecret);
  } catch (е) {
    if (е instanceof SignatureError || е instanceof CurrencyError || е instanceof AmountError) {
      deps.log.warn('Отклонён заказ Tilda: не прошёл проверку', {
        тип: е.name,
        orderId: заказ.orderId,
      });
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Не удалось проверить заказ. Обратитесь в магазин.');
      return;
    }
    throw е;
  }

  let сохранённый;
  try {
    сохранённый = await createPaymentFor(заказ, {
      store: deps.store,
      client: deps.client,
      config: deps.config,
      log: deps.log,
    });
  } catch (е) {
    // Сбой курса, сети или RPC — не денежное решение и не вина покупателя:
    // продать по неизвестному курсу хуже отказа (см. createPaymentFor).
    deps.log.error('Не удалось подготовить платёж для заказа Tilda', {
      orderId: заказ.orderId,
      сообщение: (е as Error).message,
    });
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Оплата временно недоступна. Попробуйте ещё раз позже или свяжитесь с магазином.');
    return;
  }

  res.writeHead(303, { location: `/pay/${сохранённый.token}` });
  res.end();
}
