// tilda-server/src/links/pages.ts — server-rendered pages; styles in public/link.css (design: "Steppe Sky")
import { экранироватьHtml as esc } from '../http/html.js';
import type { Invoice, Lang, Merchant } from './db.js';
import { t, type Key } from './i18n.js';

const BRAND = `<span class="lk-brand"><img class="lk-mark" src="/assets/logo.svg" alt="" width="24" height="24">SolanaPay-KZ</span>`;

export function layout(lang: Lang, title: string, body: string, scripts: string[] = [], top = ''): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="preload" href="/assets/fonts/unbounded-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml"><link rel="icon" href="/assets/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"><link rel="stylesheet" href="/assets/link.css"></head><body>${top}<main class="lk">${body}</main>
${scripts.map((s) => `<script src="${s}" defer></script>`).join('')}</body></html>`;
}

export function langSwitch(path: string, lang: Lang): string {
  const other: Lang = lang === 'en' ? 'ru' : 'en';
  return `<a class="lk-lang" href="${esc(path)}?lang=${other}" hreflang="${other}">${other === 'ru' ? 'Русский' : 'English'}</a>`;
}

/** 5000.5 → "5 000.50" (en) / "5 000,50" (ru); groups with a narrow no-break space. */
export function formatKzt(amount: string, lang: Lang): string {
  const [int = '0', frac] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F');
  if (!frac || /^0+$/.test(frac)) return grouped;
  return grouped + (lang === 'ru' ? ',' : '.') + frac.padEnd(2, '0');
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? 'SP').slice(0, 2)).toUpperCase();
}

function payTop(path: string, lang: Lang): string {
  return `<header class="lk-top lk-top-pay">${BRAND}${langSwitch(path, lang)}</header>`;
}

export interface InvoiceView {
  invoice: Invoice; merchant: Merchant; lang: Lang; tokenAmount: string; manualAmount: string;
  qrSvg: string; requestUrl: string; deepLink: string; minutesLeft: number;
  /** Wallet Standard chain id, e.g. solana:devnet — used when a browser-extension wallet pays in-page. */
  chain: string;
}

function payHead(inv: Invoice, m: Merchant, lang: Lang, title: string): string {
  return `<div class="lk-merchant"><span class="lk-av" aria-hidden="true">${esc(initials(m.name || 'SolanaPay KZ'))}</span>
<div><h1>${esc(title)}</h1><p class="lk-desc">${esc(inv.description)}</p></div></div>
<p class="lk-amount" aria-label="${esc(t(lang, 'amount_kzt'))}">${esc(formatKzt(inv.amountKzt, lang))}<span class="lk-cur">₸</span></p>`;
}

export function invoicePage(v: InvoiceView): string {
  const { invoice: inv, merchant: m, lang } = v;
  const title = t(lang, 'invoice_title', { name: m.name || 'SolanaPay-KZ' });
  const path = `/i/${inv.id}`;
  const statusKey = `status_${inv.state}` as Key;
  if (inv.state !== 'open') {
    return layout(lang, title, `<section class="lk-card lk-pay">${payHead(inv, m, lang, title)}
<p class="lk-status lk-${inv.state}">${esc(t(lang, statusKey))}</p></section>`, [], payTop(path, lang));
  }
  const percent = String(inv.feeBps / 100).replace('.', lang === 'ru' ? ',' : '.');
  return layout(lang, title, `<section class="lk-card lk-pay">${payHead(inv, m, lang, title)}
<p class="lk-conv">${esc(t(lang, 'you_pay'))} <b>${esc(v.tokenAmount)} ${inv.token}</b><span>${esc(t(lang, 'rate_note', { minutes: String(v.minutesLeft) }))}</span></p>
<p class="lk-status" id="lk-status" role="status" aria-live="polite" data-invoice="${esc(inv.id)}" data-manual-amount="${esc(v.manualAmount)}"
 data-copied="${esc(t(lang, 'copied'))}" data-paid="${esc(t(lang, 'status_paid'))}"
 data-review="${esc(t(lang, 'status_needs_review'))}">${esc(t(lang, 'status_open'))}</p>
<div class="lk-wallet"><div class="lk-qr">${v.qrSvg}</div><p class="lk-hint">${esc(t(lang, 'scan_qr'))}</p>
<a class="lk-btn" id="lk-open-wallet" href="${esc(v.deepLink)}" data-pay="/api/pay/${esc(inv.id)}" data-chain="${esc(v.chain)}"
 data-confirm-wallet="${esc(t(lang, 'wallet_confirm'))}" data-sent="${esc(t(lang, 'wallet_sent'))}">${esc(t(lang, 'open_wallet'))}</a>
<p class="lk-hint" id="lk-pay-msg" role="status"></p></div>
<details class="lk-manual"><summary>${esc(t(lang, 'pay_manually'))}</summary>
<p class="lk-warn">${esc(t(lang, 'network_warning'))}</p>
<div class="lk-field"><span class="lk-label">${esc(t(lang, 'recipient_address'))}</span>
<div class="lk-copy"><code>${esc(inv.recipient)}</code><button type="button" data-copy="${esc(inv.recipient)}">${esc(t(lang, 'copy'))}</button></div></div>
<div class="lk-field"><span class="lk-label">${esc(t(lang, 'exact_amount'))}</span>
<div class="lk-copy"><code>${esc(v.manualAmount)} ${inv.token}</code><button type="button" data-copy="${esc(v.manualAmount)}">${esc(t(lang, 'copy'))}</button></div></div>
<p class="lk-hint">${esc(t(lang, 'manual_hint'))}</p></details>
<p class="lk-foot">${esc(t(lang, 'fee_included', { percent }))} · Solana</p></section>`, ['/assets/link.js'], payTop(path, lang));
}

export function notFoundPage(lang: Lang): string {
  return layout(lang, t(lang, 'not_found'), `<section class="lk-card"><h1>${esc(t(lang, 'not_found'))}</h1></section>`, [],
    `<header class="lk-top lk-top-pay">${BRAND}</header>`);
}

export function loginPage(lang: Lang): string {
  return layout(lang, t(lang, 'sign_in'), `<section class="lk-card lk-narrow"><h1>${esc(t(lang, 'sign_in'))}</h1>
<form id="lk-email" class="lk-form" data-start="/api/auth/email/start" data-verify="/api/auth/email/verify" data-lang="${lang}">
<label>${esc(t(lang, 'email'))}<input name="email" type="email" required autocomplete="email"></label>
<button type="submit" class="lk-btn">${esc(t(lang, 'send_code'))}</button>
<label hidden>${esc(t(lang, 'code'))}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}"></label>
<button type="button" class="lk-btn" id="lk-verify" hidden>${esc(t(lang, 'verify'))}</button></form>
<p class="lk-or"><span>${esc(t(lang, 'or'))}</span></p><button type="button" class="lk-btn lk-btn-2" id="lk-wallet" data-no-wallet="${esc(t(lang, 'no_wallet'))}">${esc(t(lang, 'sign_in_wallet'))}</button>
<a class="lk-btn lk-btn-2" id="lk-phantom" hidden>${esc(t(lang, 'open_in_phantom'))}</a>
<p id="lk-msg" class="lk-hint" role="status"></p></section>`, ['/assets/dashboard.js'],
    `<header class="lk-top">${BRAND}${langSwitch('/m', lang)}</header>`);
}

type Section = 'new' | 'invoices' | 'settings';

function merchantTop(lang: Lang, current: Section): string {
  const item = (s: Section, href: string, key: Key) =>
    `<a href="${href}"${s === current ? ' aria-current="page"' : ''}>${esc(t(lang, key))}</a>`;
  return `<header class="lk-top">${BRAND}<nav class="lk-nav">${item('new', '/m', 'new_invoice')}${item('invoices', '/m/invoices', 'invoices')}
${item('settings', '/m/settings', 'settings')}</nav></header>`;
}

export function dashboardPage(m: Merchant, csrf: string, debts: { token: string; amount: string }[]): string {
  const lang = m.lang;
  // Amounts arrive as fixed-decimal strings ("0.000000000"): compare as numbers, show without trailing zeros.
  const trim = (a: string) => (a.includes('.') ? a.replace(/0+$/, '').replace(/\.$/, '') : a);
  const debt = debts.filter((x) => /[1-9]/.test(x.amount)).map((x) =>
    `<div class="lk-notice lk-notice-debt"><p>${esc(t(lang, 'fee_debt', { amount: trim(x.amount), token: x.token }))}</p>
<button type="button" class="lk-btn lk-btn-sm" data-repay="${x.token}">${esc(t(lang, 'repay'))}</button></div>`).join('');
  return layout(lang, t(lang, 'new_invoice'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>
${m.recipient ? '' : `<div class="lk-notice"><p>${esc(t(lang, 'err_no_recipient'))}</p><a class="lk-btn lk-btn-sm" href="/m/settings">${esc(t(lang, 'settings'))}</a></div>`}${debt}
<section class="lk-card"><h1>${esc(t(lang, 'new_invoice'))}</h1><form id="lk-new" class="lk-form">
<label>${esc(t(lang, 'amount_kzt'))}, ₸<input name="amountKzt" inputmode="decimal" required autocomplete="off"></label>
<label>${esc(t(lang, 'description'))}<input name="description" maxlength="140"></label>
<label>Token<select name="token"><option>USDC</option><option>SOL</option></select></label>
<button type="submit" class="lk-btn">${esc(t(lang, 'create'))}</button></form>
<div id="lk-result" class="lk-result" hidden><code id="lk-url"></code><button type="button" class="lk-btn lk-btn-sm" id="lk-share">${esc(t(lang, 'share'))}</button></div>
<p id="lk-msg" class="lk-hint" role="status"></p></section>`, ['/assets/dashboard.js'], merchantTop(lang, 'new'));
}

export function invoicesPage(m: Merchant, csrf: string, invoices: Invoice[], explorer: (sig: string) => string): string {
  const lang = m.lang;
  const deletable = (i: Invoice) => (i.state === 'open' || i.state === 'expired') && !i.txSignature;
  const pill = (i: Invoice) => `<span class="lk-pill lk-${i.state}">${esc(t(lang, `status_${i.state}` as Key))}</span>${i.reviewReason ? `<small>${esc(i.reviewReason)}</small>` : ''}`;
  const rows = invoices.map((i) => `<tr id="${esc(i.id)}"><td class="lk-num">${new Date(i.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
<td class="lk-num">${esc(formatKzt(i.amountKzt, lang))} ₸</td><td>${esc(i.description)}</td><td>${pill(i)}</td>
<td>${i.txSignature ? `<a href="${esc(explorer(i.txSignature))}" rel="noopener">Explorer</a>` : `<a href="/i/${esc(i.id)}">${esc(t(lang, 'open_link'))}</a>`}
${deletable(i) ? `<button type="button" class="lk-link lk-del" data-delete="${esc(i.id)}" data-confirm="${esc(t(lang, 'delete_confirm'))}">${esc(t(lang, 'delete'))}</button>` : ''}</td></tr>`).join('');
  return layout(lang, t(lang, 'invoices'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>
<section class="lk-card lk-wide"><div class="lk-head"><h1>${esc(t(lang, 'invoices'))}</h1><a class="lk-btn lk-btn-sm lk-btn-2" href="/m/invoices.csv">${esc(t(lang, 'export_csv'))}</a></div>
<div class="lk-table"><table><tbody>${rows}</tbody></table></div></section>`, ['/assets/dashboard.js'], merchantTop(lang, 'invoices'));
}

export function settingsPage(m: Merchant, csrf: string, hasBot: boolean): string {
  const lang = m.lang;
  return layout(lang, t(lang, 'settings'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>
<section class="lk-card"><h1>${esc(t(lang, 'settings'))}</h1><form id="lk-settings" class="lk-form">
<label>${esc(t(lang, 'receiving_wallet'))}<input name="recipient" class="lk-mono" value="${esc(m.recipient ?? '')}" autocomplete="off" spellcheck="false"></label>
<label>${esc(t(lang, 'shop_name'))}<input name="name" maxlength="80" value="${esc(m.name)}"></label>
<label>${esc(t(lang, 'language'))}<select name="lang"><option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
<option value="ru"${lang === 'ru' ? ' selected' : ''}>Русский</option></select></label>
<button type="submit" class="lk-btn">${esc(t(lang, 'save'))}</button></form>
<p id="lk-msg" class="lk-hint" role="status" data-saved="${esc(t(lang, 'saved'))}"></p>
<div class="lk-walletlogin"><h2>${esc(t(lang, 'wallet_login_title'))}</h2>
<p class="lk-hint">${m.walletLogin
    ? esc(t(lang, 'wallet_login_current', { address: `${m.walletLogin.slice(0, 4)}…${m.walletLogin.slice(-4)}` }))
    : esc(t(lang, 'wallet_login_none'))}</p>
<button type="button" class="lk-btn lk-btn-2" id="lk-link-wallet" data-no-wallet="${esc(t(lang, 'no_wallet'))}" data-linked="${esc(t(lang, 'wallet_linked'))}">${esc(t(lang, m.walletLogin ? 'relink_wallet' : 'link_wallet'))}</button>
<a class="lk-btn lk-btn-2" id="lk-phantom" hidden>${esc(t(lang, 'open_in_phantom'))}</a></div>
${hasBot ? `<p><button type="button" class="lk-btn lk-btn-2" id="lk-tg">${esc(t(lang, 'link_telegram'))}</button></p>` : ''}
<form method="post" action="/api/auth/logout" class="lk-signout"><button type="submit" class="lk-link">${esc(t(lang, 'sign_out'))}</button></form></section>`,
  ['/assets/dashboard.js'], merchantTop(lang, 'settings'));
}
