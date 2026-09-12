import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signFields, verifySignature } from '../src/signature.js';

const секрет = 'секрет-для-подписи';

const заказ = {
  order_id: '10868059:42',
  amount: '15000',
  currency: 'KZT',
  timestamp: '1789200000',
  test_mode: '0',
};

describe('signFields', () => {
  it('считает HMAC-SHA-256 от роли и значений в фиксированном порядке', () => {
    const ожидаемая = createHmac('sha256', секрет)
      .update('order|10868059:42|15000|KZT|1789200000|0')
      .digest('hex');
    expect(signFields(заказ, секрет, 'order')).toBe(ожидаемая);
  });

  it('не зависит от порядка ключей во входном объекте', () => {
    const переставленный = {
      test_mode: '0',
      currency: 'KZT',
      order_id: '10868059:42',
      timestamp: '1789200000',
      amount: '15000',
    };
    expect(signFields(переставленный, секрет, 'order')).toBe(signFields(заказ, секрет, 'order'));
  });

  it('не зависит от полей вне списка подписи', () => {
    const с_текстом = { ...заказ, description: 'Букет «Астана» | доставка', products: '[]' };
    expect(signFields(с_текстом, секрет, 'order')).toBe(signFields(заказ, секрет, 'order'));
  });

  it('другой секрет даёт другую подпись', () => {
    expect(signFields(заказ, секрет, 'order')).not.toBe(signFields(заказ, 'другой-секрет', 'order'));
  });

  it('отвергает разделитель внутри поля подписи: это признак подделки', () => {
    expect(() => signFields({ ...заказ, amount: '150|00' }, секрет, 'order')).toThrow(/Разделитель/);
  });

  it('отсутствующее поле подписи считается пустым, а не пропускается', () => {
    const без_времени = { ...заказ, timestamp: '' };
    const ожидаемая = createHmac('sha256', секрет)
      .update('order|10868059:42|15000|KZT||0')
      .digest('hex');
    expect(signFields(без_времени, секрет, 'order')).toBe(ожидаемая);
  });

  describe('роль подписи (правка финального ревью — подписи заказа и уведомления не взаимозаменяемы)', () => {
    // Раньше обе подписи считались по ОДНОЙ И ТОЙ ЖЕ строке из одних и тех
    // же пяти полей — их различал только секрет, а равенство секретов
    // ничем не было запрещено, кроме фразы в README (см. отдельный тест
    // config.test.ts на запрет равенства). Метка роли делает подписи
    // невзаимозаменяемыми НЕЗАВИСИМО от того, совпали секреты или нет.

    it('одинаковые поля и секрет, но разная роль — разные подписи', () => {
      expect(signFields(заказ, секрет, 'order')).not.toBe(signFields(заказ, секрет, 'notify'));
    });

    it('даже при равном (гипотетически) секрете подпись заказа не проходит как подпись уведомления', () => {
      const подписьЗаказа = signFields(заказ, секрет, 'order');
      expect(verifySignature(заказ, подписьЗаказа, секрет, 'notify')).toBe(false);
      expect(verifySignature(заказ, подписьЗаказа, секрет, 'order')).toBe(true);
    });
  });
});

describe('verifySignature', () => {
  const поля = заказ;

  it('принимает верную подпись', () => {
    expect(verifySignature(поля, signFields(поля, секрет, 'order'), секрет, 'order')).toBe(true);
  });

  it('отвергает подделанную подпись', () => {
    expect(verifySignature(поля, 'a'.repeat(64), секрет, 'order')).toBe(false);
  });

  it('отвергает подпись, снятую с изменённой суммы', () => {
    const подпись = signFields(поля, секрет, 'order');
    expect(verifySignature({ ...поля, amount: '1' }, подпись, секрет, 'order')).toBe(false);
  });

  it('не роняет проверку, если в поле подписи подсунут разделитель', () => {
    const подпись = signFields(поля, секрет, 'order');
    expect(verifySignature({ ...поля, amount: '1|5' }, подпись, секрет, 'order')).toBe(false);
  });

  it('отвергает подпись неверной длины, не бросая исключение', () => {
    expect(verifySignature(поля, 'коротко', секрет, 'order')).toBe(false);
    expect(verifySignature(поля, '', секрет, 'order')).toBe(false);
  });

  it('не различает регистр шестнадцатеричной записи', () => {
    const подпись = signFields(поля, секрет, 'order');
    expect(verifySignature(поля, подпись.toUpperCase(), секрет, 'order')).toBe(true);
  });

  it('отсутствующее поле подписи в разобранном запросе даёт отказ, а не падение', () => {
    // Тело HTTP-запроса не типизировано: поле signature может просто
    // отсутствовать, и на границе с внешним миром сюда приходит undefined,
    // а не гарантированная типом строка.
    expect(verifySignature(поля, undefined as unknown as string, секрет, 'order')).toBe(false);
    expect(verifySignature(поля, null as unknown as string, секрет, 'order')).toBe(false);
    expect(verifySignature(поля, 123 as unknown as string, секрет, 'order')).toBe(false);
  });

  it('битые данные заказа из разобранного запроса дают отказ, а не падение', () => {
    // Тот же случай для fields: за границей HTTP-запроса это не обязательно
    // объект — там может оказаться null, массив или что угодно ещё.
    const подпись = signFields(поля, секрет, 'order');
    expect(verifySignature(null as unknown as Record<string, string>, подпись, секрет, 'order')).toBe(false);
    expect(verifySignature([] as unknown as Record<string, string>, подпись, секрет, 'order')).toBe(false);
    expect(verifySignature('строка' as unknown as Record<string, string>, подпись, секрет, 'order')).toBe(
      false,
    );
  });
});
