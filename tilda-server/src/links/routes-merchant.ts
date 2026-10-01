// tilda-server/src/links/routes-merchant.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { address } from '@solana/kit';
import { formatUnits, generateReference, resolveToken } from '@solanapaykz/core';
import { clearSessionCookie, createSessionFor, randomToken, readSession, startEmailLogin, verifyEmailLogin, type AuthDeps } from './auth.js';
import type { Invoice, Lang, Token } from './db.js';
import { clientIp, readJson, sendHtml, sendJson } from './http.js';
import { createInvoiceFor } from './invoices.js';
import { dashboardPage, invoicesPage, loginPage, settingsPage } from './pages.js';
import type { RateLimiter } from './ratelimit.js';
import { checkRecipient, saveSettings, type AccountProbe } from './recipient.js';
import type { PublicDeps } from './routes-public.js';
import { buildPaymentTransaction } from './tx.js';
import { issueNonce, signInMessage, verifyWalletSignIn } from './wallet-auth.js';

export interface MerchantDeps extends PublicDeps {
  auth: AuthDeps;
  probe: AccountProbe;
  host: string;
  authLimiter: RateLimiter;
  botUsername?: string;
}

const FEE_TX = /^\/api\/fees\/(\d{1,12})$/;

function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function invoicesCsv(invoices: Invoice[]): string {
  const head = 'id,created_at,amount_kzt,description,token,state,paid_at,tx_signature,paid_mode';
  const rows = invoices.map((i) => [i.id, new Date(i.createdAt).toISOString(), i.amountKzt, i.description, i.token, i.state,
    i.paidAt === null ? '' : new Date(i.paidAt).toISOString(), i.txSignature ?? '', i.paidMode ?? ''].map(csvCell).join(','));
  return [head, ...rows].join('\n') + '\n';
}

function explorer(cluster: 'mainnet' | 'devnet'): (sig: string) => string {
  return (sig) => `https://explorer.solana.com/tx/${sig}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}

function langOf(v: unknown): Lang { return v === 'ru' ? 'ru' : 'en'; }

async function body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try { return await readJson(req); } catch { sendJson(res, 400, { error: 'invalid_json' }); return null; }
}

function signedIn(res: ServerResponse, d: MerchantDeps, merchantId: number): void {
  const s = createSessionFor(d.auth, merchantId);
  sendJson(res, 200, { ok: true, csrf: s.csrf }, { 'set-cookie': s.cookie });
}

export async function handleMerchant(req: IncomingMessage, res: ServerResponse, url: URL, d: MerchantDeps): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const now = d.now();

  // --- public: fee repayment transaction request (called by the wallet) ---
  const fee = FEE_TX.exec(path);
  if (fee) {
    const r = d.store.getRepayment(Number(fee[1]));
    if (method === 'GET') { sendJson(res, 200, { label: 'SolanaPay-KZ fee', icon: new URL(d.links.iconUrl, d.publicUrl).toString() }); return true; }
    if (method !== 'POST') return false;
    if (!r || r.state !== 'pending') { sendJson(res, 404, { error: 'Repayment not found' }); return true; }
    const b = await body(req, res); if (!b) return true;
    let buyer: string;
    try { buyer = address(String(b.account ?? '')); } catch { sendJson(res, 400, { error: 'Invalid account' }); return true; }
    const transaction = await buildPaymentTransaction({ cluster: d.cluster, token: r.token, buyer, merchant: d.feeWallet,
      feeWallet: d.feeWallet, merchantUnits: r.units, feeUnits: 0n, reference: r.reference, memo: `fee:${r.id}`,
      blockhash: await d.latestBlockhash() });
    sendJson(res, 200, { transaction, message: 'SolanaPay-KZ service fee' });
    return true;
  }

  // --- auth endpoints ---
  if (path.startsWith('/api/auth/') && method === 'POST') {
    if (!d.authLimiter.allow(clientIp(req), now)) { sendJson(res, 429, { error: 'too_many' }); return true; }
    if (path === '/api/auth/logout') {
      const s = readSession(d.auth, req.headers.cookie);
      if (s) d.store.deleteSession(s.id);
      res.writeHead(303, { location: '/m', 'set-cookie': clearSessionCookie() }); res.end();
      return true;
    }
    const b = await body(req, res); if (!b) return true;
    if (path === '/api/auth/email/start') {
      const r = await startEmailLogin(d.auth, b.email, langOf(b.lang));
      sendJson(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (path === '/api/auth/email/verify') {
      const r = verifyEmailLogin(d.auth, b.email, b.code, langOf(b.lang));
      if (r.ok) signedIn(res, d, r.merchantId); else sendJson(res, 400, r);
      return true;
    }
    if (path === '/api/auth/wallet/nonce') {
      const nonce = issueNonce(d.store, now);
      sendJson(res, 200, { nonce, message: signInMessage(d.host, nonce) });
      return true;
    }
    if (path === '/api/auth/wallet/verify') {
      const r = verifyWalletSignIn(d.store, now, { host: d.host, address: b.address, nonce: b.nonce, signature: b.signature, lang: langOf(b.lang) });
      if (r.ok) signedIn(res, d, r.merchantId); else sendJson(res, 400, r);
      return true;
    }
    return false;
  }

  const isPage = path === '/m' || path === '/m/invoices' || path === '/m/settings' || path === '/m/invoices.csv';
  const isApi = path.startsWith('/api/merchant/');
  if (!isPage && !isApi) return false;

  const session = readSession(d.auth, req.headers.cookie);
  const merchant = session ? d.store.getMerchant(session.merchantId) : null;
  if (!session || !merchant) {
    if (isApi) sendJson(res, 401, { error: 'unauthorized' });
    else if (path === '/m') sendHtml(res, 200, loginPage(langOf(url.searchParams.get('lang'))));
    else { res.writeHead(303, { location: '/m' }); res.end(); }
    return true;
  }

  if (method === 'GET' && path === '/m') {
    const debts = (['USDC', 'SOL'] as const).map((token) => ({ token,
      amount: formatUnits(d.store.feeDebt(merchant.id, token) > 0n ? d.store.feeDebt(merchant.id, token) : 0n,
        resolveToken(d.cluster, token).decimals) }));
    sendHtml(res, 200, dashboardPage(merchant, session.csrf, debts));
    return true;
  }
  if (method === 'GET' && path === '/m/invoices') {
    sendHtml(res, 200, invoicesPage(merchant, session.csrf, d.store.listInvoices(merchant.id, 200), explorer(d.cluster)));
    return true;
  }
  if (method === 'GET' && path === '/m/settings') {
    sendHtml(res, 200, settingsPage(merchant, session.csrf, Boolean(d.botUsername)));
    return true;
  }
  if (method === 'GET' && path === '/m/invoices.csv') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="invoices.csv"',
      'cache-control': 'no-store' });
    res.end(invoicesCsv(d.store.listInvoices(merchant.id, 10_000)));
    return true;
  }
  if (method === 'GET' && path === '/api/merchant/invoices') {
    sendJson(res, 200, { invoices: d.store.listInvoices(merchant.id, 200) });
    return true;
  }

  if (req.headers['x-csrf-token'] !== session.csrf) { sendJson(res, 403, { error: 'csrf' }); return true; }
  const b = await body(req, res); if (!b) return true;

  if (method === 'POST' && path === '/api/merchant/invoices') {
    const r = createInvoiceFor(d, merchant, { amountKzt: b.amountKzt, description: b.description, token: b.token }, 'link');
    if (!r.ok) sendJson(res, 400, r);
    else sendJson(res, 200, { id: r.invoice.id, url: `${d.publicUrl}/i/${r.invoice.id}` });
    return true;
  }
  if (method === 'PUT' && path === '/api/merchant/settings') {
    let recipient: string | undefined;
    if (b.recipient !== undefined && b.recipient !== merchant.recipient) {
      const c = await checkRecipient(d.probe, d.cluster, b.recipient);
      if (!c.ok) { sendJson(res, 400, c); return true; }
      recipient = c.address;
    }
    const r = saveSettings(d.store, merchant.id, { recipient, name: b.name, lang: b.lang });
    sendJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (method === 'POST' && path === '/api/merchant/fees/repay') {
    const token: Token = b.token === 'SOL' ? 'SOL' : 'USDC';
    const units = d.store.feeDebt(merchant.id, token);
    if (units <= 0n) { sendJson(res, 400, { error: 'no_debt' }); return true; }
    const r = d.store.createRepayment({ merchantId: merchant.id, token, units, reference: generateReference(), createdAt: now });
    sendJson(res, 200, { url: `solana:${d.publicUrl}/api/fees/${r.id}` });
    return true;
  }
  if (method === 'POST' && path === '/api/merchant/telegram-link') {
    if (!d.botUsername) { sendJson(res, 404, { error: 'no_bot' }); return true; }
    const code = randomToken(12);
    d.store.putBotLink(code, merchant.id, now + 15 * 60_000);
    sendJson(res, 200, { url: `https://t.me/${d.botUsername}?start=${code}` });
    return true;
  }
  return false;
}
