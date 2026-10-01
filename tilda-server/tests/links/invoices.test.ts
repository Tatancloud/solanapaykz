// tilda-server/tests/links/invoices.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';
import { activeQuote, createInvoiceFor, QUOTE_TTL_MS, validAmountKzt, type InvoiceDeps } from '../../src/links/invoices.js';
import { loadLinksConfig } from '../../src/links/config.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function setup() {
  let now = 1_000_000;
  let calls = 0;
  const d: InvoiceDeps = {
    store: openLinksStore(':memory:'),
    links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }),
    cluster: 'devnet', now: () => now,
    quoter: { quote: async () => { calls++; return { amountToken: '10.87', rate: '460', rateSource: 'binance' }; } },
  };
  const m = d.store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  d.store.updateMerchant(m.id, { recipient: R });
  return { d, m: d.store.getMerchant(m.id)!, tick: (ms: number) => { now += ms; }, calls: () => calls };
}

describe('validAmountKzt', () => {
  it('accepts tenge with up to 2 decimals and rejects the rest', () => {
    expect(validAmountKzt('5000')).toBe('5000');
    expect(validAmountKzt(' 5000.5 ')).toBe('5000.5');
    for (const bad of ['0', '-1', '1e3', '5000.555', '', 'abc', 12, '1234567890']) expect(validAmountKzt(bad)).toBeNull();
  });
});

describe('createInvoiceFor', () => {
  it('freezes recipient, fee and expiry', () => {
    const { d, m } = setup();
    const r = createInvoiceFor(d, m, { amountKzt: '5000', description: ' Shirt ' }, 'link');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invoice).toMatchObject({ recipient: R, feeBps: 50, token: 'USDC', description: 'Shirt', state: 'open',
      expiresAt: 1_000_000 + 7 * 24 * 3600 * 1000 });
    expect(r.invoice.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('refuses without a recipient, with a bad amount, or above the debt limit', () => {
    const { d, m } = setup();
    const bare = d.store.createMerchant({ email: 'b@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    expect(createInvoiceFor(d, bare, { amountKzt: '5000', description: 'x' }, 'link')).toEqual({ ok: false, error: 'no_recipient' });
    expect(createInvoiceFor(d, m, { amountKzt: 'abc', description: 'x' }, 'link')).toEqual({ ok: false, error: 'bad_amount' });
    d.store.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: 20_000_001n, invoiceId: null, txSignature: null, createdAt: 1 });
    expect(createInvoiceFor(d, m, { amountKzt: '5000', description: 'x' }, 'link')).toEqual({ ok: false, error: 'debt_limit' });
  });
});

describe('activeQuote', () => {
  it('reuses the quote while it is valid, then creates a new one', async () => {
    const { d, m, tick, calls } = setup();
    const r = createInvoiceFor(d, m, { amountKzt: '5000', description: 'x' }, 'link');
    if (!r.ok) throw new Error('setup');
    const q1 = await activeQuote(d, r.invoice);
    const q2 = await activeQuote(d, r.invoice);
    expect(q2).toEqual(q1);
    expect(calls()).toBe(1);
    expect(q1.totalUnits).toBe(10_870_000n);
    expect(q1.feeUnits).toBe(54_350n);
    expect(q1.merchantUnits).toBe(10_815_650n);
    expect(q1.manualUnits > q1.totalUnits && q1.manualUnits <= q1.totalUnits + 9999n).toBe(true);
    tick(QUOTE_TTL_MS);
    const q3 = await activeQuote(d, r.invoice);
    expect(q3.reference).not.toBe(q1.reference);
    expect(calls()).toBe(2);
  });

  it('gives two open invoices of one merchant different manual amounts', async () => {
    const { d, m } = setup();
    const a = createInvoiceFor(d, m, { amountKzt: '5000', description: 'a' }, 'link');
    const b = createInvoiceFor(d, m, { amountKzt: '5000', description: 'b' }, 'link');
    if (!a.ok || !b.ok) throw new Error('setup');
    const qa = await activeQuote(d, a.invoice);
    const qb = await activeQuote(d, b.invoice);
    expect(qa.manualUnits).not.toBe(qb.manualUnits);
  });
});
