// tilda-server/tests/links/tx.test.ts
import { describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { buildPaymentTransaction } from '../../src/links/tx.js';
import { usdcAccountOf } from '../../src/links/recipient.js';

const BUYER = generateReference();
const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const REF = generateReference();
const BH = { blockhash: generateReference(), lastValidBlockHeight: 100n };

function decode(b64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(b64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return { tx, msg, keys: msg.staticAccounts.map(String) };
}

describe('buildPaymentTransaction', () => {
  it('USDC: buyer pays fees, two transfers, reference and memo present', async () => {
    const b64 = await buildPaymentTransaction({ cluster: 'devnet', token: 'USDC', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 10_815_650n, feeUnits: 54_350n, reference: REF, memo: 'inv:abc', blockhash: BH });
    const { msg, keys } = decode(b64);
    expect(keys[0]).toBe(BUYER);
    expect(msg.header.numSignerAccounts).toBe(1);
    expect(keys).toContain(REF);
    expect(keys).toContain(await usdcAccountOf('devnet', MERCHANT));
    expect(keys).toContain(await usdcAccountOf('devnet', FEE));
    expect(msg.instructions).toHaveLength(3);
  });

  it('SOL: two system transfers plus memo; no fee transfer when fee is zero', async () => {
    const withFee = decode(await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 1_000n, feeUnits: 5n, reference: REF, memo: 'inv:abc', blockhash: BH }));
    expect(withFee.msg.instructions).toHaveLength(3);
    expect(withFee.keys).toEqual(expect.arrayContaining([BUYER, MERCHANT, FEE, REF]));

    const noFee = decode(await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 1_000n, feeUnits: 0n, reference: REF, memo: 'inv:abc', blockhash: BH }));
    expect(noFee.msg.instructions).toHaveLength(2);
    expect(noFee.keys).not.toContain(FEE);
  });

  it('leaves the signature slot empty (wallet signs)', async () => {
    const { tx } = decode(await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 1n, feeUnits: 0n, reference: REF, memo: 'm', blockhash: BH }));
    expect(Object.values(tx.signatures)).toEqual([null]);
  });
});
