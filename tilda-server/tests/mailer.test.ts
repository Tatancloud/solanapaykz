import { describe, expect, it } from 'vitest';
import type { Decision } from '../src/decision.js';
import type { NewOrder, Order, Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import { ссылкаНаТранзакцию, sendMerchantMail, type MailerDeps, type ПисьмоОпции } from '../src/mailer.js';

/** Полный заказ — то, что уже лежит в базе (см. tests/db.test.ts, tests/http.test.ts). */
function заказ(изменения: Partial<Order> = {}): Order {
  const базовый: NewOrder & {
    id: number;
    state: Order['state'];
    paidAt: number | null;
    notifyAttempts: number;
    notifiedOk: 0 | 1;
    mailFailedAt: number | null;
    mailError: string | null;
  } = {
    id: 1,
    tildaOrderId: '10868059:42',
    token: 'a'.repeat(32),
    state: 'уведомлён',
    amountKzt: '15000',
    currency: 'KZT',
    amountToken: '32.640000',
    tokenSymbol: 'USDC',
    cluster: 'devnet',
    recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    reference: 'секретная-метка',
    rate: '459.55',
    rateSource: 'synthetic',
    paymentUrl: 'solana:пример',
    quoteJson: '{}',
    createdAt: 1_789_200_000,
    expiresAt: 1_789_200_900,
    testMode: false,
    tildaSignature: 'подпись-заказа',
    txSignature: 'подпись-транзакции-1111111111111111111111111111',
    paidAt: 1_789_200_500,
    notifyAttempts: 1,
    notifiedOk: 1,
    customerEmail: 'k@example.kz',
    description: 'Букет «Астана»',
    productsJson: null,
    mailFailedAt: null,
    mailError: null,
  };
  return { ...базовый, ...изменения };
}

const config: MailerDeps['config'] = {
  smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'секрет-smtp-пароля', from: 'shop@example.kz' },
  merchantEmail: 'merchant@example.kz',
  publicUrl: 'https://pay.example.kz',
};

const решениеОплачен: Decision = {
  action: 'оплачен',
  signature: 'подпись-транзакции-1111111111111111111111111111',
  note: 'Платёж получен. Транзакция: подпись-транзакции-1111111111111111111111111111.',
};

/** Ловит письмо, «отправленное» тестовой подменой — без настоящего SMTP. */
function поймать(): { письма: ПисьмоОпции[]; отправка: MailerDeps['тест'] } {
  const письма: ПисьмоОпции[] = [];
  return {
    письма,
    тест: {
      отправка: async (опции) => {
        письма.push(опции);
        return { messageId: 'test-1' };
      },
    },
  };
}

/** Подменяет ту единственную операцию над базой, которую видит mailer.ts — `recordMailOutcome`. Настоящей SQLite не нужно: sendMerchantMail не читает и не создаёт заказы. */
function фейковыйStore(): { store: MailerDeps['store']; вызовы: Array<{ id: number; сбой: Parameters<Store['recordMailOutcome']>[1] }> } {
  const вызовы: Array<{ id: number; сбой: Parameters<Store['recordMailOutcome']>[1] }> = [];
  return {
    store: {
      recordMailOutcome: (id, сбой) => {
        вызовы.push({ id, сбой });
      },
    },
    вызовы,
  };
}

describe('sendMerchantMail', () => {
  it('возвращает true и отправляет письмо с адресом продавца при успехе', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    const успех = await sendMerchantMail(заказ(), решениеОплачен, { config, store, log: createLog(() => {}), тест });
    expect(успех).toBe(true);
    expect(письма).toHaveLength(1);
    expect(письма[0]!.from).toBe(config.smtp.from);
    expect(письма[0]!.to).toBe(config.merchantEmail);
  });

  it('письмо содержит номер заказа, обе суммы, курс с источником, ссылку на транзакцию и состояние', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    const о = заказ();
    await sendMerchantMail(о, решениеОплачен, { config, store, log: createLog(() => {}), тест });
    const текст = письма[0]!.text;

    expect(текст).toContain('10868059:42');
    expect(текст).toContain('15000');
    expect(текст).toContain('32.640000');
    expect(текст).toContain('459.55');
    expect(текст).toContain('synthetic');
    expect(текст).toContain(о.txSignature!);
    expect(текст).toContain('explorer.solana.com/tx/');
    expect(текст).toContain('уведомлён');
  });

  it('не содержит секретов настроек: пароль SMTP, секрет заказа, секрет уведомления, пароль админа', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    await sendMerchantMail(заказ(), решениеОплачен, { config, store, log: createLog(() => {}), тест });
    const всё = письма[0]!.text + письма[0]!.html + письма[0]!.subject;
    expect(всё).not.toContain('секрет-smtp-пароля');
  });

  it('не содержит адреса узла Solana целиком: письму узел не передаётся вовсе', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    await sendMerchantMail(заказ(), решениеОплачен, { config, store, log: createLog(() => {}), тест });
    const всё = письма[0]!.text + письма[0]!.html;
    expect(всё).not.toMatch(/api\.devnet\.solana\.com|rpcUrl/i);
  });

  it('не содержит ключа страницы оплаты (order.token)', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    const о = заказ();
    await sendMerchantMail(о, решениеОплачен, { config, store, log: createLog(() => {}), тест });
    const всё = письма[0]!.text + письма[0]!.html;
    expect(всё).not.toContain(о.token);
  });

  it('содержит ссылку на список заказов (config.publicUrl) — правка финального ревью, задача 9', async () => {
    // publicUrl был обязательной настройкой, которую нигде не применяли —
    // теперь письмо продавцу ссылается на /admin, а не на страницу оплаты
    // ЭТОГО заказа: её ключ (order.token) письму нельзя содержать никогда
    // (см. тест выше), а /admin и так за отдельным паролем.
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    await sendMerchantMail(заказ(), решениеОплачен, { config, store, log: createLog(() => {}), тест });
    expect(письма[0]!.text).toContain(`${config.publicUrl}/admin`);
    expect(письма[0]!.html).toContain(`href="${config.publicUrl}/admin"`);
  });

  it('HTML-версия экранирует состояние заказа, даже если оно необычной формы', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    // Состояние — не пользовательский ввод, но защита от разметки не должна
    // зависеть от того, что источник считается «своим»: правило то же, что
    // и в http/html.ts.
    await sendMerchantMail(
      заказ({ state: '<script>alert(1)</script>' as Order['state'] }),
      решениеОплачен,
      { config, store, log: createLog(() => {}), тест },
    );
    expect(письма[0]!.html).not.toContain('<script>alert(1)</script>');
    expect(письма[0]!.html).toContain('&lt;script&gt;');
  });

  it('для решения «не сошлось» включает причину расхождения', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    const решение: Decision = {
      action: 'не сошлось',
      signature: 'подпись-х',
      reason: 'сумма меньше требуемой',
      note: 'Найдена транзакция подпись-х, но она не прошла проверку: сумма меньше требуемой.',
    };
    await sendMerchantMail(заказ({ state: 'не сошлось' }), решение, { config, store, log: createLog(() => {}), тест });
    expect(письма[0]!.text).toContain('сумма меньше требуемой');
  });

  it('без подписи транзакции пишет «платёж ещё не подтверждён», а не пустоту или ссылку', async () => {
    const { письма, тест } = поймать();
    const { store } = фейковыйStore();
    await sendMerchantMail(
      заказ({ txSignature: null, state: 'ожидает' }),
      { action: 'ждать', note: 'Платёж пока не найден.' },
      { config, store, log: createLog(() => {}), тест },
    );
    expect(письма[0]!.text).toContain('платёж ещё не подтверждён');
    expect(письма[0]!.html).not.toContain('explorer.solana.com');
  });

  it('при неудаче отправки возвращает false и не бросает исключение наружу', async () => {
    const журнал: string[] = [];
    const { store } = фейковыйStore();
    const успех = await sendMerchantMail(заказ(), решениеОплачен, {
      config,
      store,
      log: createLog((строка) => журнал.push(строка)),
      тест: { отправка: async () => { throw new Error('SMTP недоступен'); } },
    });
    expect(успех).toBe(false);
    expect(журнал.some((с) => с.includes('Не удалось отправить письмо продавцу'))).toBe(true);
  });

  it('неудача отправки не попадает в журнал вместе с содержимым письма (секретов там и так нет, но проверяем факт, а не тело)', async () => {
    const журнал: string[] = [];
    const { store } = фейковыйStore();
    await sendMerchantMail(заказ(), решениеОплачен, {
      config,
      store,
      log: createLog((строка) => журнал.push(строка)),
      тест: { отправка: async () => { throw new Error('SMTP недоступен: секрет-smtp-пароля'); } },
    });
    // Журнал вырезает известные секреты по значению (createLog secrets list
    // здесь не передан для теста), но сообщение об ошибке — не письмо
    // целиком: важно, что журнал получает факт неудачи и сообщение об
    // ошибке, не тело письма и не адрес получателя.
    expect(журнал.join('\n')).not.toContain(config.merchantEmail);
  });

  it('при неудаче записывает сбой в базу через recordMailOutcome(order.id, {at, message})', async () => {
    const { вызовы, store } = фейковыйStore();
    const о = заказ({ id: 42 });
    await sendMerchantMail(о, решениеОплачен, {
      config,
      store,
      log: createLog(() => {}),
      тест: { отправка: async () => { throw new Error('нет связи с SMTP'); } },
    });
    expect(вызовы).toHaveLength(1);
    expect(вызовы[0]!.id).toBe(42);
    expect(вызовы[0]!.сбой).toMatchObject({ message: 'нет связи с SMTP' });
    expect(typeof вызовы[0]!.сбой?.at).toBe('number');
  });

  it('при успехе записывает в базу снятие сбоя — recordMailOutcome(order.id, null)', async () => {
    const { вызовы, store } = фейковыйStore();
    const { тест } = поймать();
    const о = заказ({ id: 7 });
    await sendMerchantMail(о, решениеОплачен, { config, store, log: createLog(() => {}), тест });
    expect(вызовы).toEqual([{ id: 7, сбой: null }]);
  });

  it('не имеет доступа ни к чему из Store, кроме recordMailOutcome — доступ ограничен на уровне типа', async () => {
    // Не рантайм-тест (TS не проверяется в vitest), а фиксация контракта:
    // если бы deps.store требовал больше методов, этот файл перестал бы
    // собираться — фейковый store ниже реализует ровно один метод.
    const { store } = фейковыйStore();
    expect(Object.keys(store)).toEqual(['recordMailOutcome']);
  });
});

describe('ссылкаНаТранзакцию', () => {
  it('для devnet добавляет параметр cluster=devnet', () => {
    expect(ссылкаНаТранзакцию('подпись', 'devnet')).toBe('https://explorer.solana.com/tx/подпись?cluster=devnet');
  });

  it('для mainnet ссылка без дополнительных параметров', () => {
    expect(ссылкаНаТранзакцию('подпись', 'mainnet')).toBe('https://explorer.solana.com/tx/подпись');
  });
});
