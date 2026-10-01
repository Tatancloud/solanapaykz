// tests/exports.test.ts
import { describe, expect, it } from 'vitest';
import { formatUnits, generateReference, parseDecimalToUnits, resolveToken } from '../src/index.js';

describe('public helper exports', () => {
  it('converts decimals to minor units and back', () => {
    expect(parseDecimalToUnits('10.87', 6)).toBe(10_870_000n);
    expect(formatUnits(10_870_000n, 6)).toBe('10.870000');
  });

  it('resolves USDC on both clusters', () => {
    expect(resolveToken('mainnet', 'USDC').decimals).toBe(6);
    expect(resolveToken('devnet', 'USDC').mint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(resolveToken('mainnet', 'SOL').mint).toBeUndefined();
  });

  it('generates distinct base58 references', () => {
    const a = generateReference();
    expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(generateReference()).not.toBe(a);
  });
});
