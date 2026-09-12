---
layout: en
title: Plugin for WooCommerce
lang: en
alt: /woocommerce
altlabel: Русский
---

# Plugin for WooCommerce

A payment method for WordPress/WooCommerce: the buyer sees the order
amount in tenge (KZT), and pays in **USDC** or **SOL** via a QR code
straight from their own wallet. Money goes directly to the merchant's
wallet — the plugin never receives it, never holds it, and can't hold it.

<div class="важно">
The plugin never asks for a private key — neither yours nor the buyer's.
All it knows is the public address of your wallet, the same one you type
into the settings. If someone asks you to enter a secret phrase or a
private key "to set up payments," that is a scammer — no such step exists.
</div>

The plugin doesn't create any tables of its own in the database: everything
it needs to remember about an order lives in ordinary WooCommerce order
meta and travels with it through exports, hosting changes, or a site
migration.

## Before you install

| Requirement | Why exactly this |
|---|---|
| WordPress 6.5+ and WooCommerce (tested on 11.1) | the plugin is a WooCommerce payment method and cannot work without it |
| PHP 8.1+ with the **bcmath** extension | without bcmath, the payment-amount calculation silently loses precision on orders above 92,233.72 ₸. That figure is not arbitrary: it is PHP's maximum integer (9,223,372,036,854,775,807) divided by USDC's six decimal places and the eight digits of rate precision. Above that amount the intermediate product no longer fits in an integer, silently becomes a float and loses its least significant digits — the plugin will refuse to activate on its own if bcmath is missing |
| **Shop currency is KZT** | the exchange rate the plugin uses is quoted against KZT; with any other currency the amount due would be computed wrong, and you likely wouldn't notice until reconciling revenue. So the plugin checks the currency itself and disables the payment method if it isn't KZT — the buyer simply won't see it |
| Your own Solana RPC node | see the section below — without it the plugin can't find payments |
| A Solana wallet to receive payments | for testing without real money, a wallet on the test network (devnet) funded from a faucet will do |

## Installation

1. Upload the plugin archive via **Plugins → Add New → Upload Plugin**, or
   unpack it into `wp-content/plugins/`.
2. Activate the plugin. If the environment is missing a required PHP
   extension, the plugin will refuse to activate and name what's missing —
   this isn't a bug, it's a guard against silently losing precision on
   amounts.
3. Check that the shop's currency is KZT: **WooCommerce → Settings →
   General → Currency**.

## Configuration

**WooCommerce → Settings → Payments → SolanaPay-KZ**:

| Field | What to enter | Why |
|---|---|---|
| Merchant wallet address | The public address of your Solana wallet (base58) | this is not a coin's mint address — a common mistake. The plugin checks for this specifically and won't let you save settings with a mint address instead of a wallet, because a payment sent to such an address would be lost for good |
| Network | Test (devnet) for checking things out, main (mainnet) for real payments | mixing the network in settings with the network of an order that already exists is a configuration error, not a payment error — the plugin doesn't fix it automatically (see "What to do for each order state" below) |
| Solana node address | The URL of your paid RPC provider | see the next section — a public node won't do |
| Coin | USDC (stable rate) or SOL | — |
| Markup, % | an optional percentage added on top of the order amount | a buffer against the rate moving while the buyer is paying |
| Price validity | 15 minutes by default | how long the locked-in rate stays valid; once it expires, the order isn't cancelled automatically if a payment signature is already visible — only a complete absence of payment after expiry leads to cancellation |
| Check cancelled orders | how long after an order is cancelled the plugin keeps looking for a payment | the buyer may have sent the payment before the cancellation, with on-chain confirmation arriving later |

The plugin won't let you save settings under which payment is guaranteed to
fail (a wrong wallet address, an unreachable network, or coin) — after
saving, check the settings page for warnings.

### Where to get a Solana node, and why a public one won't work

The plugin doesn't just need to send a request to the Solana network — it
needs to **find one specific payment** among all transactions by its
reference. Public nodes like `api.mainnet-beta.solana.com` enforce hard
rate limits and don't keep the transaction history that such a search
needs. In practice this means: checking a payment either doesn't work at
all, or only works some of the time.

You need a paid node from a provider (for example, Helius, QuickNode,
Alchemy) — most of them have a free tier that's enough to get a small shop
started. The node address goes into the settings as an ordinary URL, for
example `https://mainnet.helius-rpc.com/?api-key=...`.

### System cron

The plugin re-checks orders in the background on a schedule, in case the
buyer closed the tab right after paying, without waiting for confirmation
in the browser. WordPress's built-in pseudo-cron only fires when a visitor
loads the site: on a low-traffic shop that means the check can lag by
hours. If the site has the `DISABLE_WP_CRON` constant set, the plugin will
show a warning in the admin — set up a real system cron job hitting
`wp-cron.php`, or some payments will be confirmed with a large delay.

## Testing with a test payment

1. Turn on the settings with the network set to **devnet** and the address
   of a devnet-compatible RPC node.
2. Place a test order in the shop, choosing crypto as the payment method.
3. The "Order received" page will show a QR code for the amount converted
   into USDC or SOL.
4. Pay it with a test wallet (Phantom or Solflare, switched to devnet)
   funded from a faucet.
5. The order should move to "Processing" within seconds — either through
   polling from the payment page, or on the background schedule if the tab
   is already closed.

Only after a successful check on devnet does it make sense to switch to
mainnet with a real wallet and a real RPC provider.

## What to do for each order state

The plugin moves an order forward based on the payment check, but some
transitions deliberately require a decision from the merchant — because
money on the blockchain is irreversible, and the cost of an automatic
mistake here is higher than the cost of a delay.

| Order state | What it means | What the merchant should do |
|---|---|---|
| **Awaiting payment** (`pending`) | the price is locked in, no payment is visible yet | nothing — the plugin checks on its own, both by polling from the browser and on schedule |
| **Processing / Completed** | payment found, amount and recipient match | handle the order as usual, same as with any other payment method |
| **Cancelled** | either the price validity period expired with no payment signature at all, or the merchant cancelled the order by hand | if cancelled because the period expired, nothing needs doing; if the buyer claims they paid, check not only this order but also the next state |
| **On hold** (`on-hold`), note about a mismatch | a transaction bearing this order's reference was found on the blockchain, but failed the check — wrong recipient, wrong token, or an amount that's too low | look up the transaction by its signature (in the order note) in a block explorer by hand and decide whether to accept the payment. This does **not** mean "the buyer didn't pay" — the money may already have left their account |
| **On hold**, note about a late payment | the order had already been cancelled, and a confirmed payment to its address arrived anyway afterward (within the cancelled-order check window) | decide: restore the order, or refund the buyer directly — the plugin doesn't make this decision and can't make it |

<div class="важно">
The plugin never cancels an order automatically because of an amount
mismatch, and never changes an order's state when the Solana node is
unreachable. Silence from the network is not an answer of "there's no
money" — automation is more expensive to get wrong here than a human is.
</div>

For more on exactly what's checked in a transaction and why, see the
["Security"](security) page.

## Licence

MIT.
