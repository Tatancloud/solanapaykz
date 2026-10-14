// tilda-server/src/links/landing.ts — the public home page (GET /) when chat payment links are enabled.
import { экранироватьHtml as esc } from '../http/html.js';
import type { Lang } from './db.js';
import { brand, formatKzt, langSwitch, layout } from './pages.js';

const REPO = 'https://github.com/Tatancloud/solanapaykz';
const DOCS = 'https://tatancloud.github.io/solanapaykz/';
const RELEASE = 'https://github.com/Tatancloud/solanapaykz/releases/tag/v0.1.0';
const NPM = 'https://www.npmjs.com/package/@solanapaykz/core';
const VIDEOS = { pitch: 'QwVEPey9PfY', demo: 'Jy2tIG_G8oA' } as const;
const SOCIAL = [
  { name: 'Telegram', href: 'https://t.me/RuslanUralsk',
    path: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z' },
  { name: 'X', href: 'https://twitter.com/ruslantatankz',
    path: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z' },
  { name: 'LinkedIn', href: 'https://www.linkedin.com/in/ruslansatybaldin/',
    path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
] as const;
/** The landing embeds YouTube (privacy-enhanced domain); every other page keeps the default `default-src 'self'`. */
export const LANDING_CSP = "default-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'";

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
        links: [['Tilda setup guide', 'tilda'], ['Tilda demo shop', 'https://kzwedding.tilda.ws/solanapay']] },
    ],
    videosTitle: 'Videos',
    videos: [['Pitch', VIDEOS.pitch], ['Product demo', VIDEOS.demo]],
    watchOnYoutube: 'Watch on YouTube',
    videosNote: 'The videos are played by YouTube; YouTube may store cookies when you play them.',
    teamTitle: 'Team',
    founder: { name: 'Ruslan Satybaldin', role: 'Solo founder',
      bio: '10+ years in IT, client work and B2B sales in fintech, banking and a private medical laboratory.' },
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
        links: [['Инструкция для Tilda', 'ru/tilda'], ['Демо-магазин на Tilda', 'https://kzwedding.tilda.ws/solanapayru']] },
    ],
    videosTitle: 'Видео',
    videos: [['Питч', VIDEOS.pitch], ['Демо продукта', VIDEOS.demo]],
    watchOnYoutube: 'Смотреть на YouTube',
    videosNote: 'Видео воспроизводит YouTube; при просмотре YouTube может сохранять cookie.',
    teamTitle: 'Команда',
    founder: { name: 'Руслан Сатыбалдин', role: 'Соло-основатель',
      bio: 'Более 10 лет в IT: работа с клиентами и B2B-продажи в финтехе, банках и частной медицинской лаборатории.' },
    source: 'Исходный код',
    docs: 'Документация',
    licence: 'Лицензия MIT',
  },
} as const;

export function landingPage(lang: Lang): string {
  const c = COPY[lang];
  const q = lang === 'ru' ? '?lang=ru' : '';
  const top = `<header class="lk-top lp-top">${brand(lang)}
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
  const videos = c.videos.map(([label, id]) => `<figure class="lp-video"><div class="lp-frame">
<iframe src="https://www.youtube-nocookie.com/embed/${id}" title="${esc(label)}" loading="lazy"
 referrerpolicy="strict-origin-when-cross-origin"
 allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>
<figcaption><span class="lp-strong">${esc(label)}</span><a href="https://youtu.be/${id}">${esc(c.watchOnYoutube)}</a></figcaption></figure>`).join('');
  const f = c.founder;
  const social = SOCIAL.map((s) => `<a href="${s.href}" aria-label="${s.name}" title="${s.name}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="${s.path}"/></svg></a>`).join('');
  const facts = c.facts.map(([h, p]) => `<div><dt>${esc(h)}</dt><dd>${esc(p)}</dd></div>`).join('');

  const body = `<section class="lp-hero"><div class="lp-copy"><h1>${esc(c.h1)}</h1><p class="lp-lead">${esc(c.lead)}</p>
<div class="lp-actions"><a class="lk-btn" href="/m${q}">${esc(c.cta)}</a><a class="lk-btn lk-btn-2" href="#how">${esc(c.how)}</a></div></div>
${example}</section>
<section class="lk-card lp-section" id="how"><h2>${esc(c.stepsTitle)}</h2><ol class="lp-steps">${steps}</ol></section>
<section class="lk-card lp-section"><h2>${esc(c.factsTitle)}</h2><dl class="lp-facts">${facts}</dl></section>
<section class="lp-note"><h2>${esc(c.statusTitle)}</h2><p>${esc(c.status)}</p></section>
<section class="lp-integrations"><h2>${esc(c.integrationsTitle)}</h2><div class="lp-cards">${integrations}</div></section>
<section class="lp-integrations" id="videos"><h2>${esc(c.videosTitle)}</h2><div class="lp-videos">${videos}</div><p class="lk-hint">${esc(c.videosNote)}</p></section>
<section class="lk-card lp-section" id="team"><h2>${esc(c.teamTitle)}</h2><div class="lp-person"><h3>${esc(f.name)}</h3><p class="lk-desc">${esc(f.role)}</p></div><p class="lp-bio">${esc(f.bio)}</p>
<p class="lp-social">${social}</p></section>
<footer class="lp-foot"><a href="${REPO}">${esc(c.source)}</a><a href="${DOCS}">${esc(c.docs)}</a><span>${esc(c.licence)}</span></footer>`;

  return layout(lang, c.title, body, [], top).replace('<main class="lk">', '<main class="lk lp">');
}
