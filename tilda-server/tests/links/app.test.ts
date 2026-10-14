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

  it('serves the landing page at the root in English and Russian', async () => {
    const en = await fetch(`${base}/`);
    expect(en.status).toBe(200);
    const html = await en.text();
    expect(html).toContain('Payment links in tenge');
    expect(html).toContain('href="/m"');
    expect(html).toContain('seed phrase');
    // English by default even for a Russian browser; Russian only via the switch (?lang=ru)
    const ruBrowser = await (await fetch(`${base}/`, { headers: { 'accept-language': 'ru-RU,ru;q=0.9' } })).text();
    expect(ruBrowser).toContain('Payment links in tenge');
    const ru = await (await fetch(`${base}/?lang=ru`)).text();
    expect(ru).toContain('Платёжные ссылки в тенге');
    expect(ru).toContain('href="/m?lang=ru"');
    expect(ru).toContain('seed-фразу');
    // Integration blocks, in order: WooCommerce, SDK, Tilda
    const order = ['WordPress / WooCommerce', 'npm install @solanapaykz/core', 'Shops on Tilda'].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(ru).toContain('tatancloud.github.io/solanapaykz/ru/woocommerce');
  });

  it('serves the brand mark, favicon and touch icon', async () => {
    const svg = await fetch(`${base}/assets/logo.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect((await fetch(`${base}/assets/favicon-32.png`)).headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${base}/assets/apple-touch-icon.png`)).headers.get('content-type')).toBe('image/png');
    expect(await (await fetch(`${base}/m`)).text()).toContain('rel="icon" href="/assets/logo.svg"');
  });

  it('serves bundled fonts and nothing else under /assets/fonts', async () => {
    const font = await fetch(`${base}/assets/fonts/golos-text-latin-400-normal.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect((await fetch(`${base}/assets/fonts/missing-font.woff2`)).status).not.toBe(200);
    expect((await fetch(`${base}/assets/fonts/OFL-Unbounded.txt`)).status).not.toBe(200);
    expect((await fetch(`${base}/assets/fonts/..%2F..%2Fconfig.json`)).status).not.toBe(200);
  });

  it('does not claim unrelated paths', async () => {
    expect((await fetch(`${base}/tilda/pay`)).status).toBe(404);
  });

  it('links the logo back to the home page in the visitor\'s language', async () => {
    const en = await (await fetch(`${base}/`)).text();
    expect(en).toContain('<a class="lk-brand" href="/">');
    const ru = await (await fetch(`${base}/?lang=ru`)).text();
    expect(ru).toContain('<a class="lk-brand" href="/?lang=ru">');
    // Pages away from the landing too, e.g. sign-in and a missing invoice.
    expect(await (await fetch(`${base}/m`)).text()).toContain('class="lk-brand" href="/');
    expect(await (await fetch(`${base}/i/nope`)).text()).toContain('class="lk-brand" href="/');
  });

  it('shows the devnet note, the RPC and the Telegram contact in the footer of every page', async () => {
    for (const path of ['/', '/?lang=ru', '/m', '/i/nope']) {
      const html = await (await fetch(`${base}${path}`)).text();
      expect(html).toContain('<footer class="lk-site-foot">');
      expect(html).toContain('https://api.devnet.solana.com');
      expect(html).toContain('href="https://t.me/RuslanUralsk"');
    }
    expect(await (await fetch(`${base}/`)).text()).toContain('Devnet demo');
  });

  it('shows the pitch and demo videos and the team on the landing in English and Russian', async () => {
    const res = await fetch(`${base}/`);
    const en = await res.text();
    for (const id of ['QwVEPey9PfY', 'Jy2tIG_G8oA']) {
      expect(en).toContain(`src="https://www.youtube-nocookie.com/embed/${id}"`);
      expect(en).toContain(`href="https://youtu.be/${id}"`);
    }
    // The embeds load only if the landing's CSP lets YouTube frames in.
    expect(res.headers.get('content-security-policy')).toContain('frame-src https://www.youtube-nocookie.com');
    expect(en).toContain('Ruslan Satybaldin');
    expect(en).toContain('10+ years in IT, client work and B2B sales in fintech, banking and a private medical laboratory.');
    for (const href of ['https://t.me/RuslanUralsk', 'https://twitter.com/ruslantatankz', 'https://www.linkedin.com/in/ruslansatybaldin/']) {
      expect(en).toContain(`href="${href}"`);
    }
    expect(en.indexOf('id="team"')).toBeGreaterThan(en.indexOf('id="videos"'));

    const ru = await (await fetch(`${base}/?lang=ru`)).text();
    expect(ru).toContain('Команда');
    expect(ru).toContain('Руслан Сатыбалдин');
    expect(ru).toContain('Более 10 лет в IT');
    expect(ru).toContain('youtube-nocookie.com/embed/QwVEPey9PfY');
  });
});
