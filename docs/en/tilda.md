---
layout: en
title: Server for Tilda
lang: en
alt: /tilda
altlabel: Русский
---

# Server for Tilda

Accepts payment in **USDC** or **SOL** on Solana for an order placed on a
site built on the Tilda platform, converting the amount from tenge (KZT).
Money goes directly from the buyer's wallet to the merchant's wallet — the
server never holds it or forwards it.

<div class="важно">
The server never asks for private keys — neither yours nor the buyer's. All
it needs to work is the PUBLIC address of the receiving wallet — the same
one you'd normally give someone to have money sent to you. If someone asks
you to enter a secret (seed) phrase or a private key "to set up accepting
payments," that is a scammer — no such step exists.
</div>

## Why a server is needed here at all

Tilda has no backend of its own that a merchant could run themselves, and
Tilda's own API is read-only — it doesn't let outside code mark an order as
paid on its own. The only way to tell Tilda "this order is paid" is to send
a POST request with a valid signature to the address Tilda itself hands
out after you set up the integration.

So something needs to accept the order from Tilda, work out the amount in
tokens, show the buyer a QR code, verify the payment on the blockchain, and
send that notification back. That's the server's role — it mediates the
**notification**, not the **payment**. The distinction matters: the
transfer still goes directly from the buyer's wallet to the merchant's
wallet; the server only reports to Tilda a fact that has already happened
on the blockchain.

## What the merchant needs before starting

1. **Your own Solana RPC node.** A public node
   (`https://api.devnet.solana.com`) is fine for testing, but it's
   unreliable and hard rate-limited for production use. On mainnet you need
   a paid RPC provider (Helius, QuickNode, Triton, and similar).
2. **A receiving wallet** — a public address (base58) that payments will
   arrive at.
3. **Shop currency is KZT.** The server only understands KZT: orders in
   any other currency are rejected.
4. Mail (SMTP) for the server to send notifications about new and expired
   orders.
5. A server or virtual machine with Docker and a domain (or subdomain)
   that already has a TLS certificate issued for it.

## Deployment

The server runs as a separate Docker container, sharing neither network
nor volumes with any other services on the same host.

```bash
cd tilda-server

# 1. Settings — your own file, based on the example. config.json is in
#    .gitignore and never goes into the repository.
cp config.example.json config.json
# fill in config.json (see the table below)
chmod 600 config.json   # only the file's owner can read it

# 2. nginx — from the example, for your own domain.
sudo cp nginx.example.conf /etc/nginx/sites-available/your-domain
sudo ln -s /etc/nginx/sites-available/your-domain /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 3. Certificate.
sudo certbot --nginx -d your-domain

# 4. Build and run.
docker compose up -d --build
docker compose logs -f
```

The server's port is published externally **only on the host's
`127.0.0.1`** (`ports: "127.0.0.1:8081:8081"` in `docker-compose.yml`) — from
the outside it's only reachable through nginx, which already has a
certificate issued. Because of this, the login-attempt counter for
`/admin` only trusts the `X-Forwarded-For` header from addresses listed in
`config.json` → `trustedProxyAddresses`, and a request from nginx to the
process inside Docker's bridge network arrives from that subnet's gateway
address, not from `127.0.0.1`. The example settings already have that
address filled in (`172.21.0.1` for the `172.21.0.0/24` subnet) — if you
change the subnet in `docker-compose.yml`, change this too.

<div class="важно">
If you're updating a server that's already running, whose order database
was set up back when it ran as root: change the volume's owner BEFORE
restarting with the new image (the current `Dockerfile` runs the process as
the unprivileged `node` user), or the process won't be able to write to its
own database:

```bash
docker compose stop tilda-server
docker run --rm -v tilda-server_tilda_data:/data alpine chown -R 1000:1000 /data
docker compose up -d --build
```
</div>

## Filling in config.json

The full list of fields is in `config.example.json` (with a comment on
each field). Here's what's easy to mix up:

| Field | What goes there |
|---|---|
| `recipient` | the public address of the receiving wallet (not a private key!). The server will refuse to start if this is a known Solana system address or an address made of one repeated character — a payment to such an address would be lost for good |
| `rpcUrl` | the address of the Solana node, must be `https://` |
| `cluster` | `devnet` for testing, `mainnet` for production |
| `orderSecret` | the secret used to verify the order's signature — make it up yourself, at least 8 characters, and enter the same value in Tilda's integration settings |
| `notifySecret` | a SEPARATE secret for signing notifications — not the same as `orderSecret`. The server will refuse to start if they match |
| `tildaNotifyUrl` | the address that Tilda ITSELF shows you after you save the integration — see the next section |
| `publicUrl` | this server's own public address, for example `https://pay.your-domain.kz` |
| `successUrl` / `failureUrl` | optional URLs for returning the buyer to Tilda: a "thank you" page and a failure page. Without them the buyer stays on this server's own result page. Don't confuse these with Tilda's form fields `success_url`/`failure_url` (see the table below) — those aren't signed and aren't used for redirection |
| `adminPassword` | the password for logging into the order list (`/admin`) |
| `merchantEmail` | where to send order notification emails |
| `trustedProxyAddresses` | addresses that are trusted to set the `X-Forwarded-For` header for `/admin` — loopback only by default; when deploying via docker-compose, add the bridge network's gateway address |

Secrets (`orderSecret`, `notifySecret`, `adminPassword`, `smtp.pass`) can be
generated with, for example, the command `openssl rand -hex 24`.

## Setting up the integration in the Tilda dashboard

In the Tilda dashboard: **Site Settings → Payment Systems → Universal
Payment System → New Payment System (for developers)**.

### Addresses

| Tilda form field | Value |
|---|---|
| Name | `SolanaPay-KZ` (or your own) |
| API URL | `https://your-server/tilda/pay` |
| Test API URL | the same address — test mode is distinguished by the `test_mode` field in the request body |
| Currency | `KZT` |

This form has no field of its own for a "notification URL" — the address
Tilda will send its payment notification to is assigned by Tilda itself and
shown to you **after** you save the integration. Copy the address it shows
into `config.json` → `tildaNotifyUrl` and restart the server
(`docker compose restart`).

### Field mapping list

We choose the parameter names ourselves — enter them exactly as shown, in
lowercase, with underscores:

| Field role (per Tilda) | Parameter name |
|---|---|
| Order number | `order_id` |
| Amount | `amount` — in KZT (whole units, not tıyn) |
| Currency | `currency` |
| Timestamp | `timestamp` — Unix time (seconds) |
| Test mode | `test_mode` — `1/0` |
| Order description | `description` (up to 255 characters) |
| Cart contents | `products` — a JSON array (not base64) |
| Buyer email / phone / name | `email` / `phone` / `customer_name` |
| Success / failure page | `success_url` / `failure_url` — the server accepts them but doesn't use them for redirection (they aren't signed); specify the return address separately in `config.json` |
| Notification URL (if Tilda includes it in the order) | `notify_url` — the server only compares it against `config.tildaNotifyUrl` and logs a mismatch |
| Signature | `signature` |

The `login`, `lang`, `country`, and `receipt` fields aren't used by this
server — you can leave them at whatever Tilda suggests by default.

### Signature — separately for the order and for the notification

This is configured twice: once for the order (secret `orderSecret`), and
once for the notification (the "use the same rules" checkbox must be
**turned off**, with its own separate `notifySecret`). The strings to sign
differ by a role label:

```
order|{{order_id}}|{{amount}}|{{currency}}|{{timestamp}}|{{test_mode}}
```
```
notify|{{order_id}}|{{amount}}|{{currency}}|{{timestamp}}|{{test_mode}}
```

<div class="важно">
The role label (<code>order</code> / <code>notify</code>) is mandatory,
even when the secrets differ. Without it, if the secrets ever matched by
accident, a signed order — which Tilda sends through the buyer's browser —
would become a ready-made payment notification, needing only
<code>status=paid</code> appended. The label makes the two signatures
different regardless of the secrets — it is a second, independent line of
defense on top of the rule against <code>orderSecret</code> and
<code>notifySecret</code> matching.
</div>

The rest of the rule's settings:

- **Type:** "Custom rules."
- **Exclude empty-value fields:** **turned off** — our side treats an
  empty field as an empty string between the delimiters, not as a reason
  to shift the remaining fields; if Tilda strips empty fields out entirely,
  the delimiters will drift and the signature will stop matching.
- **Algorithm:** SHA-256.
- **Use the secret as the HMAC key:** **turned on** — mandatory, otherwise
  the secret ends up in the string as plain text rather than as the HMAC
  key, and verification won't accept such a signature.
- **Secret** should not be added as either the first or last element of the
  string — it's already used as the HMAC key.
- **Convert to uppercase:** off.
- **Encode the final signature as base64:** off — a hexadecimal encoding is
  used.

### Response to the notification

| Tilda form field | Value |
|---|---|
| Success-flag field | `status` |
| Success-flag value | `paid` |
| Transaction number field | `transaction` |
| Response on success | `OK` |
| Response on error | `ERROR` |
| JSON format | off |

## Fallback entry point via a form webhook

While the "New Payment System" application hasn't yet been approved by a
Tilda moderator (or if the integration is unavailable for some other
reason), you can accept orders through an ordinary form on the site and its
webhook — `POST /tilda/webhook`.

This entry point is **disabled by default**
(`config.json` → `"enableFormWebhook": false`). Turn it on explicitly only
if you genuinely need it: a merchant who already has an approved payment
integration doesn't need an extra unsigned entry point.

1. In the site's form settings: **Forms → Webhook**, address —
   `https://your-server/tilda/webhook`.
2. The most reliable way to pass the amount is to add your own field to
   the form, with the variable name **`Payment`**, where the buyer (or a
   script on the page) puts the order amount in KZT.
3. Right after you save the address, Tilda will send a verification
   request (`test=test`) — the server responds to it with `200`
   immediately.
4. The request's number is stored in the database with a `form:` prefix —
   a separate numbering space from the payment integration, so that a
   request from this entry point doesn't accidentally claim the number of
   a future order from the main entry point.

<div class="важно">
The limitations of the fallback entry point — stated plainly, not glossed
over:

- There's nothing to prove that a request genuinely came from Tilda rather
  than from someone who learned the webhook address. The only safeguard is
  that the address is never published anywhere except the form settings in
  the dashboard.
- There's no way to notify Tilda about payment — there's nothing to sign
  such a notification with. The order in Tilda itself will stay marked
  "not paid": the merchant tracks payment through this server's order list
  (<code>/admin</code>), not through Tilda's status.
- Tilda's ordinary form has no documented amount field — the server tries
  several likely variants in turn, and this parsing **has not been
  verified against a real Tilda submission**, only against assumptions
  about the format. The first real submission is worth checking carefully
  against the order list and the server log (<code>docker compose
  logs</code>).
- Use it as a temporary measure, not as a replacement for an approved
  integration.
</div>

## Testing with a test payment

1. `GET https://your-server/admin` — should ask for a password (a login
   form), not show the order list.
2. `POST https://your-server/tilda/pay` without a `signature` field —
   should respond with `400`.
3. In the Tilda dashboard, after saving the integration — place a test
   order (or submit the test form, if you're using the fallback entry
   point). Open the returned link `/pay/<token>`, pay via QR with a wallet
   on the test network (with `cluster: "devnet"` in `config.json`), and
   confirm the order reaches the "paid" state (list at `/admin`), that an
   email is sent to the merchant, and — after a successful notification —
   the "notified" state (for the main entry point; the fallback entry point
   never goes further than "paid").

For testing without a real Tilda, the repository includes
`tools/fake-tilda.ts` — an independent implementation of the protocol that
can place a signed order against the server and receive its notification,
including cases you can't reproduce from the live dashboard: an invalid
signature, a duplicate request, a rejected notification.

## What the server doesn't do

Refunds, partial payments, accepting currencies other than KZT,
multi-tenant operation, and a personal account with registration are all
out of scope. For more on what to do with a disputed payment and what the
project doesn't take responsibility for at all, see the
["Security"](security) page.

## Licence

MIT.
