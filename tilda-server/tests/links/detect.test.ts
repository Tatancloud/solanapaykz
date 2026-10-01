// tilda-server/tests/links/detect.test.ts
import { describe, expect, it } from 'vitest';
import { resolveToken } from '@solanapaykz/core';
import { openLinksStore, type Invoice, type QuoteRow } from '../../src/links/db.js';
import { detectOnce, type DetectDeps, type PaymentEvent } from '../../src/links/detect.js';
import { usdcAccountOf } from '../../src/links/recipient.js';
import type { ParsedTx } from '../../src/links/validate.js';

const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const USDC = resolveToken('devnet', 'USDC').mint!;

function tokenTx(blockTime: number, merchantGot: bigint, feeGot: bigint): ParsedTx {
  return {
    blockTime,
    meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: MERCHANT, uiTokenAmount: { amount: String(merchantGot) } },
        ...(feeGot > 0n ? [{ accountIndex: 2, mint: USDC, owner: FEE, uiTokenAmount: { amount: String(feeGot) } }] : []),
      ] },
    transaction: { message: { accountKeys: [{ pubkey: 'buyer' }, { pubkey: 'a' }, { pubkey: 'b' }] } },
  };
}

async function setup() {
  let now = 1_000_000;
  const store = openLinksStore(':memory:');
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  const invoice = store.createInvoice({ id: 'inv1', merchantId: m.id, amountKzt: '5000', description: 'Shirt',
    token: 'USDC', recipient: MERCHANT, feeBps: 50, source: 'link', createdAt: now, expiresAt: now + 7 * 86_400_000 });
  const quote = store.insertQuote({ invoiceId: 'inv1', totalUnits: 10_870_000n, feeUnits: 54_350n,
    merchantUnits: 10_815_650n, manualUnits: 10_871_234n, rate: '460', rateSource: 'binance', reference: 'REF1',
    createdAt: now, expiresAt: now + 15 * 60_000 });
  const sigs = new Map<string, { signature: string; err: unknown }[]>();
  const txs = new Map<string, ParsedTx>();
  const events: PaymentEvent[] = [];
  const merchantAta = await usdcAccountOf('devnet', MERCHANT);
  const d: DetectDeps = {
    store, cluster: 'devnet', feeWallet: FEE, now: () => now, log: { warn: () => {} },
    onEvent: async (e) => { events.push(e); },
    rpc: {
      signaturesFor: async (addr) => sigs.get(addr) ?? [],
      transaction: async (s) => txs.get(s) ?? null,
    },
  };
  const pay = (addr: string, sig: string, tx: ParsedTx) => {
    sigs.set(addr, [{ signature: sig, err: null }, ...(sigs.get(addr) ?? [])]);
    txs.set(sig, tx);
  };
  return { d, store, invoice, quote, events, pay, merchantAta, tick: (ms: number) => { now += ms; },
    nowSec: () => Math.floor(now / 1000) };
}

const state = (s: ReturnType<typeof openLinksStore>, id = 'inv1'): Invoice => s.getInvoice(id)!;

describe('detectOnce — transaction request mode', () => {
  it('marks paid on an exact split, once, even though the same tx also lands on the merchant account', async () => {
    const t = await setup();
    const tx = tokenTx(t.nowSec(), 10_815_650n, 54_350n);
    t.pay('REF1', 'sigA', tx);
    t.pay(t.merchantAta, 'sigA', tx);
    await detectOnce(t.d);
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'paid', paidMode: 'request', txSignature: 'sigA' });
    expect(t.events.map((e) => e.kind)).toEqual(['paid']);
    expect(t.store.feeDebt(t.invoice.merchantId, 'USDC')).toBe(0n);
  });

  it('sends a payment without the fee transfer to review', async () => {
    const t = await setup();
    t.pay('REF1', 'sigA', tokenTx(t.nowSec(), 10_815_650n, 0n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'needs_review', reviewReason: 'amount' });
  });

  it('sends a payment made after the quote expired to review', async () => {
    const t = await setup();
    t.tick(20 * 60_000);
    t.pay('REF1', 'sigA', tokenTx(t.nowSec(), 10_815_650n, 54_350n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'needs_review', reviewReason: 'late' });
  });

  it('flags a second payment for a paid invoice as duplicate and keeps the first signature', async () => {
    const t = await setup();
    t.pay('REF1', 'sigA', tokenTx(t.nowSec(), 10_815_650n, 54_350n));
    await detectOnce(t.d);
    t.pay('REF1', 'sigB', tokenTx(t.nowSec(), 10_815_650n, 54_350n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'needs_review', reviewReason: 'duplicate', txSignature: 'sigA' });
  });
});

describe('detectOnce — manual mode', () => {
  it('matches the unique amount, marks paid and accrues the fee as debt', async () => {
    const t = await setup();
    t.pay(t.merchantAta, 'sigM', tokenTx(t.nowSec(), 10_871_234n, 0n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'paid', paidMode: 'manual', txSignature: 'sigM' });
    expect(t.store.feeDebt(t.invoice.merchantId, 'USDC')).toBe(54_350n);
  });

  it('ignores unrelated incoming transfers', async () => {
    const t = await setup();
    t.pay(t.merchantAta, 'sigX', tokenTx(t.nowSec(), 123n, 0n));
    await detectOnce(t.d);
    expect(state(t.store).state).toBe('open');
  });
});

describe('detectOnce — expiry and repayments', () => {
  it('expires open invoices past their expiry', async () => {
    const t = await setup();
    t.tick(8 * 86_400_000);
    await detectOnce(t.d);
    expect(state(t.store).state).toBe('expired');
  });

  it('records a fee repayment found by its reference', async () => {
    const t = await setup();
    t.store.addFeeEntry({ merchantId: t.invoice.merchantId, token: 'USDC', amount: 54_350n, invoiceId: 'inv1',
      txSignature: 'sigM', createdAt: 1 });
    const r = t.store.createRepayment({ merchantId: t.invoice.merchantId, token: 'USDC', units: 54_350n,
      reference: 'REPAY1', createdAt: 1 });
    const tx: ParsedTx = { blockTime: t.nowSec(), meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: FEE, uiTokenAmount: { amount: '54350' } }] },
      transaction: { message: { accountKeys: [{ pubkey: 'x' }, { pubkey: 'y' }] } } };
    t.pay('REPAY1', 'sigR', tx);
    await detectOnce(t.d);
    expect(t.store.getRepayment(r.id)!.state).toBe('paid');
    expect(t.store.feeDebt(t.invoice.merchantId, 'USDC')).toBe(0n);
  });
});
