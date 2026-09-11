/**
 * Уведомление Tilda об оплате заказа: `order_id`, `amount`, `currency`,
 * `timestamp`, `test_mode`, `status` со значением `paid`, `transaction` с
 * подписью транзакции Solana и `signature`.
 *
 * Подпись считается тем же правилом и по тем же пяти полям, что и входящая
 * (`../signature.js`), но секретом уведомления (`config.notifySecret`), а
 * не секретом заказа (`config.orderSecret`) — это разные ключи ровно затем,
 * чтобы утечка одного не позволяла подделывать другое: подписанный вход от
 * Tilda и подписанное нами «оплачено» для Tilda — два разных доказательства
 * с разными владельцами секрета.
 *
 * Адрес получателя — только `config.tildaNotifyUrl`. Адрес из запроса Tilda
 * (`notify_url`) в заказе не хранится и здесь недоступен в принципе (см.
 * заголовок `../db.ts` и `../tilda/inbound.ts`) — это уже закрытая
 * уязвимость, а не то, что можно случайно открыть заново из этого файла.
 *
 * Успехом считается ТОЛЬКО тело `OK` при коде 200. Код 200 с любым другим
 * телом — не подтверждение: именно так в этом проекте уже путали «отправлено»
 * с «доставлено» на статусе WhatsApp `sent` — здесь та же ошибка была бы
 * дороже, потому что от неё зависит, узнает ли продавец об оплате вообще.
 */
import type { Config } from '../config.js';
import type { Order, Store } from '../db.js';
import type { Log } from '../log.js';
import { signFields } from '../signature.js';

/** Ответ на попытку отправки — либо от настоящего HTTP, либо от подмены в тестах. */
export interface ОтветTilda {
  status: number;
  body: string;
}

/**
 * Отправка одного HTTP-запроса. Подменяется в тестах (`deps.отправка`),
 * чтобы не бить по сети и не ждать реальных пауз между повторами.
 */
export type Отправка = (url: string, поля: Record<string, string>) => Promise<ОтветTilda>;

export interface NotifyDeps {
  config: Pick<Config, 'notifySecret' | 'tildaNotifyUrl'>;
  store: Store;
  log: Log;
  /** Только для тестов: подменяет реальную отправку HTTP. */
  отправка?: Отправка;
  /**
   * Только для тестов: паузы между попытками в миллисекундах (по умолчанию
   * 1, 5, 15, 60 секунд — как в задании). Настраиваемость нужна не бою, а
   * тестам: честное ожидание 81 секунды на пять попыток раздуло бы прогон
   * до бесполезно медленного.
   */
  задержкиMs?: readonly number[];
}

/** Не более пяти попыток отправки на одно уведомление. */
const МАКСИМУМ_ПОПЫТОК = 5;

/** Паузы между попытками — 1, 5, 15, 60 секунд, как в задании. */
const ПАУЗЫ_MS_ПО_УМОЛЧАНИЮ = [1000, 5000, 15000, 60000] as const;

/** Тайм-аут одного запроса — 10 секунд. */
const ТАЙМАУТ_ЗАПРОСА_MS = 10_000;

/** Единственное тело ответа, которое считается подтверждением приёма. */
const ТЕЛО_УСПЕХА = 'OK';

/** Настоящая отправка: POST form-urlencoded с тайм-аутом. Используется, если `deps.отправка` не задана. */
async function реальнаяОтправка(url: string, поля: Record<string, string>): Promise<ОтветTilda> {
  const ответ = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(поля).toString(),
    signal: AbortSignal.timeout(ТАЙМАУТ_ЗАПРОСА_MS),
  });
  return { status: ответ.status, body: await ответ.text() };
}

function пауза(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function этоУспех(ответ: ОтветTilda): boolean {
  return ответ.status === 200 && ответ.body.trim() === ТЕЛО_УСПЕХА;
}

/**
 * Отправляет Tilda уведомление об оплате заказа, с повторами при неуспехе.
 * Возвращает признак приёма — `true` только если Tilda ответила 200 и телом
 * `OK`.
 *
 * Заказ этой функцией не мутируется: состояние («уведомлён») выставляет
 * вызывающий код (`../checker.ts`) после успешного возврата — здесь только
 * счётчик попыток и признак исхода (`store.markNotified`), нужные для
 * диагностики и для решения не слать уведомление повторно из другого места.
 */
export async function notifyTilda(order: Order, deps: NotifyDeps): Promise<boolean> {
  const отправить = deps.отправка ?? реальнаяОтправка;
  const паузы = deps.задержкиMs ?? ПАУЗЫ_MS_ПО_УМОЛЧАНИЮ;

  // Пять полей строгого формата — те же самые и в том же порядке, что и во
  // входящей подписи (`../signature.js`), но подписаны секретом уведомления.
  const подписываемыеПоля: Record<string, string> = {
    order_id: order.tildaOrderId,
    amount: order.amountKzt,
    currency: 'KZT',
    timestamp: String(Math.floor(Date.now() / 1000)),
    test_mode: order.testMode ? '1' : '0',
  };

  const поля: Record<string, string> = {
    ...подписываемыеПоля,
    status: 'paid',
    transaction: order.txSignature ?? '',
    signature: signFields(подписываемыеПоля, deps.config.notifySecret),
  };

  for (let попытка = 1; попытка <= МАКСИМУМ_ПОПЫТОК; попытка++) {
    // Помечаем попытку В БАЗЕ ДО отправки, а не после: если процесс упадёт
    // между уходом запроса и записью исхода, при перезапуске счётчик уже
    // отразит, что попытка была, и заказ не отправит то же уведомление
    // ещё раз только потому, что мы не успели это записать.
    deps.store.markNotified(order.id, false, попытка);

    let ответ: ОтветTilda;
    try {
      ответ = await отправить(deps.config.tildaNotifyUrl, поля);
    } catch (е) {
      // Подпись и секрет — не для журнала (см. заголовок файла): номер
      // заказа, попытка и текст ошибки — этого достаточно для диагностики.
      deps.log.warn('Не удалось отправить уведомление Tilda об оплате: сбой сети', {
        tildaOrderId: order.tildaOrderId,
        попытка,
        сообщение: (е as Error).message,
      });
      if (попытка < МАКСИМУМ_ПОПЫТОК) {
        await пауза(паузы[попытка - 1] ?? 0);
      }
      continue;
    }

    if (этоУспех(ответ)) {
      deps.store.markNotified(order.id, true, попытка);
      return true;
    }

    // Код 200 с посторонним телом — тоже неуспех: именно так уже путали
    // «отправлено» с «доставлено» на статусе WhatsApp `sent` (см. заголовок
    // файла). Тело ответа не логируем целиком: это текст от Tilda, а не
    // наш секрет, но он не задан форматом и может быть большим.
    deps.log.warn('Tilda не подтвердила приём уведомления об оплате (не тело "OK")', {
      tildaOrderId: order.tildaOrderId,
      попытка,
      статус: ответ.status,
    });

    if (попытка < МАКСИМУМ_ПОПЫТОК) {
      await пауза(паузы[попытка - 1] ?? 0);
    }
  }

  return false;
}
