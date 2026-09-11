/**
 * Письмо продавцу о состоянии заказа.
 *
 * Что входит: номер заказа Tilda, сумма в тенге и в токенах, курс и его
 * источник, подпись транзакции ссылкой на публичный обозреватель, состояние
 * заказа. Ровно то, что нужно человеку для проверки, — не больше.
 *
 * Что НЕ входит никогда, ни при каких обстоятельствах: секреты настроек
 * (`orderSecret`, `notifySecret`, `adminPassword`, `smtp.pass`), адрес узла
 * Solana (`rpcUrl` сюда вообще не передаётся — письму узел не нужен) и ключ
 * страницы оплаты (`order.token`). Эти три вещи не должны покидать сервер ни
 * в одном канале — см. также заголовки `log.ts` и `http/html.ts`.
 *
 * Неудача отправки НЕ меняет и не может менять состояние заказа: почта — не
 * источник правды о платеже (см. `decision.ts`, `checker.ts` — статус
 * `notifiedOk` там же ведает Tilda, а не письмо продавцу). Всё, что делает
 * эта функция при неудаче, — журналирует её и записывает факт через
 * `Store.recordMailOutcome` (см. `db.ts`), чтобы неудача была видна в
 * списке заказов (`http/routes-admin.ts`) и пережила перезапуск сервера:
 * письмо — основной способ продавца узнать об оплате, и молчаливый провал
 * отправки означает, что он не узнает вообще.
 */
import nodemailer from 'nodemailer';
import type { Cluster, Config } from './config.js';
import type { Decision } from './decision.js';
import type { Order, Store } from './db.js';
import type { Log } from './log.js';
import { экранироватьHtml } from './http/html.js';

/** Ссылка на публичный обозреватель транзакций Solana. Подпись транзакции — открытые данные, секретов не несёт. */
export function ссылкаНаТранзакцию(signature: string, cluster: Cluster): string {
  const параметрСети = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://explorer.solana.com/tx/${signature}${параметрСети}`;
}

/** Что вернула настоящая или подменённая в тесте отправка письма. */
export interface РезультатОтправки {
  messageId?: string;
}

export interface ПисьмоОпции {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Отправка одного письма. */
export type ОтправкаПисьма = (опции: ПисьмоОпции) => Promise<РезультатОтправки>;

export interface MailerDeps {
  config: Pick<Config, 'smtp' | 'merchantEmail'>;
  /**
   * Только `recordMailOutcome`: эта функция не читает и не создаёт заказы,
   * а исход отправки — единственное, что ей позволено писать в базу. Уже
   * тип не даст случайно дописать сюда, скажем, вызов `updateState`.
   */
  store: Pick<Store, 'recordMailOutcome'>;
  log: Log;
  /** Только для тестов: подменяет настоящую отправку через SMTP. */
  тест?: { отправка?: ОтправкаПисьма };
}

function транзакцияТекстом(order: Order): string {
  return order.txSignature ? ссылкаНаТранзакцию(order.txSignature, order.cluster) : 'платёж ещё не подтверждён';
}

function транзакцияHtml(order: Order): string {
  if (!order.txSignature) return 'платёж ещё не подтверждён';
  const url = ссылкаНаТранзакцию(order.txSignature, order.cluster);
  return `<a href="${экранироватьHtml(url)}">${экранироватьHtml(order.txSignature)}</a>`;
}

/** Пояснение решения автоматики — для «не сошлось» добавляет причину расхождения. */
function пояснение(decision: Decision): string {
  if (decision.action === 'не сошлось') {
    return `${decision.note} Причина расхождения: ${decision.reason}`;
  }
  return decision.note;
}

/** Одна строка письма: подпись поля и оба представления значения (текст, HTML — уже экранированный, кроме ссылки транзакции). */
function строкиПисьма(order: Order, decision: Decision): Array<{ label: string; text: string; html: string }> {
  return [
    { label: 'Номер заказа Tilda', text: order.tildaOrderId, html: экранироватьHtml(order.tildaOrderId) },
    { label: 'Сумма', text: `${order.amountKzt} ₸`, html: экранироватьHtml(`${order.amountKzt} ₸`) },
    {
      label: 'К оплате в токене',
      text: `${order.amountToken} ${order.tokenSymbol}`,
      html: экранироватьHtml(`${order.amountToken} ${order.tokenSymbol}`),
    },
    {
      label: 'Курс',
      text: `${order.rate} (источник: ${order.rateSource})`,
      html: экранироватьHtml(`${order.rate} (источник: ${order.rateSource})`),
    },
    { label: 'Транзакция', text: транзакцияТекстом(order), html: транзакцияHtml(order) },
    { label: 'Состояние заказа', text: order.state, html: экранироватьHtml(order.state) },
    { label: 'Пояснение', text: пояснение(decision), html: экранироватьHtml(пояснение(decision)) },
  ];
}

function построитьПисьмо(order: Order, decision: Decision): { subject: string; text: string; html: string } {
  const строки = строкиПисьма(order, decision);
  const subject = `SolanaPay-KZ: заказ ${order.tildaOrderId} — ${order.state}`;
  const text = строки.map((с) => `${с.label}: ${с.text}`).join('\n');
  const html = `<table>${строки
    .map((с) => `<tr><th>${экранироватьHtml(с.label)}</th><td>${с.html}</td></tr>`)
    .join('')}</table>`;
  return { subject, text, html };
}

/** Настоящая отправка через SMTP из настроек. `port === 465` — неявный TLS (SMTPS), как у большинства провайдеров на этом порту. */
async function реальнаяОтправка(smtp: Config['smtp'], опции: ПисьмоОпции): Promise<РезультатОтправки> {
  const транспорт = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  try {
    const результат: unknown = await транспорт.sendMail(опции);
    const messageId = (результат as { messageId?: string } | undefined)?.messageId;
    return messageId === undefined ? {} : { messageId };
  } finally {
    транспорт.close();
  }
}

/**
 * Отправляет продавцу письмо о состоянии заказа. Возвращает признак успеха.
 *
 * При неудаче: журналирует (без секретов и без ключа страницы оплаты — само
 * письмо в журнал не попадает, только его тема и текст ошибки), записывает
 * сбой в базу через `store.recordMailOutcome` (виден в списке заказов и
 * переживает перезапуск сервера) и возвращает `false`. `state` заказа при
 * этом не трогает: `recordMailOutcome` пишет только свои две колонки (см.
 * `db.ts`), состояние заказа физически не может задеть.
 */
export async function sendMerchantMail(order: Order, decision: Decision, deps: MailerDeps): Promise<boolean> {
  const { subject, text, html } = построитьПисьмо(order, decision);
  const опции: ПисьмоОпции = { from: deps.config.smtp.from, to: deps.config.merchantEmail, subject, text, html };
  const отправить = deps.тест?.отправка ?? ((о: ПисьмоОпции) => реальнаяОтправка(deps.config.smtp, о));

  try {
    await отправить(опции);
    deps.store.recordMailOutcome(order.id, null);
    return true;
  } catch (е) {
    const сообщение = (е as Error).message;
    deps.log.error(
      'Не удалось отправить письмо продавцу — состояние заказа не меняется, почта не источник правды о платеже',
      { tildaOrderId: order.tildaOrderId, subject, сообщение },
    );
    deps.store.recordMailOutcome(order.id, { at: Math.floor(Date.now() / 1000), message: сообщение });
    return false;
  }
}
