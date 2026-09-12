/**
 * Разметка страниц покупателя: страница оплаты, страница итога и общий
 * шаблон 404.
 *
 * Единственная содержательная опасность файла: описание заказа и состав
 * корзины приходят из НЕ заверенной части запроса Tilda (см. заголовок
 * `tilda/inbound.ts`) и правятся покупателем прямо в его браузере перед
 * отправкой. Всё, что из заказа попадает в разметку, обязано пройти через
 * `экранироватьHtml` — включая значения внутри атрибутов (`href`), а не
 * только текст между тегами.
 */
import type { Quote } from '@solanapaykz/core';
import type { Order, OrderState } from '../db.js';

/** Экранирует текст для безопасной вставки в HTML между тегами и в атрибуты. */
export function экранироватьHtml(текст: string): string {
  const ЗАМЕНЫ: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return текст.replace(/[&<>"']/g, (символ) => ЗАМЕНЫ[символ] ?? символ);
}

/** Человекочитаемый текст для покупателя по состоянию заказа. */
export function текстСостояния(state: OrderState): string {
  switch (state) {
    case 'ожидает':
      return 'Ожидаем оплату.';
    case 'оплачен':
      return 'Оплата получена. Спасибо!';
    case 'уведомлён':
      return 'Оплата получена, продавец уведомлён. Спасибо!';
    case 'не сошлось':
      return 'Платёж найден, но не сошёлся с суммой заказа. Магазин свяжется с вами.';
    case 'поздний':
      return 'Платёж получен после истечения срока действия цены. Магазин свяжется с вами.';
    case 'просрочен':
      return 'Срок оплаты истёк, платёж не найден. Оформите заказ заново.';
    case 'ошибка настроек':
      // Покупателю ни к чему подробности рассинхрона сети/адреса в
      // настройках продавца (см. db.ts, комментарий у OrderState) —
      // достаточно понятной причины обратиться в магазин напрямую, а не
      // ждать автоматики, которая сюда всё равно не дойдёт.
      return 'Оплата временно недоступна из-за настроек магазина. Свяжитесь с продавцом напрямую.';
  }
}

/**
 * CSS-класс статуса для `checkout.js` и `checkout.css`. Отдельно от самого
 * `OrderState`: тот может содержать пробел («не сошлось»), а это не годится
 * одним токеном имени класса.
 */
export function классСостояния(state: OrderState): string {
  switch (state) {
    case 'ожидает':
      return 'pending';
    case 'оплачен':
    case 'уведомлён':
      return 'paid';
    case 'не сошлось':
      return 'mismatch';
    case 'поздний':
      return 'late';
    case 'просрочен':
      return 'expired';
    case 'ошибка настроек':
      return 'config-error';
  }
}

/** Одна позиция состава корзины после разбора и экранирования. */
interface СтрокаТовара {
  name: string;
  quantity: string;
}

/**
 * Состав корзины, сохранённый заказом, в виде списка для показа.
 *
 * Поле вне подписи (см. заголовок файла) — испорченный JSON или неожиданная
 * форма элемента не должны ронять всю страницу оплаты, поэтому при любой
 * странности список просто не показывается.
 */
function разобратьТоварыДляПоказа(productsJson: string | null): СтрокаТовара[] {
  if (!productsJson) return [];
  let разобранное: unknown;
  try {
    разобранное = JSON.parse(productsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(разобранное)) return [];

  return разобранное.map((элемент): СтрокаТовара => {
    const т = (элемент ?? {}) as Record<string, unknown>;
    const имя = typeof т.name === 'string' && т.name.length > 0 ? т.name : 'Товар';
    const количество =
      typeof т.quantity === 'number' || typeof т.quantity === 'string' ? String(т.quantity) : '1';
    return { name: имя, quantity: количество };
  });
}

/**
 * Сумма в тенге, по которой ДЕЙСТВИТЕЛЬНО считалась сумма в токене
 * (`Quote.amountKztCharged` — с уже применённой наценкой продавца), а не
 * исходная сумма заказа (`Order.amountKzt`, без наценки).
 *
 * Правка финального ревью (задача 8): страница показывала сумму в токене,
 * посчитанную С наценкой, рядом с суммой в тенге и курсом БЕЗ наценки —
 * при ненулевой наценке эти числа не сходятся между собой (по названному
 * курсу и названной сумме в тенге получилась бы другая сумма в токене), и
 * покупатель списывает больше, чем ему назвали. Сейчас наценка везде
 * нулевая (`amountKztCharged === amountKzt`), поэтому разница спит — но
 * спящая дыра всё равно дыра.
 *
 * `quoteJson` — тот же самый объект `Quote`, что использовался при
 * создании заказа (задача 5), сохранённый как есть; парсим по месту, а
 * не заводим отдельный столбец под уже сохранённое значение. Не
 * ожидается сбоя (значение пишет сам сервер, не Tilda и не покупатель),
 * но при любой странности откатываемся к `order.amountKzt` — так же,
 * как этот файл уже поступает с составом корзины (`продажаТоваровHtml`
 * выше): показ страницы не должен падать из-за неожиданной формы
 * сохранённых данных.
 */
function суммаСНаценкой(order: Order): string {
  try {
    const quote = JSON.parse(order.quoteJson) as Partial<Quote>;
    return typeof quote.amountKztCharged === 'string' && quote.amountKztCharged.length > 0
      ? quote.amountKztCharged
      : order.amountKzt;
  } catch {
    return order.amountKzt;
  }
}

function составКорзиныHtml(productsJson: string | null): string {
  const товары = разобратьТоварыДляПоказа(productsJson);
  if (товары.length === 0) return '';

  const строки = товары
    .map((т) => `<li>${экранироватьHtml(т.name)} × ${экранироватьHtml(т.quantity)}</li>`)
    .join('');

  return `<ul class="solanapaykz__products">${строки}</ul>`;
}

function обёртка(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${экранироватьHtml(title)}</title>
<link rel="stylesheet" href="/assets/checkout.css">
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * Страница оплаты для заказа, ещё ожидающего платежа: сумма, QR и блок
 * опроса статуса.
 *
 * QR передаётся уже готовым SVG (см. `routes-page.ts`) — здесь он просто
 * вставляется как разметка, без экранирования: это не пользовательский
 * ввод, а строка, которую сама же наша серверная библиотека QR построила
 * из уже сохранённой платёжной ссылки.
 */
export function страницаОплаты(order: Order, секундОсталось: number, qrSvg: string): string {
  const описание = order.description
    ? `<p class="solanapaykz__description">${экранироватьHtml(order.description)}</p>`
    : '';
  const товары = составКорзиныHtml(order.productsJson);

  // Сумма, действительно использованная для расчёта суммы в токене (см.
  // заголовок суммаСНаценкой) — показываем ЕЁ рядом с курсом, а не
  // исходную сумму заказа: иначе при ненулевой наценке эти два числа не
  // сходятся между собой (задача 8, правка финального ревью).
  const суммаКзтДляРасчёта = суммаСНаценкой(order);
  const естьНаценка = суммаКзтДляРасчёта !== order.amountKzt;
  const строкаНаценки = естьНаценка
    ? `<p class="solanapaykz__markup">Включает наценку магазина. Без наценки: ${экранироватьHtml(order.amountKzt)} ₸.</p>`
    : '';

  // Данные для checkout.js идут через data-атрибуты контейнера, а не
  // встроенным <script>: страница отдаётся с `Content-Security-Policy:
  // default-src 'self'` (без 'unsafe-inline'), и встроенный скрипт этой
  // политикой блокируется целиком — браузер молча откажется его
  // исполнять, checkout.js так и не увидит своих данных, а покупатель,
  // который уже заплатил, не узнает об этом, пока не обновит страницу
  // вручную. `fetch` в тестах (Node) политику не применяет и эту ошибку
  // не ловит — обнаружено ревью в настоящем браузере. Внешний
  // `<script src="/assets/checkout.js">` под той же политикой разрешён:
  // это тот же источник ('self'), и это не встроенный код.
  //
  // Ни суммы, ни адреса получателя, ни метки платежа сюда не идёт —
  // только то, что не является денежным решением покупателя (см. также
  // JSON у /api/status).
  const атрибутыДанных =
    `data-status-url="${экранироватьHtml(`/api/status/${order.token}`)}" ` +
    `data-seconds-left="${секундОсталось}" ` +
    `data-interval-ms="5000"`;

  const body = `
<section class="solanapaykz" id="solanapaykz" ${атрибутыДанных}>
  <h1>Оплата заказа</h1>
  ${описание}
  ${товары}
  <p class="solanapaykz__amount">
    К оплате: <strong>${экранироватьHtml(order.amountToken)} ${экранироватьHtml(order.tokenSymbol)}</strong>
    <span class="solanapaykz__kzt">(${экранироватьHtml(суммаКзтДляРасчёта)} ₸ по курсу ${экранироватьHtml(order.rate)})</span>
  </p>
  ${строкаНаценки}
  <div class="solanapaykz__qr" id="solanapaykz-qr">${qrSvg}</div>
  <p class="solanapaykz__hint">Отсканируйте код кошельком Solana. Деньги придут продавцу напрямую.</p>
  <p class="solanapaykz__timer" id="solanapaykz-timer" aria-live="polite"></p>
  <p class="solanapaykz__status" id="solanapaykz-status" role="status" aria-live="polite">Ожидаем оплату…</p>
  <p class="solanapaykz__link">
    <a href="${экранироватьHtml(order.paymentUrl)}">Открыть в кошельке на этом устройстве</a>
  </p>
  <noscript>
    <p class="solanapaykz__hint">
      В браузере отключён JavaScript: код QR виден и без него, но статус оплаты не обновится
      сам. Оплатите по ссылке выше и обновите страницу вручную позже.
    </p>
  </noscript>
</section>
<script src="/assets/checkout.js"></script>`;

  return обёртка('Оплата заказа', body);
}

/**
 * Страница с сообщением о состоянии заказа, без QR и без ссылки на
 * кошелёк — общая часть для итоговой страницы и для отказа показать QR
 * из-за собственной ошибки сервера (например, не построился QR-код).
 */
export function страницаСообщения(order: Order, сообщение: string, cssКласс = 'error'): string {
  const описание = order.description
    ? `<p class="solanapaykz__description">${экранироватьHtml(order.description)}</p>`
    : '';

  const body = `
<section class="solanapaykz" id="solanapaykz">
  <h1>Оплата заказа</h1>
  ${описание}
  <p class="solanapaykz__status solanapaykz__status--${экранироватьHtml(cssКласс)}" role="status">
    ${экранироватьHtml(сообщение)}
  </p>
</section>`;

  return обёртка('Оплата заказа', body);
}

/**
 * Страница итога для заказа, который больше не ждёт оплаты (оплачен,
 * отменён, разбирается вручную и т. п.).
 *
 * Без QR и без ссылки на кошелёк намеренно: показывать их здесь — это
 * приглашение заплатить второй раз.
 */
export function страницаИтога(order: Order): string {
  return страницаСообщения(order, текстСостояния(order.state), классСостояния(order.state));
}

/** Тело ответа 404 — одинаковое для несуществующего и чужого ключа страницы. */
export function страница404(): string {
  return обёртка('Страница не найдена', '<p>Страница не найдена.</p>');
}
