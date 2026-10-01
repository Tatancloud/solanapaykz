// tilda-server/tests/links/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadLinksConfig } from '../../src/links/config.js';

const FEE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe('loadLinksConfig', () => {
  it('applies defaults', () => {
    const c = loadLinksConfig({ feeWallet: FEE, sessionPepper: 'a-long-random-pepper' });
    expect(c).toMatchObject({
      feeWallet: FEE, feeBps: 50, invoiceTtlDays: 7, detectIntervalMs: 10_000,
      debtLimit: { USDC: '20', SOL: '0.15' },
    });
    expect(c.telegram).toBeUndefined();
  });

  it('reports every problem at once', () => {
    expect(() => loadLinksConfig({ feeWallet: 'nope', feeBps: 5000, sessionPepper: 'short' }))
      .toThrow(/feeWallet[\s\S]*feeBps[\s\S]*sessionPepper/);
  });

  it('requires all telegram fields together', () => {
    expect(() => loadLinksConfig({ feeWallet: FEE, sessionPepper: 'a-long-random-pepper', telegram: { botToken: 'x' } }))
      .toThrow(/telegram/);
  });
});
