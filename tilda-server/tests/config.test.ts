import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const полные = {
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  rpcUrl: 'https://api.devnet.solana.com',
  cluster: 'devnet',
  token: 'USDC',
  orderSecret: 'секрет-заказа',
  notifySecret: 'секрет-уведомления',
  tildaNotifyUrl: 'https://tilda.cc/payment/notify/xxx',
  publicUrl: 'https://pay.kabyldau.digital',
  adminPassword: 'пароль',
  smtp: { host: 'smtp.example.kz', port: 465, user: 'u', pass: 'p', from: 'shop@example.kz' },
  merchantEmail: 'merchant@example.kz',
  databasePath: '/data/orders.sqlite',
  listenPort: 8080,
};

describe('loadConfig', () => {
  it('принимает полный набор и подставляет значения по умолчанию', () => {
    const c = loadConfig(полные);
    expect(c.markupPercent).toBe(0);
    expect(c.quoteTtlSeconds).toBe(900);
    expect(c.lateWindowSeconds).toBe(86400);
  });

  it('перечисляет ВСЕ недостающие поля разом, а не первое', () => {
    let сообщение = '';
    try {
      loadConfig({ cluster: 'devnet' });
    } catch (e) {
      сообщение = (e as Error).message;
    }
    expect(сообщение).toContain('recipient');
    expect(сообщение).toContain('rpcUrl');
    expect(сообщение).toContain('adminPassword');
  });

  it('отвергает неизвестную сеть', () => {
    expect(() => loadConfig({ ...полные, cluster: 'testnet' })).toThrow(/cluster/);
  });

  it('отвергает адрес узла без схемы https', () => {
    expect(() => loadConfig({ ...полные, rpcUrl: 'api.devnet.solana.com' })).toThrow(/rpcUrl/);
  });

  it('отвергает пустой секрет: подпись без секрета бессмысленна', () => {
    expect(() => loadConfig({ ...полные, orderSecret: '' })).toThrow(/orderSecret/);
  });

  it('отвергает наценку вне разумных границ', () => {
    expect(() => loadConfig({ ...полные, markupPercent: -1 })).toThrow(/markupPercent/);
    expect(() => loadConfig({ ...полные, markupPercent: 101 })).toThrow(/markupPercent/);
  });

  it('отвергает опечатку в имени поля верхнего уровня, а не молча берёт значение по умолчанию', () => {
    const { markupPercent, ...безНаценки } = полные;
    expect(() =>
      loadConfig({ ...безНаценки, markupPercnt: 5 }),
    ).toThrow(/markupPercnt/);
  });

  it('отвергает опечатку в имени поля внутри smtp', () => {
    expect(() =>
      loadConfig({ ...полные, smtp: { ...полные.smtp, hots: 'smtp.example.kz' } }),
    ).toThrow(/smtp/);
  });
});
