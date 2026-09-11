/**
 * Разбор входящего POST-запроса Tilda и идемпотентное создание заказа.
 *
 * Ключевая опасность этого файла: Tilda перенаправляет покупателя к нам
 * POST-формой **из его собственного браузера** — значит любое поле запроса
 * покупатель может переписать перед отправкой. Подпись (см. `../signature.js`)
 * покрывает только пять полей строгого формата (`order_id`, `amount`,
 * `currency`, `timestamp`, `test_mode`). Всё остальное —
 * `description`, `products`, `email`, `phone`, `customer_name`,
 * `notify_url`, `success_url`, `failure_url` — НЕ заверено. Эти поля можно
 * показать покупателю и сохранить вместе с заказом, но по ним нельзя
 * принимать ни одно денежное решение: ни сумму, ни валюту, ни монету.
 *
 * Отдельно: `notify_url` из запроса не используется НИКОГДА, даже для
 * диагностики без подстановки в реальную отправку. Найдено ревью: если
 * слать по нему уведомление об оплате, покупатель может подставить свой
 * адрес, честно заплатить — и получить от нас POST с признаком `paid`,
 * подписанный секретом уведомлений, то есть готовое поддельное
 * подтверждение оплаты для продавца, пока Tilda ничего не помечает.
 * Уведомления всегда идут по `config.tildaNotifyUrl` — обязательному,
 * проверенному на `https://` и фиксированному для интеграции адресу из
 * настроек, а не из запроса. Несовпадение `notify_url` в запросе с
 * `config.tildaNotifyUrl` — не денежное решение, а повод для строки в
 * журнал: возможно, продавец сменил адрес в Tilda, а настройки ещё старые.
 */
import { randomBytes } from 'node:crypto';
import type {
  CreatePaymentRequestOptions,
  PaymentRequest,
  Quote,
  TokenSymbol,
} from '@solanapaykz/core';
import type { Config } from '../config.js';
import { DuplicateOrderError, type NewOrder, type Order, type Store } from '../db.js';
import type { Log } from '../log.js';
import { verifySignature } from '../signature.js';

/** Разобранный (но ещё не проверенный) заказ Tilda. */
export interface TildaOrder {
  orderId: string;
  amountKzt: string;
  currency: string;
  timestamp: string;
  testMode: boolean;
  description: string | null;
  products: unknown[] | null;
  email: string | null;
  phone: string | null;
  customerName: string | null;
  notifyUrl: string | null;
  successUrl: string | null;
  failureUrl: string | null;
  signature: string;
}

/** Подпись заказа не сошлась с телом запроса. */
export class SignatureError extends Error {
  constructor(message = 'Подпись заказа Tilda не сошлась') {
    super(message);
    this.name = 'SignatureError';
  }
}

/** Валюта заказа отлична от KZT — считать в неё мы не умеем. */
export class CurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyError';
  }
}

/** Сумма заказа не в допустимом формате или не больше нуля. */
export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/** Непустая строка или `null` — Tilda присылает отсутствующие поля пустой строкой, а не отсутствием ключа. */
function непустаяСтрокаИлиNull(значение: string | undefined): string | null {
  return значение ? значение : null;
}

/**
 * Состав корзины — поле вне подписи (см. заголовок файла), поэтому
 * испорченный JSON здесь не должен ронять разбор всего заказа: это
 * отображаемые данные, а не основание для денежного решения.
 */
function разобратьТовары(значение: string | undefined): unknown[] | null {
  if (!значение) return null;
  try {
    const разобранное: unknown = JSON.parse(значение);
    return Array.isArray(разобранное) ? разобранное : null;
  } catch {
    return null;
  }
}

/**
 * Разбирает тело POST-запроса Tilda в `TildaOrder`.
 *
 * Не бросает ни на незнакомых полях (список полей интеграции Tilda может
 * измениться), ни на испорченном JSON состава корзины — на этом этапе заказ
 * ещё не проверен, задача только прочитать то, что есть. Проверка подписи,
 * валюты и суммы — отдельно, в `проверитьЗаказ`.
 */
export function parseTildaOrder(body: Record<string, string>): TildaOrder {
  return {
    orderId: body.order_id ?? '',
    amountKzt: body.amount ?? '',
    currency: body.currency ?? '',
    timestamp: body.timestamp ?? '',
    testMode: body.test_mode === '1' || body.test_mode?.toLowerCase() === 'true',
    description: непустаяСтрокаИлиNull(body.description),
    products: разобратьТовары(body.products),
    email: непустаяСтрокаИлиNull(body.email),
    phone: непустаяСтрокаИлиNull(body.phone),
    customerName: непустаяСтрокаИлиNull(body.customer_name),
    notifyUrl: непустаяСтрокаИлиNull(body.notify_url),
    successUrl: непустаяСтрокаИлиNull(body.success_url),
    failureUrl: непустаяСтрокаИлиNull(body.failure_url),
    signature: body.signature ?? '',
  };
}

/**
 * Формат допустимой суммы: только цифры и, возможно, точка с дробной
 * частью. Тот же предикат, что `DECIMAL_FORMAT_PATTERN`/`isValidDecimalFormat`
 * в `@solanapaykz/core` (`src/money.ts`) — сумма, не совпадающая с тем, что
 * умеет разобрать SDK при создании котировки, не должна доходить даже до
 * проверки заказа. Продублирован здесь, а не импортирован: SDK не выносит
 * этот предикат в публичный API (`src/index.ts` его не экспортирует), а
 * менять экспорт `@solanapaykz/core` — вне рамок этой задачи.
 */
const ФОРМАТ_СУММЫ = /^\d+(\.\d+)?$/;

/**
 * Проверяет заказ Tilda: подпись, валюту, формат и знак суммы. Бросает при
 * первом несоответствии.
 *
 * Порядок проверок важен: подпись — первой и без исключений. Поля вне
 * подписи (currency и amount входят в подпись, но их содержательная
 * проверка всё равно идёт вторым шагом) не должны влиять даже на текст
 * ошибки, пока подлинность запроса не подтверждена.
 */
export function проверитьЗаказ(
  order: TildaOrder,
  body: Record<string, string>,
  secret: string,
): void {
  if (!verifySignature(body, order.signature, secret)) {
    throw new SignatureError();
  }

  if (order.currency !== 'KZT') {
    throw new CurrencyError(
      `Валюта заказа «${order.currency}» не поддерживается: считаем только в тенге (KZT). ` +
        'Расчёт по валюте, отличной от валюты магазина, уже занижал сумму в 460 раз в плагине WooCommerce.',
    );
  }

  if (!ФОРМАТ_СУММЫ.test(order.amountKzt)) {
    throw new AmountError(
      `Сумма заказа «${order.amountKzt}» имеет неверный формат: допустимы только цифры и точка, ` +
        'без пробелов, запятых и знака минус',
    );
  }

  if (Number(order.amountKzt) <= 0) {
    throw new AmountError(`Сумма заказа «${order.amountKzt}» должна быть больше нуля`);
  }
}

/**
 * Минимально нужный от `SolanaPayKZ` набор методов для создания платежа —
 * не сам класс, чтобы в тестах его можно было подменить простым объектом,
 * не поднимая ни сеть, ни RPC.
 */
export interface PaymentClient {
  createQuote(params: { amountKzt: string; token: TokenSymbol }): Promise<Quote>;
  createPaymentRequest(quote: Quote, options?: CreatePaymentRequestOptions): Promise<PaymentRequest>;
}

export interface CreatePaymentForDeps {
  store: Store;
  client: PaymentClient;
  config: Pick<Config, 'token' | 'recipient' | 'shopName' | 'tildaNotifyUrl'>;
  log: Log;
}

/**
 * Идемпотентно создаёт (или возвращает уже существующий) заказ и платёжный
 * запрос для разобранного и уже проверенного (`проверитьЗаказ`) заказа
 * Tilda.
 *
 * Идемпотентность — главное требование этой функции: повторное нажатие
 * «Оплатить», обновление страницы или дубль запроса от Tilda обязаны
 * вернуть ту же котировку, ту же сумму, ту же метку платежа. В плагине
 * WooCommerce ревью нашло ровно обратную ошибку — повторный запрос
 * перевыпускал метку, и уже отправленные деньги теряли связь с заказом.
 *
 * Проверка «есть ли уже такой заказ» с последующей вставкой — это
 * «прочитать, потом записать», то есть гонка между двумя параллельными
 * запросами с одним номером заказа. Единственная настоящая защита —
 * ограничение `UNIQUE` в базе (`db.ts`): если `store.createOrder` бросает
 * `DuplicateOrderError`, значит конкурентный запрос успел вставить свою
 * запись первым, и здесь она перечитывается и возвращается как есть, без
 * повторной попытки вставки.
 */
export async function createPaymentFor(order: TildaOrder, deps: CreatePaymentForDeps): Promise<Order> {
  // Диагностика, а не решение: notify_url из запроса никогда не идёт в
  // отправку (см. заголовок файла) — уведомления шлются по
  // config.tildaNotifyUrl. Несовпадение здесь почти всегда безобидно
  // (продавец сменил адрес в Tilda, настройки ещё старые), но полезно
  // узнать раньше, чем начнут молча копиться необъяснимые сбои
  // уведомлений. Проверяется на каждый запрос, а не только при создании
  // заказа — сигнал о рассинхроне настроек актуален и на повторных.
  if (order.notifyUrl && order.notifyUrl !== deps.config.tildaNotifyUrl) {
    deps.log.warn(
      'notify_url в заказе Tilda отличается от настроенного config.tildaNotifyUrl — запрос игнорируется',
      {
        tildaOrderId: order.orderId,
        notifyUrlИзЗапроса: order.notifyUrl,
        notifyUrlНастроенный: deps.config.tildaNotifyUrl,
      },
    );
  }

  const существующий = deps.store.findByTildaOrderId(order.orderId);
  if (существующий) {
    return существующий;
  }

  // Курс запрашивается один раз здесь; сбой сети или отсутствие курса не
  // должны заводить заказ с неизвестной ценой — продажа по неизвестному
  // курсу хуже отказа. Промах ниже намеренно не перехвачен: он всплывает
  // вызывающему коду как есть.
  const quote = await deps.client.createQuote({ amountKzt: order.amountKzt, token: deps.config.token });
  const paymentRequest = await deps.client.createPaymentRequest(quote, {
    // Покупатель видит label в своём кошельке в момент подтверждения
    // платежа: безликая метка вызывает подозрение — человек, который не
    // понимает, кому платит, платёж отменяет. Название магазина, если
    // продавец его задал в настройках, — понятнее общей фразы.
    label: deps.config.shopName || 'Оплата заказа',
    message: `Заказ №${order.orderId}`,
  });

  const новыйЗаказ: NewOrder = {
    tildaOrderId: order.orderId,
    // Случайный ключ страницы оплаты — по нему, а не по номеру заказа,
    // открывается `/pay/:token`: перебор чужих заказов через номер не
    // должен быть возможен.
    token: randomBytes(16).toString('hex'),
    amountKzt: quote.amountKzt,
    amountToken: quote.amountToken,
    tokenSymbol: quote.token,
    cluster: quote.cluster,
    recipient: deps.config.recipient,
    reference: paymentRequest.reference,
    rate: quote.rate,
    rateSource: quote.rateSource,
    paymentUrl: paymentRequest.url,
    quoteJson: JSON.stringify(quote),
    // Order.createdAt/expiresAt — Unix-секунды (см. db.ts), а Quote несёт
    // ISO-строки: переводим один раз здесь, при заморозке записи заказа.
    createdAt: Math.floor(Date.parse(quote.createdAt) / 1000),
    expiresAt: Math.floor(Date.parse(quote.expiresAt) / 1000),
    // Подпись заказа Tilda — доказательство происхождения заказа, отдельный
    // столбец от подписи транзакции Solana (та появится только при оплате,
    // задача 7). Один столбец на обе означал бы, что подтверждение платежа
    // стирает единственное доказательство, что заказ вообще пришёл от Tilda.
    tildaSignature: order.signature,
    txSignature: null,
    // notify_url из запроса НЕ хранится в заказе — см. заголовок файла и
    // комментарий у Order в db.ts: это неподписанное поле, а хранение
    // открывало бы дорогу поддельным уведомлениям об оплате.
    customerEmail: order.email,
    description: order.description,
    productsJson: order.products ? JSON.stringify(order.products) : null,
  };

  try {
    return deps.store.createOrder(новыйЗаказ);
  } catch (е) {
    if (е instanceof DuplicateOrderError) {
      const конкурентный = deps.store.findByTildaOrderId(order.orderId);
      if (!конкурентный) {
        // Не должно случаться: DuplicateOrderError означает, что запись
        // только что появилась у конкурента. Пробрасываем исходную ошибку
        // вместо того, чтобы маскировать её непонятным null.
        throw е;
      }
      return конкурентный;
    }
    throw е;
  }
}
