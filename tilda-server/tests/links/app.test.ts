// tilda-server/tests/links/app.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLinksApp, type LinksApp } from '../../src/links/app.js';
import { loadLinksConfig } from '../../src/links/config.js';
import http from 'node:http';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE = '6UnyHquRaHTjq3XjvmXyhWeeRHA5eHQgyCKmW6rP8XC2';
let app: LinksApp; let server: Server; let base: string; const codes: string[] = [];

beforeEach(async () => {
  app = createLinksApp({
    links: loadLinksConfig({ feeWallet: FEE, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com', publicUrl: 'https://pay.test', databasePath: ':memory:',
    smtp: { host: 'smtp.test', port: 465, user: 'u', pass: 'p', from: 'noreply@pay.test' },
    log: { info: () => {}, warn: () => {} },
    overrides: {
      quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
      probe: { exists: async () => true }, startDetector: false,
      sendMail: async (_to, _s, text) => { codes.push(/\d{6}/.exec(text)![0]); },
      latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
    },
  });
  server = http.createServer((req, res) => { void app.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { app.stop(); return new Promise<void>((ok) => server.close(() => ok())); });

describe('links app', () => {
  it('runs the merchant journey: sign in → settings → invoice → public page → blink metadata', async () => {
    await fetch(`${base}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email: 'a@shop.kz' }) });
    const v = await fetch(`${base}/api/auth/email/verify`, { method: 'POST', body: JSON.stringify({ email: 'a@shop.kz', code: codes.at(-1) }) });
    const cookie = v.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await v.json() as { csrf: string };
    const h = { cookie, 'x-csrf-token': csrf };
    await fetch(`${base}/api/merchant/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ recipient: R, name: 'Shop' }) });
    const inv = await (await fetch(`${base}/api/merchant/invoices`, { method: 'POST', headers: h,
      body: JSON.stringify({ amountKzt: '5000', description: 'Shirt' }) })).json() as { id: string };
    expect((await fetch(`${base}/i/${inv.id}`)).status).toBe(200);
    expect((await fetch(`${base}/api/actions/i/${inv.id}`)).status).toBe(200);
    expect((await fetch(`${base}/assets/link.js`)).status).toBe(200);
  });

  it('does not claim unrelated paths', async () => {
    expect((await fetch(`${base}/tilda/pay`)).status).toBe(404);
  });
});
