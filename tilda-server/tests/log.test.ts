import { describe, expect, it, vi } from 'vitest';
import { createLog, redactUrl } from '../src/log.js';

describe('redactUrl', () => {
  it('оставляет только схему и хост', () => {
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=8f3c9d')).toBe(
      'https://mainnet.helius-rpc.com',
    );
    expect(redactUrl('https://x.quiknode.pro/секретный-токен/')).toBe('https://x.quiknode.pro');
  });

  it('не падает на мусоре и не возвращает его целиком', () => {
    expect(redactUrl('не-адрес-вовсе')).toBe('<адрес скрыт>');
  });

  it('вырезает логин и пароль, зашитые прямо в адрес', () => {
    expect(redactUrl('https://user:pass@mainnet.helius-rpc.com/rpc')).toBe(
      'https://mainnet.helius-rpc.com',
    );
  });

  it('не падает на пустой строке', () => {
    expect(redactUrl('')).toBe('<адрес скрыт>');
  });

  it('не падает на схеме без хоста', () => {
    expect(redactUrl('https://')).toBe('<адрес скрыт>');
  });

  it('не возвращает длинный мусор целиком', () => {
    const мусор = 'x'.repeat(5000);
    const результат = redactUrl(мусор);
    expect(результат).toBe('<адрес скрыт>');
    expect(результат.length).toBeLessThan(100);
  });
});

describe('createLog', () => {
  it('вырезает значения секретов по имени поля', () => {
    const строки: string[] = [];
    const log = createLog((s) => строки.push(s));
    log.info('старт', { orderSecret: 'абв', adminPassword: 'гдеё', orderId: '1:2' });
    const запись = строки[0] ?? '';
    expect(запись).not.toContain('абв');
    expect(запись).not.toContain('гдеё');
    expect(запись).toContain('1:2');
  });

  it('адрес узла с ключом провайдера не уходит в журнал целиком', () => {
    const строки: string[] = [];
    const log = createLog((s) => строки.push(s));
    log.info('старт', { rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=КЛЮЧ' });
    expect(строки[0]).not.toContain('КЛЮЧ');
    expect(строки[0]).toContain('mainnet.helius-rpc.com');
  });

  it('секрет внутри текста сообщения вырезается, если журнал его знает', () => {
    const строки: string[] = [];
    const log = createLog((s) => строки.push(s), ['ОЧЕНЬ-СЕКРЕТНО']);
    log.error('не удалось подписать: ОЧЕНЬ-СЕКРЕТНО');
    expect(строки[0]).not.toContain('ОЧЕНЬ-СЕКРЕТНО');
  });

  it('секрет во вложенном объекте и в массиве вырезается', () => {
    const строки: string[] = [];
    const log = createLog((s) => строки.push(s), ['ПАРОЛЬ-SMTP']);
    log.info('почта', { smtp: { pass: 'ПАРОЛЬ-SMTP' }, попытки: [{ pass: 'ПАРОЛЬ-SMTP' }] });
    expect(строки[0]).not.toContain('ПАРОЛЬ-SMTP');
  });

  it('короткие строки в списке секретов игнорируются', () => {
    const строки: string[] = [];
    const log = createLog((s) => строки.push(s), ['a']);
    log.info('заказ 10868059:42 принят');
    expect(строки[0]).toContain('10868059:42');
  });
});
