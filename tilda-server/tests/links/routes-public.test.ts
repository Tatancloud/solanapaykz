// tilda-server/tests/links/routes-public.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { createInvoiceFor } from '../../src/links/invoices.js';
import { handlePublic, type PublicDeps } from '../../src/links/routes-public.js';
import { createRateLimiter } from '../../src/links/ratelimit.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BUYER = generateReference();
let server: http.Server;
let base: string;
let d: PublicDeps;
let invoiceId: string;

beforeEach(async () => {
  const store = openLinksStore(':memory:');
  d = {
    store, links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000_000, quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
    publicUrl: 'https://pay.test', feeWallet: R, txLimiter: createRateLimiter(100, 60_000),
    latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
  };
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  store.updateMerchant(m.id, { recipient: R, name: 'Shop <A>' });
  const r = createInvoiceFor(d, store.getMerchant(m.id)!, { amountKzt: '5000', description: 'Shirt' }, 'link');
  if (!r.ok) throw new Error('setup');
  invoiceId = r.invoice.id;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handlePublic(req, res, url, d).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

describe('public invoice routes', () => {
  it('renders the page with KZT, token amount, escaped name, QR and manual details', async () => {
    const res = await fetch(`${base}/i/${invoiceId}?lang=en`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('5\u202F000'); // KZT amount, grouped by thousands
    expect(html).toContain('10.87');
    expect(html).toContain('Shop &lt;A&gt;');
    expect(html).toContain('<svg');
    expect(html).toContain(`solana:https://pay.test/api/pay/${invoiceId}`);
    expect(html).toContain(R);
    expect(html).toContain('/assets/link.js');
  });

  it('gives the wallet button what a browser-extension wallet needs (pay API and chain)', async () => {
    const html = await (await fetch(`${base}/i/${invoiceId}?lang=ru`)).text();
    expect(html).toContain('id="lk-open-wallet"');
    expect(html).toContain(`data-pay="/api/pay/${invoiceId}"`);
    expect(html).toContain('data-chain="solana:devnet"');
    expect(html).toMatch(/data-confirm-wallet="[^"]*кошел/);
  });

  it('shows the same quote on a second open', async () => {
    const a = await (await fetch(`${base}/i/${invoiceId}`)).text();
    const b = await (await fetch(`${base}/i/${invoiceId}`)).text();
    const manual = (h: string) => /data-manual-amount="([^"]+)"/.exec(h)![1];
    expect(manual(b)).toBe(manual(a));
  });

  it('renders Russian when asked', async () => {
    expect(await (await fetch(`${base}/i/${invoiceId}?lang=ru`)).text()).toContain('Оплатить вручную');
  });

  it('answers the Solana Pay GET and POST', async () => {
    const meta = await (await fetch(`${base}/api/pay/${invoiceId}`)).json();
    expect(meta).toMatchObject({ label: expect.any(String), icon: expect.stringMatching(/^https:\/\//) });
    const res = await fetch(`${base}/api/pay/${invoiceId}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: BUYER }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { transaction: string; message: string };
    expect(body.transaction.length).toBeGreaterThan(100);
    expect(body.message).toContain('5000');
  });

  it('rejects a bad account and unknown or closed invoices', async () => {
    const bad = await fetch(`${base}/api/pay/${invoiceId}`, { method: 'POST', body: JSON.stringify({ account: 'x' }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/i/nope`)).status).toBe(404);
    d.store.updateInvoice(invoiceId, { state: 'paid' });
    const closed = await fetch(`${base}/api/pay/${invoiceId}`, { method: 'POST', body: JSON.stringify({ account: BUYER }) });
    expect(closed.status).toBe(409);
  });

  it('reports status as JSON', async () => {
    expect(await (await fetch(`${base}/api/invoices/${invoiceId}/status`)).json()).toMatchObject({ state: 'open' });
  });
});
