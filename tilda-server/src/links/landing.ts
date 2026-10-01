// tilda-server/src/links/landing.ts — the public home page (GET /) when chat payment links are enabled.
import { экранироватьHtml as esc } from '../http/html.js';
import type { Lang } from './db.js';
import { formatKzt, langSwitch, layout } from './pages.js';

const REPO = 'https://github.com/Tatancloud/solanapaykz';
const DOCS = 'https://tatancloud.github.io/solanapaykz/';

const COPY = {
  en: {
    title: 'SolanaPay-KZ — payment links in tenge',
    signIn: 'Sign in',
    h1: 'Payment links in tenge for shops that sell in chats',
    lead: 'Set a price in tenge, send the link in WhatsApp, Instagram or Telegram, and get paid in USDC or SOL on Solana. The money goes straight to your wallet.',
    cta: 'Start accepting payments',
    how: 'See how it works',
    example: 'Example of a payment link',
    payTo: 'Payment to Aigerim Crafts',
    item: 'Felt slippers, size 38',
    youPay: 'You pay',
    waiting: 'Waiting for payment',
    openWallet: 'Open in wallet',
    stepsTitle: 'How it works',
    steps: [
      ['Add your wallet', 'Sign in with your email or a Solana wallet and paste the address where you want to receive USDC or SOL.'],
      ['Create a link in tenge', 'Enter the amount in ₸ and what it is for. The buyer sees the price in tenge and the exact amount in USDC or SOL at the current rate.'],
      ['Send it in the chat', 'The buyer pays in one tap from Phantom or Solflare, by QR, as a Blink on X, or manually from an exchange. You see the payment in your dashboard and get an email.'],
    ],
    factsTitle: 'What you should know',
    facts: [
      ['0.5% fee', 'Taken inside the same payment. For manual payments from exchanges the fee is recorded as owed and paid from your dashboard.'],
      ['Your money, your wallet', 'Payments go directly from the buyer to your wallet. SolanaPay-KZ never holds or delays them.'],
      ['No private keys', 'We never ask for a private key or a seed phrase. If a page asks you for one, it is a fraud.'],
      ['Price fixed for 15 minutes', 'The tenge amount is converted at the exchange rate and held while the buyer pays.'],
    ],
    statusTitle: 'Status',
    status: 'This site runs on Solana devnet with test tokens for the Colosseum hackathon. Kazakhstan does not allow crypto-assets as payment for goods; the legal route is conversion to tenge through a licensed provider. We are looking for a licensed AIFC partner before accepting real payments here.',
    tildaTitle: 'Shops on Tilda',
    tilda: 'This server also accepts USDC and SOL for Tilda shops through the Tilda payment integration.',
    tildaLink: 'Tilda setup guide',
    source: 'Source code',
    docs: 'Documentation',
    licence: 'MIT licence',
  },
  ru: {
    title: 'SolanaPay-KZ — платёжные ссылки в тенге',
    signIn: 'Войти',
    h1: 'Платёжные ссылки в тенге для тех, кто продаёт в чатах',
    lead: 'Укажите цену в тенге, отправьте ссылку в WhatsApp, Instagram или Telegram и получите оплату в USDC или SOL на Solana. Деньги приходят прямо на ваш кошелёк.',
    cta: 'Начать принимать оплату',
    how: 'Как это работает',
    example: 'Пример платёжной ссылки',
    payTo: 'Оплата для Aigerim Crafts',
    item: 'Войлочные тапочки, размер 38',
    youPay: 'К оплате',
    waiting: 'Ожидает оплаты',
    openWallet: 'Открыть в кошельке',
    stepsTitle: 'Как это работает',
    steps: [
      ['Укажите кошелёк', 'Войдите по email или кошельком Solana и вставьте адрес, на который хотите получать USDC или SOL.'],
      ['Создайте ссылку в тенге', 'Введите сумму в ₸ и за что оплата. Покупатель увидит цену в тенге и точную сумму в USDC или SOL по текущему курсу.'],
      ['Отправьте её в чат', 'Покупатель платит в одно касание из Phantom или Solflare, по QR, через Blink в X или вручную с биржи. Оплата появится в кабинете, а вам придёт письмо.'],
    ],
    factsTitle: 'Что важно знать',
    facts: [
      ['Комиссия 0,5%', 'Берётся внутри того же платежа. При ручной оплате с биржи комиссия записывается долгом и гасится из кабинета.'],
      ['Ваши деньги — на вашем кошельке', 'Платёж идёт напрямую от покупателя на ваш кошелёк. SolanaPay-KZ его не хранит и не задерживает.'],
      ['Никаких приватных ключей', 'Мы никогда не просим приватный ключ или seed-фразу. Если страница их просит — это мошенничество.'],
      ['Цена держится 15 минут', 'Сумма в тенге пересчитывается по курсу бирж и фиксируется, пока покупатель платит.'],
    ],
    statusTitle: 'Статус',
    status: 'Сайт работает в тестовой сети Solana devnet на тестовых токенах для хакатона Colosseum. В Казахстане оплата товаров криптоактивами запрещена; законный путь — конвертация в тенге через лицензированного провайдера. Прежде чем принимать здесь реальные платежи, мы ищем лицензированного партнёра МФЦА.',
    tildaTitle: 'Магазины на Tilda',
    tilda: 'Этот сервер также принимает USDC и SOL для магазинов на Tilda через платёжную интеграцию Tilda.',
    tildaLink: 'Инструкция для Tilda',
    source: 'Исходный код',
    docs: 'Документация',
    licence: 'Лицензия MIT',
  },
} as const;

export function landingPage(lang: Lang): string {
  const c = COPY[lang];
  const q = lang === 'ru' ? '?lang=ru' : '';
  const top = `<header class="lk-top lp-top"><span class="lk-brand"><img class="lk-mark" src="/assets/logo.svg" alt="" width="24" height="24">SolanaPay-KZ</span>
<nav class="lk-nav"><a href="/m${q}">${esc(c.signIn)}</a></nav>${langSwitch('/', lang)}</header>`;

  const example = `<figure class="lp-example"><figcaption>${esc(c.example)}</figcaption>
<div class="lk-card lk-pay" aria-hidden="true"><div class="lk-merchant"><span class="lk-av">AC</span>
<div><p class="lp-strong">${esc(c.payTo)}</p><p class="lk-desc">${esc(c.item)}</p></div></div>
<p class="lk-amount">${esc(formatKzt('18500', lang))}<span class="lk-cur">₸</span></p>
<p class="lk-conv">${esc(c.youPay)} <b>39.13 USDC</b></p>
<p class="lk-status">${esc(c.waiting)}</p><span class="lk-btn">${esc(c.openWallet)}</span></div></figure>`;

  const steps = c.steps.map(([h, p]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p></li>`).join('');
  const facts = c.facts.map(([h, p]) => `<div><dt>${esc(h)}</dt><dd>${esc(p)}</dd></div>`).join('');

  const body = `<section class="lp-hero"><div class="lp-copy"><h1>${esc(c.h1)}</h1><p class="lp-lead">${esc(c.lead)}</p>
<div class="lp-actions"><a class="lk-btn" href="/m${q}">${esc(c.cta)}</a><a class="lk-btn lk-btn-2" href="#how">${esc(c.how)}</a></div></div>
${example}</section>
<section class="lk-card lp-section" id="how"><h2>${esc(c.stepsTitle)}</h2><ol class="lp-steps">${steps}</ol></section>
<section class="lk-card lp-section"><h2>${esc(c.factsTitle)}</h2><dl class="lp-facts">${facts}</dl></section>
<section class="lp-note"><h2>${esc(c.statusTitle)}</h2><p>${esc(c.status)}</p></section>
<section class="lp-tilda"><h2>${esc(c.tildaTitle)}</h2><p>${esc(c.tilda)} <a href="${DOCS}tilda">${esc(c.tildaLink)}</a></p></section>
<footer class="lp-foot"><a href="${REPO}">${esc(c.source)}</a><a href="${DOCS}">${esc(c.docs)}</a><span>${esc(c.licence)}</span></footer>`;

  return layout(lang, c.title, body, [], top).replace('<main class="lk">', '<main class="lk lp">');
}
