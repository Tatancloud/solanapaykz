// tilda-server/src/links/app.ts
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { address, createSolanaRpc } from '@solana/kit';
import nodemailer from 'nodemailer';
import { SolanaPayKZ } from '@solanapaykz/core';
import { createRateLimiter } from './ratelimit.js';
import type { AuthDeps } from './auth.js';
import { handleUpdate, telegramSender } from './bot.js';
import type { LinksConfig } from './config.js';
import { openLinksStore } from './db.js';
import { createRpc, startDetector, type DetectRpc } from './detect.js';
import { readJson, sendHtml, sendJson } from './http.js';
import { t } from './i18n.js';
import { landingPage } from './landing.js';
import type { Quoter } from './invoices.js';
import { createNotifier } from './notify.js';
import { feeWalletProblems, type AccountProbe } from './recipient.js';
import { handleActions } from './routes-actions.js';
import { handleMerchant, type MerchantDeps } from './routes-merchant.js';
import { handlePublic } from './routes-public.js';

export interface LinksApp { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>; stop(): void }

export interface LinksAppOptions {
  links: LinksConfig;
  cluster: 'mainnet' | 'devnet';
  rpcUrl: string;
  publicUrl: string;
  databasePath: string;
  /** Config `trustedProxyAddresses`: peers whose X-Forwarded-For is trusted for rate limits. */
  trustedProxies?: readonly string[];
  smtp: { host: string; port: number; user: string; pass: string; from: string };
  log: { info(m: string, f?: object): void; warn(m: string, f?: object): void };
  overrides?: Partial<{
    quoter: Quoter; rpc: DetectRpc; probe: AccountProbe;
    sendMail: (to: string, subject: string, text: string) => Promise<void>;
    latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
    now: () => number; startDetector: boolean;
  }>;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const ASSETS: Record<string, string> = {
  '/assets/link.js': 'text/javascript; charset=utf-8',
  '/assets/dashboard.js': 'text/javascript; charset=utf-8',
  '/assets/link.css': 'text/css; charset=utf-8',
  '/assets/icon.png': 'image/png',
  '/assets/logo.svg': 'image/svg+xml',
  '/assets/favicon-32.png': 'image/png',
  '/assets/apple-touch-icon.png': 'image/png',
};
// Self-hosted fonts (the page CSP is default-src 'self'): only the .woff2 files shipped in public/fonts.
for (const f of readdirSync(join(PUBLIC_DIR, 'fonts'))) if (f.endsWith('.woff2')) ASSETS[`/assets/fonts/${f}`] = 'font/woff2';

export function createLinksApp(o: LinksAppOptions): LinksApp {
  const ov = o.overrides ?? {};
  const now = ov.now ?? (() => Date.now());
  const store = openLinksStore(o.databasePath);
  const rpc = createSolanaRpc(o.rpcUrl);
  const sdk = new SolanaPayKZ({ recipient: o.links.feeWallet, rpcUrl: o.rpcUrl, cluster: o.cluster });

  const quoter: Quoter = ov.quoter ?? {
    quote: async (amountKzt, token) => {
      const q = await sdk.createQuote({ amountKzt, token });
      return { amountToken: q.amountToken, rate: q.rate, rateSource: q.rateSource };
    },
  };
  const probe: AccountProbe = ov.probe ?? {
    exists: async (a) => (await rpc.getAccountInfo(address(a), { encoding: 'base64' }).send()).value !== null,
  };
  const latestBlockhash = ov.latestBlockhash ?? (async () => (await rpc.getLatestBlockhash().send()).value);
  const transport = nodemailer.createTransport({ host: o.smtp.host, port: o.smtp.port, secure: o.smtp.port === 465,
    auth: { user: o.smtp.user, pass: o.smtp.pass } });
  const sendMail = ov.sendMail ?? (async (to: string, subject: string, text: string) => {
    await transport.sendMail({ from: o.smtp.from, to, subject, text });
  });
  const sendTelegram = o.links.telegram ? telegramSender(o.links.telegram.botToken) : undefined;

  const auth: AuthDeps = { store, pepper: o.links.sessionPepper, now,
    sendCode: (email, code, lang) => sendMail(email, t(lang, 'email_subject'), t(lang, 'email_body', { code })) };
  const deps: MerchantDeps = {
    store, links: o.links, cluster: o.cluster, now, quoter, publicUrl: o.publicUrl, feeWallet: o.links.feeWallet,
    latestBlockhash, txLimiter: createRateLimiter(30, 60_000), auth, probe, host: new URL(o.publicUrl).host,
    authLimiter: createRateLimiter(10, 60_000),
    ...(o.trustedProxies ? { trustedProxies: o.trustedProxies } : {}),
    ...(o.links.telegram ? { botUsername: o.links.telegram.botUsername } : {}),
  };

  if (ov.startDetector !== false) {
    feeWalletProblems(probe, o.cluster, o.links.feeWallet)
      .then((problems) => { for (const p of problems) o.log.warn(`links: ${p}`, { feeWallet: o.links.feeWallet }); })
      .catch((e: unknown) => o.log.warn('links: fee wallet check failed', { message: (e as Error).message }));
  }
  const stopDetector = ov.startDetector === false ? () => {} : startDetector({
    store, rpc: ov.rpc ?? createRpc(o.rpcUrl), cluster: o.cluster, feeWallet: o.links.feeWallet, now, log: o.log,
    onEvent: createNotifier({ store, publicUrl: o.publicUrl, sendMail, ...(sendTelegram ? { sendTelegram } : {}) }),
  }, o.links.detectIntervalMs);

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const type = ASSETS[url.pathname];
      if (type && req.method === 'GET') {
        const maxAge = type === 'font/woff2' ? 31536000 : 300;
        res.writeHead(200, { 'content-type': type, 'cache-control': `public, max-age=${maxAge}` });
        res.end(readFileSync(join(PUBLIC_DIR, url.pathname.slice('/assets/'.length))));
        return true;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // The landing is English by default (owner's decision); Russian only via the language switch.
        sendHtml(res, 200, landingPage(url.searchParams.get('lang') === 'ru' ? 'ru' : 'en'));
        return true;
      }
      const tg = o.links.telegram;
      if (tg && req.method === 'POST' && url.pathname === `/tg/${tg.webhookSecret}`) {
        try { await handleUpdate({ ...deps, send: sendTelegram! }, await readJson(req)); } catch (e) {
          o.log.warn('links: telegram update failed', { message: (e as Error).message });
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (await handleActions(req, res, url, deps)) return true;
      if (await handlePublic(req, res, url, deps)) return true;
      return handleMerchant(req, res, url, deps);
    },
    stop() { stopDetector(); store.close(); },
  };
}
