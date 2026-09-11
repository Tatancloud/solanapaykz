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
  it('считает HMAC-SHA-256 от значений в фиксированном порядке', () => {
    const ожидаемая = createHmac('sha256', секрет)
      .update('10868059:42|15000|KZT|1789200000|0')
      .digest('hex');
    expect(signFields(заказ, секрет)).toBe(ожидаемая);
  });

  it('не зависит от порядка ключей во входном объекте', () => {
    const переставленный = {
      test_mode: '0',
      currency: 'KZT',
      order_id: '10868059:42',
      timestamp: '1789200000',
      amount: '15000',
    };
    expect(signFields(переставленный, секрет)).toBe(signFields(заказ, секрет));
  });

  it('не зависит от полей вне списка подписи', () => {
    const с_текстом = { ...заказ, description: 'Букет «Астана» | доставка', products: '[]' };
    expect(signFields(с_текстом, секрет)).toBe(signFields(заказ, секрет));
  });

  it('другой секрет даёт другую подпись', () => {
    expect(signFields(заказ, секрет)).not.toBe(signFields(заказ, 'другой-секрет'));
  });

  it('отвергает разделитель внутри поля подписи: это признак подделки', () => {
    expect(() => signFields({ ...заказ, amount: '150|00' }, секрет)).toThrow(/Разделитель/);
  });

  it('отсутствующее поле подписи считается пустым, а не пропускается', () => {
    const без_времени = { ...заказ, timestamp: '' };
    const ожидаемая = createHmac('sha256', секрет)
      .update('10868059:42|15000|KZT||0')
      .digest('hex');
    expect(signFields(без_времени, секрет)).toBe(ожидаемая);
  });
});

describe('verifySignature', () => {
  const поля = заказ;

  it('принимает верную подпись', () => {
    expect(verifySignature(поля, signFields(поля, секрет), секрет)).toBe(true);
  });

  it('отвергает подделанную подпись', () => {
    expect(verifySignature(поля, 'a'.repeat(64), секрет)).toBe(false);
  });

  it('отвергает подпись, снятую с изменённой суммы', () => {
    const подпись = signFields(поля, секрет);
    expect(verifySignature({ ...поля, amount: '1' }, подпись, секрет)).toBe(false);
  });

  it('не роняет проверку, если в поле подписи подсунут разделитель', () => {
    const подпись = signFields(поля, секрет);
    expect(verifySignature({ ...поля, amount: '1|5' }, подпись, секрет)).toBe(false);
  });

  it('отвергает подпись неверной длины, не бросая исключение', () => {
    expect(verifySignature(поля, 'коротко', секрет)).toBe(false);
    expect(verifySignature(поля, '', секрет)).toBe(false);
  });

  it('не различает регистр шестнадцатеричной записи', () => {
    const подпись = signFields(поля, секрет);
    expect(verifySignature(поля, подпись.toUpperCase(), секрет)).toBe(true);
  });
});
