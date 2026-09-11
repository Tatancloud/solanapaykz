/**
 * Уведомление Tilda об оплате заказа: `order_id`, `amount`, `currency`,
 * `timestamp`, `test_mode`, `status` со значением `paid`, `transaction` с
 * подписью транзакции Solana и `signature`.
 *
 * Подпись считается тем же правилом и по тем же пяти полям, что и входящая
 * (`../signature.js`), но секретом уведомления (`config.notifySecret`), а
 * не секретом заказа — разные ключи, чтобы утечка одного не позволяла
 * подделывать другое.
 *
 * Адрес получателя — только `config.tildaNotifyUrl`. Адрес из запроса Tilda
 * (`notify_url`) в заказе не хранится и здесь недоступен в принципе (см.
 * заголовок `../db.ts` и `../tilda/inbound.ts`) — покупатель мог бы иначе
 * подставить свой адрес и получить от нас поддельное подтверждение оплаты.
 *
 * Успехом считается ТОЛЬКО тело `OK` при коде 200. Код 200 с любым другим
 * телом — не подтверждение: именно так в этом проекте уже путали
 * «отправлено» с «доставлено» на статусе WhatsApp `sent`.
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

/** Отправка одного HTTP-запроса. */
export type Отправка = (url: string, поля: Record<string, string>) => Promise<ОтветTilda>;

/**
 * Тестовые крюки этого модуля — не для боевого кода. Боевой вызов их не
 * задаёт: `deps.тест` в бою всегда `undefined`, и все настоящие значения
 * (реальная отправка, паузы из задания) берутся по умолчанию.
 */
export interface NotifyTestHooks {
  /** Подменяет реальную отправку HTTP. */
  отправка?: Отправка;
  /** Паузы между попытками в мс (по умолчанию 1/5/15/60 секунд — как в задании). */
  задержкиMs?: readonly number[];
  /** Подменяет реальное ожидание между попытками — фиксирует, каких пауз просили, не ожидая их по-настоящему. */
  подождать?: (ms: number) => Promise<void>;
}

export interface NotifyDeps {
  config: Pick<Config, 'notifySecret' | 'tildaNotifyUrl'>;
  store: Store;
  log: Log;
  /** Только для тестов. */
  тест?: NotifyTestHooks;
}

const МАКСИМУМ_ПОПЫТОК = 5;
const ПАУЗЫ_MS_ПО_УМОЛЧАНИЮ = [1000, 5000, 15000, 60000] as const;
const ТАЙМАУТ_ЗАПРОСА_MS = 10_000;
const ТЕЛО_УСПЕХА = 'OK';

/**
 * Потолок размера тела ответа. Tilda отвечает двумя буквами; лимит — не
 * бизнес-правило, а защита от буферизации произвольно большого ответа
 * целиком в память, если на другом конце окажется не Tilda, а что-то
 * чужое или неисправное. Тайм-аут запроса ограничивает время ответа,
 * но не его объём — это ограничивает объём.
 */
const МАКСИМАЛЬНЫЙ_РАЗМЕР_ОТВЕТА_БАЙТ = 10_000;

/**
 * Читает тело ответа не более чем `лимитБайт` — остаток обрывается, а не
 * буферизуется. Экспортирована ради теста: прогонять через настоящую сеть,
 * чтобы проверить именно этот предел, была бы дорогая и медленная затея
 * (тело ответа на десятки/сотни килобайт заметно на глаз в общем прогоне
 * тестов), а через реальный `Response`/`ReadableStream` без сети — быстро.
 */
export async function прочитатьТелоСОграничением(ответ: Response, лимитБайт: number): Promise<string> {
  if (!ответ.body) return '';
  const reader = ответ.body.getReader();
  const части: Uint8Array[] = [];
  let размер = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      размер += value.length;
      if (размер > лимитБайт) {
        await reader.cancel();
        break;
      }
      части.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(части).toString('utf8');
}

/** Настоящая отправка: POST form-urlencoded с тайм-аутом и ограничением размера ответа. */
async function реальнаяОтправка(url: string, поля: Record<string, string>): Promise<ОтветTilda> {
  const ответ = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(поля).toString(),
    signal: AbortSignal.timeout(ТАЙМАУТ_ЗАПРОСА_MS),
  });
  return { status: ответ.status, body: await прочитатьТелоСОграничением(ответ, МАКСИМАЛЬНЫЙ_РАЗМЕР_ОТВЕТА_БАЙТ) };
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
 * Отказывается отправлять, если у заказа нет подписи транзакции
 * (`order.txSignature`): «оплачено» без номера транзакции — утверждение,
 * которое нечем подтвердить и не на что сослаться при споре. Из рабочего
 * пути (`../checker.ts` пишет `txSignature` в той же записи, что и
 * `state: 'оплачен'`, до вызова этой функции) это недостижимо — проверка
 * здесь на случай, если вызовут иначе.
 *
 * Заказ этой функцией не мутируется, кроме счётчика попыток
 * (`store.markNotified`) — состояние («уведомлён») выставляет вызывающий
 * код после успешного возврата.
 */
export async function notifyTilda(order: Order, deps: NotifyDeps): Promise<boolean> {
  if (!order.txSignature) {
    deps.log.error('notifyTilda вызвана для заказа без подписи транзакции — уведомление не отправлено', {
      tildaOrderId: order.tildaOrderId,
    });
    return false;
  }

  const отправить = deps.тест?.отправка ?? реальнаяОтправка;
  const паузы = deps.тест?.задержкиMs ?? ПАУЗЫ_MS_ПО_УМОЛЧАНИЮ;
  const ждать = deps.тест?.подождать ?? пауза;

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
    transaction: order.txSignature,
    signature: signFields(подписываемыеПоля, deps.config.notifySecret),
  };

  for (let попытка = 1; попытка <= МАКСИМУМ_ПОПЫТОК; попытка++) {
    // Помечаем попытку В БАЗЕ ДО отправки: падение процесса между уходом
    // запроса и записью исхода не должно привести к повторной отправке
    // того же уведомления при перезапуске.
    deps.store.markNotified(order.id, false, попытка);

    let ответ: ОтветTilda;
    try {
      ответ = await отправить(deps.config.tildaNotifyUrl, поля);
    } catch (е) {
      // Подпись и секрет — не для журнала: номер заказа, попытка и текст
      // ошибки — этого достаточно для диагностики.
      deps.log.warn('Не удалось отправить уведомление Tilda об оплате: сбой сети', {
        tildaOrderId: order.tildaOrderId,
        попытка,
        сообщение: (е as Error).message,
      });
      if (попытка < МАКСИМУМ_ПОПЫТОК) await ждать(паузы[попытка - 1] ?? 0);
      continue;
    }

    if (этоУспех(ответ)) {
      deps.store.markNotified(order.id, true, попытка);
      return true;
    }

    // Код 200 с посторонним телом — тоже неуспех (см. заголовок файла).
    deps.log.warn('Tilda не подтвердила приём уведомления об оплате (не тело "OK")', {
      tildaOrderId: order.tildaOrderId,
      попытка,
      статус: ответ.status,
    });

    if (попытка < МАКСИМУМ_ПОПЫТОК) await ждать(паузы[попытка - 1] ?? 0);
  }

  return false;
}
