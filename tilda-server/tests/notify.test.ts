import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type NewOrder, type Order, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import { signFields } from '../src/signature.js';
import { notifyTilda, type NotifyDeps, type Отправка } from '../src/tilda/notify.js';

const config = {
  notifySecret: 'секрет-уведомления',
  orderSecret: 'секрет-заказа',
  tildaNotifyUrl: 'https://tilda.cc/payment/notify/abc',
};

const образецНовогоЗаказа: NewOrder = {
  tildaOrderId: '10868059:42',
  token: 'a'.repeat(32),
  amountKzt: '15000',
  amountToken: '32.640000',
  tokenSymbol: 'USDC',
  cluster: 'devnet',
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  reference: 'секретная-метка',
  rate: '459.55',
  rateSource: 'synthetic',
  paymentUrl: 'solana:пример',
  quoteJson: '{}',
  createdAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 900,
  testMode: false,
  tildaSignature: 'подпись-заказа',
  txSignature: 'подпись-транзакции-1',
  customerEmail: null,
  description: null,
  productsJson: null,
};

/** Готовый ответ на отправку — без сети, без ожидания. */
function ответ(status: number, body: string): Отправка {
  return async () => ({ status, body });
}

/** Отвечает неуспехом дважды подряд, затем — успехом. */
function падаетДважды(): Отправка {
  let вызов = 0;
  return async () => {
    вызов += 1;
    return вызов <= 2 ? { status: 500, body: 'ошибка' } : { status: 200, body: 'OK' };
  };
}

/** Никогда не отвечает успехом. */
function всегдаПадает(): Отправка {
  return async () => ({ status: 500, body: 'ошибка сервера' });
}

/** Перехватывает поля, реально переданные в отправку, минуя сеть. */
async function перехватитьОтправку(
  вызвать: (отправка: Отправка) => Promise<unknown>,
): Promise<Record<string, string>> {
  let перехваченные: Record<string, string> | null = null;
  const отправка: Отправка = async (_url, поля) => {
    перехваченные = поля;
    return { status: 200, body: 'OK' };
  };
  await вызвать(отправка);
  if (!перехваченные) throw new Error('отправка ни разу не была вызвана');
  return перехваченные;
}

describe('notifyTilda', () => {
  let каталог: string;
  let store: Store;
  let журнал: string[];
  let заказ: Order;
  let deps: NotifyDeps;

  beforeEach(() => {
    каталог = mkdtempSync(join(tmpdir(), 'spkz-notify-'));
    store = openDatabase(join(каталог, 'orders.sqlite'));
    журнал = [];
    заказ = store.createOrder(образецНовогоЗаказа);
    store.updateState(заказ.id, 'оплачен', { txSignature: 'подпись-транзакции-1' });
    заказ = store.findByToken(заказ.token)!;
    deps = {
      config,
      store,
      log: createLog((строка) => журнал.push(строка)),
      // Настоящие паузы (1, 5, 15, 60 секунд) — для боя; здесь достаточно
      // проверить сам факт повтора и счётчик попыток, а не честно ждать
      // почти полторы минуты в каждом прогоне тестов.
      задержкиMs: [1, 1, 1, 1],
    };
  });

  afterEach(() => {
    rmSync(каталог, { recursive: true, force: true });
  });

  it('подписывает уведомление секретом уведомления, а не секретом заказа', async () => {
    const отправленное = await перехватитьОтправку((отправка) =>
      notifyTilda(заказ, { ...deps, отправка }),
    );
    expect(отправленное.signature).toBe(signFields(отправленное, config.notifySecret));
    expect(отправленное.signature).not.toBe(signFields(отправленное, config.orderSecret));
  });

  it('несёт order_id, amount, currency, test_mode, status «paid» и подпись транзакции', async () => {
    const отправленное = await перехватитьОтправку((отправка) =>
      notifyTilda(заказ, { ...deps, отправка }),
    );
    expect(отправленное.order_id).toBe(заказ.tildaOrderId);
    expect(отправленное.amount).toBe(заказ.amountKzt);
    expect(отправленное.currency).toBe('KZT');
    expect(отправленное.test_mode).toBe('0');
    expect(отправленное.status).toBe('paid');
    expect(отправленное.transaction).toBe(заказ.txSignature);
  });

  it('считает успехом только тело OK', async () => {
    expect(await notifyTilda(заказ, { ...deps, отправка: ответ(200, 'OK') })).toBe(true);
    expect(await notifyTilda(заказ, { ...deps, отправка: ответ(200, 'что-то другое') })).toBe(false);
    expect(await notifyTilda(заказ, { ...deps, отправка: ответ(500, 'OK') })).toBe(false);
  });

  it('повторяет с нарастающими паузами и запоминает число попыток', async () => {
    const результат = await notifyTilda(заказ, { ...deps, отправка: падаетДважды() });
    expect(результат).toBe(true);
    const после = store.findByToken(заказ.token);
    expect(после?.notifyAttempts).toBe(3);
    expect(после?.notifiedOk).toBe(1);
  });

  it('исчерпав попытки, оставляет заказ оплаченным, но не уведомлённым', async () => {
    const результат = await notifyTilda(заказ, { ...deps, отправка: всегдаПадает() });
    expect(результат).toBe(false);
    const после = store.findByToken(заказ.token);
    // Состояние заказа notifyTilda не трогает вовсе — им управляет
    // src/checker.ts после получения результата (см. tests/checker.test.ts).
    expect(после?.state).toBe('оплачен');
    expect(после?.notifiedOk).toBe(0);
    expect(после?.notifyAttempts).toBe(5);
  });

  it('помечает попытку в базе ДО отправки: падение процесса не приведёт к повторной отправке при перечтении', async () => {
    let попытокЗамеченоВБазеВнутриОтправки = 0;
    const отправка: Отправка = async () => {
      // На момент вызова самой отправки заказ уже должен быть помечен как
      // «попытка была» — иначе неудачное завершение процесса ровно здесь
      // (после ухода запроса, до записи исхода) осталось бы незамеченным.
      попытокЗамеченоВБазеВнутриОтправки = store.findByToken(заказ.token)?.notifyAttempts ?? 0;
      return { status: 200, body: 'OK' };
    };
    await notifyTilda(заказ, { ...deps, отправка });
    expect(попытокЗамеченоВБазеВнутриОтправки).toBe(1);
  });

  it('не пишет в журнал ни подпись, ни секрет уведомления', async () => {
    await notifyTilda(заказ, { ...deps, отправка: всегдаПадает() });
    const отправленное = await перехватитьОтправку((отправка) =>
      notifyTilda(заказ, { ...deps, отправка }),
    );
    const весьЖурнал = журнал.join('\n');
    expect(весьЖурнал).not.toContain(отправленное.signature);
    expect(весьЖурнал).not.toContain(config.notifySecret);
  });

  it('падение сети (исключение внутри отправки) — тоже неуспех, а не необработанный сбой', async () => {
    const отправка: Отправка = async () => {
      throw new Error('сеть недоступна');
    };
    await expect(notifyTilda(заказ, { ...deps, отправка })).resolves.toBe(false);
  });

  it('без переданного txSignature шлёт пустую строку transaction, а не падает', async () => {
    store.updateState(заказ.id, 'оплачен', { txSignature: null });
    заказ = store.findByToken(заказ.token)!;
    const отправленное = await перехватитьОтправку((отправка) =>
      notifyTilda(заказ, { ...deps, отправка }),
    );
    expect(отправленное.transaction).toBe('');
  });
});
