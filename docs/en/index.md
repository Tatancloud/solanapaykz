---
layout: en
title: Accepting USDC and SOL payments for shops in Kazakhstan
lang: en
alt: /
altlabel: Русский
---

# SolanaPay-KZ

An open-source toolkit that lets an online shop accept payment in the
**USDC** stablecoin and in **SOL** on the Solana blockchain, while showing
the buyer a price in tenge (KZT).

**Money goes straight from the buyer's wallet to the merchant's wallet.**
Neither this project nor its authors receive, hold, or can freeze your
funds. Private keys are never requested, generated, or stored at any step.

<div class="важно">
<strong>If someone asks you to enter a private key or a seed phrase for a
wallet, that is a scammer.</strong> No part of SolanaPay-KZ does this or can
do this: accepting payments only ever needs a public address.
</div>

## What's included

| Part | For whom | Status |
|---|---|---|
| [WooCommerce plugin](woocommerce) | a shop on WordPress | ready |
| [Server for Tilda](tilda) | a shop on Tilda | ready, integration pending moderation |
| [Library for developers](sdk) | a custom platform | ready |

## How it works

1. The buyer places an order. The shop knows the amount in KZT.
2. The amount is converted into tokens at the exchange rate and **frozen
   for 15 minutes** — so the price doesn't move while the buyer is paying.
3. The buyer is shown a QR code. They pay from their own wallet.
4. The shop checks the payment directly on the blockchain and confirms the
   order.

Nothing stands between steps two and three: the transfer goes wallet to
wallet. Our code only computes the amount and confirms that the money
arrived.

## Why the rate is computed this way

The primary source is the exchange rate for the USDT/KZT pair on Binance,
multiplied by the USDC-to-USDT rate. This is the only direct pair between a
cryptocurrency and KZT that exists.

The fallback source is the official dollar-to-KZT rate, multiplied by the
token's dollar price. It comes out roughly a percent below the exchange
rate, so it's used only when the exchange is unavailable.

CoinGecko, which is usually recommended for this, doesn't support KZT at
all: it answers the request with success and an empty result. A naive
implementation would mistake that emptiness for a zero rate.

## Rounding always favours the merchant

The token amount is rounded **up**, to the last digit the coin supports —
six digits for USDC, nine for SOL. The buyer never pays less than the order
costs; the difference never exceeds one millionth of a dollar.

## What happens if the amount doesn't match

A payment that is found but doesn't match the expected amount is **never
cancelled automatically**. Such an order is flagged as needing review, and
the merchant decides, by looking at the transaction itself. The reason is
simple: automation is more expensive to get wrong here than a human is —
money on the blockchain is irreversible.

The same applies to network outages: if the Solana node doesn't respond,
the order's state doesn't change. Silence from the network is not an
answer of "there's no money."

## Source code

[github.com/Tatancloud/solanapaykz](https://github.com/Tatancloud/solanapaykz)
— MIT licence. The code can be read, used, and modified, including in
commercial projects.
