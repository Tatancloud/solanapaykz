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
 *
 * По той же причине `success_url`/`failure_url` из запроса разбираются
 * (`TildaOrder.successUrl`/`failureUrl`), но никогда не используются для
 * переадресации покупателя (правка финального ревью, задача 4): переход
 * по неподписанному адресу, который покупатель может переписать в своём
 * браузере, — открытая переадресация. Возврат на страницу магазина после
 * оплаты (`GET /pay/:token`, см. `../http/routes-page.ts`) использует
 * `config.successUrl`/`config.failureUrl` — тот же приём, что и с
 * `notify_url`: адрес один на весь магазин, из настроек продавца, а не
 * из запроса.
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

/**
 * Заказ с таким `tildaOrderId` уже есть, но его сумма, валюта или признак
 * тестового режима расходятся с текущим (подписанным) запросом.
 *
 * Ревью на живом сервере: `POST /tilda/webhook` (запасной вход БЕЗ подписи,
 * см. заголовок `../http/routes-webhook.ts`) заранее заводил заказ с чужим
 * номером и суммой в один тенге; когда настоящий подписанный заказ на сто
 * пятьдесят тысяч тенге приходил с тем же номером, `createPaymentFor`
 * находил уже существующую запись и отдавал её как есть — покупатель видел
 * страницу оплаты на один тенге вместо ста пятидесяти тысяч. Пространства
 * номеров теперь разведены (`form:` — приставка запасного входа), но эта
 * проверка — вторая, самостоятельная линия обороны на случай ЛЮБОГО другого
 * пути к тому же `tildaOrderId` с другими деньгами, а не только уже
 * закрытой дыры: два по-настоящему подписанных запроса с одним и тем же
 * номером заказа, но разными суммами, для покупателя тоже не должны молча
 * привести к оплате по устаревшей цене.
 */
export class OrderConflictError extends Error {
  readonly tildaOrderId: string;

  constructor(tildaOrderId: string) {
    super(
      `заказ с номером Tilda «${tildaOrderId}» уже существует с другими условиями ` +
        '(сумма, валюта или признак тестового режима не совпадают)',
    );
    this.name = 'OrderConflictError';
    this.tildaOrderId = tildaOrderId;
  }
}

/** Непустая строка или `null` — Tilda присылает отсутствующие поля пустой строкой, а не отсутствием ключа. */
function непустаяСтрокаИлиNull(значение: string | undefined): string | null {
  return значение ? значение : null;
}

/**
 * Потолок длины отображаемых полей — не бизнес-правило Tilda (карта полей
 * ограничивает `description` 255 символами, `products` не ограничивает
 * вовсе), а защита от чрезмерно большого POST-тела: покупатель правит
 * форму в своём браузере, и двести тысяч символов в этих полях ложились в
 * базу без единой проверки (найдено ревью).
 */
const МАКСИМАЛЬНАЯ_ДЛИНА_ОПИСАНИЯ = 255;
const МАКСИМАЛЬНАЯ_ДЛИНА_СОСТАВА_КОРЗИНЫ = 20_000;

/**
 * Описание — поле вне подписи и чистый текст для витрины, поэтому лишнее
 * просто обрезается: показать 255 символов из длинного текста лучше, чем
 * отбросить всё описание целиком.
 */
function описаниеИлиNull(значение: string | undefined): string | null {
  if (!значение) return null;
  return значение.length > МАКСИМАЛЬНАЯ_ДЛИНА_ОПИСАНИЯ
    ? значение.slice(0, МАКСИМАЛЬНАЯ_ДЛИНА_ОПИСАНИЯ)
    : значение;
}

/**
 * Состав корзины — поле вне подписи (см. заголовок файла), поэтому
 * испорченный JSON здесь не должен ронять разбор всего заказа: это
 * отображаемые данные, а не основание для денежного решения. Чрезмерная
 * длина исходной строки трактуется так же, как испорченный JSON: обрезать
 * JSON посимвольно почти всегда значит испортить его синтаксис, так что
 * смысла его вообще парсить после этого нет.
 */
function разобратьТовары(значение: string | undefined): unknown[] | null {
  if (!значение) return null;
  if (значение.length > МАКСИМАЛЬНАЯ_ДЛИНА_СОСТАВА_КОРЗИНЫ) return null;
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
    description: описаниеИлиNull(body.description),
    products: разобратьТовары(body.products),
    email: непустаяСтрокаИлиNull(body.email),
    phone: непустаяСтрокаИлиNull(body.phone),
    customerName: непустаяСтрокаИлиNull(body.customer_name),
    notifyUrl: непустаяСтрокаИлиNull(body.notify_url),
    successUrl: непустаяСтрокаИлиNull(body.success_url),
    failureUrl: непустаяСтрокаИлиNull(body.failure_url),
    // Нормализуется здесь так же, как при сверке (`verifySignature` внутри
    // сравнивает `signature.trim().toLowerCase()`): иначе сохранённое
    // значение отличалось бы от того, с которым реально сверяли подпись,
    // и его нельзя было бы потом сопоставить с пересчитанной.
    signature: (body.signature ?? '').trim().toLowerCase(),
  };
}

/**
 * Формат допустимой суммы: цифры и, возможно, точка с дробной частью не
 * длиннее двух знаков. Тенге у нас хранятся с точностью до тиына
 * (`KZT_DECIMALS = 2` в `@solanapaykz/core/src/money.ts`), и SDK разбирает
 * сумму с этой же точностью, отказываясь на большей (`allowTruncation:
 * false` в `createQuote`) — необработанным исключением, а не понятным
 * отказом у входа. Найдено ревью: `0.0000001` и
 * `15000.000000000000001` проходили старый предикат (`\d+(\.\d+)?`, без
 * ограничения на число знаков) и падали уже внутри SDK. Предикат
 * продублирован ЗДЕСЬ (а не импортирован из `@solanapaykz/core`): SDK не
 * выносит точность тенге в публичный API (`src/index.ts` её не
 * экспортирует), а менять экспорт `@solanapaykz/core` — вне рамок этой
 * задачи.
 *
 * Экспортируется — запасной вход (`../http/routes-webhook.ts`) проверяет
 * ту же самую сумму тем же самым правилом. Правка финального ревью
 * (задача 9): раньше правило было продублировано ВТОРОЙ РАЗ, отдельной
 * копией в том файле — комментарий там честно объяснял, что копия
 * намеренная, но два числовых потолка (и два регулярных выражения)
 * неизбежно разошлись бы при первой же правке одного без другого. Один
 * и тот же запасной вход — тот же самый источник истины.
 */
export const ФОРМАТ_СУММЫ = /^\d+(\.\d{1,2})?$/;

/**
 * Верхняя граница суммы заказа в тенге. Не техническое ограничение SDK (там
 * предел — точность JS `number`, куда сумма попадает при построении
 * платёжной ссылки), а разумный потолок розничного заказа: без него строка
 * из нескольких сотен девяток проходит формат, котировка создаётся, а
 * ссылка на оплату получается с суммой `Infinity` — заказ заводится
 * заведомо неоткрываемым (находка ревью, воспроизведено). 100 000 000
 * тенге (100 млн) — с большим запасом выше любого мыслимого розничного
 * чека на Tilda, но далеко от границ точности `number`.
 *
 * Экспортируется по той же причине, что и `ФОРМАТ_СУММЫ` выше — см. её
 * комментарий.
 */
export const МАКСИМАЛЬНАЯ_СУММА_KZT = 100_000_000;

/**
 * Проверяет заказ Tilda: подпись, согласованность разбора с телом, валюту,
 * формат и знак суммы. Бросает при первом несоответствии.
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
  if (!verifySignature(body, order.signature, secret, 'order')) {
    throw new SignatureError();
  }

  // Подпись сверяется по body, а валюта и сумма ниже — по order: ничто
  // само по себе не гарантирует, что order разобран именно из этого body,
  // а не из другого запроса. Сейчас это только форма интерфейса, но именно
  // такая форма однажды позволяет вызвать функцию с разными источниками и
  // не заметить — сверяем все пять подписанных полей и закрываем вопрос.
  const пересобранный = parseTildaOrder(body);
  if (
    order.orderId !== пересобранный.orderId ||
    order.amountKzt !== пересобранный.amountKzt ||
    order.currency !== пересобранный.currency ||
    order.timestamp !== пересобранный.timestamp ||
    order.testMode !== пересобранный.testMode
  ) {
    throw new SignatureError(
      'Заказ разобран не из этого тела запроса: order и body не совпадают по подписанным полям',
    );
  }

  if (order.currency !== 'KZT') {
    // Текст ошибки уходит в ответ, который может увидеть покупатель —
    // историческая справка ему не по адресу, место ей здесь: расчёт по
    // валюте, отличной от валюты магазина, уже занижал сумму в 460 раз в
    // плагине WooCommerce (то же самое семейство ошибок, что и здесь).
    throw new CurrencyError(
      `Валюта заказа «${order.currency}» не поддерживается: считаем только в тенге (KZT)`,
    );
  }

  if (!ФОРМАТ_СУММЫ.test(order.amountKzt)) {
    throw new AmountError(
      `Сумма заказа «${order.amountKzt}» имеет неверный формат: допустимы только цифры и точка ` +
        'не более чем с двумя знаками дробной части, без пробелов, запятых и знака минус',
    );
  }

  const сумма = Number(order.amountKzt);

  if (сумма <= 0) {
    throw new AmountError(`Сумма заказа «${order.amountKzt}» должна быть больше нуля`);
  }

  if (сумма > МАКСИМАЛЬНАЯ_СУММА_KZT) {
    throw new AmountError(
      `Сумма заказа «${order.amountKzt}» превышает допустимый потолок ${МАКСИМАЛЬНАЯ_СУММА_KZT} тенге`,
    );
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
    // Найденная запись возвращается «как есть» только если она заведена
    // ровно ЭТИМИ же условиями — иначе это либо повторный вызов (в норме
    // сумма/валюта/режим совпадают всегда), либо чужой заказ, случайно или
    // намеренно занявший тот же номер (см. `OrderConflictError`). Сверяем с
    // ПОДПИСАННЫМ/только что разобранным `order`, а не наоборот — источник
    // истины сейчас в руках у вызывающего, а не в уже сохранённой записи.
    if (
      существующий.amountKzt !== order.amountKzt ||
      существующий.currency !== order.currency ||
      существующий.testMode !== order.testMode
    ) {
      deps.log.error(
        'Найден заказ с тем же номером Tilda, но с другими условиями — возможна подмена суммы. Отказ.',
        {
          tildaOrderId: order.orderId,
          суммаСохранённая: существующий.amountKzt,
          суммаЗапроса: order.amountKzt,
          валютаСохранённая: существующий.currency,
          валютаЗапроса: order.currency,
          тестСохранённый: существующий.testMode,
          тестЗапроса: order.testMode,
        },
      );
      throw new OrderConflictError(order.orderId);
    }
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
    // Валюта заказа — сохраняется отдельным столбцом ровно для сверки выше
    // (см. `OrderConflictError`), а не потому что мы когда-то считаем в
    // чём-то кроме тенге: `order.currency` на этом месте уже проверена
    // (`проверитьЗаказ`/хардкод вебхука формы) и всегда равна `'KZT'`.
    currency: order.currency,
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
    // Заморожен здесь и хранится: восстановить его позже неоткуда (валюта —
    // константа KZT, время можно взять свежее, а этот флаг — нет), а
    // уведомление Tilda (задача 8) обязано вернуть его обратно.
    testMode: order.testMode,
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
