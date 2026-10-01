// tilda-server/tests/links/money.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_OFFSET, pickManualOffset, splitFee } from '../../src/links/money.js';

describe('splitFee', () => {
  it('takes 0.5% rounded down in favour of the merchant', () => {
    expect(splitFee(10_870_000n, 50)).toEqual({ fee: 54_350n, merchant: 10_815_650n });
    expect(splitFee(199n, 50)).toEqual({ fee: 0n, merchant: 199n });
    expect(splitFee(201n, 50)).toEqual({ fee: 1n, merchant: 200n });
  });

  it('returns everything to the merchant at 0 bps', () => {
    expect(splitFee(123n, 0)).toEqual({ fee: 0n, merchant: 123n });
  });
});

describe('pickManualOffset', () => {
  it('returns a value in [1, 9999] not in the used set', () => {
    const used = new Set<bigint>([1n, 2n, 3n]);
    const seq = [0, 0.0001, 0.5];
    let i = 0;
    const off = pickManualOffset(used, () => seq[i++ % seq.length]!);
    expect(off >= 1n && off <= MAX_OFFSET).toBe(true);
    expect(used.has(off)).toBe(false);
  });

  it('throws when every offset is taken', () => {
    const used = new Set<bigint>();
    for (let k = 1n; k <= MAX_OFFSET; k++) used.add(k);
    expect(() => pickManualOffset(used)).toThrow('no free manual offset');
  });
});
