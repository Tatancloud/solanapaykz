// tilda-server/tests/links/routes-actions.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { createInvoiceFor } from '../../src/links/invoices.js';
import { createRateLimiter } from '../../src/links/ratelimit.js';
import { handleActions } from '../../src/links/routes-actions.js';
import type { PublicDeps } from '../../src/links/routes-public.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BUYER = generateReference();
let server: http.Server; let base: string; let id: string;

beforeEach(async () => {
  const store = openLinksStore(':memory:');
  const d: PublicDeps = {
    store, links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000_000, quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
    publicUrl: 'https://pay.test', feeWallet: R, txLimiter: createRateLimiter(100, 60_000),
    latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
  };
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  store.updateMerchant(m.id, { recipient: R, name: 'Shop A' });
  const r = createInvoiceFor(d, store.getMerchant(m.id)!, { amountKzt: '5000', description: 'Shirt' }, 'link');
  if (!r.ok) throw new Error('setup');
  id = r.invoice.id;
  server = http.createServer((req, res) => {
    void handleActions(req, res, new URL(req.url ?? '/', 'http://x'), d).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

describe('Solana Actions', () => {
  it('serves actions.json mapping invoice pages to the action API', async () => {
    const res = await fetch(`${base}/actions.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ rules: [{ pathPattern: '/i/*', apiPath: '/api/actions/i/*' }] });
  });

  it('describes the invoice with required headers', async () => {
    const res = await fetch(`${base}/api/actions/i/${id}`);
    expect(res.headers.get('x-action-version')).toBe('2.4');
    expect(res.headers.get('x-blockchain-ids')).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'action', label: expect.stringContaining('10.87'), title: expect.stringContaining('Shop A') });
    expect(String(body.icon)).toMatch(/^https:\/\//);
  });

  it('answers preflight and returns a transaction on POST', async () => {
    expect((await fetch(`${base}/api/actions/i/${id}`, { method: 'OPTIONS' })).status).toBe(200);
    const res = await fetch(`${base}/api/actions/i/${id}`, { method: 'POST', body: JSON.stringify({ account: BUYER }) });
    const body = await res.json() as { type: string; transaction: string };
    expect(body.type).toBe('transaction');
    expect(body.transaction.length).toBeGreaterThan(100);
  });

  it('returns an action error for a closed invoice', async () => {
    const res = await fetch(`${base}/api/actions/i/nope`, { method: 'POST', body: JSON.stringify({ account: BUYER }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Invoice not found' });
  });
});
