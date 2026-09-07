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
      recipient: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
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

  it('создаёт котировку и платёжный запрос', async () => {
    mockBinance();
    const sdk = new SolanaPayKZ({
      recipient: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      rpcUrl: 'https://api.devnet.solana.com',
      cluster: 'mainnet',
    });

    const quote = await sdk.createQuote({ amountKzt: '10000', token: 'USDC' });
    expect(quote.amountToken).toBe('21.758051');

    const request = await sdk.createPaymentRequest(quote, { label: 'Магазин' });
    expect(request.url).toContain('solana:');
    expect(request.qrSvg.startsWith('<svg')).toBe(true);
  });
});
