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
export function loginPage(lang: Lang): string {
  return layout(lang, t(lang, 'sign_in'), `${langSwitch('/m', lang)}<h1>${esc(t(lang, 'sign_in'))}</h1>
<form id="lk-email" data-start="/api/auth/email/start" data-verify="/api/auth/email/verify" data-lang="${lang}">
<label>${esc(t(lang, 'email'))}<input name="email" type="email" required autocomplete="email"></label>
<button type="submit">${esc(t(lang, 'send_code'))}</button>
<label hidden>${esc(t(lang, 'code'))}<input name="code" inputmode="numeric" pattern="\\d{6}"></label>
<button type="button" id="lk-verify" hidden>${esc(t(lang, 'verify'))}</button></form>
<p>${esc(t(lang, 'or'))}</p><button type="button" id="lk-wallet">${esc(t(lang, 'sign_in_wallet'))}</button>
<p id="lk-msg" class="lk-hint"></p>`, ['/assets/dashboard.js']);
}

function nav(lang: Lang): string {
  return `<nav><a href="/m">${esc(t(lang, 'new_invoice'))}</a><a href="/m/invoices">${esc(t(lang, 'invoices'))}</a>
<a href="/m/settings">${esc(t(lang, 'settings'))}</a></nav>`;
}

export function dashboardPage(m: Merchant, csrf: string, debts: { token: string; amount: string }[]): string {
  const lang = m.lang;
  const debt = debts.filter((x) => x.amount !== '0').map((x) =>
    `<p class="lk-warn">${esc(t(lang, 'fee_debt', { amount: x.amount, token: x.token }))}
 <button type="button" data-repay="${x.token}">${esc(t(lang, 'repay'))}</button></p>`).join('');
  return layout(lang, t(lang, 'new_invoice'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>${nav(lang)}
${m.recipient ? '' : `<p class="lk-warn">${esc(t(lang, 'err_no_recipient'))}</p>`}${debt}
<h1>${esc(t(lang, 'new_invoice'))}</h1><form id="lk-new">
<label>${esc(t(lang, 'amount_kzt'))}, ₸<input name="amountKzt" inputmode="decimal" required></label>
<label>${esc(t(lang, 'description'))}<input name="description" maxlength="140"></label>
<label>Token<select name="token"><option>USDC</option><option>SOL</option></select></label>
<button type="submit">${esc(t(lang, 'create'))}</button></form>
<div id="lk-result" hidden><code id="lk-url"></code> <button type="button" id="lk-share">${esc(t(lang, 'share'))}</button></div>
<p id="lk-msg" class="lk-hint"></p>`, ['/assets/dashboard.js']);
}

export function invoicesPage(m: Merchant, csrf: string, invoices: Invoice[], explorer: (sig: string) => string): string {
  const lang = m.lang;
  const rows = invoices.map((i) => `<tr id="${esc(i.id)}"><td>${new Date(i.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
<td>${esc(i.amountKzt)} ₸</td><td>${esc(i.description)}</td><td class="lk-${i.state}">${esc(t(lang, `status_${i.state}` as Key))}
${i.reviewReason ? ` (${esc(i.reviewReason)})` : ''}</td>
<td>${i.txSignature ? `<a href="${esc(explorer(i.txSignature))}" rel="noopener">tx</a>` : `<a href="/i/${esc(i.id)}">link</a>`}</td></tr>`).join('');
  return layout(lang, t(lang, 'invoices'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>${nav(lang)}
<h1>${esc(t(lang, 'invoices'))}</h1><p><a href="/m/invoices.csv">${esc(t(lang, 'export_csv'))}</a></p>
<table><tbody>${rows}</tbody></table>`, ['/assets/dashboard.js']);
}

export function settingsPage(m: Merchant, csrf: string, hasBot: boolean): string {
  const lang = m.lang;
  return layout(lang, t(lang, 'settings'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>${nav(lang)}
<h1>${esc(t(lang, 'settings'))}</h1><form id="lk-settings">
<label>${esc(t(lang, 'receiving_wallet'))}<input name="recipient" value="${esc(m.recipient ?? '')}" autocomplete="off" spellcheck="false"></label>
<label>${esc(t(lang, 'shop_name'))}<input name="name" maxlength="80" value="${esc(m.name)}"></label>
<label>${esc(t(lang, 'language'))}<select name="lang"><option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
<option value="ru"${lang === 'ru' ? ' selected' : ''}>Русский</option></select></label>
<button type="submit">${esc(t(lang, 'save'))}</button></form>
${hasBot ? `<p><button type="button" id="lk-tg">${esc(t(lang, 'link_telegram'))}</button></p>` : ''}
<form method="post" action="/api/auth/logout"><button type="submit">${esc(t(lang, 'sign_out'))}</button></form>
<p id="lk-msg" class="lk-hint" data-saved="${esc(t(lang, 'saved'))}"></p>`, ['/assets/dashboard.js']);
}
