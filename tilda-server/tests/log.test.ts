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
});

describe('createLog', () => {
  it('вырезает значения секретов', () => {
    const строки: string[] = [];
    const log = createLog((s) => строки.push(s));
    log.info('старт', { orderSecret: 'абв', adminPassword: 'гдеё', orderId: '1:2' });
    const запись = строки[0] ?? '';
    expect(запись).not.toContain('абв');
    expect(запись).not.toContain('гдеё');
    expect(запись).toContain('1:2');
  });
});
