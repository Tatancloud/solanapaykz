import { describe, expect, it } from 'vitest';
import { decide } from '../src/decision.js';

const основа = {
  createdAt: 1000,
  expiresAt: 1900,
  lateWindowSeconds: 86400,
  now: 1500,
};

describe('decide', () => {
  it('подтверждённый платёж в срок — оплачен', () => {
    const р = decide({
      ...основа,
      orderState: 'ожидает',
      status: { status: 'confirmed', signature: 'п1', amountPaid: '32.64' },
    });
    expect(р.action).toBe('оплачен');
  });

  it('платёж не пришёл, срок не вышел — ждать', () => {
    const р = decide({ ...основа, orderState: 'ожидает', status: { status: 'pending' } });
    expect(р.action).toBe('ждать');
  });

  it('платёж не пришёл, срок вышел — просрочен', () => {
    const р = decide({ ...основа, now: 2000, orderState: 'ожидает', status: { status: 'pending' } });
    expect(р.action).toBe('просрочен');
  });

  it('платёж пришёл после срока, в пределах окна — поздний, НЕ отмена', () => {
    const р = decide({
      ...основа,
      now: 5000,
      orderState: 'просрочен',
      status: { status: 'confirmed', signature: 'п2', amountPaid: '32.64' },
    });
    expect(р.action).toBe('поздний');
  });

  it('платёж пришёл далеко за окном — всё равно поздний: продавец должен узнать', () => {
    const р = decide({
      ...основа,
      now: 1000 + 86400 * 3,
      orderState: 'просрочен',
      status: { status: 'confirmed', signature: 'п3', amountPaid: '32.64' },
    });
    expect(р.action).toBe('поздний');
  });

  it('несовпадение суммы не отменяет и не подтверждает', () => {
    const р = decide({
      ...основа,
      now: 5000,
      orderState: 'ожидает',
      status: { status: 'mismatch', signature: 'п4', reason: 'сумма меньше' },
    });
    expect(р.action).toBe('не сошлось');
  });

  it('уже оплаченный заказ не трогаем даже при повторном подтверждении', () => {
    const р = decide({
      ...основа,
      orderState: 'оплачен',
      status: { status: 'confirmed', signature: 'п5', amountPaid: '32.64' },
    });
    expect(р.action).toBe('ждать');
  });

  it('уведомлённый заказ не трогаем', () => {
    const р = decide({
      ...основа,
      orderState: 'уведомлён',
      status: { status: 'confirmed', signature: 'п6', amountPaid: '32.64' },
    });
    expect(р.action).toBe('ждать');
  });

  it('заказ на ручном разборе не трогаем автоматикой', () => {
    const р = decide({
      ...основа,
      orderState: 'не сошлось',
      status: { status: 'confirmed', signature: 'п7', amountPaid: '32.64' },
    });
    expect(р.action).toBe('ждать');
  });

  it('заметка при несовпадении содержит причину и подпись транзакции', () => {
    const р = decide({
      ...основа,
      now: 5000,
      orderState: 'ожидает',
      status: { status: 'mismatch', signature: 'п8', reason: 'сумма меньше' },
    });
    expect(р.note).toContain('п8');
    expect(р.note).toContain('сумма меньше');
  });

  it('статус expired от SDK на невышедшем сроке всё равно даёт ждать', () => {
    const р = decide({ ...основа, orderState: 'ожидает', status: { status: 'expired' } });
    expect(р.action).toBe('ждать');
  });

  it('платёж пришёл ровно на границе: заказ ещё «ожидает», а срок уже вышел', () => {
    // Браузер опрашивает каждые несколько секунд, поэтому состояние заказа
    // отстаёт от часов. Заказ ещё не помечен просроченным, но срок истёк —
    // это «поздний», а не «оплачен»: цена уже не действует.
    const р = decide({
      ...основа,
      now: 2000,
      orderState: 'ожидает',
      status: { status: 'confirmed', signature: 'п9', amountPaid: '32.64' },
    });
    expect(р.action).toBe('поздний');
  });
});
