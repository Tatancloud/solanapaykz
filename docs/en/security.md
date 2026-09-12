---
layout: en
title: Security
lang: en
alt: /security
altlabel: Русский
---

# Security

This page is for the merchant who wants to understand what can be trusted,
and for the developer who wants to understand exactly what the code checks
before treating an order as paid.

## Private keys are never requested

No component of SolanaPay-KZ — not the WooCommerce plugin, not the server
for Tilda, not the `@solanapaykz/core` library — creates, stores, or
requests a private key or a seed phrase. Not the merchant's, and not the
buyer's.

This isn't a promise, it's a consequence of how accepting payments works.
All the system needs to accept money is the merchant's public wallet
address (the same one you'd give someone to have money sent to you the
ordinary way) and a random tag (`reference`) for finding the payment on the
blockchain — 32 random bytes formatted as a Solana address, for which no
key pair is ever generated or exists. Neither receiving the money nor
verifying its arrival requires signing anything on anyone's behalf — and
since it isn't required, there's nowhere a private key could even be used.

<div class="важно">
If someone — in a chat, in support, anywhere — asks you to enter a secret
phrase or a wallet's private key "to set up accepting payments," that is a
scammer. No such step exists anywhere in the project.
</div>

## Money goes straight through

The transfer happens from the buyer's wallet to the merchant's wallet in a
single transaction on the Solana blockchain. Neither this project, nor its
code, nor the server for Tilda stands between them as a recipient or an
intermediary for the money — they cannot accept a payment to their own
address instead of the merchant's, hold it, or redirect it. The code's role
is always the same: compute the amount from the exchange rate, show the
buyer a QR code, and **verify after the fact** that a transfer which has
already happened on the blockchain matches the order.

## What exactly gets checked in a transaction

When the code searches for a payment by its reference and decides whether
to accept it, five things are checked at once:

| Checked | Why |
|---|---|
| **Recipient** | the transfer must go to the merchant address recorded on the order — otherwise it's someone else's payment that happened to land under the same reference |
| **Amount** | the amount transferred must be at least the quoted amount (an overpayment passes the check, an underpayment doesn't) |
| **Coin** | the transfer must be in the token specified on the order (USDC or SOL) — a payment in a different token isn't accepted as payment for this order |
| **Reference** | this is what lets the transaction be found among all transfers on the blockchain in the first place — without the reference there's nothing to check the recipient, amount, and coin against |
| **No error in the transaction** (`meta.err === null`) | Solana records failed transactions on-chain too — a record existing doesn't by itself mean the transfer went through |
| **`finalized` commitment level** | the most reliable one available on Solana; the faster but less reliable levels (`confirmed`, `processed`) are deliberately not used, because for the irreversible decision "the order is paid," speed is never worth trading for reliability |

The actual verification is delegated to the `@solana/pay` library
(`validateTransfer`) rather than written from scratch: checking an incoming
transaction by hand is exactly the kind of place where it's easiest to
accept someone else's or an incomplete payment by mistake.

## Why an amount mismatch doesn't cancel an order automatically

If a transaction with the right reference is found but fails the check —
wrong recipient, wrong token, or an amount lower than expected — the
system does not automatically treat the order as unpaid and does not
cancel it. This is a state that requires a human decision: the transaction
already exists on the blockchain, the money may already have left the
buyer's account, and that is not the same thing as "the buyer didn't pay."

<div class="важно">
Automation is more expensive to get wrong here than a human is. Cancelling
an order the buyer has already sent money for (even if it didn't match on
a formal criterion) means losing the buyer's trust and possibly money that
no one will get back: transfers on the blockchain are irreversible. That's
why the decision is deliberately left to the merchant, who looks at the
transaction itself, rather than at some automated interpretation of it.
</div>

## Why a network failure doesn't change an order's state

If the Solana node doesn't respond — a timeout, a rate limit, an outage —
this is propagated as an error, not as the outcome of a payment check. The
order stays in its current state. Silence from the network is not an
answer of "there's no money": if an unreachable node were interpreted as
"no payment," orders would get cancelled over real, already-sent money
whenever an RPC provider was overloaded or briefly down.

For the same reason, an exchange rate that couldn't be obtained from any
source doesn't lead to a sale at a stale or made-up value — the order
simply isn't created. Selling at an unknown rate is worse than not
selling.

## What the merchant should do about a disputed payment

1. Find the transaction by its signature (`signature`), which is saved in
   the order note (WooCommerce) or in the order list (`/admin` for the
   Tilda server).
2. Look it up in a public Solana block explorer, or via the RPC itself —
   the recipient, amount, and token can be checked independently of what
   the code decided.
3. Decide based on the transaction's actual contents: accept the payment,
   ask the buyer for the remaining amount, or refund them directly from
   your own wallet, if the transfer arrived but the order is no longer
   valid for some reason.

This decision always belongs to the merchant — no component of the project
can make it automatically, because doing so would require either holding
the money (which it doesn't) or being wrong about irreversible transfers.

## What the project doesn't do

SolanaPay-KZ doesn't take on the role of a payment intermediary — only the
role of a cashier that counts and verifies:

- **Doesn't issue refunds.** Only the merchant can refund the buyer, by a
  transfer from their own wallet — no one else has access to that wallet.
- **Doesn't resolve disputes.** If a payment didn't match or arrived late,
  the decision is the merchant's, not automation's and not the project's
  (see above).
- **Doesn't hold funds.** At no step does money pass through an address
  controlled by the project — only directly from buyer to merchant.
- **Doesn't store and cannot recover private keys** — because it never
  receives them in the first place.

If you need any of the above, that's a separate task for the merchant or a
third-party service, not this system.
