// tilda-server/src/links/routes-public.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { address } from '@solana/kit';
import QRCode from 'qrcode';
import { formatUnits, resolveToken } from '@solanapaykz/core';
import { activeQuote, type InvoiceDeps } from './invoices.js';
import { clientIp, readJson, sendHtml, sendJson } from './http.js';
import { pickLang } from './i18n.js';
import { invoicePage, notFoundPage } from './pages.js';
import type { RateLimiter } from './ratelimit.js';
import { buildPaymentTransaction } from './tx.js';

export interface PublicDeps extends InvoiceDeps {
  publicUrl: string;
  feeWallet: string;
  latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  txLimiter: RateLimiter;
  /** Peers whose X-Forwarded-For is trusted; defaults to loopback. */
  trustedProxies?: readonly string[];
}

const INVOICE_PAGE = /^\/i\/([A-Za-z0-9_-]{1,32})$/;
const PAY_API = /^\/api\/pay\/([A-Za-z0-9_-]{1,32})$/;
const STATUS_API = /^\/api\/invoices\/([A-Za-z0-9_-]{1,32})\/status$/;

export async function buildInvoiceTransaction(d: PublicDeps, invoiceId: string, account: unknown):
  Promise<{ ok: true; transaction: string; message: string } | { ok: false; status: number; error: string }> {
  const inv = d.store.getInvoice(invoiceId);
  if (!inv) return { ok: false, status: 404, error: 'Invoice not found' };
  if (inv.state !== 'open') return { ok: false, status: 409, error: 'Invoice is not open' };
  let buyer: string;
  try { buyer = address(String(account ?? '')); } catch { return { ok: false, status: 400, error: 'Invalid account' }; }
  const q = await activeQuote(d, inv);
  const transaction = await buildPaymentTransaction({
    cluster: d.cluster, token: inv.token, buyer, merchant: inv.recipient, feeWallet: d.feeWallet,
    merchantUnits: q.merchantUnits, feeUnits: q.feeUnits, reference: q.reference, memo: `inv:${inv.id}`,
    blockhash: await d.latestBlockhash(),
  });
  const decimals = resolveToken(d.cluster, inv.token).decimals;
  return { ok: true, transaction,
    message: `${inv.amountKzt} KZT = ${formatUnits(q.totalUnits, decimals)} ${inv.token} — ${inv.description}`.slice(0, 200) };
}

export async function handlePublic(req: IncomingMessage, res: ServerResponse, url: URL, d: PublicDeps): Promise<boolean> {
  const method = req.method ?? 'GET';

  const page = INVOICE_PAGE.exec(url.pathname);
  if (page && method === 'GET') {
    const lang = pickLang(url.searchParams.get('lang'), req.headers['accept-language']);
    const inv = d.store.getInvoice(page[1]!);
    const merchant = inv ? d.store.getMerchant(inv.merchantId) : null;
    if (!inv || !merchant) { sendHtml(res, 404, notFoundPage(lang)); return true; }
    const decimals = resolveToken(d.cluster, inv.token).decimals;
    const requestUrl = `solana:${d.publicUrl}/api/pay/${inv.id}`;
    if (inv.state !== 'open') {
      sendHtml(res, 200, invoicePage({ invoice: inv, merchant, lang, tokenAmount: '', manualAmount: '', qrSvg: '',
        requestUrl, deepLink: requestUrl, minutesLeft: 0 }));
      return true;
    }
    const q = await activeQuote(d, inv);
    sendHtml(res, 200, invoicePage({
      invoice: inv, merchant, lang, requestUrl, deepLink: requestUrl,
      tokenAmount: formatUnits(q.totalUnits, decimals), manualAmount: formatUnits(q.manualUnits, decimals),
      qrSvg: await QRCode.toString(requestUrl, { type: 'svg', margin: 1, width: 240 }),
      minutesLeft: Math.max(1, Math.ceil((q.expiresAt - d.now()) / 60_000)),
    }));
    return true;
  }

  const pay = PAY_API.exec(url.pathname);
  if (pay && method === 'GET') {
    const inv = d.store.getInvoice(pay[1]!);
    const m = inv ? d.store.getMerchant(inv.merchantId) : null;
    sendJson(res, 200, { label: m?.name || 'SolanaPay-KZ', icon: new URL(d.links.iconUrl, d.publicUrl).toString() });
    return true;
  }
  if (pay && method === 'POST') {
    if (!d.txLimiter.allow(clientIp(req, d.trustedProxies), d.now())) { sendJson(res, 429, { error: 'Too many requests' }); return true; }
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const r = await buildInvoiceTransaction(d, pay[1]!, body.account);
    if (!r.ok) sendJson(res, r.status, { error: r.error });
    else sendJson(res, 200, { transaction: r.transaction, message: r.message });
    return true;
  }

  const status = STATUS_API.exec(url.pathname);
  if (status && method === 'GET') {
    const inv = d.store.getInvoice(status[1]!);
    if (!inv) sendJson(res, 404, { error: 'Invoice not found' });
    else sendJson(res, 200, { state: inv.state, paidAt: inv.paidAt, txSignature: inv.txSignature });
    return true;
  }
  return false;
}
