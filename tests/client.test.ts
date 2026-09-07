import { describe, expect, it, vi, afterEach } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { SolanaPayKZ } from '../src/client.js';

function mockBinance(rate = '459.60000000') {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    const price = url.includes('USDTKZT') ? rate : '1.00000000';
    return new Response(JSON.stringify({ price }), { status: 200 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('SolanaPayKZ', () => {
  it('требует RPC-адрес', () => {
    expect(() => new SolanaPayKZ({
      recipient: '11111111111111111111111111111111',
      rpcUrl: '',
      cluster: 'mainnet',
    })).toThrow(ConfigError);
  });

  it('требует корректный адрес получателя', () => {
    expect(() => new SolanaPayKZ({
      recipient: 'не-адрес',
      rpcUrl: 'https://api.devnet.solana.com',
      cluster: 'devnet',
    })).toThrow(ConfigError);
  });

  it('требует корректный rpcUrl (опечатка не должна всплывать сетевым сбоем позже)', () => {
    expect(() => new SolanaPayKZ({
      recipient: '11111111111111111111111111111111',
      rpcUrl: 'не-url-совсем',
      cluster: 'devnet',
    })).toThrow(ConfigError);
  });

  it('создаёт котировку и платёжный запрос', async () => {
    mockBinance();
    const sdk = new SolanaPayKZ({
      recipient: '11111111111111111111111111111111',
      rpcUrl: 'https://api.devnet.solana.com',
      cluster: 'mainnet',
    });

    const quote = await sdk.createQuote({ amountKzt: '10000', token: 'USDC' });
    expect(quote.amountToken).toBe('21.758051');

    const request = await sdk.createPaymentRequest(quote, { label: 'Магазин' });
    expect(request.url).toContain('solana:');
    expect(request.qrSvg.startsWith('<svg')).toBe(true);
  });

  it('кеш курса живёт отдельно от TTL котировки — обновляется чаще, чем раз в quoteTtlMs', async () => {
    vi.useFakeTimers();
    let fetchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      fetchCalls++;
      const url = String(input);
      const price = url.includes('USDTKZT') ? '459.60000000' : '1.00000000';
      return new Response(JSON.stringify({ price }), { status: 200 });
    }));

    // quoteTtlMs сознательно намного больше TTL кеша курса (порядка минуты):
    // если бы quoteTtlMs передавался в RateProvider как раньше, второй
    // вызов взял бы курс из кеша и источник не был бы опрошен повторно.
    const sdk = new SolanaPayKZ({
      recipient: '11111111111111111111111111111111',
      rpcUrl: 'https://api.devnet.solana.com',
      cluster: 'mainnet',
      quoteTtlMs: 24 * 60 * 60 * 1000, // сутки
    });

    await sdk.createQuote({ amountKzt: '10000', token: 'USDC' });
    const callsAfterFirst = fetchCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Дольше, чем кеш курса (порядка минуты), но много меньше суточного TTL котировки.
    vi.advanceTimersByTime(90_000);

    await sdk.createQuote({ amountKzt: '10000', token: 'USDC' });
    expect(fetchCalls).toBeGreaterThan(callsAfterFirst);

    vi.useRealTimers();
  });
});
