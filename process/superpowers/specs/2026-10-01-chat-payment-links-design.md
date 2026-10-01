# Chat Payment Links — Design

**Date:** 2026-10-01
**Status:** Draft for review
**Event:** Colosseum "Crypto World's Fair" hackathon (submission deadline 2026-10-12 23:59 PT)
**Builds on:** `@solanapaykz/core` and `tilda-server` (release `v0.1.0`, 2026-09-13 — prior work, see "Prior work boundary")

## 1. Goal

Let a small seller who sells through WhatsApp, Instagram or Telegram send a buyer a **payment link priced in
Kazakhstani tenge (KZT)**. The buyer pays in USDC or SOL on Solana from their own wallet in one tap, or by a manual
transfer from any wallet or exchange. The same link works as a **Solana Blink** in X/Telegram clients that support
Solana Actions. Money goes straight from the buyer's wallet to the seller's own wallet; the service never holds funds
or keys. The service earns a **0.5% fee taken inside the payment transaction**.

Success for the hackathon:
- A seller signs up, creates an invoice, and shares a link in a chat in under a minute.
- A buyer pays it on Solana **mainnet** from Phantom (transaction request with fee split) and from an exchange-style
  manual transfer; the invoice turns `paid` automatically and the seller is notified.
- The same invoice is paid as a Blink (dial.to or a Phantom-rendered Blink).
- Public repo (MIT), English README with a prior-work disclosure, pitch, 3-minute video.

## 2. Prior work boundary

Everything up to tag `v0.1.0` (2026-09-13) — the core SDK, the WooCommerce plugin, the Tilda server — existed before
the hackathon (contest period starts 2026-09-14). Hackathon work is everything after `v0.1.0`. The README gets a
"Prior work disclosure" section linking the compare view `v0.1.0...main`.

New code, comments, UI defaults, docs and commit messages are in **English** (contest rule 12(a)(i)). Existing
Russian-language code in `tilda-server` is left as is.

## 3. Scope

**In scope (MVP):**
1. Multi-merchant accounts: sign-up / sign-in by **email one-time code** or **wallet signature**.
2. Merchant settings: receiving wallet (entered by the merchant), display name, email, Telegram link, language.
3. Invoices created by link: KZT amount, description, expiry; shareable URL `/i/:id`.
4. Public invoice page: KZT price, live token amount, QR + "Open in wallet" deep link (Solana Pay transaction request),
   and a "Pay manually" tab with copyable address and exact amount.
5. Transaction builder: transfer to merchant + 0.5% to service fee wallet + `reference`, shared by the invoice page and
   the Blink.
6. Solana Actions (Blink) for invoices.
7. Payment detection for both modes; invoice states; "needs review" cases.
8. Fee debt for manual payments, repayable from the dashboard; invoice creation blocked above a threshold.
9. Mobile-first merchant dashboard: create invoice, list with status and explorer link, CSV export, fee balance.
10. Telegram bot for merchants: link account, create invoice, list, paid notifications. **First to cut** if behind.
11. UI in English (default) and Russian.

**Out of scope:** settlement in tenge or any fiat off-ramp; a licensed-partner integration; custom on-chain program;
per-merchant WhatsApp bots; mobile apps; currencies other than KZT; refunds; changing the Tilda/WooCommerce paths.

## 4. Legal context and roadmap

Kazakhstan does not allow cryptocurrency to be used as payment for goods and services (banking-law amendments of
December 2025; since 2026-05-01 digital assets are treated as property and operations go through licensed providers).
The legal route for crypto-paid purchases is conversion to tenge by a licensed intermediary; since 2026-07-19 the
National Bank's unified QR accepts crypto wallets with conversion through AIFC exchanges.

Decisions:
- The product lets merchants enter **their own receiving wallets** (as designed). No partner settlement in the MVP.
- The hackathon demo on mainnet uses a team-owned test merchant plus up to two **pilot merchants recruited by the
  team**. The team is responsible for the pilots' legal standing under the rules above (merchants outside Kazakhstan
  or test purchases without a real sale are the low-risk options).
- The submission states this openly. The roadmap's first item is **finding a licensed AIFC partner** to accept
  SOL/USDC on Solana and settle merchants in tenge, aligned with the unified-QR model.

## 5. Architecture

All new code lives inside `tilda-server` (one Node.js process, `node:http`, `node:sqlite`, no web framework), in new
modules beside the existing Tilda path:

```
tilda-server/src/
  merchants/      accounts, sessions, email codes, wallet sign-in
  invoices/       invoice CRUD, quote-on-open, unique manual amounts
  tx/             transaction builder (split transfer + reference + memo)
  actions/        Solana Actions endpoints + actions.json
  detect/         payment detection for transaction-request and manual payments
  fees/           fee ledger, debt, repayment
  bot/            Telegram webhook + commands
  i18n/           en.ts, ru.ts dictionaries
  http/routes-*   new route files for /i, /api/pay, /api/actions, /m, /api/auth, /tg
```

Existing modules reused: `mailer.ts` (email codes, notifications), `log.ts`, HTML helpers and escaping from `html.ts`,
`@solanapaykz/core` for rates (`src/rates`), money arithmetic (`money.ts`) and QR.

The existing Tilda tables and flow (`orders`, `admin_session`, `checker.ts`) are **not modified**. Link invoices use new
tables in the same SQLite file, so existing tests stay valid and prior and hackathon work stay separable.

### Flow

```
Merchant (dashboard / Telegram bot) ── create invoice (KZT, description) ──► invoices row ──► link /i/:id
Buyer opens link (WhatsApp/Instagram page, or Blink in X/Telegram)
  └► quote created or reused: KZT→token at current rate, valid 15 min, own reference + unique manual amount
     ├─ One tap: wallet POSTs /api/pay/:id (or /api/actions/i/:id) with its account
     │     └► transaction builder: merchant 99.5% + service 0.5% + reference + memo → wallet signs and sends
     └─ Manual: buyer copies address + exact amount, sends from any wallet/exchange (single transfer to merchant)
Detector (background loop) ─► finds tx by reference, or incoming transfer with the unique amount
  └► invoice paid / needs_review ─► email + Telegram notification ─► manual payments add 0.5% to fee debt
```

## 6. Data model (new tables)

`merchants` — `id`, `email` (unique, nullable), `wallet_login` (unique, nullable; address that signs in),
`recipient` (receiving wallet, required before creating invoices), `name`, `lang` (`en`|`ru`),
`telegram_chat_id` (nullable), `created_at`.

`auth_codes` — `email`, `code_hash`, `expires_at` (10 min), `attempts`; one active code per email.
`auth_nonces` — `nonce`, `expires_at` (5 min), single use.
`sessions` — `id` (random), `merchant_id`, `expires_at` (30 days); httpOnly, Secure, SameSite=Lax cookie.
`bot_links` — `code` (one-time, 15 min), `merchant_id`.

`invoices` — `id` (random URL-safe), `merchant_id`, `amount_kzt`, `description`, `token` (`USDC`|`SOL`, default USDC),
`recipient` (frozen at creation), `fee_bps` (50, frozen), `state`, `created_at`, `expires_at` (default 7 days),
`paid_at`, `tx_signature`, `paid_mode` (`request`|`manual`), `review_reason`.

`quotes` — `id`, `invoice_id`, `amount_token` (minor units), `fee_token` (minor units), `merchant_token`,
`manual_amount_token` (total + unique offset), `rate`, `rate_source`, `reference` (pubkey), `created_at`,
`expires_at` (15 min).

`fee_ledger` — `id`, `merchant_id`, `token`, `amount` (minor units; positive = accrued, negative = repaid),
`invoice_id` (nullable), `tx_signature` (nullable), `created_at`.

## 7. Money rules

- All amounts are integer minor units (BigInt): USDC 6 decimals, SOL 9 decimals, KZT 2 decimals.
- Quote: `total = convert(amount_kzt, rate)` rounded **up** to the token's minor unit (buyer never underpays).
- Fee: `fee = floor(total × fee_bps / 10000)`; `merchant = total − fee` (rounding favours the merchant).
- Manual amount: `total + offset`, where `offset ∈ [1, 9999]` minor units, unique among this merchant's unexpired
  quotes; the offset is part of the merchant's revenue.
- Fee debt (manual payments): `floor(total × fee_bps / 10000)` accrued in the paid token.
- Debt threshold: invoice creation is blocked while the merchant's debt in any token exceeds that token's limit
  from config (`debtLimit`, default `USDC: "20"`, `SOL: "0.15"`).

## 8. Invoice states

`open` → `paid` | `needs_review` | `expired`.

- `paid`: a matching transaction was found (request mode: both transfers exact; manual mode: exact unique amount to
  the merchant within the quote's validity).
- `needs_review` (never auto-cancelled; the merchant decides): payment found after the quote expired; amount differs;
  request-mode transaction without the fee transfer; a second payment for an already paid invoice.
- `expired`: no payment by `expires_at`. A late payment on an expired invoice moves it to `needs_review`.
- A quote expiring does not change the invoice; the page fetches a new quote.

## 9. Interfaces

Public:
- `GET /i/:id` — invoice page (EN/RU switch): KZT amount, token amount, QR (Solana Pay transaction-request URL
  `solana:https://<host>/api/pay/:id`), "Open in wallet" deep link, "Pay manually" tab: network **Solana** warning,
  merchant address + copy, exact amount + copy, quote countdown, hint "the amount received must equal this amount —
  exchanges show the withdrawal fee before you confirm". Polls status.
- `GET /api/pay/:id` → `{ label, icon }`; `POST /api/pay/:id` `{ account }` → `{ transaction, message }` (Solana Pay
  transaction request spec).
- `GET /actions.json` → rules mapping `/i/*` to `/api/actions/i/*`.
- `GET /api/actions/i/:id` → Action metadata (title, description with KZT and token amount, icon, label "Pay");
  `POST /api/actions/i/:id` `{ account }` → `{ transaction, message }`. Required CORS and `X-Action-Version` /
  `X-Blockchain-Ids` headers on all Action responses.
- `GET /api/invoices/:id/status` → `{ state, paidAt, txSignature }`.

Merchant (session required, every query scoped by `merchant_id`):
- `POST /api/auth/email/start` `{ email }`, `POST /api/auth/email/verify` `{ email, code }`.
- `POST /api/auth/wallet/nonce`, `POST /api/auth/wallet/verify` `{ address, nonce, signature }` (ed25519 via
  `node:crypto`; message states domain, nonce and purpose).
- `GET /m` dashboard; `/m/new` create invoice; `/m/invoices` list; `/m/invoices.csv`; `/m/settings`; `/m/fees`.
- `POST /api/merchant/invoices`, `GET /api/merchant/invoices`, `PUT /api/merchant/settings`.
- `POST /api/merchant/fees/repay` → returns a transaction-request URL paying the debt to the fee wallet.

Telegram (`POST /tg/<secret-path>` webhook): `/start <code>` links the chat; `/invoice <amount> <description>`;
`/list`; paid/needs-review notifications. Bot language follows the merchant's `lang`.

## 10. Transaction builder

Input: invoice, quote, buyer account. Output: unsigned versioned transaction (base64), fee payer = buyer, recent
blockhash. No compute-unit price instruction in the MVP (avoids an extra dependency; fees are already low).

USDC: `transferChecked` buyer ATA → merchant ATA (`merchant_token`), `transferChecked` buyer ATA → fee wallet ATA
(`fee_token`), `reference` as a read-only non-signer key on the first transfer, memo `inv:<id>`.
SOL: two `SystemProgram.transfer` instructions, same reference and memo.

Merchant and fee-wallet USDC accounts must already exist; the settings page checks the merchant's ATA and explains how
to create it. The builder never creates accounts for others at the buyer's expense. Built with `@solana/kit`
(already a dependency of the core SDK).

## 11. Payment detection

Background loop every 10 s over invoices `open` (and `expired` for 24 h, to catch late payments):
- Request mode: `getSignaturesForAddress(reference)` per active quote → fetch transaction → validate both transfers
  (recipient, mint, exact amounts) → `paid`, otherwise `needs_review`.
- Manual mode: per merchant with open invoices, scan new signatures for the merchant's USDC token account (for SOL: the
  merchant's wallet address) since the last checkpoint → match incoming transfers by exact `manual_amount_token` of an active quote → `paid` (`paid_mode=manual`),
  accrue fee debt; match outside validity → `needs_review`.
- Fee repayments: detected by reference like request mode, written to `fee_ledger` as negative entries.
- RPC: a paid provider (Helius free tier) configured in `config.json`; backoff on rate limits.

## 12. Security

- No private keys anywhere: not the merchant's, the buyer's, or the service's (the fee wallet is a public address).
- Email codes: 6 digits, stored hashed, 10-minute expiry, 5 attempts, rate-limited per email and IP.
- Wallet sign-in: single-use nonce bound to the domain; signature verified server-side.
- Sessions: random IDs, httpOnly/Secure/SameSite=Lax cookies; CSRF token on dashboard forms.
- Recipient entry: base58 and on-curve validation, reject known mint addresses, show the address large for
  confirmation; changing it does not affect existing invoices (recipient frozen per invoice).
- Rate limits on invoice creation, auth endpoints and transaction building.
- Telegram webhook path contains a secret; bot linking uses one-time codes.
- All HTML output escaped with the existing helpers.

## 13. i18n

Two dictionaries (`en`, `ru`), no library. Invoice page: `?lang=` override, otherwise `Accept-Language`, default
English. Dashboard: merchant `lang`. Bot: merchant `lang`, initially from Telegram `language_code`.

## 14. Testing

- Unit (vitest, existing setup): fee/rounding math, unique offsets, transaction builder output (decode and assert
  instructions), transfer validation, state transitions, email code and nonce lifecycle, tenant isolation (merchant A
  cannot read or create for merchant B), CSV, i18n completeness (same keys in both dictionaries).
- Integration (devnet, existing `vitest.integration.config.ts`): create invoice → pay via transaction request with a
  funded devnet keypair → detector marks `paid`; manual transfer with the unique amount → `paid` and fee debt accrued.
- Existing core and Tilda tests must stay green.
- Manual mainnet check before submission: Phantom payment, exchange-style manual transfer, Blink on dial.to.

## 15. Schedule (2026-10-01 → 2026-10-12)

| Days | Work | Demo outcome |
|---|---|---|
| 1–2 | merchants, email and wallet sign-in, sessions, settings | Merchant can sign up |
| 3–4 | invoices, quotes, transaction builder, invoice page (QR, deep link, manual tab), i18n | Pay from WhatsApp link on devnet |
| 5 | detection for both modes, states, needs_review, fee debt, notifications | Invoice turns paid by itself |
| 6 | Solana Actions / Blink | Same invoice paid as a Blink |
| 7 | dashboard list, CSV, fee repayment | Merchant dashboard |
| 8 | Telegram bot (cut first if behind) | Invoice from the bot |
| 9 | mainnet config, deploy to solanapaykz.site, team test merchant + pilot merchants, real transactions | Explorer links |
| 10–11 | English README + prior-work disclosure + legal note + roadmap, pitch, 3-min video | Submission materials |
| 12 | buffer, submit before 23:59 PT | Submitted |

Cut order if behind: Telegram bot → CSV export → fee repayment UI (keep ledger) → SOL support (keep USDC).

## 16. Deployment

Same host as before (93.171.162.30), Docker Compose service from `tilda-server/Dockerfile`, domain
`solanapaykz.site` (DNS already served by the host's BIND). The host owner sets up the nginx site and TLS certificate
(root access). `actions.json` must be served at the domain root.

## 17. Risks

- Legal (section 4): stated openly; roadmap item 1 is the licensed partner.
- Blink unfurling in X requires registration in the Dialect registry, which may not complete in time — demo on dial.to.
- Buyers need USDC/SOL on Solana; the manual tab widens reach to exchange balances.
- Exchanges may deduct withdrawal fees from the sent amount — handled by the hint and `needs_review`.
- Mainnet RPC rate limits — paid-provider free tier, backoff.
- `node:sqlite` is experimental in Node 22 — already used by `tilda-server`; keep the pinned image.

## 18. Submission deliverables

English README (product, quick start, architecture, security, prior-work disclosure, legal note, roadmap), live demo
at `solanapaykz.site`, mainnet transaction links, pitch deck, 3-minute video, business model: 0.5% on-chain fee vs
1–2% for incumbent payment-link providers.
