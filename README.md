# SolanaPay-KZ

[Русская версия](README.ru.md) · [Documentation](https://tatancloud.github.io/solanapaykz/)

An open-source toolkit that lets online shops in Kazakhstan accept payment in
**USDC** and **SOL** on Solana while showing prices in **tenge (KZT)**.

**Money moves straight from the buyer's wallet to the merchant's wallet.**
Nothing in this project holds, routes or can freeze the merchant's funds.
Private keys are never requested, created or stored — accepting a payment only
needs a public address.

---

## The problem it solves

A small shop in Kazakhstan that wants to accept stablecoins faces three
obstacles at once:

1. **No direct rate.** No exchange quotes crypto against the tenge except one
   pair. The widely recommended price APIs do not support KZT at all — one of
   them answers a KZT request with HTTP 200 and an empty object, which a naive
   implementation reads as a rate of zero.
2. **No ready integration.** Shop platforms ship card gateways, not wallets.
3. **Custody.** Most crypto payment services take the money first and settle
   later, which is exactly what a small merchant cannot risk.

SolanaPay-KZ answers all three: it computes the rate from the one pair that
exists, ships ready integrations for two platforms, and never touches the
money.

## What is built

| Component | For | Tests | Status |
|---|---|---|---|
| [`@solanapaykz/core`](https://www.npmjs.com/package/@solanapaykz/core) | developers on any platform | 126 | published on npm |
| [WooCommerce plugin](https://tatancloud.github.io/solanapaykz/woocommerce) | WordPress shops | 213 | working |
| [Tilda server](https://tatancloud.github.io/solanapaykz/tilda) | Tilda shops | 310 | working, integration under review by Tilda |

649 automated tests across three languages, plus end-to-end verification with
real payments on Solana devnet.

## How a payment works

```
buyer                     shop                      Solana
  │                        │                          │
  │   places an order  ──> │                          │
  │                        │ rate: Binance USDT/KZT   │
  │                        │ amount frozen for 15 min │
  │  <── QR code / link ── │                          │
  │                                                   │
  │  ─────────── pays directly from own wallet ─────> │
  │                        │                          │
  │                        │ ── checks the chain ──>  │
  │  <── order confirmed ──│                          │
```

The shop never holds the buyer's money and the project never holds the shop's.
The only thing the code does with funds is *look* at them.

## Design decisions worth knowing

These are the choices that cost the most to get wrong, and each is enforced by
tests:

- **Money is integer arithmetic, never floating point.** Amounts are carried as
  strings and computed in the token's minimal units.
- **Rounding is always in the merchant's favour**, to the last digit the coin
  has — six decimals for USDC, nine for SOL.
- **A network failure never changes an order.** If the Solana node is silent,
  the order stays as it was. Silence is not an answer of "no payment".
- **An amount mismatch is never resolved automatically.** A payment that exists
  but does not add up is handed to a human, because blockchain transfers are
  irreversible and automation errs more expensively than a person here.
- **The price is frozen with the order** — amount, recipient, network and
  payment reference — and never recomputed during verification.

## Try it

- **Documentation:** <https://tatancloud.github.io/solanapaykz/>
- **Live WooCommerce demo:** <https://shop.pagafox.kz>

## Repository map

| Path | What it is |
|---|---|
| `src/` | the `@solanapaykz/core` library (TypeScript) |
| `tests/` | its tests |
| `tilda-server/` | payment server for Tilda shops (TypeScript, Node 22) |
| `demo-shop/plugin/` | WooCommerce plugin (PHP 8.1) |
| `demo-shop/` | Docker setup of the demo shop |
| `docs/` | the public documentation site (GitHub Pages) |
| `process/` | how this was built: brief, specifications, plans, code map |

`process/` is unusual for a repository and deliberate: it holds the design
documents, the implementation plans and the review findings that shaped the
code. Anyone judging the engineering can read the reasoning, not just the
result.

## Requirements

- **Own Solana RPC endpoint.** Public nodes are rate-limited and do not keep
  enough history to find a payment reliably. This is a hard requirement, not a
  recommendation.
- PHP 8.1 with the `bcmath` extension for the WooCommerce plugin.
- Node.js 22 for the library and the Tilda server.
- Shop currency must be KZT.

## Licence

MIT — see [LICENSE](LICENSE). Free to read, use and modify, including
commercially.
