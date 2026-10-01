// tilda-server/src/links/landing.ts — the public home page (GET /) when chat payment links are enabled.
import { экранироватьHtml as esc } from '../http/html.js';
import type { Lang } from './db.js';
import { formatKzt, langSwitch, layout } from './pages.js';

const REPO = 'https://github.com/Tatancloud/solanapaykz';
const DOCS = 'https://tatancloud.github.io/solanapaykz/';
const RELEASE = 'https://github.com/Tatancloud/solanapaykz/releases/tag/v0.1.0';
const NPM = 'https://www.npmjs.com/package/@solanapaykz/core';

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
    integrationsTitle: 'Other ways to accept payment',
    integrations: [
      { title: 'WordPress / WooCommerce',
        text: 'A payment method for WordPress/WooCommerce: the buyer sees the order amount in tenge (KZT), and pays in USDC or SOL via a QR code straight from their own wallet. Money goes directly to the merchant\u2019s wallet \u2014 the plugin never receives it, never holds it, and can\u2019t hold it.',
        links: [['Plugin guide', 'woocommerce'], ['Download v0.1.0', RELEASE], ['Live demo shop', 'https://shop.pagafox.kz']] },
      { title: 'SDK for developers',
        text: '@solanapaykz/core is a TypeScript package for accepting USDC/SOL payments on the Solana network, with automatic conversion from tenge (KZT) at the current exchange rate. It works in both Node.js 20.18+ and the browser and covers three steps of accepting a payment: quote, payment request, and verification.',
        code: 'npm install @solanapaykz/core',
        links: [['Library guide', 'sdk'], ['npm', NPM]] },
      { title: 'Shops on Tilda',
        text: 'Accepts payment in USDC or SOL on Solana for an order placed on a site built on the Tilda platform, converting the amount from tenge (KZT). Money goes directly from the buyer\u2019s wallet to the merchant\u2019s wallet \u2014 the server never holds it or forwards it.',
        links: [['Tilda setup guide', 'tilda']] },
    ],
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
    integrationsTitle: 'Другие способы принимать оплату',
    integrations: [
      { title: 'WordPress / WooCommerce',
        text: 'Способ оплаты для WordPress/WooCommerce: покупатель видит сумму заказа в тенге, платит в USDC или SOL по QR-коду прямо со своего кошелька. Деньги идут напрямую на кошелёк продавца \u2014 плагин их не получает, не удерживает и не может удержать.',
        links: [['Инструкция по плагину', 'ru/woocommerce'], ['Скачать v0.1.0', RELEASE], ['Демо-магазин', 'https://shop.pagafox.kz']] },
      { title: 'SDK для разработчиков',
        text: '@solanapaykz/core \u2014 пакет на TypeScript для приёма платежей в USDC/SOL сети Solana с автоматической конвертацией из тенге по текущему курсу. Работает и в Node.js 20.18+, и в браузере и закрывает три шага приёма платежа: котировка, платёжный запрос и проверка.',
        code: 'npm install @solanapaykz/core',
        links: [['Описание библиотеки', 'ru/sdk'], ['npm', NPM]] },
      { title: 'Магазины на Tilda',
        text: 'Принимает оплату в USDC или SOL на Solana за заказ, оформленный на сайте на платформе Tilda, с пересчётом суммы из тенге. Деньги идут напрямую с кошелька покупателя на кошелёк продавца \u2014 сервер их не хранит и не пересылает.',
        links: [['Инструкция для Tilda', 'ru/tilda']] },
    ],
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
  // Links are either absolute URLs or paths inside the documentation site.
  const href = (l: string) => (l.startsWith('https://') ? l : DOCS + l);
  const integrations = c.integrations.map((it) => `<article class="lk-card lp-int"><h3>${esc(it.title)}</h3><p>${esc(it.text)}</p>
${'code' in it ? `<code class="lp-code">${esc(it.code)}</code>` : ''}<p class="lp-links">${it.links.map(([label, l]) => `<a href="${esc(href(l))}">${esc(label)}</a>`).join('')}</p></article>`).join('');
  const facts = c.facts.map(([h, p]) => `<div><dt>${esc(h)}</dt><dd>${esc(p)}</dd></div>`).join('');

  const body = `<section class="lp-hero"><div class="lp-copy"><h1>${esc(c.h1)}</h1><p class="lp-lead">${esc(c.lead)}</p>
<div class="lp-actions"><a class="lk-btn" href="/m${q}">${esc(c.cta)}</a><a class="lk-btn lk-btn-2" href="#how">${esc(c.how)}</a></div></div>
${example}</section>
<section class="lk-card lp-section" id="how"><h2>${esc(c.stepsTitle)}</h2><ol class="lp-steps">${steps}</ol></section>
<section class="lk-card lp-section"><h2>${esc(c.factsTitle)}</h2><dl class="lp-facts">${facts}</dl></section>
<section class="lp-note"><h2>${esc(c.statusTitle)}</h2><p>${esc(c.status)}</p></section>
<section class="lp-integrations"><h2>${esc(c.integrationsTitle)}</h2><div class="lp-cards">${integrations}</div></section>
<footer class="lp-foot"><a href="${REPO}">${esc(c.source)}</a><a href="${DOCS}">${esc(c.docs)}</a><span>${esc(c.licence)}</span></footer>`;

  return layout(lang, c.title, body, [], top).replace('<main class="lk">', '<main class="lk lp">');
}
