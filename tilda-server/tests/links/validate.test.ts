// tilda-server/tests/links/validate.test.ts
import { describe, expect, it } from 'vitest';
import { balanceDelta, checkSplitPayment, type ParsedTx } from '../../src/links/validate.js';

const USDC = 'USDCmint1111111111111111111111111111111111';

function usdcTx(merchantGot: bigint, feeGot: bigint, err: unknown = null): ParsedTx {
  return {
    blockTime: 1_700_000_000,
    meta: {
      err, preBalances: [5, 0, 0, 0], postBalances: [4, 0, 0, 0],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: 'buyer', uiTokenAmount: { amount: '100000000' } },
        { accountIndex: 2, mint: USDC, owner: 'merchant', uiTokenAmount: { amount: '5' } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: 'buyer', uiTokenAmount: { amount: String(100_000_000n - merchantGot - feeGot) } },
        { accountIndex: 2, mint: USDC, owner: 'merchant', uiTokenAmount: { amount: String(5n + merchantGot) } },
        { accountIndex: 3, mint: USDC, owner: 'fee', uiTokenAmount: { amount: String(feeGot) } },
      ],
    },
    transaction: { message: { accountKeys: ['buyer', 'buyerAta', 'merchantAta', 'feeAta'].map((pubkey) => ({ pubkey })) } },
  };
}

const exp = { mint: USDC, merchant: 'merchant', feeWallet: 'fee', merchantUnits: 10_815_650n, feeUnits: 54_350n };

describe('balanceDelta', () => {
  it('handles token accounts that did not exist before the transaction', () => {
    expect(balanceDelta(usdcTx(1n, 7n), 'fee', USDC)).toBe(7n);
  });

  it('computes native SOL deltas from account keys', () => {
    const tx: ParsedTx = { blockTime: 1, meta: { err: null, preBalances: [10, 3], postBalances: [5, 8] },
      transaction: { message: { accountKeys: [{ pubkey: 'buyer' }, { pubkey: 'merchant' }] } } };
    expect(balanceDelta(tx, 'merchant', null)).toBe(5n);
    expect(balanceDelta(tx, 'absent', null)).toBe(0n);
  });
});

describe('checkSplitPayment', () => {
  it('accepts exact split amounts', () => {
    expect(checkSplitPayment(usdcTx(10_815_650n, 54_350n), exp)).toBe('ok');
  });

  it('flags a missing fee transfer or a short amount', () => {
    expect(checkSplitPayment(usdcTx(10_815_650n, 0n), exp)).toBe('mismatch');
    expect(checkSplitPayment(usdcTx(10_000_000n, 54_350n), exp)).toBe('mismatch');
  });

  it('reports failed transactions', () => {
    expect(checkSplitPayment(usdcTx(10_815_650n, 54_350n, { InstructionError: [0, 'x'] }), exp)).toBe('failed');
  });
});
