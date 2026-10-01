// tilda-server/tests/links/routes-merchant.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { createRateLimiter } from '../../src/links/ratelimit.js';
import { handleMerchant, invoicesCsv, type MerchantDeps } from '../../src/links/routes-merchant.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE = '6UnyHquRaHTjq3XjvmXyhWeeRHA5eHQgyCKmW6rP8XC2';
const BUYER = generateReference();
let server: http.Server; let base: string; let d: MerchantDeps; let codes: string[];

beforeEach(async () => {
  codes = [];
  const store = openLinksStore(':memory:');
  d = {
    store, links: loadLinksConfig({ feeWallet: FEE, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000_000, quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
    publicUrl: 'https://pay.test', feeWallet: FEE, txLimiter: createRateLimiter(100, 60_000), host: 'pay.test',
    latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
    auth: { store, pepper: 'pepper-pepper-pepper', now: () => 1_000_000, sendCode: async (_e, c) => { codes.push(c); } },
    probe: { exists: async () => true }, authLimiter: createRateLimiter(100, 60_000), botUsername: 'spk_bot',
  };
  server = http.createServer((req, res) => {
    void handleMerchant(req, res, new URL(req.url ?? '/', 'http://x'), d).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  await fetch(`${base}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email, lang: 'en' }) });
  const res = await fetch(`${base}/api/auth/email/verify`, { method: 'POST',
    body: JSON.stringify({ email, code: codes.at(-1), lang: 'en' }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = await res.json() as { csrf: string };
  return { cookie, csrf };
}

function call(path: string, s: { cookie: string; csrf: string }, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, { method, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('merchant routes', () => {
  it('shows the sign-in page without a session and the dashboard with one', async () => {
    expect(await (await fetch(`${base}/m`)).text()).toContain('/api/auth/email/start');
    const s = await signIn('a@shop.kz');
    expect(await (await call('/m', s)).text()).toContain('data-csrf');
  });

  it('creates an invoice after setting a recipient, and refuses without csrf', async () => {
    const s = await signIn('a@shop.kz');
    expect((await call('/api/merchant/invoices', s, 'POST', { amountKzt: '5000', description: 'x' })).status).toBe(400);
    expect((await call('/api/merchant/settings', s, 'PUT', { recipient: R, name: 'Shop' })).status).toBe(200);
    const res = await call('/api/merchant/invoices', s, 'POST', { amountKzt: '5000', description: 'Shirt' });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; url: string };
    expect(body.url).toBe(`https://pay.test/i/${body.id}`);
    const noCsrf = await fetch(`${base}/api/merchant/invoices`, { method: 'POST', headers: { cookie: s.cookie },
      body: JSON.stringify({ amountKzt: '1', description: 'y' }) });
    expect(noCsrf.status).toBe(403);
  });

  it('isolates merchants from each other', async () => {
    const a = await signIn('a@shop.kz');
    await call('/api/merchant/settings', a, 'PUT', { recipient: R });
    await call('/api/merchant/invoices', a, 'POST', { amountKzt: '5000', description: 'A only' });
    const b = await signIn('b@shop.kz');
    expect(await (await call('/api/merchant/invoices', b)).json()).toEqual({ invoices: [] });
    expect(await (await call('/m/invoices.csv', b)).text()).not.toContain('A only');
    expect((await fetch(`${base}/api/merchant/invoices`)).status).toBe(401);
  });

  it('rejects a mint address as recipient with a readable error', async () => {
    const s = await signIn('a@shop.kz');
    const res = await call('/api/merchant/settings', s, 'PUT', { recipient: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'is_mint' });
  });

  it('creates a fee repayment and serves its transaction request', async () => {
    const s = await signIn('a@shop.kz');
    const m = d.store.findMerchantByEmail('a@shop.kz')!;
    d.store.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: 54_350n, invoiceId: null, txSignature: null, createdAt: 1 });
    const res = await call('/api/merchant/fees/repay', s, 'POST', { token: 'USDC' });
    const { url } = await res.json() as { url: string };
    expect(url).toMatch(/^solana:https:\/\/pay\.test\/api\/fees\/\d+$/);
    const tx = await fetch(`${base}${new URL(url.slice('solana:'.length)).pathname}`, { method: 'POST',
      body: JSON.stringify({ account: BUYER }) });
    expect(tx.status).toBe(200);
  });

  it('issues a one-time Telegram link code', async () => {
    const s = await signIn('a@shop.kz');
    const { url } = await (await call('/api/merchant/telegram-link', s, 'POST', {})).json() as { url: string };
    expect(url).toMatch(/^https:\/\/t\.me\/spk_bot\?start=[A-Za-z0-9_-]+$/);
  });
});

describe('invoicesCsv', () => {
  it('quotes fields and neutralizes spreadsheet formulas', () => {
    const csv = invoicesCsv([{ id: 'i1', merchantId: 1, amountKzt: '5000', description: '=HYPERLINK("x"), "q"',
      token: 'USDC', recipient: R, feeBps: 50, state: 'paid', source: 'link', createdAt: 0, expiresAt: 0,
      paidAt: 0, txSignature: 'sig', paidMode: 'manual', reviewReason: null }]);
    expect(csv.split('\n')[0]).toBe('id,created_at,amount_kzt,description,token,state,paid_at,tx_signature,paid_mode');
    expect(csv).toContain(`"'=HYPERLINK(""x""), ""q"""`);
  });
});

describe('error messages people can read', () => {
  it('settings: the fee wallet is refused with a sentence in the merchant language', async () => {
    const s = await signIn('a@shop.kz');
    await call('/api/merchant/settings', s, 'PUT', { lang: 'ru' });
    const r = await (await call('/api/merchant/settings', s, 'PUT', { recipient: FEE })).json() as { error: string; message: string };
    expect(r.error).toBe('is_fee_wallet');
    expect(r.message).toBe('Это кошелёк комиссии сервиса. Вставьте адрес своего кошелька.');
  });

  it('sign-in: a wrong code and a too-early resend get sentences, not codes', async () => {
    await fetch(`${base}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email: 'b@shop.kz', lang: 'en' }) });
    const again = await (await fetch(`${base}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email: 'b@shop.kz', lang: 'en' }) })).json() as { message: string };
    expect(again.message).toMatch(/wait/i);
    const wrong = await (await fetch(`${base}/api/auth/email/verify`, { method: 'POST', body: JSON.stringify({ email: 'b@shop.kz', code: '000000', lang: 'ru' }) })).json() as { error: string; message: string };
    expect(wrong.error).toBe('invalid');
    expect(wrong.message).toMatch(/код/i);
  });

  it('invoice creation without a wallet explains what to do', async () => {
    const s = await signIn('c@shop.kz');
    const r = await (await call('/api/merchant/invoices', s, 'POST', { amountKzt: '5000' })).json() as { message: string };
    expect(r.message).toBe('Add your receiving wallet in Settings first.');
  });
});
