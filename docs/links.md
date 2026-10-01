# Chat payment links

Payment links priced in Kazakhstani tenge (KZT) that a seller pastes into WhatsApp, Instagram or Telegram. The buyer
pays in USDC or SOL on Solana. The same link works as a Solana Blink. Code: `tilda-server/src/links/`.

## For merchants

1. **Sign up / sign in** at `/m` — either with a 6-digit code sent to your email, or by signing a message with your
   Solana wallet (Phantom, Solflare). No passwords. You can use one or the other.
2. **Settings → receiving wallet.** Paste your Solana wallet address. It must already have a USDC account (receive any
   amount of USDC to it once). The service rejects malformed addresses and token mint addresses. Changing the wallet
   later does not affect invoices you already created — each invoice keeps the wallet it was created with.
3. **Create a link** — amount in tenge, what it is for, token (USDC by default, or SOL). Share the link in the chat.
   An invoice is valid for 7 days by default.
4. **Statuses**
   - `open` — waiting for payment.
   - `paid` — a matching payment was found on-chain.
   - `needs_review` — money arrived but something differs; you decide. Reasons: `late` (paid after the 15-minute
     price lock), `amount` (amount or fee transfer differs), `duplicate` (a second payment for the same invoice).
     Payments are never cancelled automatically.
   - `expired` — not paid within the invoice lifetime. A late payment moves it to `needs_review`.
5. **Fee.** 0.5% of each payment, taken inside the same transaction when the buyer pays with a wallet (one tap or
   Blink). Manual payments from exchanges go to you in full; their 0.5% is recorded as fee owed. When the fee owed in
   a token exceeds the limit (default 20 USDC or 0.15 SOL), new invoices are blocked until you pay it from the dashboard.
6. **Invoices page** — status, link to the transaction in Solana Explorer, CSV export.
7. **Telegram bot** (optional) — Settings → "Link Telegram bot". Then `/invoice 5000 Description` creates a link and
   `/list` shows recent invoices. Paid and needs-review alerts arrive in the chat and by email.

## For buyers

- **One tap:** scan the QR or press "Open in wallet" (Phantom, Solflare, Backpack). The wallet shows one transaction
  for the full amount; confirm it. The price is fixed for 15 minutes.
- **Manually from any wallet or exchange:** open "Pay manually", copy the address and the **exact** amount. Send only
  on the **Solana** network. The recipient must receive exactly that amount — exchanges show their withdrawal fee
  before you confirm; add it on top.

## For operators

### Configuration (`config.json`, section `links`)

| Key | Default | Meaning |
|---|---|---|
| `feeWallet` | — (required) | Public address that receives the 0.5% fee. Must already have a USDC account. |
| `feeBps` | `50` | Fee in basis points (50 = 0.5%), frozen per invoice. Range 0–1000. |
| `invoiceTtlDays` | `7` | Invoice lifetime in days. Range 1–90. |
| `debtLimit` | `{ "USDC": "20", "SOL": "0.15" }` | Fee owed above which new invoices are blocked. |
| `sessionPepper` | — (required) | 16+ random characters; used to hash email codes. |
| `detectIntervalMs` | `10000` | Payment detector interval. Range 1000–600000. |
| `iconUrl` | `/assets/icon.png` | Icon shown by wallets and Blinks. |
| `telegram` | absent | `{ botToken, botUsername, webhookSecret (16+ chars) }`; omit to disable the bot. |

Without the `links` section the server runs only the Tilda integration, as before.

### Network

- Proxy the whole domain to the server (as `tilda-server/nginx.example.conf` does). `actions.json` must be served at
  the domain root for Blinks.
- TLS is required (session cookies are `Secure`).
- Use a paid mainnet RPC provider in `rpcUrl`; public RPC endpoints are rate-limited.
- Telegram webhook:
  `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<host>/tg/<webhookSecret>"`

### Testing

- Unit and HTTP tests: `cd tilda-server && npx vitest run`.
- Devnet end-to-end (pays a real devnet invoice and detects it):
  `DEVNET_PAYER_SECRET=<base58 64-byte secret of a funded devnet key> npx vitest run tests/integration/links-devnet.test.ts`.

## Security

- No private keys anywhere: not the merchant's, not the buyer's, not the service's (the fee wallet is a public address).
  The server only builds unsigned transactions for the buyer's wallet to sign.
- Email codes: 6 digits, stored hashed, valid 10 minutes, 5 attempts, one new code per minute.
- Wallet sign-in: single-use nonce valid 5 minutes, bound to the host; ed25519 signature verified on the server.
- Sessions: random IDs in an httpOnly, Secure, SameSite=Lax cookie, 30 days. Dashboard changes require a CSRF header.
- Rate limits on sign-in (10/min per IP) and transaction building (30/min per IP).
- Every merchant request is scoped to the signed-in merchant.
- The receiving wallet is frozen per invoice.
- CSV export neutralises spreadsheet formulas.
