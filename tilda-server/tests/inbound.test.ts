import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Quote, PaymentRequest } from '@solanapaykz/core';
import { openDatabase, type Store } from '../src/db.js';
import { createLog } from '../src/log.js';
import { signFields } from '../src/signature.js';
import {
  AmountError,
  createPaymentFor,
  CurrencyError,
  parseTildaOrder,
  SignatureError,
  проверитьЗаказ,
  type CreatePaymentForDeps,
  type PaymentClient,
  type TildaOrder,
} from '../src/tilda/inbound.js';

const секрет = 'секрет-заказа';

function телоЗаказа(изменения: Record<string, string> = {}): Record<string, string> {
  const поля: Record<string, string> = {
    order_id: '10868059:42',
    amount: '15000',
    currency: 'KZT',
    timestamp: '1789200000',
    test_mode: '0',
    description: 'Букет «Астана»',
    products: '[{"name":"Букет","quantity":1,"price":15000}]',
    email: 'k@example.kz',
    notify_url: 'https://tilda.cc/payment/notify/abc',
    ...изменения,
  };
  return { ...поля, signature: signFields(поля, секрет) };
}

function парс(тело: Record<string, string>) {
  return parseTildaOrder(тело);
}

describe('parseTildaOrder', () => {
  it('разбирает обязательные поля', () => {
    const з = parseTildaOrder(телоЗаказа());
    expect(з.orderId).toBe('10868059:42');
    expect(з.amountKzt).toBe('15000');
    expect(з.testMode).toBe(false);
  });

  it('не падает на незнакомых полях: состав запроса Tilda может измениться', () => {
    expect(() => parseTildaOrder({ ...телоЗаказа(), неизвестное_поле: 'что-то' })).not.toThrow();
  });

  it('пустые необязательные поля становятся null, а не пустой строкой', () => {
    const з = parseTildaOrder(телоЗаказа({ email: '', description: '' }));
    expect(з.email).toBeNull();
    expect(з.description).toBeNull();
  });

  it('испорченный JSON состава корзины не роняет разбор', () => {
    const з = parseTildaOrder(телоЗаказа({ products: 'не json' }));
    expect(з.products).toBeNull();
  });
});

describe('проверитьЗаказ', () => {
  it('принимает заказ с верной подписью в тенге', () => {
    expect(() => проверитьЗаказ(парс(телоЗаказа()), телоЗаказа(), секрет)).not.toThrow();
  });

  it('отвергает подделанную сумму', () => {
    const тело = телоЗаказа();
    const подделка = { ...тело, amount: '1' };
    expect(() => проверитьЗаказ(парс(подделка), подделка, секрет)).toThrow(SignatureError);
  });

  it('отвергает чужую валюту: считать в неё мы не умеем', () => {
    const тело = телоЗаказа({ currency: 'USD' });
    expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow(CurrencyError);
  });

  it('отвергает отрицательную и нулевую сумму', () => {
    for (const сумма of ['0', '-100']) {
      const тело = телоЗаказа({ amount: сумма });
      expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow(AmountError);
    }
  });

  it('отвергает сумму с посторонними символами', () => {
    const тело = телоЗаказа({ amount: '15 000,00' });
    expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow(AmountError);
  });

  it('принимает сумму ровно с двумя знаками после точки', () => {
    const тело = телоЗаказа({ amount: '15000.50' });
    expect(() => проверитьЗаказ(парс(тело), тело, секрет)).not.toThrow();
  });

  it('отвергает сумму точнее тиына: SDK хранит тенге с точностью до двух знаков', () => {
    for (const сумма of ['0.0000001', '15000.000000000000001']) {
      const тело = телоЗаказа({ amount: сумма });
      expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow(AmountError);
    }
  });

  it('отвергает сумму выше разумного потолка: иначе ссылка на оплату получается с суммой Infinity', () => {
    const тело = телоЗаказа({ amount: '9'.repeat(400) });
    expect(() => проверитьЗаказ(парс(тело), тело, секрет)).toThrow(AmountError);
  });
});

/**
 * Фейковый клиент SDK для тестов `createPaymentFor`: без него тесты били бы
 * по сети (курс с Binance) и превратили бы секундный набор в медленный.
 * Считает вызовы, чтобы идемпотентность было видно по числу обращений, а не
 * только по совпадению полей результата.
 */
function фейковыйКлиент(): PaymentClient & {
  вызововКотировки: number;
  вызововЗапроса: number;
  последняяМетка: string | undefined;
} {
  let котировка = 0;
  let запрос = 0;
  let последняяМетка: string | undefined;
  return {
    get вызововКотировки() {
      return котировка;
    },
    get вызововЗапроса() {
      return запрос;
    },
    get последняяМетка() {
      return последняяМетка;
    },
    async createQuote({ amountKzt, token }): Promise<Quote> {
      котировка += 1;
      return Object.freeze({
        quoteId: `котировка-${котировка}`,
        amountKzt,
        amountKztCharged: amountKzt,
        token,
        cluster: 'devnet',
        amountToken: '32.640000',
        rate: '459.55',
        rateSource: 'synthetic',
        createdAt: new Date(1789200000000).toISOString(),
        expiresAt: new Date(1789200900000).toISOString(),
      });
    },
    async createPaymentRequest(quote, options): Promise<PaymentRequest> {
      запрос += 1;
      последняяМетка = options?.label;
      return {
        quote,
        url: `solana:пример-${запрос}`,
        reference: `метка-${запрос}`,
        qrSvg: '<svg></svg>',
      };
    },
  };
}

/** Курс недоступен: createQuote всегда отказывает, как настоящий SDK при сбое всех источников курса. */
function клиентБезКурса(): PaymentClient {
  return {
    async createQuote() {
      throw new Error('курс недоступен: ни один источник не ответил');
    },
    async createPaymentRequest() {
      throw new Error('не должно вызываться: котировки нет');
    },
  };
}

describe('createPaymentFor', () => {
  let каталог: string;
  let store: Store;
  let deps: CreatePaymentForDeps;
  let заказ: TildaOrder;
  let журнал: string[];

  beforeEach(() => {
    каталог = mkdtempSync(join(tmpdir(), 'spkz-inbound-'));
    store = openDatabase(join(каталог, 'orders.sqlite'));
    журнал = [];
    deps = {
      store,
      client: фейковыйКлиент(),
      config: {
        token: 'USDC',
        recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        shopName: '',
        // Совпадает с notify_url в телоЗаказа() по умолчанию — предупреждение
        // о рассинхроне не должно сработать на «нормальном» заказе.
        tildaNotifyUrl: 'https://tilda.cc/payment/notify/abc',
      },
      log: createLog((строка) => журнал.push(строка)),
    };
    заказ = парс(телоЗаказа());
  });

  afterEach(() => {
    rmSync(каталог, { recursive: true, force: true });
  });

  it('недоступный курс не создаёт заказ: продажа по неизвестному курсу хуже отказа', async () => {
    await expect(createPaymentFor(заказ, { ...deps, client: клиентБезКурса() })).rejects.toThrow();
    expect(store.findByTildaOrderId(заказ.orderId)).toBeNull();
  });

  it('повторный запрос с тем же номером не выпускает новую метку', async () => {
    const первый = await createPaymentFor(заказ, deps);
    const второй = await createPaymentFor(заказ, deps);
    expect(второй.id).toBe(первый.id);
    expect(второй.reference).toBe(первый.reference);
    expect(второй.amountToken).toBe(первый.amountToken);
    expect(второй.token).toBe(первый.token);
    // Клиент SDK не должен был звать курс и платёжный запрос второй раз —
    // иначе цифры выше совпали бы случайно, а не по причине идемпотентности.
    expect((deps.client as ReturnType<typeof фейковыйКлиент>).вызововКотировки).toBe(1);
    expect((deps.client as ReturnType<typeof фейковыйКлиент>).вызововЗапроса).toBe(1);
  });

  it('заводит запись заказа с полями из котировки и заявки', async () => {
    const созданный = await createPaymentFor(заказ, deps);
    expect(созданный.tildaOrderId).toBe('10868059:42');
    expect(созданный.state).toBe('ожидает');
    expect(созданный.amountKzt).toBe('15000');
    expect(созданный.amountToken).toBe('32.640000');
    expect(созданный.tokenSymbol).toBe('USDC');
    expect(созданный.recipient).toBe('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(созданный.customerEmail).toBe('k@example.kz');
    expect(созданный.description).toBe('Букет «Астана»');
    expect(созданный.testMode).toBe(false);
    expect(JSON.parse(созданный.productsJson ?? 'null')).toEqual([
      { name: 'Букет', quantity: 1, price: 15000 },
    ]);
    // notify_url из запроса не хранится в заказе вовсе — Order его не несёт
    // (см. db.ts): у типа просто нет такого поля, это проверено компилятором,
    // а не отдельным assert.
  });

  it('признак тестового режима сохраняется в заказе — восстановить его позже неоткуда', async () => {
    заказ = парс(телоЗаказа({ test_mode: '1' }));
    const созданный = await createPaymentFor(заказ, deps);
    expect(созданный.testMode).toBe(true);
  });

  it('уведомления всегда идут по config.tildaNotifyUrl, а не по notify_url из запроса', async () => {
    заказ = парс(телоЗаказа({ notify_url: 'https://evil.example/steal?token=x' }));
    await createPaymentFor(заказ, deps);
    // Несовпадение — сигнал для журнала (продавец мог сменить настройки в
    // Tilda), но не денежное решение: адрес всё равно берётся из конфига.
    const строка = журнал.find((с) => с.includes('notify_url'));
    expect(строка).toBeDefined();
    // Схема и хост остаются (как у любого URL в журнале — см. log.ts), а
    // путь и параметры — нет: значение самого поля попало бы в путь/query
    // ровно там, где живёт что угодно, что покупатель туда вписал.
    expect(строка).toContain('https://evil.example');
    expect(строка).not.toContain('/steal');
    expect(строка).not.toContain('token=x');
  });

  it('совпадающий с настройками notify_url не пишет предупреждение', async () => {
    // По умолчанию телоЗаказа().notify_url совпадает с deps.config.tildaNotifyUrl.
    await createPaymentFor(заказ, deps);
    expect(журнал.some((с) => с.includes('notify_url'))).toBe(false);
  });

  it('без названия магазина в настройках метка платежа — общая фраза', async () => {
    await createPaymentFor(заказ, deps);
    expect((deps.client as ReturnType<typeof фейковыйКлиент>).последняяМетка).toBe('Оплата заказа');
  });

  it('название магазина из настроек идёт меткой платежа: покупатель должен видеть, кому платит', async () => {
    deps = { ...deps, config: { ...deps.config, shopName: 'Цветы Астана' } };
    await createPaymentFor(заказ, deps);
    expect((deps.client as ReturnType<typeof фейковыйКлиент>).последняяМетка).toBe('Цветы Астана');
  });

  it('параллельная гонка: второй createOrder ловит DuplicateOrderError и перечитывает запись', async () => {
    // Настоящую гонку двух процессов в юнит-тесте не воспроизвести — здесь
    // имитируем её результат: к моменту первой проверки findByTildaOrderId
    // заказа ещё не видно (гонка ещё не разрешилась), но конкурент уже
    // вставил свою строку раньше нашей вставки — createOrder обязан
    // получить DuplicateOrderError и перечитать запись, а не свою.
    let вызововПоиска = 0;
    const обёрнутыйStore: Store = {
      ...store,
      findByTildaOrderId(id: string) {
        вызововПоиска += 1;
        if (вызововПоиска === 1) return null;
        return store.findByTildaOrderId(id);
      },
    };
    deps = { ...deps, store: обёрнутыйStore };

    store.createOrder({
      tildaOrderId: заказ.orderId,
      token: 'уже-занятый-токен',
      amountKzt: '15000',
      amountToken: '32.640000',
      tokenSymbol: 'USDC',
      cluster: 'devnet',
      recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      reference: 'метка-соперника',
      rate: '459.55',
      rateSource: 'synthetic',
      paymentUrl: 'solana:соперник',
      quoteJson: '{}',
      createdAt: 1789200000,
      expiresAt: 1789200900,
      testMode: заказ.testMode,
      tildaSignature: заказ.signature,
      txSignature: null,
      customerEmail: заказ.email,
      description: заказ.description,
      productsJson: '[]',
    });

    const результат = await createPaymentFor(заказ, deps);
    expect(результат.reference).toBe('метка-соперника');
    expect(результат.token).toBe('уже-занятый-токен');
  });
});
