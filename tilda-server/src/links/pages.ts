// tilda-server/src/links/pages.ts
import { экранироватьHtml as esc } from '../http/html.js';
import type { Invoice, Lang, Merchant } from './db.js';
import { t, type Key } from './i18n.js';

export function layout(lang: Lang, title: string, body: string, scripts: string[] = []): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/link.css"></head><body><main class="lk">${body}</main>
${scripts.map((s) => `<script src="${s}" defer></script>`).join('')}</body></html>`;
}

export function langSwitch(path: string, lang: Lang): string {
  const other: Lang = lang === 'en' ? 'ru' : 'en';
  return `<a class="lk-lang" href="${esc(path)}?lang=${other}">${other.toUpperCase()}</a>`;
}

export interface InvoiceView {
  invoice: Invoice; merchant: Merchant; lang: Lang; tokenAmount: string; manualAmount: string;
  qrSvg: string; requestUrl: string; deepLink: string; minutesLeft: number;
}

export function invoicePage(v: InvoiceView): string {
  const { invoice: inv, merchant: m, lang } = v;
  const title = t(lang, 'invoice_title', { name: m.name || 'SolanaPay-KZ' });
  const statusKey = `status_${inv.state}` as Key;
  if (inv.state !== 'open') {
    return layout(lang, title, `${langSwitch(`/i/${inv.id}`, lang)}<h1>${esc(title)}</h1>
<p class="lk-desc">${esc(inv.description)}</p><p class="lk-status lk-${inv.state}">${esc(t(lang, statusKey))}</p>`);
  }
  return layout(lang, title, `${langSwitch(`/i/${inv.id}`, lang)}
<h1>${esc(title)}</h1><p class="lk-desc">${esc(inv.description)}</p>
<p class="lk-kzt">${esc(t(lang, 'amount_kzt'))}: <b>${esc(inv.amountKzt)} ₸</b></p>
<p class="lk-token">${esc(t(lang, 'you_pay'))}: <b>${esc(v.tokenAmount)} ${inv.token}</b>
 <small>${esc(t(lang, 'rate_note', { minutes: String(v.minutesLeft) }))}</small></p>
<div class="lk-qr">${v.qrSvg}</div><p class="lk-hint">${esc(t(lang, 'scan_qr'))}</p>
<a class="lk-btn" href="${esc(v.deepLink)}">${esc(t(lang, 'open_wallet'))}</a>
<details class="lk-manual"><summary>${esc(t(lang, 'pay_manually'))}</summary>
<p class="lk-warn">${esc(t(lang, 'network_warning'))}</p>
<label>${esc(t(lang, 'recipient_address'))}</label>
<div class="lk-copy"><code>${esc(inv.recipient)}</code><button type="button" data-copy="${esc(inv.recipient)}">${esc(t(lang, 'copy'))}</button></div>
<label>${esc(t(lang, 'exact_amount'))}</label>
<div class="lk-copy"><code>${esc(v.manualAmount)} ${inv.token}</code><button type="button" data-copy="${esc(v.manualAmount)}">${esc(t(lang, 'copy'))}</button></div>
<p class="lk-hint">${esc(t(lang, 'manual_hint'))}</p></details>
<p class="lk-status" id="lk-status" data-invoice="${esc(inv.id)}" data-manual-amount="${esc(v.manualAmount)}"
 data-copied="${esc(t(lang, 'copied'))}" data-paid="${esc(t(lang, 'status_paid'))}"
 data-review="${esc(t(lang, 'status_needs_review'))}">${esc(t(lang, 'status_open'))}</p>`, ['/assets/link.js']);
}

export function notFoundPage(lang: Lang): string {
  return layout(lang, t(lang, 'not_found'), `<h1>${esc(t(lang, 'not_found'))}</h1>`);
}
