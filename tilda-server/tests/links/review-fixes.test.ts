// tilda-server/tests/links/review-fixes.test.ts — regressions for the final whole-branch review findings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { generateReference, resolveToken } from '@solanapaykz/core';
import { openLinksStore } from '../../src/links/db.js';
import { detectOnce, type DetectDeps, type DetectRpc } from '../../src/links/detect.js';
import { usdcAccountOf, checkRecipient, feeWalletProblems } from '../../src/links/recipient.js';
import { activeQuote, createInvoiceFor, type InvoiceDeps } from '../../src/links/invoices.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { clientIp } from '../../src/links/http.js';
import { startEmailLogin, verifyEmailLogin, type AuthDeps } from '../../src/links/auth.js';
import type { ParsedTx } from '../../src/links/validate.js';

const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE = generateReference();
const USDC = resolveToken('devnet', 'USDC').mint!;

afterEach(() => { vi.restoreAllMocks(); });

function tokenTx(blockTime: number, merchantGot: bigint, feeGot: bigint, extraKeys: string[] = []): ParsedTx {
  return {
    blockTime,
    meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: MERCHANT, uiTokenAmount: { amount: String(merchantGot) } },
        ...(feeGot > 0n ? [{ accountIndex: 2, mint: USDC, owner: FEE, uiTokenAmount: { amount: String(feeGot) } }] : []),
      ] },
    transaction: { message: { accountKeys: ['buyer', 'a', 'b', ...extraKeys].map((pubkey) => ({ pubkey })) } },
  };
}

/** Fake RPC honouring limit/before/until on newest-first signature lists. */
function fakeRpc() {
  const sigs = new Map<string, string[]>();
  const txs = new Map<string, ParsedTx | null>();
  const times = new Map<string, number>();
  const fetched: string[] = [];
  let failFor: string | null = null;
  const rpc: DetectRpc = {
    async signaturesFor(addr, opts) {
      if (addr === failFor) throw new Error('429 Too Many Requests');
      const all = sigs.get(addr) ?? [];
      let start = 0;
      if (opts.before) start = all.indexOf(opts.before) + 1;
      let end = all.length;
      if (opts.until) { const u = all.indexOf(opts.until); if (u >= 0) end = u; }
      return all.slice(start, Math.min(end, start + opts.limit))
        .map((signature) => ({ signature, err: null, ...(times.has(signature) ? { blockTime: times.get(signature)! } : {}) }));
    },
    async transaction(s) { fetched.push(s); return txs.get(s) ?? null; },
  };
  return {
    rpc,
    fetched,
    add(addr: string, sig: string, tx: ParsedTx | null, blockTime?: number) {
      sigs.set(addr, [sig, ...(sigs.get(addr) ?? [])]); txs.set(sig, tx);
      if (blockTime !== undefined) times.set(sig, blockTime);
    },
    setTx(sig: string, tx: ParsedTx) { txs.set(sig, tx); },
    failOn(addr: string | null) { failFor = addr; },
  };
}

async function world() {
  let now = 1_000_000;
  const store = openLinksStore(':memory:');
  const links = loadLinksConfig({ feeWallet: FEE, sessionPepper: 'pepper-pepper-pepper' });
  const inv: InvoiceDeps = { store, links, cluster: 'devnet', now: () => now,
    quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) } };
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  store.updateMerchant(m.id, { recipient: MERCHANT });
  const f = fakeRpc();
  const events: string[] = [];
  const d: DetectDeps = { store, rpc: f.rpc, cluster: 'devnet', feeWallet: FEE, now: () => now, log: { warn: () => {} },
    onEvent: async (e) => { events.push(`${e.kind}:${e.invoice.id}`); } };
  const make = async (description: string) => {
    const r = createInvoiceFor(inv, store.getMerchant(m.id)!, { amountKzt: '5000', description }, 'link');
    if (!r.ok) throw new Error(r.error);
    return { invoice: r.invoice, quote: await activeQuote(inv, r.invoice) };
  };
  return { store, inv, d, f, m, events, make, merchantAta: await usdcAccountOf('devnet', MERCHANT),
    tick: (ms: number) => { now += ms; }, sec: () => Math.floor(now / 1000) };
}

describe('C1: a request-mode payment first seen by the manual scan is still credited', () => {
  it('marks the invoice paid on the next pass', async () => {
    const w = await world();
    const { invoice, quote } = await w.make('Shirt');
    const tx = tokenTx(w.sec(), quote.merchantUnits, quote.feeUnits, [quote.reference]);
    w.f.add(w.merchantAta, 'sigA', tx);           // the reference index lags behind the ATA index
    await detectOnce(w.d);
    w.f.add(quote.reference, 'sigA', tx);
    await detectOnce(w.d);
    expect(w.store.getInvoice(invoice.id)).toMatchObject({ state: 'paid', paidMode: 'request', txSignature: 'sigA' });
    expect(w.store.feeDebt(invoice.merchantId, 'USDC')).toBe(0n);
  });
});

describe('C2: a transaction the RPC cannot return yet is retried, not dropped', () => {
  it('credits a request payment once the transaction becomes available', async () => {
    const w = await world();
    const { invoice, quote } = await w.make('Shirt');
    w.f.add(quote.reference, 'sigA', null);
    await detectOnce(w.d);
    w.f.setTx('sigA', tokenTx(w.sec(), quote.merchantUnits, quote.feeUnits, [quote.reference]));
    await detectOnce(w.d);
    expect(w.store.getInvoice(invoice.id)!.state).toBe('paid');
  });

  it('credits a manual payment once the transaction becomes available', async () => {
    const w = await world();
    const { invoice, quote } = await w.make('Shirt');
    w.f.add(w.merchantAta, 'sigM', null);
    await detectOnce(w.d);
    w.f.setTx('sigM', tokenTx(w.sec(), quote.manualUnits, 0n));
    await detectOnce(w.d);
    expect(w.store.getInvoice(invoice.id)).toMatchObject({ state: 'paid', paidMode: 'manual' });
  });
});

describe('I1/I2: manual amounts stay unique while the detector still matches them', () => {
  it('does not reuse the manual amount of an expired quote of a still-open invoice', async () => {
    const w = await world();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const a = await w.make('A');
    w.tick(16 * 60_000);
    const b = await w.make('B');
    expect(b.quote.manualUnits).not.toBe(a.quote.manualUnits);
  });

  it('keeps amounts unique across merchants that share a receiving wallet', async () => {
    const w = await world();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const a = await w.make('A');
    const other = w.store.createMerchant({ email: null, walletLogin: MERCHANT, lang: 'en', now: 1 });
    w.store.updateMerchant(other.id, { recipient: MERCHANT });
    const r = createInvoiceFor(w.inv, w.store.getMerchant(other.id)!, { amountKzt: '5000', description: 'B' }, 'link');
    if (!r.ok) throw new Error(r.error);
    const qb = await activeQuote(w.inv, r.invoice);
    expect(qb.manualUnits).not.toBe(a.quote.manualUnits);
  });
});

describe('I2a: the manual scan pages through more than one page of signatures', () => {
  it('finds a payment older than the newest 50 signatures', async () => {
    const w = await world();
    const { invoice, quote } = await w.make('Shirt');
    w.f.add(w.merchantAta, 'sigOld', tokenTx(w.sec(), quote.manualUnits, 0n));
    for (let i = 0; i < 60; i++) w.f.add(w.merchantAta, `noise${i}`, tokenTx(w.sec(), 1n, 0n));
    await detectOnce(w.d);
    expect(w.store.getInvoice(invoice.id)!.state).toBe('paid');
  });
});

describe('I3: a late payment within 24 h after expiry is detected', () => {
  it('moves an expired invoice to needs_review(late)', async () => {
    const w = await world();
    w.inv.links.invoiceTtlDays = 1;
    const { invoice, quote } = await w.make('Shirt');
    w.tick(24 * 3600_000 + 60_000);
    await detectOnce(w.d);
    expect(w.store.getInvoice(invoice.id)!.state).toBe('expired');
    w.f.add(w.merchantAta, 'sigLate', tokenTx(w.sec(), quote.manualUnits, 0n));
    await detectOnce(w.d);
    expect(w.store.getInvoice(invoice.id)).toMatchObject({ state: 'needs_review', reviewReason: 'late' });
  });
});

describe('I4: an RPC error on one invoice does not stop the rest of the pass', () => {
  it('still credits another invoice', async () => {
    const w = await world();
    const a = await w.make('A');
    const b = await w.make('B');
    w.f.failOn(a.quote.reference);
    w.f.add(b.quote.reference, 'sigB', tokenTx(w.sec(), b.quote.merchantUnits, b.quote.feeUnits, [b.quote.reference]));
    await expect(detectOnce(w.d)).resolves.toBeDefined();
    expect(w.store.getInvoice(b.invoice.id)!.state).toBe('paid');
  });
});

describe('I5: client IP cannot be spoofed with X-Forwarded-For', () => {
  const req = (headers: Record<string, string>) =>
    ({ socket: { remoteAddress: '127.0.0.1' }, headers } as unknown as IncomingMessage);
  it('prefers CF-Connecting-IP, else the last forwarded hop', () => {
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 172.70.1.1', 'cf-connecting-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });
});

describe('I6: a resent email code does not reset the attempt counter', () => {
  it('stays locked after 5 wrong attempts even with a new code', async () => {
    let now = 1_000_000;
    const codes: string[] = [];
    const d: AuthDeps = { store: openLinksStore(':memory:'), pepper: 'pepper-pepper-pepper', now: () => now,
      sendCode: async (_e, c) => { codes.push(c); } };
    await startEmailLogin(d, 'a@shop.kz', 'en');
    for (let i = 0; i < 5; i++) verifyEmailLogin(d, 'a@shop.kz', '000000', 'en');
    now += 61_000;
    await startEmailLogin(d, 'a@shop.kz', 'en');
    expect(verifyEmailLogin(d, 'a@shop.kz', codes.at(-1)!, 'en')).toEqual({ ok: false, error: 'locked' });
  });

  it('allows at most 5 codes per email per hour', async () => {
    let now = 1_000_000;
    const d: AuthDeps = { store: openLinksStore(':memory:'), pepper: 'pepper-pepper-pepper', now: () => now,
      sendCode: async () => {} };
    for (let i = 0; i < 5; i++) { expect((await startEmailLogin(d, 'a@shop.kz', 'en')).ok).toBe(true); now += 61_000; }
    expect(await startEmailLogin(d, 'a@shop.kz', 'en')).toEqual({ ok: false, error: 'too_soon' });
  });
});

describe('I7: fee wallet checks', () => {
  it('rejects the service fee wallet as a merchant receiving wallet', async () => {
    const probe = { exists: async () => true };
    expect(await checkRecipient(probe, 'devnet', FEE, [FEE])).toEqual({ ok: false, error: 'is_fee_wallet' });
  });

  it('reports a fee wallet without a USDC account', async () => {
    expect(await feeWalletProblems({ exists: async () => false }, 'devnet', FEE)).toEqual(['fee wallet has no USDC account']);
    expect(await feeWalletProblems({ exists: async () => true }, 'devnet', FEE)).toEqual([]);
  });
});

describe('RPC numbers: @solana/kit returns blockTime as a bigint', () => {
  it('still credits the payment', async () => {
    const w = await world();
    const { invoice, quote } = await w.make('Shirt');
    const tx = tokenTx(w.sec(), quote.merchantUnits, quote.feeUnits, [quote.reference]);
    w.f.add(quote.reference, 'sigA', { ...tx, blockTime: BigInt(w.sec()) as unknown as number });
    expect(await detectOnce(w.d)).toEqual({ errors: 0 });
    expect(w.store.getInvoice(invoice.id)!.state).toBe('paid');
  });
});

describe('manual scan load: no transaction fetches for history older than the oldest candidate invoice', () => {
  it('skips old signatures on the first scan of a busy wallet', async () => {
    const w = await world();
    const old = w.sec() - 3600;
    for (let i = 0; i < 30; i++) w.f.add(w.merchantAta, `old${i}`, tokenTx(old, 1n, 0n), old);
    const { invoice, quote } = await w.make('Shirt');
    w.f.add(w.merchantAta, 'sigM', tokenTx(w.sec(), quote.manualUnits, 0n), w.sec());
    await detectOnce(w.d);
    expect(w.store.getInvoice(invoice.id)!.state).toBe('paid');
    expect(w.f.fetched.filter((s) => s.startsWith('old'))).toEqual([]);
  });
});

describe('deploy: behind docker-proxy the peer is the bridge gateway, not loopback', () => {
  const req = (remoteAddress: string, headers: Record<string, string>) =>
    ({ socket: { remoteAddress }, headers } as unknown as IncomingMessage);
  it('trusts X-Forwarded-For from a configured proxy address', () => {
    const r = req('172.30.81.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
    expect(clientIp(r, ['127.0.0.1', '172.30.81.1'])).toBe('203.0.113.9');
    expect(clientIp(r)).toBe('172.30.81.1');
  });
});
