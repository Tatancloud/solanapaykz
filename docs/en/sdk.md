---
layout: en
title: Library for developers
lang: en
alt: /sdk
altlabel: Русский
---

# Library for developers

`@solanapaykz/core` is a TypeScript package for accepting USDC/SOL payments
on the Solana network, with automatic conversion from tenge (KZT) at the
current exchange rate. It's isomorphic code: it works in both Node.js
20.18+ and the browser, depending only on the global `fetch`.

## Who this library is for

For those who have their **own platform** — not WordPress and not Tilda.
If the shop runs on WooCommerce, it needs the [ready-made
plugin](woocommerce); if on Tilda, the [ready-made server](tilda). This
library is for a developer writing their own backend or their own
integration, who wants just the arithmetic and the payment check, without
the library deciding for them where to store orders or how to show a QR
code on the page.

The SDK covers three steps of accepting a payment: quote, payment request,
and verification. It is **not** responsible for storing orders, showing a
QR code on the page, or handling webhooks/polling — that's the
integration's job.

## Installation

```bash
npm install @solanapaykz/core
```

The package already pins exact versions of `@solana/pay` and `@solana/kit`
— there's no need to change them by hand (and `@solana/kit@8` must not be
installed: `@solana/pay` requires `^6.4.0`).

## Quick start

The full path is four steps. `orderId`, `saveOrder`, and `markOrderPaid` in
the example are not part of the SDK — they're functions from your own
integration; here they only illustrate where to pass the `reference` from
step 3.

```ts
import { SolanaPayKZ } from '@solanapaykz/core';

const sdk = new SolanaPayKZ({
  recipient: '<YOUR_SOLANA_ADDRESS>', // the merchant's WALLET address — NOT a coin's mint address.
                                       // A mistake here is irreversible: whoever controls the
                                       // USDC/SOL mint address, not your wallet, gets the payments,
                                       // and there's no getting them back.
  rpcUrl: process.env.SOLANA_RPC_URL!, // your own RPC provider, see the section below
  cluster: 'mainnet',
});

// Step 1. Quote: amount in KZT → amount in tokens. The rate is frozen
// for 15 minutes — see "Rate-drift risk" below.
const quote = await sdk.createQuote({ amountKzt: '10000', token: 'USDC' });
// quote.amountToken — the amount in USDC as a string, e.g. "21.758051"

// Step 2. Payment request: a Solana Pay link (solana:...) and an SVG QR code.
const request = await sdk.createPaymentRequest(quote, {
  label: 'Example Shop',
  message: `Order #${orderId}`,
});

// Step 3. Save request.reference together with the order — mandatory, see
// "Payment reference" below. Show the buyer request.qrSvg (or the
// request.url link, to jump straight into a wallet).
await saveOrder({
  orderId,
  reference: request.reference,
  quoteId: quote.quoteId,
});

// Step 4. Verification — called later: on a timer, when the buyer returns
// to the site, from a cron job, and so on. Can be called repeatedly.
const status = await sdk.checkPayment({ reference: request.reference, quote });

switch (status.status) {
  case 'pending':
    // Payment hasn't arrived yet. Check again later.
    break;
  case 'expired':
    // The quote expired and payment never arrived. You need to issue a new
    // quote and a new payment request — the old reference can't be reused,
    // see the warning about reference uniqueness.
    break;
  case 'confirmed':
    // status.signature — the transaction's signature on Solana.
    // status.amountPaid — the quoted amount, confirmed as received
    // (at least this much — see "What amountPaid means" below).
    await markOrderPaid(orderId, status.signature);
    break;
  case 'mismatch':
    // A transaction with this reference was found, but failed the check —
    // wrong recipient, wrong token, or an amount that's too low.
    // status.reason is text for logs, not for showing the buyer. This does
    // NOT mean "there's no money" — the money may already be gone. Look at
    // status.signature by hand before treating the order as unpaid.
    break;
}
```

## `SolanaPayKZ` constructor parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `recipient` | `string` | yes | — | The merchant's Solana address that payments should arrive at. |
| `rpcUrl` | `string` | **yes** | no default value | The address of the Solana RPC node. A public node won't do, see below. |
| `cluster` | `'mainnet' \| 'devnet'` | yes | — | The network cluster: determines the token mint addresses. |
| `markupPercent` | `number` | no | `0` | Merchant markup as a percentage (0–100, in steps of 0.01 pp), applied to the KZT amount before conversion. |
| `quoteTtlMs` | `number` | no | `900000` (15 minutes) | The quote's lifetime in milliseconds. |

## `createPaymentRequest` parameters

The second argument is `CreatePaymentRequestOptions`. `recipient` is not
part of it: the recipient address is already fixed in the constructor and
can't be overridden for an individual request.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `label` | `string` | no | — | The shop/recipient name — shown by the buyer's wallet. |
| `message` | `string` | no | — | A note about the payment (e.g. an order number) — shown by the wallet. |
| `memo` | `string` | no | — | Written into the Solana transaction itself (a memo instruction) — part of the on-chain history, not just the wallet's UI. |
| `qrSize` | `number` | no | `320` | The QR code's size in pixels. |

## Payment reference — the only thing your storage must keep

Every payment request gets a `reference` — a random tag that the
blockchain search uses to find the transaction.

<div class="важно">
Save the <code>reference</code> together with the order. Without it there
is no way to find the payment belonging to a specific order — the
blockchain doesn't know about orders, only about transfers carrying a tag.

The reference must be unique for every payment attempt. The search returns
the oldest transaction bearing a given reference. If the buyer's first
attempt fails and you reuse the same reference for a retry, verification
will forever find that first, failed transaction — a new, valid payment
will stay invisible to <code>checkPayment</code>. The practical
consequence: a new <code>createPaymentRequest</code> for every payment
attempt, even for the same order and the same quote.
</div>

## Mandatory requirements for the Solana node

`rpcUrl` has no default value and is required in the constructor. A public
node (`api.mainnet-beta.solana.com` and similar) is hard rate-limited and
doesn't keep enough transaction history for a search by reference —
`checkPayment` will be unreliable or unavailable on it. Production needs
your own RPC provider (Helius, QuickNode, Triton, and the like); for
development, a public devnet node will do.

## Quote format and rate-drift risk

A quote freezes the rate for `quoteTtlMs` (15 minutes by default) — exactly
how long the amount in the QR code stays valid. Until the buyer pays, the
market rate can drift slightly from the one that was locked in, and the
merchant bears that difference.

A measurement of the `USDT/KZT` pair on Binance (288 five-minute candles
over a day) shows: the typical move in the rate within five minutes is
close to zero (median 0.000%), the 95th percentile is 0.065%, and the
maximum over a day is 0.92%. The risk over the span of a single payment
attempt is usually negligible, but not zero — factor this in when choosing
`quoteTtlMs` and the markup.

The SDK queries rate sources in order and takes the first successful
answer:

| Priority | Source | How it's computed |
|---|---|---|
| Primary | Binance | `USDTKZT × USDCUSDT` (or `× SOLUSDT` for SOL) |
| Fallback | synthetic | the USD/KZT rate (open.er-api.com) × the token's USD price (CoinGecko) |

CoinGecko doesn't support KZT at all: the request answers with HTTP 200
and an empty object, meaning the failure happens silently rather than as
an explicit error. Because of this, the KZT value for the fallback path
is fetched separately from a currency-rate provider, and the SDK treats
such an empty response as a source failure, not as a zero rate. The
fallback rate refreshes once a day and, at the moment of a Binance outage,
can differ from the exchange rate by roughly a percent.

The order of sources is fixed inside the SDK and is not configurable
through the public API — `RateProvider`, `BinanceRateSource`,
`SyntheticRateSource`, and the `RateSource` type are deliberately not
exported from the package, so that no one can assemble a rate provider with
a different source order that bypasses `SolanaPayKZ`.

## Verifying a payment

`checkPayment` returns one of four statuses:

| Status | Fields | When |
|---|---|---|
| `pending` | — | No transaction with this reference has been found yet, and the quote hasn't expired. |
| `expired` | — | No transaction found, and the quote has already expired. |
| `confirmed` | `signature`, `amountPaid` | A transaction was found and passed the check for recipient, token, and amount. |
| `mismatch` | `signature`, `reason` | A transaction was found, but failed the check — wrong recipient, wrong token, or an amount that's too low. |

Confirmation is checked at the `finalized` commitment level — the most
reliable one available on Solana; the faster but less reliable levels
(`confirmed`, `processed`) are not used by the SDK.

A payment that arrives after the quote has already expired (`expired` at
the time of the check) can still be found and confirmed on a later call —
a blockchain transaction is irreversible. Whether to accept such a payment
for the order or not is a decision for your integration; the SDK doesn't
make it.

<div class="важно">
A <code>mismatch</code> status is not the same thing as "the buyer didn't
pay." A transaction with this reference was found on the blockchain — the
money may already have left the buyer's account; the check simply didn't
match on a formal criterion. On seeing <code>mismatch</code>, don't
automatically treat the order as unpaid — look at the transaction via
<code>status.signature</code> by hand and decide what to do with it before
telling the buyer about a payment error or creating a new payment request.
</div>

### What `amountPaid` means

On a `confirmed` status, the `amountPaid` field is the quoted amount,
confirmed as received **at least** in that amount — not the exact amount
actually transferred. The check (via `validateTransfer` from
`@solana/pay`) verifies the condition "at least the expected amount was
transferred" — an overpayment also passes. If the actual amount received
matters to you, look it up in the transaction itself via
`status.signature`, not in `amountPaid`.

## Error handling

Besides the regular `PaymentStatus` statuses, SDK methods can throw
exceptions. All of them inherit from `SolanaPayKzError`.

| Method | What it can throw | When |
|---|---|---|
| `createQuote` | `ConfigError` | Invalid input (amount, token/cluster, TTL) — before any network request. |
| `createQuote` | `RateUnavailableError` | No rate source responded. |
| `createPaymentRequest` | `ConfigError` | The quote is malformed, or `recipient` is invalid. |
| `createPaymentRequest` | `QuoteExpiredError` | The quote has already expired — a new one needs to be issued. |
| `checkPayment` | `ConfigError` | The quote is malformed, `recipient`/`reference` are invalid, or the quote's cluster doesn't match the client's cluster. |
| `checkPayment` | RPC-client / network errors | **Propagated as-is, unwrapped.** An RPC node failure is not a `mismatch` and not a `pending` — it's an exception: a temporary network failure shouldn't look like the outcome of a payment check. Wrap the call in `try/catch` and plan for retries. |

The `new SolanaPayKZ(...)` constructor also throws `ConfigError`
synchronously for an invalid `recipient` or `rpcUrl` — it's worth checking
for this right when the client is created, not only on the first call.

## Private keys

The SDK never creates, stores, or requests private keys, for either the
merchant or the buyer. The payment reference (`reference`) is 32 random
bytes formatted as a Solana address; no key pair is ever generated or
exists for it. Verifying a payment only reads public blockchain data (via
RPC); the SDK cannot and does not attempt to sign or send transactions on
anyone's behalf.

For more on exactly what's checked in a transaction, and what happens on
an amount mismatch or a network failure, see the
["Security"](security) page.

## Compatibility

Node.js 20.18+ and the browser. The only runtime dependency that needs the
network is the global `fetch`; older Node environments without built-in
`fetch` will need a polyfill.

QR generation (`createPaymentRequest`) only asks the `qrcode` library for
SVG. Bundlers (webpack, Vite/Rollup, esbuild) targeting the browser
respect that library's `"browser"` field in `package.json` by default and
use its browser build, which doesn't reference `fs` — no special
configuration is needed on your side. The issue could, in theory, only
show up with a non-standard build configuration that explicitly disables
respecting the `browser` field.

## Licence

MIT — [github.com/Tatancloud/solanapaykz](https://github.com/Tatancloud/solanapaykz).
