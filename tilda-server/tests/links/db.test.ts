// tilda-server/tests/links/db.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function seed() {
  const s = openLinksStore(':memory:');
  const m = s.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  s.updateMerchant(m.id, { recipient: R, name: 'Shop A' });
  const inv = s.createInvoice({ id: 'inv1', merchantId: m.id, amountKzt: '5000', description: 'Shirt', token: 'USDC',
    recipient: R, feeBps: 50, source: 'link', createdAt: 1000, expiresAt: 10_000 });
  return { s, m, inv };
}

describe('links store', () => {
  it('creates and finds merchants by email and wallet', () => {
    const { s, m } = seed();
    expect(s.findMerchantByEmail('a@shop.kz')?.id).toBe(m.id);
    expect(s.getMerchant(m.id)).toMatchObject({ recipient: R, name: 'Shop A', lang: 'en' });
    const w = s.createMerchant({ email: null, walletLogin: R, lang: 'ru', now: 2 });
    expect(s.findMerchantByWallet(R)?.id).toBe(w.id);
  });

  it('stores bigints exactly and returns the latest quote', () => {
    const { s } = seed();
    s.insertQuote({ invoiceId: 'inv1', totalUnits: 10_870_001n, feeUnits: 54_350n, merchantUnits: 10_815_651n,
      manualUnits: 10_871_234n, rate: '460', rateSource: 'binance', reference: 'ref1', createdAt: 1000, expiresAt: 1900 });
    const q = s.insertQuote({ invoiceId: 'inv1', totalUnits: 2n, feeUnits: 0n, merchantUnits: 2n, manualUnits: 3n,
      rate: '1', rateSource: 'x', reference: 'ref2', createdAt: 2000, expiresAt: 2900 });
    expect(s.latestQuote('inv1')).toEqual(q);
    expect(s.quotesForInvoice('inv1').map((x) => x.totalUnits)).toEqual([10_870_001n, 2n]);
  });

  it('lists manual amounts of quotes expiring after `since`, per receiving wallet and token only', () => {
    const { s } = seed();
    const recipient = s.getInvoice('inv1')!.recipient;
    s.insertQuote({ invoiceId: 'inv1', totalUnits: 1n, feeUnits: 0n, merchantUnits: 1n, manualUnits: 77n,
      rate: '1', rateSource: 'x', reference: 'r', createdAt: 1000, expiresAt: 1900 });
    expect(s.manualUnitsInUse(recipient, 'USDC', 1500)).toEqual([77n]);
    expect(s.manualUnitsInUse(recipient, 'USDC', 2000)).toEqual([]);
    expect(s.manualUnitsInUse(recipient, 'SOL', 1500)).toEqual([]);
    expect(s.manualUnitsInUse('OtherWallet', 'USDC', 1500)).toEqual([]);
  });

  it('deletes an invoice together with its quotes', () => {
    const { s } = seed();
    s.insertQuote({ invoiceId: 'inv1', totalUnits: 1n, feeUnits: 0n, merchantUnits: 1n, manualUnits: 2n,
      rate: '1', rateSource: 'x', reference: 'refdel', createdAt: 1000, expiresAt: 1900 });
    s.deleteInvoice('inv1');
    expect(s.getInvoice('inv1')).toBeNull();
    expect(s.quotesForInvoice('inv1')).toEqual([]);
  });

  it('takes a nonce and a bot link only once', () => {
    const { s, m } = seed();
    s.putNonce('n1', 100);
    expect(s.takeNonce('n1', 50)).toBe(true);
    expect(s.takeNonce('n1', 50)).toBe(false);
    s.putBotLink('c1', m.id, 100);
    expect(s.takeBotLink('c1', 200)).toBeNull();
    s.putBotLink('c2', m.id, 100);
    expect(s.takeBotLink('c2', 50)).toBe(m.id);
    expect(s.takeBotLink('c2', 50)).toBeNull();
  });

  it('marks a signature processed exactly once', () => {
    const { s } = seed();
    expect(s.markProcessed('sig1')).toBe(true);
    expect(s.markProcessed('sig1')).toBe(false);
  });

  it('sums fee debt per token', () => {
    const { s, m } = seed();
    s.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: 100n, invoiceId: 'inv1', txSignature: 'a', createdAt: 1 });
    s.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: -40n, invoiceId: null, txSignature: 'b', createdAt: 2 });
    expect(s.feeDebt(m.id, 'USDC')).toBe(60n);
    expect(s.feeDebt(m.id, 'SOL')).toBe(0n);
  });

  it('scopes invoice lists by merchant', () => {
    const { s, m } = seed();
    const other = s.createMerchant({ email: 'b@shop.kz', walletLogin: null, lang: 'en', now: 3 });
    expect(s.listInvoices(m.id, 50).map((i) => i.id)).toEqual(['inv1']);
    expect(s.listInvoices(other.id, 50)).toEqual([]);
  });
});
