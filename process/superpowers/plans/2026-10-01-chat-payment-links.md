# Chat Payment Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `tilda-server` into a multi-merchant service where sellers create KZT-priced Solana payment links for chats, buyers pay USDC/SOL in one tap (with a 0.5% on-chain fee), by manual transfer, or as a Blink, and payments are detected automatically.

**Architecture:** A new self-contained subsystem `tilda-server/src/links/` (English identifiers) with its own SQLite tables in the same database file, its own HTTP handler hooked into the existing `node:http` server with one dispatch line, and its own background detector. The existing Tilda path (`orders`, `checker.ts`, Russian-named code) is not modified apart from that hook, one config key and startup wiring. Pure logic (money, validation, auth, transaction building) lives in small modules with injected dependencies and is unit-tested; HTTP handlers are tested against a real `http.Server` on port 0.

**Tech Stack:** Node.js ≥ 22.13 (`node:http`, `node:sqlite`, `node:crypto`), TypeScript 5.7 (ESM, `.js` import suffixes), vitest 3, `@solana/kit` 6.10.0, `@solana-program/token` 0.12.0, `@solana-program/system` 0.12.2, `@solana-program/memo` 0.11.2, `@solanapaykz/core` (local), nodemailer 6.9.16, qrcode 1.5.4.

**Spec:** `process/superpowers/specs/2026-10-01-chat-payment-links-design.md`

## Global Constraints

- All new code, comments, UI strings (default), docs and commit messages are in English. Existing Russian code is left as is.
- Prior work ends at tag `v0.1.0`; never rewrite history before it.
- No private keys anywhere: merchant, buyer and service fee wallet are public addresses only.
- Money is integer minor units (`bigint`): USDC 6 decimals, SOL 9, KZT 2. Stored in SQLite as TEXT.
- Quote total rounds **up**; fee = `floor(total × feeBps / 10000)`; merchant = total − fee.
- Manual amount = total + offset, offset ∈ [1, 9999] minor units, unique among the merchant's active quotes.
- Fee default 50 bps (0.5%), frozen per invoice. Quote validity 15 minutes. Invoice expiry default 7 days.
- Invoice states exactly: `open`, `paid`, `needs_review`, `expired`. Never auto-cancel a payment.
- Debt limit from config `debtLimit` (default `USDC: "20"`, `SOL: "0.15"`); above it invoice creation is refused.
- Email code: 6 digits, stored hashed, 10-minute expiry, max 5 attempts. Wallet nonce: 5 minutes, single use. Session: 30 days, cookie `spk_session`, httpOnly, Secure, SameSite=Lax.
- UI languages `en` (default) and `ru`; both dictionaries must have identical keys.
- New dependencies only those listed in Tech Stack, pinned to exact versions.
- Every merchant query is scoped by the session's `merchantId`.
- Tests: `cd tilda-server && npx vitest run` (unit) must stay green, including all pre-existing tests; core: `npx vitest run` at repo root.

## Review Focus

1. A buyer opens the same invoice link twice within 15 minutes (two tabs, or WhatsApp preview + real open) — expect the **same** quote, reference and manual amount, not a second quote that splits payment detection.
2. A payment arrives for an invoice that is already `paid` (buyer pays twice) — expect the invoice to move to `needs_review` with reason `duplicate`, not silently ignored, and the first `txSignature` kept.
3. A request-mode payment also lands on the merchant's token account that the manual scan watches — expect it counted **once** (no second `paid` transition, no fee debt accrual).
4. A merchant edits their receiving wallet while invoices are open — expect open invoices to keep the frozen `recipient` they were created with.
5. Merchant B requests merchant A's invoice list, CSV, or tries to create an invoice with A's session cookie missing — expect only B's data or 401, never A's rows.

Each line is pinned by a test in the task that owns the code (Tasks 8, 11, 11, 7 and 14 respectively).

---

## File Structure

```
src/index.ts                                  (modify) export money/token/reference helpers
tilda-server/package.json                     (modify) add @solana/kit + program packages
tilda-server/src/config.ts                    (modify) allow top-level "links" key
tilda-server/src/http/server.ts               (modify) dispatch to links handler; start/stop links app
tilda-server/config.example.json              (modify) example "links" section
tilda-server/src/links/
  config.ts       LinksConfig + loadLinksConfig()
  db.ts           openLinksStore(): schema + all queries for the subsystem
  money.ts        splitFee(), pickManualOffset(), toUnits()
  ratelimit.ts    createRateLimiter() (in-memory fixed window)
  auth.ts         email codes, sessions, cookies
  wallet-auth.ts  sign-in nonce + ed25519 verification
  recipient.ts    receiving-wallet validation
  i18n.ts         en/ru dictionaries + t()
  invoices.ts     createInvoiceFor(), activeQuote(), debt check
  tx.ts           buildPaymentTransaction()
  validate.ts     balanceDelta(), checkSplitPayment()
  detect.ts       detectOnce(), startDetector()
  notify.ts       createNotifier(): email + Telegram
  http.ts         sendJson/sendHtml/readJson/getCookie/clientIp
  pages.ts        invoice page + dashboard pages (HTML)
  routes-public.ts   /i/:id, /api/pay/:id, /api/invoices/:id/status
  routes-actions.ts  /actions.json, /api/actions/i/:id
  routes-merchant.ts /m, /api/auth/*, /api/merchant/*, CSV, fee repayment
  bot.ts          Telegram webhook commands
  app.ts          createLinksApp(): wires everything, returns { handle, stop }
tilda-server/public/link.js, dashboard.js, link.css
tilda-server/tests/links/*.test.ts
```

---

### Task 1: Export money, token and reference helpers from the core SDK

**Files:**
- Modify: `src/index.ts`
- Test: `tests/exports.test.ts`

**Interfaces:**
- Produces: `parseDecimalToUnits(value: string, decimals: number): bigint`, `formatUnits(units: bigint, decimals: number): string`, `resolveToken(cluster, token): { mint?: string; decimals: number }`, `generateReference(): string` — all importable from `@solanapaykz/core`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/exports.test.ts
import { describe, expect, it } from 'vitest';
import { formatUnits, generateReference, parseDecimalToUnits, resolveToken } from '../src/index.js';

describe('public helper exports', () => {
  it('converts decimals to minor units and back', () => {
    expect(parseDecimalToUnits('10.87', 6)).toBe(10_870_000n);
    expect(formatUnits(10_870_000n, 6)).toBe('10.87');
  });

  it('resolves USDC on both clusters', () => {
    expect(resolveToken('mainnet', 'USDC').decimals).toBe(6);
    expect(resolveToken('devnet', 'USDC').mint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(resolveToken('mainnet', 'SOL').mint).toBeUndefined();
  });

  it('generates distinct base58 references', () => {
    const a = generateReference();
    expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(generateReference()).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/exports.test.ts`
Expected: FAIL — `formatUnits` (and the others) are not exported (`does not provide an export named`).

- [ ] **Step 3: Add the exports**

Append to `src/index.ts`:

```ts
export { formatUnits, parseDecimalToUnits } from './money.js';
export { resolveToken } from './config.js';
export type { TokenInfo } from './config.js';
export { generateReference } from './payment/request.js';
```

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all tests PASS, typecheck clean, `dist/` rebuilt (tilda-server consumes `dist`).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/exports.test.ts
git commit -m "feat(core): export money, token and reference helpers"
```

---

### Task 2: Dependencies and the `links` configuration section

**Files:**
- Modify: `tilda-server/package.json`, `tilda-server/package-lock.json` (via npm), `tilda-server/src/config.ts:155` (known keys set)
- Create: `tilda-server/src/links/config.ts`
- Test: `tilda-server/tests/links/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LinksConfig {
    feeWallet: string; feeBps: number; invoiceTtlDays: number;
    debtLimit: { USDC: string; SOL: string };
    sessionPepper: string; detectIntervalMs: number; iconUrl: string;
    telegram?: { botToken: string; webhookSecret: string; botUsername: string };
  }
  export function loadLinksConfig(raw: unknown): LinksConfig  // throws Error listing all problems
  ```

- [ ] **Step 1: Install pinned dependencies**

```bash
cd tilda-server
npm install --save-exact @solana/kit@6.10.0 @solana-program/token@0.12.0 @solana-program/system@0.12.2 @solana-program/memo@0.11.2
```
Expected: `package.json` dependencies contain the four exact versions.

- [ ] **Step 2: Write the failing test**

```ts
// tilda-server/tests/links/config.test.ts
import { describe, expect, it } from 'vitest';
import { loadLinksConfig } from '../../src/links/config.js';

const FEE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe('loadLinksConfig', () => {
  it('applies defaults', () => {
    const c = loadLinksConfig({ feeWallet: FEE, sessionPepper: 'a-long-random-pepper' });
    expect(c).toMatchObject({
      feeWallet: FEE, feeBps: 50, invoiceTtlDays: 7, detectIntervalMs: 10_000,
      debtLimit: { USDC: '20', SOL: '0.15' },
    });
    expect(c.telegram).toBeUndefined();
  });

  it('reports every problem at once', () => {
    expect(() => loadLinksConfig({ feeWallet: 'nope', feeBps: 5000, sessionPepper: 'short' }))
      .toThrow(/feeWallet[\s\S]*feeBps[\s\S]*sessionPepper/);
  });

  it('requires all telegram fields together', () => {
    expect(() => loadLinksConfig({ feeWallet: FEE, sessionPepper: 'a-long-random-pepper', telegram: { botToken: 'x' } }))
      .toThrow(/telegram/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/links/config.test.ts`
Expected: FAIL — cannot find module `../../src/links/config.js`.

- [ ] **Step 4: Implement**

```ts
// tilda-server/src/links/config.ts
import { address } from '@solana/kit';

export interface LinksConfig {
  feeWallet: string;
  feeBps: number;
  invoiceTtlDays: number;
  debtLimit: { USDC: string; SOL: string };
  sessionPepper: string;
  detectIntervalMs: number;
  iconUrl: string;
  telegram?: { botToken: string; webhookSecret: string; botUsername: string };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intIn(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

const DECIMAL = /^\d+(\.\d+)?$/;

export function loadLinksConfig(raw: unknown): LinksConfig {
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error('links: must be an object');

  let feeWallet = '';
  try {
    feeWallet = address(String(raw.feeWallet ?? ''));
  } catch {
    problems.push('links.feeWallet: must be a Solana address');
  }

  const feeBps = raw.feeBps ?? 50;
  if (!intIn(feeBps, 0, 1000)) problems.push('links.feeBps: integer 0..1000');

  const invoiceTtlDays = raw.invoiceTtlDays ?? 7;
  if (!intIn(invoiceTtlDays, 1, 90)) problems.push('links.invoiceTtlDays: integer 1..90');

  const detectIntervalMs = raw.detectIntervalMs ?? 10_000;
  if (!intIn(detectIntervalMs, 1_000, 600_000)) problems.push('links.detectIntervalMs: integer 1000..600000');

  const pepper = raw.sessionPepper;
  if (typeof pepper !== 'string' || pepper.length < 16) problems.push('links.sessionPepper: string of 16+ chars');

  const limitRaw = isObject(raw.debtLimit) ? raw.debtLimit : {};
  const debtLimit = { USDC: String(limitRaw.USDC ?? '20'), SOL: String(limitRaw.SOL ?? '0.15') };
  if (!DECIMAL.test(debtLimit.USDC) || !DECIMAL.test(debtLimit.SOL)) problems.push('links.debtLimit: decimal strings');

  const iconUrl = String(raw.iconUrl ?? '/assets/icon.png');

  let telegram: LinksConfig['telegram'];
  if (raw.telegram !== undefined) {
    const t = raw.telegram;
    if (!isObject(t) || typeof t.botToken !== 'string' || typeof t.webhookSecret !== 'string'
      || typeof t.botUsername !== 'string' || t.webhookSecret.length < 16) {
      problems.push('links.telegram: botToken, botUsername and webhookSecret (16+ chars) are all required');
    } else {
      telegram = { botToken: t.botToken, webhookSecret: t.webhookSecret, botUsername: t.botUsername };
    }
  }

  if (problems.length > 0) throw new Error(problems.join('\n'));
  return {
    feeWallet, feeBps: feeBps as number, invoiceTtlDays: invoiceTtlDays as number,
    debtLimit, sessionPepper: pepper as string, detectIntervalMs: detectIntervalMs as number, iconUrl, telegram,
  };
}
```

In `tilda-server/src/config.ts`, add `'links',` to the `ИЗВЕСТНЫЕ_КЛЮЧИ` set (line 155) so the existing loader accepts the key; the section itself is parsed by `loadLinksConfig` at startup (Task 16).

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: new tests PASS; all existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config.ts src/links/config.ts tests/links/config.test.ts
git commit -m "feat(links): config section and Solana dependencies"
```

---

### Task 3: Storage for the links subsystem

**Files:**
- Create: `tilda-server/src/links/db.ts`
- Test: `tilda-server/tests/links/db.test.ts`

**Interfaces:**
- Produces (all used by later tasks):
  ```ts
  export type Lang = 'en' | 'ru';
  export type Token = 'USDC' | 'SOL';
  export type InvoiceState = 'open' | 'paid' | 'needs_review' | 'expired';
  export interface Merchant { id: number; email: string | null; walletLogin: string | null; recipient: string | null;
    name: string; lang: Lang; telegramChatId: string | null; createdAt: number }
  export interface Invoice { id: string; merchantId: number; amountKzt: string; description: string; token: Token;
    recipient: string; feeBps: number; state: InvoiceState; source: 'link' | 'bot'; createdAt: number; expiresAt: number;
    paidAt: number | null; txSignature: string | null; paidMode: 'request' | 'manual' | null; reviewReason: string | null }
  export interface QuoteRow { id: number; invoiceId: string; totalUnits: bigint; feeUnits: bigint; merchantUnits: bigint;
    manualUnits: bigint; rate: string; rateSource: string; reference: string; createdAt: number; expiresAt: number }
  export interface Repayment { id: number; merchantId: number; token: Token; units: bigint; reference: string;
    state: 'pending' | 'paid'; createdAt: number; txSignature: string | null }
  export interface LinksStore { /* methods listed in Step 3 */ close(): void }
  export function openLinksStore(path: string): LinksStore
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/db.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function seed() {
  const s = openLinksStore(':memory:');
  const m = s.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  s.updateMerchant(m.id, { recipient: R, name: 'Shop A' });
  const inv = s.createInvoice({ id: 'inv1', merchantId: m.id, amountKzt: '5000', description: 'Shirt', token: 'USDC',
    recipient: R, feeBps: 50, source: 'link', createdAt: 1000, expiresAt: 10_000 });
  return { s, m, inv };
}

describe('links store', () => {
  it('creates and finds merchants by email and wallet', () => {
    const { s, m } = seed();
    expect(s.findMerchantByEmail('a@shop.kz')?.id).toBe(m.id);
    expect(s.getMerchant(m.id)).toMatchObject({ recipient: R, name: 'Shop A', lang: 'en' });
    const w = s.createMerchant({ email: null, walletLogin: R, lang: 'ru', now: 2 });
    expect(s.findMerchantByWallet(R)?.id).toBe(w.id);
  });

  it('stores bigints exactly and returns the latest quote', () => {
    const { s } = seed();
    s.insertQuote({ invoiceId: 'inv1', totalUnits: 10_870_001n, feeUnits: 54_350n, merchantUnits: 10_815_651n,
      manualUnits: 10_871_234n, rate: '460', rateSource: 'binance', reference: 'ref1', createdAt: 1000, expiresAt: 1900 });
    const q = s.insertQuote({ invoiceId: 'inv1', totalUnits: 2n, feeUnits: 0n, merchantUnits: 2n, manualUnits: 3n,
      rate: '1', rateSource: 'x', reference: 'ref2', createdAt: 2000, expiresAt: 2900 });
    expect(s.latestQuote('inv1')).toEqual(q);
    expect(s.quotesForInvoice('inv1').map((x) => x.totalUnits)).toEqual([10_870_001n, 2n]);
  });

  it('lists manual amounts of active quotes per merchant and token only', () => {
    const { s, m } = seed();
    s.insertQuote({ invoiceId: 'inv1', totalUnits: 1n, feeUnits: 0n, merchantUnits: 1n, manualUnits: 77n,
      rate: '1', rateSource: 'x', reference: 'r', createdAt: 1000, expiresAt: 1900 });
    expect(s.activeManualUnits(m.id, 'USDC', 1500)).toEqual([77n]);
    expect(s.activeManualUnits(m.id, 'USDC', 2000)).toEqual([]);
    expect(s.activeManualUnits(m.id, 'SOL', 1500)).toEqual([]);
  });

  it('takes a nonce and a bot link only once', () => {
    const { s, m } = seed();
    s.putNonce('n1', 100);
    expect(s.takeNonce('n1', 50)).toBe(true);
    expect(s.takeNonce('n1', 50)).toBe(false);
    s.putBotLink('c1', m.id, 100);
    expect(s.takeBotLink('c1', 200)).toBeNull();
    s.putBotLink('c2', m.id, 100);
    expect(s.takeBotLink('c2', 50)).toBe(m.id);
    expect(s.takeBotLink('c2', 50)).toBeNull();
  });

  it('marks a signature processed exactly once', () => {
    const { s } = seed();
    expect(s.markProcessed('sig1')).toBe(true);
    expect(s.markProcessed('sig1')).toBe(false);
  });

  it('sums fee debt per token', () => {
    const { s, m } = seed();
    s.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: 100n, invoiceId: 'inv1', txSignature: 'a', createdAt: 1 });
    s.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: -40n, invoiceId: null, txSignature: 'b', createdAt: 2 });
    expect(s.feeDebt(m.id, 'USDC')).toBe(60n);
    expect(s.feeDebt(m.id, 'SOL')).toBe(0n);
  });

  it('scopes invoice lists by merchant', () => {
    const { s, m } = seed();
    const other = s.createMerchant({ email: 'b@shop.kz', walletLogin: null, lang: 'en', now: 3 });
    expect(s.listInvoices(m.id, 50).map((i) => i.id)).toEqual(['inv1']);
    expect(s.listInvoices(other.id, 50)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/db.test.ts`
Expected: FAIL — cannot find module `../../src/links/db.js`.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/db.ts
import { DatabaseSync } from 'node:sqlite';

export type Lang = 'en' | 'ru';
export type Token = 'USDC' | 'SOL';
export type InvoiceState = 'open' | 'paid' | 'needs_review' | 'expired';

export interface Merchant {
  id: number; email: string | null; walletLogin: string | null; recipient: string | null;
  name: string; lang: Lang; telegramChatId: string | null; createdAt: number;
}
export interface Invoice {
  id: string; merchantId: number; amountKzt: string; description: string; token: Token; recipient: string;
  feeBps: number; state: InvoiceState; source: 'link' | 'bot'; createdAt: number; expiresAt: number;
  paidAt: number | null; txSignature: string | null; paidMode: 'request' | 'manual' | null; reviewReason: string | null;
}
export interface QuoteRow {
  id: number; invoiceId: string; totalUnits: bigint; feeUnits: bigint; merchantUnits: bigint; manualUnits: bigint;
  rate: string; rateSource: string; reference: string; createdAt: number; expiresAt: number;
}
export interface Repayment {
  id: number; merchantId: number; token: Token; units: bigint; reference: string;
  state: 'pending' | 'paid'; createdAt: number; txSignature: string | null;
}
export type NewInvoice = Omit<Invoice, 'state' | 'paidAt' | 'txSignature' | 'paidMode' | 'reviewReason'>;
export type NewQuote = Omit<QuoteRow, 'id'>;
export interface MerchantPatch {
  recipient?: string; name?: string; lang?: Lang; email?: string; walletLogin?: string; telegramChatId?: string | null;
}
export interface InvoiceUpdate {
  state: InvoiceState; paidAt?: number | null; txSignature?: string | null;
  paidMode?: 'request' | 'manual' | null; reviewReason?: string | null;
}

export interface LinksStore {
  createMerchant(p: { email: string | null; walletLogin: string | null; lang: Lang; now: number }): Merchant;
  getMerchant(id: number): Merchant | null;
  findMerchantByEmail(email: string): Merchant | null;
  findMerchantByWallet(wallet: string): Merchant | null;
  findMerchantByTelegram(chatId: string): Merchant | null;
  updateMerchant(id: number, patch: MerchantPatch): void;

  putEmailCode(email: string, codeHash: string, createdAt: number, expiresAt: number): void;
  getEmailCode(email: string): { codeHash: string; createdAt: number; expiresAt: number; attempts: number } | null;
  bumpEmailCodeAttempts(email: string): void;
  deleteEmailCode(email: string): void;
  putNonce(nonce: string, expiresAt: number): void;
  takeNonce(nonce: string, now: number): boolean;
  createSession(id: string, merchantId: number, csrf: string, expiresAt: number): void;
  getSession(id: string, now: number): { merchantId: number; csrf: string } | null;
  deleteSession(id: string): void;
  putBotLink(code: string, merchantId: number, expiresAt: number): void;
  takeBotLink(code: string, now: number): number | null;

  createInvoice(p: NewInvoice): Invoice;
  getInvoice(id: string): Invoice | null;
  listInvoices(merchantId: number, limit: number): Invoice[];
  candidateInvoices(now: number, lateWindowMs: number): Invoice[];
  updateInvoice(id: string, u: InvoiceUpdate): void;
  expireInvoices(now: number): number;

  insertQuote(q: NewQuote): QuoteRow;
  latestQuote(invoiceId: string): QuoteRow | null;
  quotesForInvoice(invoiceId: string): QuoteRow[];
  activeManualUnits(merchantId: number, token: Token, now: number): bigint[];

  addFeeEntry(e: { merchantId: number; token: Token; amount: bigint; invoiceId: string | null;
    txSignature: string | null; createdAt: number }): void;
  feeDebt(merchantId: number, token: Token): bigint;
  createRepayment(r: { merchantId: number; token: Token; units: bigint; reference: string; createdAt: number }): Repayment;
  getRepayment(id: number): Repayment | null;
  pendingRepayments(): Repayment[];
  markRepaymentPaid(id: number, txSignature: string): void;

  markProcessed(signature: string): boolean;
  getCheckpoint(key: string): string | null;
  setCheckpoint(key: string, signature: string): void;
  close(): void;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS lk_merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE, wallet_login TEXT UNIQUE, recipient TEXT,
  name TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'en',
  telegram_chat_id TEXT UNIQUE, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lk_email_codes (
  email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lk_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lk_sessions (
  id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lk_bot_links (code TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lk_invoices (
  id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, amount_kzt TEXT NOT NULL, description TEXT NOT NULL,
  token TEXT NOT NULL, recipient TEXT NOT NULL, fee_bps INTEGER NOT NULL, state TEXT NOT NULL,
  source TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, paid_at INTEGER,
  tx_signature TEXT, paid_mode TEXT, review_reason TEXT
);
CREATE INDEX IF NOT EXISTS lk_invoices_merchant ON lk_invoices (merchant_id, created_at);
CREATE INDEX IF NOT EXISTS lk_invoices_state ON lk_invoices (state, expires_at);
CREATE TABLE IF NOT EXISTS lk_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL,
  total_units TEXT NOT NULL, fee_units TEXT NOT NULL, merchant_units TEXT NOT NULL, manual_units TEXT NOT NULL,
  rate TEXT NOT NULL, rate_source TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lk_quotes_invoice ON lk_quotes (invoice_id, created_at);
CREATE TABLE IF NOT EXISTS lk_fee_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, merchant_id INTEGER NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL,
  invoice_id TEXT, tx_signature TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lk_repayments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, merchant_id INTEGER NOT NULL, token TEXT NOT NULL, units TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_at INTEGER NOT NULL, tx_signature TEXT
);
CREATE TABLE IF NOT EXISTS lk_processed (signature TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS lk_checkpoints (key TEXT PRIMARY KEY, signature TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

function merchantFrom(r: Row): Merchant {
  return {
    id: Number(r.id), email: (r.email as string) ?? null, walletLogin: (r.wallet_login as string) ?? null,
    recipient: (r.recipient as string) ?? null, name: String(r.name), lang: r.lang as Lang,
    telegramChatId: (r.telegram_chat_id as string) ?? null, createdAt: Number(r.created_at),
  };
}

function invoiceFrom(r: Row): Invoice {
  return {
    id: String(r.id), merchantId: Number(r.merchant_id), amountKzt: String(r.amount_kzt),
    description: String(r.description), token: r.token as Token, recipient: String(r.recipient),
    feeBps: Number(r.fee_bps), state: r.state as InvoiceState, source: r.source as 'link' | 'bot',
    createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
    paidAt: r.paid_at === null ? null : Number(r.paid_at), txSignature: (r.tx_signature as string) ?? null,
    paidMode: (r.paid_mode as Invoice['paidMode']) ?? null, reviewReason: (r.review_reason as string) ?? null,
  };
}

function quoteFrom(r: Row): QuoteRow {
  return {
    id: Number(r.id), invoiceId: String(r.invoice_id), totalUnits: BigInt(r.total_units as string),
    feeUnits: BigInt(r.fee_units as string), merchantUnits: BigInt(r.merchant_units as string),
    manualUnits: BigInt(r.manual_units as string), rate: String(r.rate), rateSource: String(r.rate_source),
    reference: String(r.reference), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
  };
}

function repaymentFrom(r: Row): Repayment {
  return {
    id: Number(r.id), merchantId: Number(r.merchant_id), token: r.token as Token, units: BigInt(r.units as string),
    reference: String(r.reference), state: r.state as Repayment['state'], createdAt: Number(r.created_at),
    txSignature: (r.tx_signature as string) ?? null,
  };
}

const MERCHANT_COLUMNS: Record<keyof MerchantPatch, string> = {
  recipient: 'recipient', name: 'name', lang: 'lang', email: 'email', walletLogin: 'wallet_login',
  telegramChatId: 'telegram_chat_id',
};

export function openLinksStore(path: string): LinksStore {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const one = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).get(...p) as Row | undefined;
  const all = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).all(...p) as Row[];
  const run = (sql: string, ...p: (string | number | null)[]) => db.prepare(sql).run(...p);

  const store: LinksStore = {
    createMerchant({ email, walletLogin, lang, now }) {
      const r = run('INSERT INTO lk_merchants (email, wallet_login, lang, created_at) VALUES (?, ?, ?, ?)',
        email, walletLogin, lang, now);
      return store.getMerchant(Number(r.lastInsertRowid))!;
    },
    getMerchant(id) { const r = one('SELECT * FROM lk_merchants WHERE id = ?', id); return r ? merchantFrom(r) : null; },
    findMerchantByEmail(email) { const r = one('SELECT * FROM lk_merchants WHERE email = ?', email); return r ? merchantFrom(r) : null; },
    findMerchantByWallet(w) { const r = one('SELECT * FROM lk_merchants WHERE wallet_login = ?', w); return r ? merchantFrom(r) : null; },
    findMerchantByTelegram(c) { const r = one('SELECT * FROM lk_merchants WHERE telegram_chat_id = ?', c); return r ? merchantFrom(r) : null; },
    updateMerchant(id, patch) {
      for (const [key, column] of Object.entries(MERCHANT_COLUMNS)) {
        const value = patch[key as keyof MerchantPatch];
        if (value !== undefined) run(`UPDATE lk_merchants SET ${column} = ? WHERE id = ?`, value, id);
      }
    },

    putEmailCode(email, codeHash, createdAt, expiresAt) {
      run(`INSERT INTO lk_email_codes (email, code_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at,
           expires_at = excluded.expires_at, attempts = 0`, email, codeHash, createdAt, expiresAt);
    },
    getEmailCode(email) {
      const r = one('SELECT * FROM lk_email_codes WHERE email = ?', email);
      return r ? { codeHash: String(r.code_hash), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
        attempts: Number(r.attempts) } : null;
    },
    bumpEmailCodeAttempts(email) { run('UPDATE lk_email_codes SET attempts = attempts + 1 WHERE email = ?', email); },
    deleteEmailCode(email) { run('DELETE FROM lk_email_codes WHERE email = ?', email); },
    putNonce(nonce, expiresAt) { run('INSERT INTO lk_nonces (nonce, expires_at) VALUES (?, ?)', nonce, expiresAt); },
    takeNonce(nonce, now) {
      const r = run('DELETE FROM lk_nonces WHERE nonce = ? AND expires_at > ?', nonce, now);
      return Number(r.changes) === 1;
    },
    createSession(id, merchantId, csrf, expiresAt) {
      run('INSERT INTO lk_sessions (id, merchant_id, csrf, expires_at) VALUES (?, ?, ?, ?)', id, merchantId, csrf, expiresAt);
    },
    getSession(id, now) {
      const r = one('SELECT * FROM lk_sessions WHERE id = ? AND expires_at > ?', id, now);
      return r ? { merchantId: Number(r.merchant_id), csrf: String(r.csrf) } : null;
    },
    deleteSession(id) { run('DELETE FROM lk_sessions WHERE id = ?', id); },
    putBotLink(code, merchantId, expiresAt) {
      run('INSERT INTO lk_bot_links (code, merchant_id, expires_at) VALUES (?, ?, ?)', code, merchantId, expiresAt);
    },
    takeBotLink(code, now) {
      const r = one('SELECT merchant_id FROM lk_bot_links WHERE code = ? AND expires_at > ?', code, now);
      run('DELETE FROM lk_bot_links WHERE code = ?', code);
      return r ? Number(r.merchant_id) : null;
    },

    createInvoice(p) {
      run(`INSERT INTO lk_invoices (id, merchant_id, amount_kzt, description, token, recipient, fee_bps, state, source,
           created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        p.id, p.merchantId, p.amountKzt, p.description, p.token, p.recipient, p.feeBps, p.source, p.createdAt, p.expiresAt);
      return store.getInvoice(p.id)!;
    },
    getInvoice(id) { const r = one('SELECT * FROM lk_invoices WHERE id = ?', id); return r ? invoiceFrom(r) : null; },
    listInvoices(merchantId, limit) {
      return all('SELECT * FROM lk_invoices WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?', merchantId, limit)
        .map(invoiceFrom);
    },
    candidateInvoices(now, lateWindowMs) {
      return all(`SELECT * FROM lk_invoices WHERE state = 'open'
                  OR (state IN ('expired', 'paid', 'needs_review') AND created_at > ?)`, now - lateWindowMs)
        .map(invoiceFrom);
    },
    updateInvoice(id, u) {
      const cur = store.getInvoice(id);
      if (!cur) return;
      run(`UPDATE lk_invoices SET state = ?, paid_at = ?, tx_signature = ?, paid_mode = ?, review_reason = ? WHERE id = ?`,
        u.state, u.paidAt !== undefined ? u.paidAt : cur.paidAt, u.txSignature !== undefined ? u.txSignature : cur.txSignature,
        u.paidMode !== undefined ? u.paidMode : cur.paidMode, u.reviewReason !== undefined ? u.reviewReason : cur.reviewReason, id);
    },
    expireInvoices(now) {
      return Number(run(`UPDATE lk_invoices SET state = 'expired' WHERE state = 'open' AND expires_at <= ?`, now).changes);
    },

    insertQuote(q) {
      const r = run(`INSERT INTO lk_quotes (invoice_id, total_units, fee_units, merchant_units, manual_units, rate,
           rate_source, reference, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        q.invoiceId, q.totalUnits.toString(), q.feeUnits.toString(), q.merchantUnits.toString(), q.manualUnits.toString(),
        q.rate, q.rateSource, q.reference, q.createdAt, q.expiresAt);
      return quoteFrom(one('SELECT * FROM lk_quotes WHERE id = ?', Number(r.lastInsertRowid))!);
    },
    latestQuote(invoiceId) {
      const r = one('SELECT * FROM lk_quotes WHERE invoice_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', invoiceId);
      return r ? quoteFrom(r) : null;
    },
    quotesForInvoice(invoiceId) {
      return all('SELECT * FROM lk_quotes WHERE invoice_id = ? ORDER BY created_at, id', invoiceId).map(quoteFrom);
    },
    activeManualUnits(merchantId, token, now) {
      return all(`SELECT q.manual_units FROM lk_quotes q JOIN lk_invoices i ON i.id = q.invoice_id
                  WHERE i.merchant_id = ? AND i.token = ? AND q.expires_at > ?`, merchantId, token, now)
        .map((r) => BigInt(r.manual_units as string));
    },

    addFeeEntry(e) {
      run(`INSERT INTO lk_fee_ledger (merchant_id, token, amount, invoice_id, tx_signature, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`, e.merchantId, e.token, e.amount.toString(), e.invoiceId, e.txSignature, e.createdAt);
    },
    feeDebt(merchantId, token) {
      return all('SELECT amount FROM lk_fee_ledger WHERE merchant_id = ? AND token = ?', merchantId, token)
        .reduce((sum, r) => sum + BigInt(r.amount as string), 0n);
    },
    createRepayment(r) {
      const res = run(`INSERT INTO lk_repayments (merchant_id, token, units, reference, state, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`, r.merchantId, r.token, r.units.toString(), r.reference, r.createdAt);
      return store.getRepayment(Number(res.lastInsertRowid))!;
    },
    getRepayment(id) { const r = one('SELECT * FROM lk_repayments WHERE id = ?', id); return r ? repaymentFrom(r) : null; },
    pendingRepayments() { return all(`SELECT * FROM lk_repayments WHERE state = 'pending'`).map(repaymentFrom); },
    markRepaymentPaid(id, sig) { run(`UPDATE lk_repayments SET state = 'paid', tx_signature = ? WHERE id = ?`, sig, id); },

    markProcessed(signature) {
      return Number(run('INSERT OR IGNORE INTO lk_processed (signature) VALUES (?)', signature).changes) === 1;
    },
    getCheckpoint(key) { const r = one('SELECT signature FROM lk_checkpoints WHERE key = ?', key); return r ? String(r.signature) : null; },
    setCheckpoint(key, signature) {
      run(`INSERT INTO lk_checkpoints (key, signature) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET signature = excluded.signature`, key, signature);
    },
    close() { db.close(); },
  };
  return store;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/links/db.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/links/db.ts tests/links/db.test.ts
git commit -m "feat(links): storage for merchants, invoices, quotes and fee ledger"
```

---

### Task 4: Money rules

**Files:**
- Create: `tilda-server/src/links/money.ts`
- Test: `tilda-server/tests/links/money.test.ts`

**Interfaces:**
- Produces: `splitFee(total: bigint, feeBps: number): { fee: bigint; merchant: bigint }`, `pickManualOffset(used: ReadonlySet<bigint>, random?: () => number): bigint` (throws `Error('no free manual offset')`), `MAX_OFFSET = 9999n`.

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/money.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_OFFSET, pickManualOffset, splitFee } from '../../src/links/money.js';

describe('splitFee', () => {
  it('takes 0.5% rounded down in favour of the merchant', () => {
    expect(splitFee(10_870_000n, 50)).toEqual({ fee: 54_350n, merchant: 10_815_650n });
    expect(splitFee(199n, 50)).toEqual({ fee: 0n, merchant: 199n });
    expect(splitFee(201n, 50)).toEqual({ fee: 1n, merchant: 200n });
  });

  it('returns everything to the merchant at 0 bps', () => {
    expect(splitFee(123n, 0)).toEqual({ fee: 0n, merchant: 123n });
  });
});

describe('pickManualOffset', () => {
  it('returns a value in [1, 9999] not in the used set', () => {
    const used = new Set<bigint>([1n, 2n, 3n]);
    const seq = [0, 0.0001, 0.5];
    let i = 0;
    const off = pickManualOffset(used, () => seq[i++ % seq.length]!);
    expect(off >= 1n && off <= MAX_OFFSET).toBe(true);
    expect(used.has(off)).toBe(false);
  });

  it('throws when every offset is taken', () => {
    const used = new Set<bigint>();
    for (let k = 1n; k <= MAX_OFFSET; k++) used.add(k);
    expect(() => pickManualOffset(used)).toThrow('no free manual offset');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/money.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/money.ts
export const MAX_OFFSET = 9999n;

export function splitFee(total: bigint, feeBps: number): { fee: bigint; merchant: bigint } {
  const fee = (total * BigInt(feeBps)) / 10_000n;
  return { fee, merchant: total - fee };
}

/** Random offset in [1, MAX_OFFSET] that is not already used by an active quote of the same merchant and token. */
export function pickManualOffset(used: ReadonlySet<bigint>, random: () => number = Math.random): bigint {
  if (BigInt(used.size) >= MAX_OFFSET) throw new Error('no free manual offset');
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = BigInt(1 + Math.floor(random() * Number(MAX_OFFSET)));
    if (candidate <= MAX_OFFSET && !used.has(candidate)) return candidate;
  }
  for (let k = 1n; k <= MAX_OFFSET; k++) if (!used.has(k)) return k;
  throw new Error('no free manual offset');
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/links/money.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/links/money.ts tests/links/money.test.ts
git commit -m "feat(links): fee split and unique manual offsets"
```

---
### Task 5: Email sign-in, sessions and rate limiting

**Files:**
- Create: `tilda-server/src/links/ratelimit.ts`, `tilda-server/src/links/auth.ts`
- Test: `tilda-server/tests/links/auth.test.ts`

**Interfaces:**
- Consumes: `LinksStore` (Task 3).
- Produces:
  ```ts
  export interface RateLimiter { allow(key: string, now: number): boolean }
  export function createRateLimiter(limit: number, windowMs: number): RateLimiter
  export const SESSION_COOKIE = 'spk_session';
  export const SESSION_TTL_MS: number;            // 30 days
  export interface AuthDeps { store: LinksStore; pepper: string; now: () => number;
    sendCode: (email: string, code: string, lang: Lang) => Promise<void> }
  export function normalizeEmail(raw: unknown): string | null
  export function randomToken(bytes?: number): string            // base64url
  export async function startEmailLogin(d: AuthDeps, rawEmail: unknown, lang: Lang):
    Promise<{ ok: true } | { ok: false; error: 'invalid_email' | 'too_soon' }>
  export function verifyEmailLogin(d: AuthDeps, rawEmail: unknown, rawCode: unknown, lang: Lang):
    { ok: true; merchantId: number } | { ok: false; error: 'invalid' | 'expired' | 'locked' }
  export function createSessionFor(d: AuthDeps, merchantId: number): { id: string; csrf: string; cookie: string }
  export function readSession(d: AuthDeps, cookieHeader: string | undefined):
    { id: string; merchantId: number; csrf: string } | null
  export function clearSessionCookie(): string
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/auth.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';
import {
  createSessionFor, normalizeEmail, readSession, SESSION_COOKIE, startEmailLogin, verifyEmailLogin, type AuthDeps,
} from '../../src/links/auth.js';
import { createRateLimiter } from '../../src/links/ratelimit.js';

function deps(start = 1_000_000) {
  let now = start;
  const sent: { email: string; code: string }[] = [];
  const d: AuthDeps = {
    store: openLinksStore(':memory:'), pepper: 'pepper-pepper-pepper', now: () => now,
    sendCode: async (email, code) => { sent.push({ email, code }); },
  };
  return { d, sent, tick: (ms: number) => { now += ms; } };
}

describe('email sign-in', () => {
  it('normalizes emails and rejects garbage', () => {
    expect(normalizeEmail('  Shop@Example.KZ ')).toBe('shop@example.kz');
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it('sends a 6-digit code and signs up a new merchant on verify', async () => {
    const { d, sent } = deps();
    expect(await startEmailLogin(d, 'a@shop.kz', 'ru')).toEqual({ ok: true });
    expect(sent[0]!.code).toMatch(/^\d{6}$/);
    const r = verifyEmailLogin(d, 'a@shop.kz', sent[0]!.code, 'ru');
    expect(r.ok).toBe(true);
    if (r.ok) expect(d.store.getMerchant(r.merchantId)).toMatchObject({ email: 'a@shop.kz', lang: 'ru' });
  });

  it('stores only a hash of the code', async () => {
    const { d, sent } = deps();
    await startEmailLogin(d, 'a@shop.kz', 'en');
    expect(d.store.getEmailCode('a@shop.kz')!.codeHash).not.toContain(sent[0]!.code);
  });

  it('refuses a second code within 60 seconds', async () => {
    const { d, tick } = deps();
    await startEmailLogin(d, 'a@shop.kz', 'en');
    expect(await startEmailLogin(d, 'a@shop.kz', 'en')).toEqual({ ok: false, error: 'too_soon' });
    tick(61_000);
    expect(await startEmailLogin(d, 'a@shop.kz', 'en')).toEqual({ ok: true });
  });

  it('locks after 5 wrong attempts and expires after 10 minutes', async () => {
    const { d, sent, tick } = deps();
    await startEmailLogin(d, 'a@shop.kz', 'en');
    for (let i = 0; i < 5; i++) expect(verifyEmailLogin(d, 'a@shop.kz', '000000', 'en')).toEqual({ ok: false, error: 'invalid' });
    expect(verifyEmailLogin(d, 'a@shop.kz', sent[0]!.code, 'en')).toEqual({ ok: false, error: 'locked' });
    tick(61_000);
    await startEmailLogin(d, 'a@shop.kz', 'en');
    tick(10 * 60_000 + 1);
    expect(verifyEmailLogin(d, 'a@shop.kz', sent[1]!.code, 'en')).toEqual({ ok: false, error: 'expired' });
  });

  it('a code works only once', async () => {
    const { d, sent } = deps();
    await startEmailLogin(d, 'a@shop.kz', 'en');
    expect(verifyEmailLogin(d, 'a@shop.kz', sent[0]!.code, 'en').ok).toBe(true);
    expect(verifyEmailLogin(d, 'a@shop.kz', sent[0]!.code, 'en')).toEqual({ ok: false, error: 'expired' });
  });
});

describe('sessions', () => {
  it('round-trips through the cookie header', () => {
    const { d } = deps();
    const m = d.store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    const s = createSessionFor(d, m.id);
    expect(s.cookie).toContain(`${SESSION_COOKIE}=${s.id}`);
    expect(s.cookie).toMatch(/HttpOnly/);
    expect(s.cookie).toMatch(/Secure/);
    expect(s.cookie).toMatch(/SameSite=Lax/);
    expect(readSession(d, `other=1; ${SESSION_COOKIE}=${s.id}`)).toEqual({ id: s.id, merchantId: m.id, csrf: s.csrf });
    expect(readSession(d, `${SESSION_COOKIE}=forged`)).toBeNull();
    expect(readSession(d, undefined)).toBeNull();
  });
});

describe('rate limiter', () => {
  it('allows N per window per key', () => {
    const rl = createRateLimiter(2, 1000);
    expect(rl.allow('ip', 0)).toBe(true);
    expect(rl.allow('ip', 10)).toBe(true);
    expect(rl.allow('ip', 20)).toBe(false);
    expect(rl.allow('other', 20)).toBe(true);
    expect(rl.allow('ip', 1001)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/auth.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the rate limiter**

```ts
// tilda-server/src/links/ratelimit.ts
export interface RateLimiter { allow(key: string, now: number): boolean }

/** Fixed-window counter per key; the map is pruned when it grows past 10k keys. */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    allow(key, now) {
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      }
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      if (w.count >= limit) return false;
      w.count += 1;
      return true;
    },
  };
}
```

- [ ] **Step 4: Implement email sign-in and sessions**

```ts
// tilda-server/src/links/auth.ts
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Lang, LinksStore } from './db.js';

export const SESSION_COOKIE = 'spk_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface AuthDeps {
  store: LinksStore;
  pepper: string;
  now: () => number;
  sendCode: (email: string, code: string, lang: Lang) => Promise<void>;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/.test(email) ? email : null;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function hashCode(pepper: string, email: string, code: string): string {
  return createHash('sha256').update(`${pepper}\n${email}\n${code}`).digest('hex');
}

export async function startEmailLogin(d: AuthDeps, rawEmail: unknown, lang: Lang):
  Promise<{ ok: true } | { ok: false; error: 'invalid_email' | 'too_soon' }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: 'invalid_email' };
  const now = d.now();
  const existing = d.store.getEmailCode(email);
  if (existing && now - existing.createdAt < CODE_RESEND_MS) return { ok: false, error: 'too_soon' };
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  d.store.putEmailCode(email, hashCode(d.pepper, email, code), now, now + CODE_TTL_MS);
  await d.sendCode(email, code, lang);
  return { ok: true };
}

export function verifyEmailLogin(d: AuthDeps, rawEmail: unknown, rawCode: unknown, lang: Lang):
  { ok: true; merchantId: number } | { ok: false; error: 'invalid' | 'expired' | 'locked' } {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!email) return { ok: false, error: 'invalid' };
  const row = d.store.getEmailCode(email);
  if (!row || row.expiresAt <= d.now()) return { ok: false, error: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'locked' };
  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(hashCode(d.pepper, email, code), 'hex');
  if (!/^\d{6}$/.test(code) || !timingSafeEqual(expected, actual)) {
    d.store.bumpEmailCodeAttempts(email);
    return { ok: false, error: 'invalid' };
  }
  d.store.deleteEmailCode(email);
  const merchant = d.store.findMerchantByEmail(email)
    ?? d.store.createMerchant({ email, walletLogin: null, lang, now: d.now() });
  return { ok: true, merchantId: merchant.id };
}

export function createSessionFor(d: AuthDeps, merchantId: number): { id: string; csrf: string; cookie: string } {
  const id = randomToken(32);
  const csrf = randomToken(24);
  d.store.createSession(id, merchantId, csrf, d.now() + SESSION_TTL_MS);
  const cookie = `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
  return { id, csrf, cookie };
}

export function readSession(d: AuthDeps, cookieHeader: string | undefined):
  { id: string; merchantId: number; csrf: string } | null {
  if (!cookieHeader) return null;
  const pair = cookieHeader.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  if (!pair) return null;
  const id = pair.slice(SESSION_COOKIE.length + 1);
  const s = d.store.getSession(id, d.now());
  return s ? { id, ...s } : null;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/links/auth.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/links/ratelimit.ts src/links/auth.ts tests/links/auth.test.ts
git commit -m "feat(links): email one-time-code sign-in, sessions and rate limiter"
```

---

### Task 6: Wallet sign-in

**Files:**
- Create: `tilda-server/src/links/wallet-auth.ts`
- Test: `tilda-server/tests/links/wallet-auth.test.ts`

**Interfaces:**
- Consumes: `LinksStore`, `randomToken` (Task 5).
- Produces:
  ```ts
  export function signInMessage(host: string, nonce: string): string
  export function issueNonce(store: LinksStore, now: number): string            // valid 5 min
  export function verifyEd25519(addressB58: string, message: Uint8Array, signatureB58: string): boolean
  export function verifyWalletSignIn(store: LinksStore, now: number,
    p: { host: string; address: unknown; nonce: unknown; signature: unknown; lang: Lang }):
    { ok: true; merchantId: number } | { ok: false; error: 'bad_request' | 'nonce' | 'signature' }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/wallet-auth.test.ts
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getAddressDecoder, getBase58Decoder } from '@solana/kit';
import { openLinksStore } from '../../src/links/db.js';
import { issueNonce, signInMessage, verifyEd25519, verifyWalletSignIn } from '../../src/links/wallet-auth.js';

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const address = getAddressDecoder().decode(raw);
  const signB58 = (text: string) => getBase58Decoder().decode(sign(null, Buffer.from(text, 'utf8'), privateKey));
  return { address, signB58 };
}

describe('wallet sign-in', () => {
  it('verifies a genuine ed25519 signature and rejects a wrong one', () => {
    const w = wallet();
    const msg = 'hello';
    expect(verifyEd25519(w.address, Buffer.from(msg), w.signB58(msg))).toBe(true);
    expect(verifyEd25519(w.address, Buffer.from('other'), w.signB58(msg))).toBe(false);
    expect(verifyEd25519('not-an-address', Buffer.from(msg), w.signB58(msg))).toBe(false);
  });

  it('signs up on first sign-in and finds the same merchant later', () => {
    const store = openLinksStore(':memory:');
    const w = wallet();
    const n1 = issueNonce(store, 1000);
    const r1 = verifyWalletSignIn(store, 2000, { host: 'pay.test', address: w.address, nonce: n1,
      signature: w.signB58(signInMessage('pay.test', n1)), lang: 'en' });
    expect(r1.ok).toBe(true);
    const n2 = issueNonce(store, 3000);
    const r2 = verifyWalletSignIn(store, 4000, { host: 'pay.test', address: w.address, nonce: n2,
      signature: w.signB58(signInMessage('pay.test', n2)), lang: 'en' });
    expect(r2).toEqual(r1);
  });

  it('rejects a reused nonce, an expired nonce and a message for another host', () => {
    const store = openLinksStore(':memory:');
    const w = wallet();
    const n = issueNonce(store, 0);
    const ok = { host: 'pay.test', address: w.address, nonce: n, signature: w.signB58(signInMessage('pay.test', n)), lang: 'en' as const };
    expect(verifyWalletSignIn(store, 1, ok).ok).toBe(true);
    expect(verifyWalletSignIn(store, 2, ok)).toEqual({ ok: false, error: 'nonce' });

    const late = issueNonce(store, 0);
    expect(verifyWalletSignIn(store, 5 * 60_000 + 1, { ...ok, nonce: late,
      signature: w.signB58(signInMessage('pay.test', late)) })).toEqual({ ok: false, error: 'nonce' });

    const n3 = issueNonce(store, 0);
    expect(verifyWalletSignIn(store, 1, { ...ok, nonce: n3,
      signature: w.signB58(signInMessage('evil.test', n3)) })).toEqual({ ok: false, error: 'signature' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/wallet-auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/wallet-auth.ts
import { createPublicKey, verify } from 'node:crypto';
import { address as toAddress, getAddressEncoder, getBase58Encoder } from '@solana/kit';
import { randomToken } from './auth.js';
import type { Lang, LinksStore } from './db.js';

const NONCE_TTL_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function signInMessage(host: string, nonce: string): string {
  return `${host} asks you to sign in to SolanaPay-KZ.\n\nThis does not move funds or authorize transactions.\n\nNonce: ${nonce}`;
}

export function issueNonce(store: LinksStore, now: number): string {
  const nonce = randomToken(16);
  store.putNonce(nonce, now + NONCE_TTL_MS);
  return nonce;
}

export function verifyEd25519(addressB58: string, message: Uint8Array, signatureB58: string): boolean {
  try {
    const raw = getAddressEncoder().encode(toAddress(addressB58));
    const sig = getBase58Encoder().encode(signatureB58);
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

export function verifyWalletSignIn(
  store: LinksStore,
  now: number,
  p: { host: string; address: unknown; nonce: unknown; signature: unknown; lang: Lang },
): { ok: true; merchantId: number } | { ok: false; error: 'bad_request' | 'nonce' | 'signature' } {
  if (typeof p.address !== 'string' || typeof p.nonce !== 'string' || typeof p.signature !== 'string') {
    return { ok: false, error: 'bad_request' };
  }
  if (!store.takeNonce(p.nonce, now)) return { ok: false, error: 'nonce' };
  const message = Buffer.from(signInMessage(p.host, p.nonce), 'utf8');
  if (!verifyEd25519(p.address, message, p.signature)) return { ok: false, error: 'signature' };
  const merchant = store.findMerchantByWallet(p.address)
    ?? store.createMerchant({ email: null, walletLogin: p.address, lang: p.lang, now });
  return { ok: true, merchantId: merchant.id };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/links/wallet-auth.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/links/wallet-auth.ts tests/links/wallet-auth.test.ts
git commit -m "feat(links): wallet sign-in with single-use nonce"
```

---

### Task 7: Receiving wallet validation, merchant settings and i18n

**Files:**
- Create: `tilda-server/src/links/recipient.ts`, `tilda-server/src/links/i18n.ts`
- Test: `tilda-server/tests/links/recipient.test.ts`, `tilda-server/tests/links/i18n.test.ts`

**Interfaces:**
- Consumes: `resolveToken` from `@solanapaykz/core` (Task 1), `LinksStore` (Task 3).
- Produces:
  ```ts
  export interface AccountProbe { exists(address: string): Promise<boolean> }
  export async function usdcAccountOf(cluster: 'mainnet' | 'devnet', owner: string): Promise<string>
  export async function checkRecipient(probe: AccountProbe, cluster: 'mainnet' | 'devnet', raw: unknown):
    Promise<{ ok: true; address: string } | { ok: false; error: 'format' | 'is_mint' | 'no_usdc_account' }>
  export function saveSettings(store: LinksStore, merchantId: number,
    p: { recipient?: string; name?: unknown; lang?: unknown }): { ok: true } | { ok: false; error: 'name' | 'lang' }
  export type Dict = Record<keyof typeof en, string>;
  export const en: { ...keys }; export const ru: Dict;
  export function t(lang: Lang, key: keyof typeof en, vars?: Record<string, string>): string
  export function pickLang(query: string | null, acceptLanguage: string | undefined): Lang
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tilda-server/tests/links/recipient.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';
import { checkRecipient, saveSettings, usdcAccountOf } from '../../src/links/recipient.js';

const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('checkRecipient', () => {
  it('accepts a wallet that already has a USDC account', async () => {
    const ata = await usdcAccountOf('devnet', OWNER);
    const probe = { exists: async (a: string) => a === ata };
    expect(await checkRecipient(probe, 'devnet', ` ${OWNER} `)).toEqual({ ok: true, address: OWNER });
  });

  it('rejects malformed input, the USDC mint itself and wallets without a USDC account', async () => {
    const none = { exists: async () => false };
    expect(await checkRecipient(none, 'devnet', 'abc')).toEqual({ ok: false, error: 'format' });
    expect(await checkRecipient(none, 'devnet', DEVNET_USDC)).toEqual({ ok: false, error: 'is_mint' });
    expect(await checkRecipient(none, 'devnet', OWNER)).toEqual({ ok: false, error: 'no_usdc_account' });
  });
});

describe('saveSettings', () => {
  it('changes the recipient without touching invoices already created', () => {
    const store = openLinksStore(':memory:');
    const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    expect(saveSettings(store, m.id, { recipient: OWNER, name: 'Shop', lang: 'en' })).toEqual({ ok: true });
    store.createInvoice({ id: 'i1', merchantId: m.id, amountKzt: '100', description: 'x', token: 'USDC',
      recipient: OWNER, feeBps: 50, source: 'link', createdAt: 1, expiresAt: 2 });
    const NEW = 'So11111111111111111111111111111111111111112';
    saveSettings(store, m.id, { recipient: NEW });
    expect(store.getMerchant(m.id)!.recipient).toBe(NEW);
    expect(store.getInvoice('i1')!.recipient).toBe(OWNER);
  });

  it('validates name length and language', () => {
    const store = openLinksStore(':memory:');
    const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    expect(saveSettings(store, m.id, { name: 'x'.repeat(81) })).toEqual({ ok: false, error: 'name' });
    expect(saveSettings(store, m.id, { lang: 'de' })).toEqual({ ok: false, error: 'lang' });
  });
});
```

```ts
// tilda-server/tests/links/i18n.test.ts
import { describe, expect, it } from 'vitest';
import { en, pickLang, ru, t } from '../../src/links/i18n.js';

describe('i18n', () => {
  it('has the same keys in both dictionaries and no empty strings', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    for (const v of [...Object.values(en), ...Object.values(ru)]) expect(v.trim()).not.toBe('');
  });

  it('substitutes variables', () => {
    expect(t('en', 'invoice_title', { name: 'Shop' })).toContain('Shop');
  });

  it('picks the language from query, then Accept-Language, default English', () => {
    expect(pickLang('ru', 'en-US')).toBe('ru');
    expect(pickLang(null, 'ru-RU,ru;q=0.9')).toBe('ru');
    expect(pickLang(null, 'kk-KZ')).toBe('en');
    expect(pickLang('xx', undefined)).toBe('en');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/links/recipient.test.ts tests/links/i18n.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement recipient checks and settings**

```ts
// tilda-server/src/links/recipient.ts
import { address } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { resolveToken } from '@solanapaykz/core';
import type { Lang, LinksStore } from './db.js';

export interface AccountProbe { exists(address: string): Promise<boolean> }

export async function usdcAccountOf(cluster: 'mainnet' | 'devnet', owner: string): Promise<string> {
  const mint = resolveToken(cluster, 'USDC').mint!;
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

export async function checkRecipient(probe: AccountProbe, cluster: 'mainnet' | 'devnet', raw: unknown):
  Promise<{ ok: true; address: string } | { ok: false; error: 'format' | 'is_mint' | 'no_usdc_account' }> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  let owner: string;
  try {
    owner = address(value);
  } catch {
    return { ok: false, error: 'format' };
  }
  const mints = (['mainnet', 'devnet'] as const).map((c) => resolveToken(c, 'USDC').mint);
  if (mints.includes(owner)) return { ok: false, error: 'is_mint' };
  if (!(await probe.exists(await usdcAccountOf(cluster, owner)))) return { ok: false, error: 'no_usdc_account' };
  return { ok: true, address: owner };
}

export function saveSettings(store: LinksStore, merchantId: number,
  p: { recipient?: string; name?: unknown; lang?: unknown }): { ok: true } | { ok: false; error: 'name' | 'lang' } {
  if (p.name !== undefined && (typeof p.name !== 'string' || p.name.trim().length > 80)) return { ok: false, error: 'name' };
  if (p.lang !== undefined && p.lang !== 'en' && p.lang !== 'ru') return { ok: false, error: 'lang' };
  store.updateMerchant(merchantId, {
    recipient: p.recipient,
    name: typeof p.name === 'string' ? p.name.trim() : undefined,
    lang: p.lang as Lang | undefined,
  });
  return { ok: true };
}
```

- [ ] **Step 4: Implement i18n**

```ts
// tilda-server/src/links/i18n.ts
import type { Lang } from './db.js';

export const en = {
  invoice_title: 'Payment to {name}',
  amount_kzt: 'Amount',
  you_pay: 'You pay',
  rate_note: 'Rate fixed for {minutes} min',
  open_wallet: 'Open in wallet',
  scan_qr: 'Scan with Phantom, Solflare or Backpack',
  pay_manually: 'Pay manually (any wallet or exchange)',
  network_warning: 'Send only on the Solana network. Other networks will lose the funds.',
  recipient_address: 'Recipient address',
  exact_amount: 'Exact amount',
  copy: 'Copy',
  copied: 'Copied',
  manual_hint: 'The amount the recipient gets must equal this amount exactly. Exchanges show their withdrawal fee before you confirm — add it on top.',
  status_open: 'Waiting for payment',
  status_paid: 'Paid',
  status_needs_review: 'Payment received, the seller will check it',
  status_expired: 'This invoice has expired',
  not_found: 'Invoice not found',
  sign_in: 'Sign in',
  email: 'Email',
  send_code: 'Send code',
  code: 'Code from the email',
  verify: 'Sign in',
  or: 'or',
  sign_in_wallet: 'Sign in with wallet',
  email_subject: 'Your SolanaPay-KZ sign-in code',
  email_body: 'Your code is {code}. It expires in 10 minutes. If you did not request it, ignore this email.',
  new_invoice: 'New invoice',
  description: 'What is it for',
  create: 'Create link',
  share: 'Share',
  invoices: 'Invoices',
  settings: 'Settings',
  fees: 'Service fee',
  receiving_wallet: 'Your receiving wallet (Solana address)',
  shop_name: 'Shop name',
  language: 'Language',
  save: 'Save',
  saved: 'Saved',
  sign_out: 'Sign out',
  export_csv: 'Export CSV',
  fee_debt: 'Fee owed for manual payments: {amount} {token}',
  repay: 'Pay fee',
  link_telegram: 'Link Telegram bot',
  err_no_recipient: 'Add your receiving wallet in Settings first.',
  err_debt_limit: 'Pay the service fee owed to create new invoices.',
  err_bad_amount: 'Enter an amount in tenge, for example 5000.',
  err_format: 'This is not a valid Solana address.',
  err_is_mint: 'This is a token mint address, not a wallet. Paste your wallet address.',
  err_no_usdc_account: 'This wallet has no USDC account yet. Receive any amount of USDC to it once, then try again.',
  err_generic: 'Something went wrong. Try again.',
  bot_linked: 'Telegram linked. Create invoices with /invoice 5000 Description',
  bot_help: 'Commands: /invoice <amount in KZT> <description>, /list',
  bot_unknown: 'Link this chat first: open Settings in the dashboard and press "Link Telegram bot".',
  bot_paid: 'Paid: {amount} ₸ — {description}\n{link}',
  bot_review: 'Needs review: {amount} ₸ — {description} ({reason})\n{link}',
} as const;

export type Key = keyof typeof en;
export type Dict = Record<Key, string>;

export const ru: Dict = {
  invoice_title: 'Оплата для {name}',
  amount_kzt: 'Сумма',
  you_pay: 'К оплате',
  rate_note: 'Курс зафиксирован на {minutes} мин',
  open_wallet: 'Открыть в кошельке',
  scan_qr: 'Отсканируйте в Phantom, Solflare или Backpack',
  pay_manually: 'Оплатить вручную (любой кошелёк или биржа)',
  network_warning: 'Отправляйте только в сети Solana. В других сетях средства будут потеряны.',
  recipient_address: 'Адрес получателя',
  exact_amount: 'Точная сумма',
  copy: 'Копировать',
  copied: 'Скопировано',
  manual_hint: 'Получатель должен получить ровно эту сумму. Биржа показывает комиссию за вывод до подтверждения — добавьте её сверху.',
  status_open: 'Ожидает оплаты',
  status_paid: 'Оплачено',
  status_needs_review: 'Платёж получен, продавец проверит его',
  status_expired: 'Срок счёта истёк',
  not_found: 'Счёт не найден',
  sign_in: 'Вход',
  email: 'Email',
  send_code: 'Получить код',
  code: 'Код из письма',
  verify: 'Войти',
  or: 'или',
  sign_in_wallet: 'Войти через кошелёк',
  email_subject: 'Код входа в SolanaPay-KZ',
  email_body: 'Ваш код: {code}. Он действует 10 минут. Если вы его не запрашивали, проигнорируйте письмо.',
  new_invoice: 'Новый счёт',
  description: 'За что',
  create: 'Создать ссылку',
  share: 'Поделиться',
  invoices: 'Счета',
  settings: 'Настройки',
  fees: 'Комиссия сервиса',
  receiving_wallet: 'Ваш кошелёк для приёма (адрес Solana)',
  shop_name: 'Название магазина',
  language: 'Язык',
  save: 'Сохранить',
  saved: 'Сохранено',
  sign_out: 'Выйти',
  export_csv: 'Выгрузить CSV',
  fee_debt: 'Комиссия за ручные оплаты к оплате: {amount} {token}',
  repay: 'Оплатить комиссию',
  link_telegram: 'Привязать Telegram-бота',
  err_no_recipient: 'Сначала укажите кошелёк для приёма в настройках.',
  err_debt_limit: 'Чтобы создавать новые счета, оплатите комиссию сервиса.',
  err_bad_amount: 'Введите сумму в тенге, например 5000.',
  err_format: 'Это не адрес Solana.',
  err_is_mint: 'Это адрес токена, а не кошелька. Вставьте адрес своего кошелька.',
  err_no_usdc_account: 'У этого кошелька ещё нет счёта USDC. Получите на него любую сумму USDC один раз и повторите.',
  err_generic: 'Что-то пошло не так. Попробуйте ещё раз.',
  bot_linked: 'Telegram привязан. Создавайте счета командой /invoice 5000 Описание',
  bot_help: 'Команды: /invoice <сумма в тенге> <описание>, /list',
  bot_unknown: 'Сначала привяжите чат: откройте «Настройки» в кабинете и нажмите «Привязать Telegram-бота».',
  bot_paid: 'Оплачено: {amount} ₸ — {description}\n{link}',
  bot_review: 'Требует проверки: {amount} ₸ — {description} ({reason})\n{link}',
};

const DICTS: Record<Lang, Dict> = { en, ru };

export function t(lang: Lang, key: Key, vars: Record<string, string> = {}): string {
  return DICTS[lang][key].replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}

export function pickLang(query: string | null, acceptLanguage: string | undefined): Lang {
  if (query === 'ru' || query === 'en') return query;
  return /^\s*ru\b/i.test(acceptLanguage ?? '') ? 'ru' : 'en';
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/links/recipient.test.ts tests/links/i18n.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/links/recipient.ts src/links/i18n.ts tests/links/recipient.test.ts tests/links/i18n.test.ts
git commit -m "feat(links): receiving wallet checks, merchant settings and en/ru dictionaries"
```

---

### Task 8: Invoices and quote-on-open

**Files:**
- Create: `tilda-server/src/links/invoices.ts`
- Test: `tilda-server/tests/links/invoices.test.ts`

**Interfaces:**
- Consumes: `LinksStore`, `Merchant`, `Invoice`, `QuoteRow` (Task 3); `splitFee`, `pickManualOffset` (Task 4); `parseDecimalToUnits`, `resolveToken`, `generateReference` (Task 1); `LinksConfig` (Task 2).
- Produces:
  ```ts
  export const QUOTE_TTL_MS = 15 * 60 * 1000;
  export interface Quoter { quote(amountKzt: string, token: Token): Promise<{ amountToken: string; rate: string; rateSource: string }> }
  export interface InvoiceDeps { store: LinksStore; links: LinksConfig; cluster: 'mainnet' | 'devnet';
    now: () => number; quoter: Quoter; newId?: () => string }
  export function validAmountKzt(raw: unknown): string | null
  export function createInvoiceFor(d: InvoiceDeps, merchant: Merchant,
    p: { amountKzt: unknown; description: unknown; token?: unknown }, source: 'link' | 'bot'):
    { ok: true; invoice: Invoice } | { ok: false; error: 'no_recipient' | 'bad_amount' | 'debt_limit' }
  export async function activeQuote(d: InvoiceDeps, invoice: Invoice): Promise<QuoteRow>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/invoices.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';
import { activeQuote, createInvoiceFor, QUOTE_TTL_MS, validAmountKzt, type InvoiceDeps } from '../../src/links/invoices.js';
import { loadLinksConfig } from '../../src/links/config.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function setup() {
  let now = 1_000_000;
  let calls = 0;
  const d: InvoiceDeps = {
    store: openLinksStore(':memory:'),
    links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }),
    cluster: 'devnet', now: () => now,
    quoter: { quote: async () => { calls++; return { amountToken: '10.87', rate: '460', rateSource: 'binance' }; } },
  };
  const m = d.store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  d.store.updateMerchant(m.id, { recipient: R });
  return { d, m: d.store.getMerchant(m.id)!, tick: (ms: number) => { now += ms; }, calls: () => calls };
}

describe('validAmountKzt', () => {
  it('accepts tenge with up to 2 decimals and rejects the rest', () => {
    expect(validAmountKzt('5000')).toBe('5000');
    expect(validAmountKzt(' 5000.5 ')).toBe('5000.5');
    for (const bad of ['0', '-1', '1e3', '5000.555', '', 'abc', 12, '1234567890']) expect(validAmountKzt(bad)).toBeNull();
  });
});

describe('createInvoiceFor', () => {
  it('freezes recipient, fee and expiry', () => {
    const { d, m } = setup();
    const r = createInvoiceFor(d, m, { amountKzt: '5000', description: ' Shirt ' }, 'link');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invoice).toMatchObject({ recipient: R, feeBps: 50, token: 'USDC', description: 'Shirt', state: 'open',
      expiresAt: 1_000_000 + 7 * 24 * 3600 * 1000 });
    expect(r.invoice.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('refuses without a recipient, with a bad amount, or above the debt limit', () => {
    const { d, m } = setup();
    const bare = d.store.createMerchant({ email: 'b@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    expect(createInvoiceFor(d, bare, { amountKzt: '5000', description: 'x' }, 'link')).toEqual({ ok: false, error: 'no_recipient' });
    expect(createInvoiceFor(d, m, { amountKzt: 'abc', description: 'x' }, 'link')).toEqual({ ok: false, error: 'bad_amount' });
    d.store.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: 20_000_001n, invoiceId: null, txSignature: null, createdAt: 1 });
    expect(createInvoiceFor(d, m, { amountKzt: '5000', description: 'x' }, 'link')).toEqual({ ok: false, error: 'debt_limit' });
  });
});

describe('activeQuote', () => {
  it('reuses the quote while it is valid, then creates a new one', async () => {
    const { d, m, tick, calls } = setup();
    const r = createInvoiceFor(d, m, { amountKzt: '5000', description: 'x' }, 'link');
    if (!r.ok) throw new Error('setup');
    const q1 = await activeQuote(d, r.invoice);
    const q2 = await activeQuote(d, r.invoice);
    expect(q2).toEqual(q1);
    expect(calls()).toBe(1);
    expect(q1.totalUnits).toBe(10_870_000n);
    expect(q1.feeUnits).toBe(54_350n);
    expect(q1.merchantUnits).toBe(10_815_650n);
    expect(q1.manualUnits > q1.totalUnits && q1.manualUnits <= q1.totalUnits + 9999n).toBe(true);
    tick(QUOTE_TTL_MS);
    const q3 = await activeQuote(d, r.invoice);
    expect(q3.reference).not.toBe(q1.reference);
    expect(calls()).toBe(2);
  });

  it('gives two open invoices of one merchant different manual amounts', async () => {
    const { d, m } = setup();
    const a = createInvoiceFor(d, m, { amountKzt: '5000', description: 'a' }, 'link');
    const b = createInvoiceFor(d, m, { amountKzt: '5000', description: 'b' }, 'link');
    if (!a.ok || !b.ok) throw new Error('setup');
    const qa = await activeQuote(d, a.invoice);
    const qb = await activeQuote(d, b.invoice);
    expect(qa.manualUnits).not.toBe(qb.manualUnits);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/invoices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/invoices.ts
import { randomBytes } from 'node:crypto';
import { generateReference, parseDecimalToUnits, resolveToken } from '@solanapaykz/core';
import type { LinksConfig } from './config.js';
import type { Invoice, LinksStore, Merchant, QuoteRow, Token } from './db.js';
import { pickManualOffset, splitFee } from './money.js';

export const QUOTE_TTL_MS = 15 * 60 * 1000;

export interface Quoter {
  quote(amountKzt: string, token: Token): Promise<{ amountToken: string; rate: string; rateSource: string }>;
}

export interface InvoiceDeps {
  store: LinksStore;
  links: LinksConfig;
  cluster: 'mainnet' | 'devnet';
  now: () => number;
  quoter: Quoter;
  newId?: () => string;
}

export function validAmountKzt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  return Number(v) > 0 ? v : null;
}

function overDebtLimit(d: InvoiceDeps, merchantId: number): boolean {
  return (['USDC', 'SOL'] as const).some((token) => {
    const limit = parseDecimalToUnits(d.links.debtLimit[token], resolveToken(d.cluster, token).decimals);
    return d.store.feeDebt(merchantId, token) > limit;
  });
}

export function createInvoiceFor(
  d: InvoiceDeps,
  merchant: Merchant,
  p: { amountKzt: unknown; description: unknown; token?: unknown },
  source: 'link' | 'bot',
): { ok: true; invoice: Invoice } | { ok: false; error: 'no_recipient' | 'bad_amount' | 'debt_limit' } {
  if (!merchant.recipient) return { ok: false, error: 'no_recipient' };
  const amountKzt = validAmountKzt(p.amountKzt);
  if (!amountKzt) return { ok: false, error: 'bad_amount' };
  if (overDebtLimit(d, merchant.id)) return { ok: false, error: 'debt_limit' };
  const token: Token = p.token === 'SOL' ? 'SOL' : 'USDC';
  const description = typeof p.description === 'string' ? p.description.trim().slice(0, 140) : '';
  const now = d.now();
  const invoice = d.store.createInvoice({
    id: d.newId?.() ?? randomBytes(9).toString('base64url'),
    merchantId: merchant.id, amountKzt, description, token, recipient: merchant.recipient,
    feeBps: d.links.feeBps, source, createdAt: now, expiresAt: now + d.links.invoiceTtlDays * 24 * 3600 * 1000,
  });
  return { ok: true, invoice };
}

/** Returns the invoice's current quote, creating a new one when there is none or the last one expired. */
export async function activeQuote(d: InvoiceDeps, invoice: Invoice): Promise<QuoteRow> {
  const now = d.now();
  const last = d.store.latestQuote(invoice.id);
  if (last && last.expiresAt > now) return last;

  const { amountToken, rate, rateSource } = await d.quoter.quote(invoice.amountKzt, invoice.token);
  const decimals = resolveToken(d.cluster, invoice.token).decimals;
  const totalUnits = parseDecimalToUnits(amountToken, decimals);
  const { fee, merchant } = splitFee(totalUnits, invoice.feeBps);
  const used = new Set(d.store.activeManualUnits(invoice.merchantId, invoice.token, now).map((u) => u - totalUnits));
  const offset = pickManualOffset(used);
  return d.store.insertQuote({
    invoiceId: invoice.id, totalUnits, feeUnits: fee, merchantUnits: merchant, manualUnits: totalUnits + offset,
    rate, rateSource, reference: generateReference(), createdAt: now, expiresAt: now + QUOTE_TTL_MS,
  });
}
```

Note: the core quote already rounds the token amount **up** (`convertKztToTokenUnits` uses `ceilDiv`), satisfying "quote total rounds up".

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/links/invoices.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/links/invoices.ts tests/links/invoices.test.ts
git commit -m "feat(links): invoices with frozen recipient and quote-on-open"
```

---
### Task 9: Transaction builder (fee split + reference + memo)

**Files:**
- Create: `tilda-server/src/links/tx.ts`
- Test: `tilda-server/tests/links/tx.test.ts`

**Interfaces:**
- Consumes: `resolveToken` (Task 1), `Token` (Task 3).
- Produces:
  ```ts
  export interface PayTxParams { cluster: 'mainnet' | 'devnet'; token: Token; buyer: string; merchant: string;
    feeWallet: string; merchantUnits: bigint; feeUnits: bigint; reference: string; memo: string;
    blockhash: { blockhash: string; lastValidBlockHeight: bigint } }
  export async function buildPaymentTransaction(p: PayTxParams): Promise<string>   // base64 wire transaction, unsigned
  ```
  Rules: fee payer = buyer; transfer to merchant first, with `reference` appended as a read-only non-signer account;
  fee transfer only when `feeUnits > 0n`; memo instruction last. Never creates token accounts.

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/tx.test.ts
import { describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { buildPaymentTransaction } from '../../src/links/tx.js';
import { usdcAccountOf } from '../../src/links/recipient.js';

const BUYER = generateReference();
const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const REF = generateReference();
const BH = { blockhash: generateReference(), lastValidBlockHeight: 100n };

function decode(b64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(b64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return { tx, msg, keys: msg.staticAccounts.map(String) };
}

describe('buildPaymentTransaction', () => {
  it('USDC: buyer pays fees, two transfers, reference and memo present', async () => {
    const b64 = await buildPaymentTransaction({ cluster: 'devnet', token: 'USDC', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 10_815_650n, feeUnits: 54_350n, reference: REF, memo: 'inv:abc', blockhash: BH });
    const { msg, keys } = decode(b64);
    expect(keys[0]).toBe(BUYER);
    expect(msg.header.numSignerAccounts).toBe(1);
    expect(keys).toContain(REF);
    expect(keys).toContain(await usdcAccountOf('devnet', MERCHANT));
    expect(keys).toContain(await usdcAccountOf('devnet', FEE));
    expect(msg.instructions).toHaveLength(3);
  });

  it('SOL: two system transfers plus memo; no fee transfer when fee is zero', async () => {
    const withFee = decode(await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 1_000n, feeUnits: 5n, reference: REF, memo: 'inv:abc', blockhash: BH }));
    expect(withFee.msg.instructions).toHaveLength(3);
    expect(withFee.keys).toEqual(expect.arrayContaining([BUYER, MERCHANT, FEE, REF]));

    const noFee = decode(await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 1_000n, feeUnits: 0n, reference: REF, memo: 'inv:abc', blockhash: BH }));
    expect(noFee.msg.instructions).toHaveLength(2);
    expect(noFee.keys).not.toContain(FEE);
  });

  it('leaves the signature slot empty (wallet signs)', async () => {
    const { tx } = decode(await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: BUYER, merchant: MERCHANT,
      feeWallet: FEE, merchantUnits: 1n, feeUnits: 0n, reference: REF, memo: 'm', blockhash: BH }));
    expect(Object.values(tx.signatures)).toEqual([null]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/tx.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/tx.ts
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner,
  createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction,
} from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { resolveToken } from '@solanapaykz/core';
import type { Token } from './db.js';

export interface PayTxParams {
  cluster: 'mainnet' | 'devnet';
  token: Token;
  buyer: string;
  merchant: string;
  feeWallet: string;
  merchantUnits: bigint;
  feeUnits: bigint;
  reference: string;
  memo: string;
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
}

function withReference(ix: Instruction, reference: string): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), { address: address(reference), role: AccountRole.READONLY }] };
}

export async function buildPaymentTransaction(p: PayTxParams): Promise<string> {
  const buyer = createNoopSigner(address(p.buyer));
  const transfers: Instruction[] = [];

  if (p.token === 'SOL') {
    transfers.push(getTransferSolInstruction({ source: buyer, destination: address(p.merchant), amount: p.merchantUnits }));
    if (p.feeUnits > 0n) {
      transfers.push(getTransferSolInstruction({ source: buyer, destination: address(p.feeWallet), amount: p.feeUnits }));
    }
  } else {
    const { mint, decimals } = resolveToken(p.cluster, 'USDC');
    const mintAddress = address(mint!);
    const ata = async (owner: string) =>
      (await findAssociatedTokenPda({ owner: address(owner), mint: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
    const source = await ata(p.buyer);
    transfers.push(getTransferCheckedInstruction({ source, mint: mintAddress, destination: await ata(p.merchant),
      authority: buyer, amount: p.merchantUnits, decimals }));
    if (p.feeUnits > 0n) {
      transfers.push(getTransferCheckedInstruction({ source, mint: mintAddress, destination: await ata(p.feeWallet),
        authority: buyer, amount: p.feeUnits, decimals }));
    }
  }

  transfers[0] = withReference(transfers[0]!, p.reference);
  const instructions = [...transfers, getAddMemoInstruction({ memo: p.memo })];

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(buyer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: p.blockhash.blockhash as Blockhash, lastValidBlockHeight: p.blockhash.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
```

If `tsc` reports that `Instruction` is not exported by `@solana/kit` 6.10, use the name the package exports for the
instruction type (`IInstruction` in older 2.x releases) — check with `grep -r "export type.*Instruction\b" node_modules/@solana/instructions/dist/types`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/links/tx.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: 3 tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/links/tx.ts tests/links/tx.test.ts
git commit -m "feat(links): payment transaction builder with on-chain fee split"
```

---

### Task 10: Payment validation from a fetched transaction

**Files:**
- Create: `tilda-server/src/links/validate.ts`
- Test: `tilda-server/tests/links/validate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
  export interface ParsedTx { blockTime: number | null;
    meta: { err: unknown; preBalances: (number | bigint)[]; postBalances: (number | bigint)[];
      preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
    transaction: { message: { accountKeys: { pubkey: string }[] } } }
  export function balanceDelta(tx: ParsedTx, owner: string, mint: string | null): bigint   // mint null = SOL
  export function checkSplitPayment(tx: ParsedTx, e: { mint: string | null; merchant: string; feeWallet: string;
    merchantUnits: bigint; feeUnits: bigint }): 'ok' | 'mismatch' | 'failed'
  ```
  `ParsedTx` matches `getTransaction(sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })`.

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/validate.test.ts
import { describe, expect, it } from 'vitest';
import { balanceDelta, checkSplitPayment, type ParsedTx } from '../../src/links/validate.js';

const USDC = 'USDCmint1111111111111111111111111111111111';

function usdcTx(merchantGot: bigint, feeGot: bigint, err: unknown = null): ParsedTx {
  return {
    blockTime: 1_700_000_000,
    meta: {
      err, preBalances: [5, 0, 0, 0], postBalances: [4, 0, 0, 0],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: 'buyer', uiTokenAmount: { amount: '100000000' } },
        { accountIndex: 2, mint: USDC, owner: 'merchant', uiTokenAmount: { amount: '5' } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: 'buyer', uiTokenAmount: { amount: String(100_000_000n - merchantGot - feeGot) } },
        { accountIndex: 2, mint: USDC, owner: 'merchant', uiTokenAmount: { amount: String(5n + merchantGot) } },
        { accountIndex: 3, mint: USDC, owner: 'fee', uiTokenAmount: { amount: String(feeGot) } },
      ],
    },
    transaction: { message: { accountKeys: ['buyer', 'buyerAta', 'merchantAta', 'feeAta'].map((pubkey) => ({ pubkey })) } },
  };
}

const exp = { mint: USDC, merchant: 'merchant', feeWallet: 'fee', merchantUnits: 10_815_650n, feeUnits: 54_350n };

describe('balanceDelta', () => {
  it('handles token accounts that did not exist before the transaction', () => {
    expect(balanceDelta(usdcTx(1n, 7n), 'fee', USDC)).toBe(7n);
  });

  it('computes native SOL deltas from account keys', () => {
    const tx: ParsedTx = { blockTime: 1, meta: { err: null, preBalances: [10, 3], postBalances: [5, 8] },
      transaction: { message: { accountKeys: [{ pubkey: 'buyer' }, { pubkey: 'merchant' }] } } };
    expect(balanceDelta(tx, 'merchant', null)).toBe(5n);
    expect(balanceDelta(tx, 'absent', null)).toBe(0n);
  });
});

describe('checkSplitPayment', () => {
  it('accepts exact split amounts', () => {
    expect(checkSplitPayment(usdcTx(10_815_650n, 54_350n), exp)).toBe('ok');
  });

  it('flags a missing fee transfer or a short amount', () => {
    expect(checkSplitPayment(usdcTx(10_815_650n, 0n), exp)).toBe('mismatch');
    expect(checkSplitPayment(usdcTx(10_000_000n, 54_350n), exp)).toBe('mismatch');
  });

  it('reports failed transactions', () => {
    expect(checkSplitPayment(usdcTx(10_815_650n, 54_350n, { InstructionError: [0, 'x'] }), exp)).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/validate.ts
export interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }

export interface ParsedTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances: (number | bigint)[];
    postBalances: (number | bigint)[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: { message: { accountKeys: { pubkey: string }[] } };
}

function sumTokens(list: TokenBalance[] | undefined, owner: string, mint: string): bigint {
  return (list ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
}

/** Change of `owner`'s balance in this transaction: token balance for `mint`, or lamports when `mint` is null. */
export function balanceDelta(tx: ParsedTx, owner: string, mint: string | null): bigint {
  if (!tx.meta) return 0n;
  if (mint !== null) return sumTokens(tx.meta.postTokenBalances, owner, mint) - sumTokens(tx.meta.preTokenBalances, owner, mint);
  const i = tx.transaction.message.accountKeys.findIndex((k) => String(k.pubkey) === owner);
  if (i < 0) return 0n;
  return BigInt(tx.meta.postBalances[i]!) - BigInt(tx.meta.preBalances[i]!);
}

export function checkSplitPayment(
  tx: ParsedTx,
  e: { mint: string | null; merchant: string; feeWallet: string; merchantUnits: bigint; feeUnits: bigint },
): 'ok' | 'mismatch' | 'failed' {
  if (!tx.meta || tx.meta.err !== null) return 'failed';
  const merchantOk = balanceDelta(tx, e.merchant, e.mint) === e.merchantUnits;
  const feeOk = e.feeUnits === 0n || balanceDelta(tx, e.feeWallet, e.mint) === e.feeUnits;
  return merchantOk && feeOk ? 'ok' : 'mismatch';
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/links/validate.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/links/validate.ts tests/links/validate.test.ts
git commit -m "feat(links): validate split and manual payments from transaction balances"
```

---

### Task 11: Payment detector and notifications

**Files:**
- Create: `tilda-server/src/links/detect.ts`, `tilda-server/src/links/notify.ts`
- Test: `tilda-server/tests/links/detect.test.ts`

**Interfaces:**
- Consumes: `LinksStore`, `Invoice`, `QuoteRow`, `Repayment` (Task 3); `balanceDelta`, `checkSplitPayment`, `ParsedTx` (Task 10); `usdcAccountOf` (Task 7); `resolveToken` (Task 1).
- Produces:
  ```ts
  export interface DetectRpc {
    signaturesFor(address: string, opts: { limit: number; until?: string }): Promise<{ signature: string; err: unknown }[]>;
    transaction(signature: string): Promise<ParsedTx | null>;
  }
  export type PaymentEvent = { kind: 'paid' | 'needs_review'; invoice: Invoice };
  export interface DetectDeps { store: LinksStore; rpc: DetectRpc; cluster: 'mainnet' | 'devnet'; feeWallet: string;
    now: () => number; onEvent: (e: PaymentEvent) => Promise<void>; log: { warn(m: string, f?: object): void } }
  export const LATE_WINDOW_MS = 24 * 3600 * 1000;
  export async function detectOnce(d: DetectDeps): Promise<void>
  export function startDetector(d: DetectDeps, intervalMs: number): () => void
  export function createRpc(rpcUrl: string): DetectRpc            // real implementation over @solana/kit
  // notify.ts
  export interface NotifyDeps { store: LinksStore; publicUrl: string; sendMail?: (to: string, subject: string, text: string) => Promise<void>;
    sendTelegram?: (chatId: string, text: string) => Promise<void> }
  export function createNotifier(d: NotifyDeps): (e: PaymentEvent) => Promise<void>
  ```
  Rules (spec §8, §11): request mode first, then manual scan; every signature counted once via `markProcessed`;
  paid-after-quote-expiry → `needs_review('late')`; amount mismatch → `needs_review('amount')`; payment for an invoice
  already `paid`/`needs_review` → `needs_review('duplicate')`, first `txSignature` kept; manual payment accrues
  `quote.feeUnits` to the fee ledger; fee repayments matched by reference.

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/detect.test.ts
import { describe, expect, it } from 'vitest';
import { resolveToken } from '@solanapaykz/core';
import { openLinksStore, type Invoice, type QuoteRow } from '../../src/links/db.js';
import { detectOnce, type DetectDeps, type PaymentEvent } from '../../src/links/detect.js';
import { usdcAccountOf } from '../../src/links/recipient.js';
import type { ParsedTx } from '../../src/links/validate.js';

const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const FEE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const USDC = resolveToken('devnet', 'USDC').mint!;

function tokenTx(blockTime: number, merchantGot: bigint, feeGot: bigint): ParsedTx {
  return {
    blockTime,
    meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: MERCHANT, uiTokenAmount: { amount: String(merchantGot) } },
        ...(feeGot > 0n ? [{ accountIndex: 2, mint: USDC, owner: FEE, uiTokenAmount: { amount: String(feeGot) } }] : []),
      ] },
    transaction: { message: { accountKeys: [{ pubkey: 'buyer' }, { pubkey: 'a' }, { pubkey: 'b' }] } },
  };
}

async function setup() {
  let now = 1_000_000;
  const store = openLinksStore(':memory:');
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  const invoice = store.createInvoice({ id: 'inv1', merchantId: m.id, amountKzt: '5000', description: 'Shirt',
    token: 'USDC', recipient: MERCHANT, feeBps: 50, source: 'link', createdAt: now, expiresAt: now + 7 * 86_400_000 });
  const quote = store.insertQuote({ invoiceId: 'inv1', totalUnits: 10_870_000n, feeUnits: 54_350n,
    merchantUnits: 10_815_650n, manualUnits: 10_871_234n, rate: '460', rateSource: 'binance', reference: 'REF1',
    createdAt: now, expiresAt: now + 15 * 60_000 });
  const sigs = new Map<string, { signature: string; err: unknown }[]>();
  const txs = new Map<string, ParsedTx>();
  const events: PaymentEvent[] = [];
  const merchantAta = await usdcAccountOf('devnet', MERCHANT);
  const d: DetectDeps = {
    store, cluster: 'devnet', feeWallet: FEE, now: () => now, log: { warn: () => {} },
    onEvent: async (e) => { events.push(e); },
    rpc: {
      signaturesFor: async (addr) => sigs.get(addr) ?? [],
      transaction: async (s) => txs.get(s) ?? null,
    },
  };
  const pay = (addr: string, sig: string, tx: ParsedTx) => {
    sigs.set(addr, [{ signature: sig, err: null }, ...(sigs.get(addr) ?? [])]);
    txs.set(sig, tx);
  };
  return { d, store, invoice, quote, events, pay, merchantAta, tick: (ms: number) => { now += ms; },
    nowSec: () => Math.floor(now / 1000) };
}

const state = (s: ReturnType<typeof openLinksStore>, id = 'inv1'): Invoice => s.getInvoice(id)!;

describe('detectOnce — transaction request mode', () => {
  it('marks paid on an exact split, once, even though the same tx also lands on the merchant account', async () => {
    const t = await setup();
    const tx = tokenTx(t.nowSec(), 10_815_650n, 54_350n);
    t.pay('REF1', 'sigA', tx);
    t.pay(t.merchantAta, 'sigA', tx);
    await detectOnce(t.d);
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'paid', paidMode: 'request', txSignature: 'sigA' });
    expect(t.events.map((e) => e.kind)).toEqual(['paid']);
    expect(t.store.feeDebt(t.invoice.merchantId, 'USDC')).toBe(0n);
  });

  it('sends a payment without the fee transfer to review', async () => {
    const t = await setup();
    t.pay('REF1', 'sigA', tokenTx(t.nowSec(), 10_815_650n, 0n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'needs_review', reviewReason: 'amount' });
  });

  it('sends a payment made after the quote expired to review', async () => {
    const t = await setup();
    t.tick(20 * 60_000);
    t.pay('REF1', 'sigA', tokenTx(t.nowSec(), 10_815_650n, 54_350n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'needs_review', reviewReason: 'late' });
  });

  it('flags a second payment for a paid invoice as duplicate and keeps the first signature', async () => {
    const t = await setup();
    t.pay('REF1', 'sigA', tokenTx(t.nowSec(), 10_815_650n, 54_350n));
    await detectOnce(t.d);
    t.pay('REF1', 'sigB', tokenTx(t.nowSec(), 10_815_650n, 54_350n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'needs_review', reviewReason: 'duplicate', txSignature: 'sigA' });
  });
});

describe('detectOnce — manual mode', () => {
  it('matches the unique amount, marks paid and accrues the fee as debt', async () => {
    const t = await setup();
    t.pay(t.merchantAta, 'sigM', tokenTx(t.nowSec(), 10_871_234n, 0n));
    await detectOnce(t.d);
    expect(state(t.store)).toMatchObject({ state: 'paid', paidMode: 'manual', txSignature: 'sigM' });
    expect(t.store.feeDebt(t.invoice.merchantId, 'USDC')).toBe(54_350n);
  });

  it('ignores unrelated incoming transfers', async () => {
    const t = await setup();
    t.pay(t.merchantAta, 'sigX', tokenTx(t.nowSec(), 123n, 0n));
    await detectOnce(t.d);
    expect(state(t.store).state).toBe('open');
  });
});

describe('detectOnce — expiry and repayments', () => {
  it('expires open invoices past their expiry', async () => {
    const t = await setup();
    t.tick(8 * 86_400_000);
    await detectOnce(t.d);
    expect(state(t.store).state).toBe('expired');
  });

  it('records a fee repayment found by its reference', async () => {
    const t = await setup();
    t.store.addFeeEntry({ merchantId: t.invoice.merchantId, token: 'USDC', amount: 54_350n, invoiceId: 'inv1',
      txSignature: 'sigM', createdAt: 1 });
    const r = t.store.createRepayment({ merchantId: t.invoice.merchantId, token: 'USDC', units: 54_350n,
      reference: 'REPAY1', createdAt: 1 });
    const tx: ParsedTx = { blockTime: t.nowSec(), meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: FEE, uiTokenAmount: { amount: '54350' } }] },
      transaction: { message: { accountKeys: [{ pubkey: 'x' }, { pubkey: 'y' }] } } };
    t.pay('REPAY1', 'sigR', tx);
    await detectOnce(t.d);
    expect(t.store.getRepayment(r.id)!.state).toBe('paid');
    expect(t.store.feeDebt(t.invoice.merchantId, 'USDC')).toBe(0n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the detector**

```ts
// tilda-server/src/links/detect.ts
import { address, createSolanaRpc, type Signature } from '@solana/kit';
import { resolveToken } from '@solanapaykz/core';
import type { Invoice, LinksStore, QuoteRow } from './db.js';
import { usdcAccountOf } from './recipient.js';
import { balanceDelta, checkSplitPayment, type ParsedTx } from './validate.js';

export interface DetectRpc {
  signaturesFor(address: string, opts: { limit: number; until?: string }): Promise<{ signature: string; err: unknown }[]>;
  transaction(signature: string): Promise<ParsedTx | null>;
}
export type PaymentEvent = { kind: 'paid' | 'needs_review'; invoice: Invoice };
export interface DetectDeps {
  store: LinksStore;
  rpc: DetectRpc;
  cluster: 'mainnet' | 'devnet';
  feeWallet: string;
  now: () => number;
  onEvent: (e: PaymentEvent) => Promise<void>;
  log: { warn(m: string, f?: object): void };
}

export const LATE_WINDOW_MS = 24 * 3600 * 1000;

function mintOf(d: DetectDeps, invoice: Invoice): string | null {
  return invoice.token === 'SOL' ? null : resolveToken(d.cluster, 'USDC').mint!;
}

async function record(d: DetectDeps, invoice: Invoice, quote: QuoteRow, signature: string, tx: ParsedTx,
  verdict: 'ok' | 'mismatch', mode: 'request' | 'manual'): Promise<void> {
  const current = d.store.getInvoice(invoice.id)!;
  const paidAtMs = (tx.blockTime ?? Math.floor(d.now() / 1000)) * 1000;
  let state: 'paid' | 'needs_review' = 'paid';
  let reason: string | null = null;
  if (current.state === 'paid' || current.state === 'needs_review') { state = 'needs_review'; reason = 'duplicate'; }
  else if (verdict === 'mismatch') { state = 'needs_review'; reason = 'amount'; }
  else if (paidAtMs > quote.expiresAt) { state = 'needs_review'; reason = 'late'; }

  d.store.updateInvoice(invoice.id, {
    state, reviewReason: reason, paidAt: current.paidAt ?? paidAtMs,
    txSignature: current.txSignature ?? signature, paidMode: current.paidMode ?? mode,
  });
  if (mode === 'manual' && verdict === 'ok' && quote.feeUnits > 0n) {
    d.store.addFeeEntry({ merchantId: invoice.merchantId, token: invoice.token, amount: quote.feeUnits,
      invoiceId: invoice.id, txSignature: signature, createdAt: d.now() });
  }
  await d.onEvent({ kind: state, invoice: d.store.getInvoice(invoice.id)! });
}

async function scanRequests(d: DetectDeps, invoice: Invoice): Promise<void> {
  for (const quote of d.store.quotesForInvoice(invoice.id)) {
    for (const s of await d.rpc.signaturesFor(quote.reference, { limit: 10 })) {
      if (s.err !== null || !d.store.markProcessed(s.signature)) continue;
      const tx = await d.rpc.transaction(s.signature);
      if (!tx) { d.log.warn('links: transaction not found yet', { signature: s.signature }); continue; }
      const verdict = checkSplitPayment(tx, { mint: mintOf(d, invoice), merchant: invoice.recipient,
        feeWallet: d.feeWallet, merchantUnits: quote.merchantUnits, feeUnits: quote.feeUnits });
      if (verdict === 'failed') continue;
      await record(d, invoice, quote, s.signature, tx, verdict, 'request');
    }
  }
}

async function scanManual(d: DetectDeps, recipient: string, token: Invoice['token'], invoices: Invoice[]): Promise<void> {
  const watched = token === 'SOL' ? recipient : await usdcAccountOf(d.cluster, recipient);
  const key = `manual:${watched}`;
  const until = d.store.getCheckpoint(key) ?? undefined;
  const list = await d.rpc.signaturesFor(watched, { limit: 50, until });
  if (list.length === 0) return;
  const quotes = invoices.flatMap((inv) => d.store.quotesForInvoice(inv.id).map((q) => ({ inv, q })));
  for (const s of [...list].reverse()) {
    if (s.err !== null || !d.store.markProcessed(s.signature)) continue;
    const tx = await d.rpc.transaction(s.signature);
    if (!tx) continue;
    const got = balanceDelta(tx, recipient, token === 'SOL' ? null : resolveToken(d.cluster, 'USDC').mint!);
    const match = quotes.find(({ q }) => q.manualUnits === got);
    if (match) await record(d, match.inv, match.q, s.signature, tx, 'ok', 'manual');
  }
  d.store.setCheckpoint(key, list[0]!.signature);
}

async function scanRepayments(d: DetectDeps): Promise<void> {
  for (const r of d.store.pendingRepayments()) {
    for (const s of await d.rpc.signaturesFor(r.reference, { limit: 5 })) {
      if (s.err !== null || !d.store.markProcessed(s.signature)) continue;
      const tx = await d.rpc.transaction(s.signature);
      if (!tx) continue;
      const mint = r.token === 'SOL' ? null : resolveToken(d.cluster, 'USDC').mint!;
      if (balanceDelta(tx, d.feeWallet, mint) !== r.units) continue;
      d.store.markRepaymentPaid(r.id, s.signature);
      d.store.addFeeEntry({ merchantId: r.merchantId, token: r.token, amount: -r.units, invoiceId: null,
        txSignature: s.signature, createdAt: d.now() });
    }
  }
}

export async function detectOnce(d: DetectDeps): Promise<void> {
  const now = d.now();
  d.store.expireInvoices(now);
  const candidates = d.store.candidateInvoices(now, LATE_WINDOW_MS);
  for (const invoice of candidates) await scanRequests(d, invoice);

  const groups = new Map<string, Invoice[]>();
  for (const inv of candidates) {
    const k = `${inv.recipient}|${inv.token}`;
    groups.set(k, [...(groups.get(k) ?? []), inv]);
  }
  for (const [k, invoices] of groups) {
    const [recipient, token] = k.split('|') as [string, Invoice['token']];
    await scanManual(d, recipient, token, invoices);
  }
  await scanRepayments(d);
}

export function startDetector(d: DetectDeps, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    detectOnce(d)
      .catch((e: unknown) => d.log.warn('links: detector pass failed', { message: (e as Error).message }))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function createRpc(rpcUrl: string): DetectRpc {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async signaturesFor(addr, opts) {
      const res = await rpc.getSignaturesForAddress(address(addr), {
        limit: opts.limit, commitment: 'confirmed', ...(opts.until ? { until: opts.until as Signature } : {}),
      }).send();
      return res.map((r) => ({ signature: String(r.signature), err: r.err }));
    },
    async transaction(signature) {
      const tx = await rpc.getTransaction(signature as Signature, {
        encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed',
      }).send();
      return (tx as unknown as ParsedTx | null) ?? null;
    },
  };
}
```

Note on the manual scan for invoices whose `recipient` differs from the merchant's current wallet: grouping is by the
invoice's frozen `recipient`, so old invoices keep being matched on the old address (Review Focus 4).

- [ ] **Step 4: Implement notifications**

```ts
// tilda-server/src/links/notify.ts
import type { LinksStore } from './db.js';
import type { PaymentEvent } from './detect.js';
import { t } from './i18n.js';

export interface NotifyDeps {
  store: LinksStore;
  publicUrl: string;
  sendMail?: (to: string, subject: string, text: string) => Promise<void>;
  sendTelegram?: (chatId: string, text: string) => Promise<void>;
}

export function createNotifier(d: NotifyDeps): (e: PaymentEvent) => Promise<void> {
  return async ({ kind, invoice }) => {
    const m = d.store.getMerchant(invoice.merchantId);
    if (!m) return;
    const vars = { amount: invoice.amountKzt, description: invoice.description, reason: invoice.reviewReason ?? '',
      link: `${d.publicUrl}/m/invoices#${invoice.id}` };
    const text = t(m.lang, kind === 'paid' ? 'bot_paid' : 'bot_review', vars);
    const subject = text.split('\n')[0]!;
    const jobs: Promise<void>[] = [];
    if (m.email && d.sendMail) jobs.push(d.sendMail(m.email, subject, text));
    if (m.telegramChatId && d.sendTelegram) jobs.push(d.sendTelegram(m.telegramChatId, text));
    await Promise.allSettled(jobs);
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/links/detect.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/links/detect.ts src/links/notify.ts tests/links/detect.test.ts
git commit -m "feat(links): background payment detection for request, manual and fee repayments"
```

---

### Task 12: Public invoice page and Solana Pay transaction request

**Files:**
- Create: `tilda-server/src/links/http.ts`, `tilda-server/src/links/pages.ts`, `tilda-server/src/links/routes-public.ts`, `tilda-server/public/link.js`, `tilda-server/public/link.css`
- Test: `tilda-server/tests/links/routes-public.test.ts`

**Interfaces:**
- Consumes: `InvoiceDeps`, `activeQuote` (Task 8); `buildPaymentTransaction` (Task 9); `t`, `pickLang` (Task 7); `formatUnits`, `resolveToken` (Task 1); `прочитатьТело` from `src/http/routes-pay.ts`; `экранироватьHtml` from `src/http/html.ts`.
- Produces:
  ```ts
  // http.ts
  export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void
  export function sendHtml(res: ServerResponse, status: number, html: string, headers?: Record<string, string>): void
  export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>>   // {} on empty; throws on bad JSON
  export function clientIp(req: IncomingMessage): string
  // routes-public.ts
  export interface PublicDeps extends InvoiceDeps { publicUrl: string; feeWallet: string;
    latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>; txLimiter: RateLimiter }
  export async function handlePublic(req: IncomingMessage, res: ServerResponse, url: URL, d: PublicDeps): Promise<boolean>
  export async function buildInvoiceTransaction(d: PublicDeps, invoiceId: string, account: unknown):
    Promise<{ ok: true; transaction: string; message: string } | { ok: false; status: number; error: string }>
  ```
  `buildInvoiceTransaction` is reused by the Blink endpoint (Task 13).

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/routes-public.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { createInvoiceFor } from '../../src/links/invoices.js';
import { handlePublic, type PublicDeps } from '../../src/links/routes-public.js';
import { createRateLimiter } from '../../src/links/ratelimit.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BUYER = generateReference();
let server: http.Server;
let base: string;
let d: PublicDeps;
let invoiceId: string;

beforeEach(async () => {
  const store = openLinksStore(':memory:');
  d = {
    store, links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000_000, quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
    publicUrl: 'https://pay.test', feeWallet: R, txLimiter: createRateLimiter(100, 60_000),
    latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
  };
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  store.updateMerchant(m.id, { recipient: R, name: 'Shop <A>' });
  const r = createInvoiceFor(d, store.getMerchant(m.id)!, { amountKzt: '5000', description: 'Shirt' }, 'link');
  if (!r.ok) throw new Error('setup');
  invoiceId = r.invoice.id;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handlePublic(req, res, url, d).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

describe('public invoice routes', () => {
  it('renders the page with KZT, token amount, escaped name, QR and manual details', async () => {
    const res = await fetch(`${base}/i/${invoiceId}?lang=en`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('5000');
    expect(html).toContain('10.87');
    expect(html).toContain('Shop &lt;A&gt;');
    expect(html).toContain('<svg');
    expect(html).toContain(`solana:https://pay.test/api/pay/${invoiceId}`);
    expect(html).toContain(R);
    expect(html).toContain('/assets/link.js');
  });

  it('shows the same quote on a second open', async () => {
    const a = await (await fetch(`${base}/i/${invoiceId}`)).text();
    const b = await (await fetch(`${base}/i/${invoiceId}`)).text();
    const manual = (h: string) => /data-manual-amount="([^"]+)"/.exec(h)![1];
    expect(manual(b)).toBe(manual(a));
  });

  it('renders Russian when asked', async () => {
    expect(await (await fetch(`${base}/i/${invoiceId}?lang=ru`)).text()).toContain('Оплатить вручную');
  });

  it('answers the Solana Pay GET and POST', async () => {
    const meta = await (await fetch(`${base}/api/pay/${invoiceId}`)).json();
    expect(meta).toMatchObject({ label: expect.any(String), icon: expect.stringMatching(/^https:\/\//) });
    const res = await fetch(`${base}/api/pay/${invoiceId}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: BUYER }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { transaction: string; message: string };
    expect(body.transaction.length).toBeGreaterThan(100);
    expect(body.message).toContain('5000');
  });

  it('rejects a bad account and unknown or closed invoices', async () => {
    const bad = await fetch(`${base}/api/pay/${invoiceId}`, { method: 'POST', body: JSON.stringify({ account: 'x' }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/i/nope`)).status).toBe(404);
    d.store.updateInvoice(invoiceId, { state: 'paid' });
    const closed = await fetch(`${base}/api/pay/${invoiceId}`, { method: 'POST', body: JSON.stringify({ account: BUYER }) });
    expect(closed.status).toBe(409);
  });

  it('reports status as JSON', async () => {
    expect(await (await fetch(`${base}/api/invoices/${invoiceId}/status`)).json()).toMatchObject({ state: 'open' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/routes-public.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement HTTP helpers**

```ts
// tilda-server/src/links/http.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { прочитатьТело } from '../http/routes-pay.js';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(html);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await прочитатьТело(req);
  if (text.trim() === '') return {};
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SyntaxError('JSON object expected');
  return v as Record<string, unknown>;
}

/** Remote address; behind the local nginx the first X-Forwarded-For entry is the client. */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const fwd = req.headers['x-forwarded-for'];
  if (local && typeof fwd === 'string' && fwd.trim() !== '') return fwd.split(',')[0]!.trim();
  return remote;
}
```

- [ ] **Step 4: Implement the invoice page HTML**

```ts
// tilda-server/src/links/pages.ts
import { экранироватьHtml as esc } from '../http/html.js';
import type { Invoice, Lang, Merchant } from './db.js';
import { t, type Key } from './i18n.js';

export function layout(lang: Lang, title: string, body: string, scripts: string[] = []): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/link.css"></head><body><main class="lk">${body}</main>
${scripts.map((s) => `<script src="${s}" defer></script>`).join('')}</body></html>`;
}

export function langSwitch(path: string, lang: Lang): string {
  const other: Lang = lang === 'en' ? 'ru' : 'en';
  return `<a class="lk-lang" href="${esc(path)}?lang=${other}">${other.toUpperCase()}</a>`;
}

export interface InvoiceView {
  invoice: Invoice; merchant: Merchant; lang: Lang; tokenAmount: string; manualAmount: string;
  qrSvg: string; requestUrl: string; deepLink: string; minutesLeft: number;
}

export function invoicePage(v: InvoiceView): string {
  const { invoice: inv, merchant: m, lang } = v;
  const title = t(lang, 'invoice_title', { name: m.name || 'SolanaPay-KZ' });
  const statusKey = `status_${inv.state}` as Key;
  if (inv.state !== 'open') {
    return layout(lang, title, `${langSwitch(`/i/${inv.id}`, lang)}<h1>${esc(title)}</h1>
<p class="lk-desc">${esc(inv.description)}</p><p class="lk-status lk-${inv.state}">${esc(t(lang, statusKey))}</p>`);
  }
  return layout(lang, title, `${langSwitch(`/i/${inv.id}`, lang)}
<h1>${esc(title)}</h1><p class="lk-desc">${esc(inv.description)}</p>
<p class="lk-kzt">${esc(t(lang, 'amount_kzt'))}: <b>${esc(inv.amountKzt)} ₸</b></p>
<p class="lk-token">${esc(t(lang, 'you_pay'))}: <b>${esc(v.tokenAmount)} ${inv.token}</b>
 <small>${esc(t(lang, 'rate_note', { minutes: String(v.minutesLeft) }))}</small></p>
<div class="lk-qr">${v.qrSvg}</div><p class="lk-hint">${esc(t(lang, 'scan_qr'))}</p>
<a class="lk-btn" href="${esc(v.deepLink)}">${esc(t(lang, 'open_wallet'))}</a>
<details class="lk-manual"><summary>${esc(t(lang, 'pay_manually'))}</summary>
<p class="lk-warn">${esc(t(lang, 'network_warning'))}</p>
<label>${esc(t(lang, 'recipient_address'))}</label>
<div class="lk-copy"><code>${esc(inv.recipient)}</code><button type="button" data-copy="${esc(inv.recipient)}">${esc(t(lang, 'copy'))}</button></div>
<label>${esc(t(lang, 'exact_amount'))}</label>
<div class="lk-copy"><code>${esc(v.manualAmount)} ${inv.token}</code><button type="button" data-copy="${esc(v.manualAmount)}">${esc(t(lang, 'copy'))}</button></div>
<p class="lk-hint">${esc(t(lang, 'manual_hint'))}</p></details>
<p class="lk-status" id="lk-status" data-invoice="${esc(inv.id)}" data-manual-amount="${esc(v.manualAmount)}"
 data-copied="${esc(t(lang, 'copied'))}" data-paid="${esc(t(lang, 'status_paid'))}"
 data-review="${esc(t(lang, 'status_needs_review'))}">${esc(t(lang, 'status_open'))}</p>`, ['/assets/link.js']);
}

export function notFoundPage(lang: Lang): string {
  return layout(lang, t(lang, 'not_found'), `<h1>${esc(t(lang, 'not_found'))}</h1>`);
}
```

- [ ] **Step 5: Implement the public routes**

```ts
// tilda-server/src/links/routes-public.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { address } from '@solana/kit';
import QRCode from 'qrcode';
import { formatUnits, resolveToken } from '@solanapaykz/core';
import { activeQuote, type InvoiceDeps } from './invoices.js';
import { clientIp, readJson, sendHtml, sendJson } from './http.js';
import { pickLang } from './i18n.js';
import { invoicePage, notFoundPage } from './pages.js';
import type { RateLimiter } from './ratelimit.js';
import { buildPaymentTransaction } from './tx.js';

export interface PublicDeps extends InvoiceDeps {
  publicUrl: string;
  feeWallet: string;
  latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  txLimiter: RateLimiter;
}

const INVOICE_PAGE = /^\/i\/([A-Za-z0-9_-]{1,32})$/;
const PAY_API = /^\/api\/pay\/([A-Za-z0-9_-]{1,32})$/;
const STATUS_API = /^\/api\/invoices\/([A-Za-z0-9_-]{1,32})\/status$/;

export async function buildInvoiceTransaction(d: PublicDeps, invoiceId: string, account: unknown):
  Promise<{ ok: true; transaction: string; message: string } | { ok: false; status: number; error: string }> {
  const inv = d.store.getInvoice(invoiceId);
  if (!inv) return { ok: false, status: 404, error: 'Invoice not found' };
  if (inv.state !== 'open') return { ok: false, status: 409, error: 'Invoice is not open' };
  let buyer: string;
  try { buyer = address(String(account ?? '')); } catch { return { ok: false, status: 400, error: 'Invalid account' }; }
  const q = await activeQuote(d, inv);
  const transaction = await buildPaymentTransaction({
    cluster: d.cluster, token: inv.token, buyer, merchant: inv.recipient, feeWallet: d.feeWallet,
    merchantUnits: q.merchantUnits, feeUnits: q.feeUnits, reference: q.reference, memo: `inv:${inv.id}`,
    blockhash: await d.latestBlockhash(),
  });
  const decimals = resolveToken(d.cluster, inv.token).decimals;
  return { ok: true, transaction,
    message: `${inv.amountKzt} KZT = ${formatUnits(q.totalUnits, decimals)} ${inv.token} — ${inv.description}`.slice(0, 200) };
}

export async function handlePublic(req: IncomingMessage, res: ServerResponse, url: URL, d: PublicDeps): Promise<boolean> {
  const method = req.method ?? 'GET';

  const page = INVOICE_PAGE.exec(url.pathname);
  if (page && method === 'GET') {
    const lang = pickLang(url.searchParams.get('lang'), req.headers['accept-language']);
    const inv = d.store.getInvoice(page[1]!);
    const merchant = inv ? d.store.getMerchant(inv.merchantId) : null;
    if (!inv || !merchant) { sendHtml(res, 404, notFoundPage(lang)); return true; }
    const decimals = resolveToken(d.cluster, inv.token).decimals;
    const requestUrl = `solana:${d.publicUrl}/api/pay/${inv.id}`;
    if (inv.state !== 'open') {
      sendHtml(res, 200, invoicePage({ invoice: inv, merchant, lang, tokenAmount: '', manualAmount: '', qrSvg: '',
        requestUrl, deepLink: requestUrl, minutesLeft: 0 }));
      return true;
    }
    const q = await activeQuote(d, inv);
    sendHtml(res, 200, invoicePage({
      invoice: inv, merchant, lang, requestUrl, deepLink: requestUrl,
      tokenAmount: formatUnits(q.totalUnits, decimals), manualAmount: formatUnits(q.manualUnits, decimals),
      qrSvg: await QRCode.toString(requestUrl, { type: 'svg', margin: 1, width: 240 }),
      minutesLeft: Math.max(1, Math.ceil((q.expiresAt - d.now()) / 60_000)),
    }));
    return true;
  }

  const pay = PAY_API.exec(url.pathname);
  if (pay && method === 'GET') {
    const inv = d.store.getInvoice(pay[1]!);
    const m = inv ? d.store.getMerchant(inv.merchantId) : null;
    sendJson(res, 200, { label: m?.name || 'SolanaPay-KZ', icon: new URL(d.links.iconUrl, d.publicUrl).toString() });
    return true;
  }
  if (pay && method === 'POST') {
    if (!d.txLimiter.allow(clientIp(req), d.now())) { sendJson(res, 429, { error: 'Too many requests' }); return true; }
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { sendJson(res, 400, { error: 'Invalid JSON' }); return true; }
    const r = await buildInvoiceTransaction(d, pay[1]!, body.account);
    if (!r.ok) sendJson(res, r.status, { error: r.error });
    else sendJson(res, 200, { transaction: r.transaction, message: r.message });
    return true;
  }

  const status = STATUS_API.exec(url.pathname);
  if (status && method === 'GET') {
    const inv = d.store.getInvoice(status[1]!);
    if (!inv) sendJson(res, 404, { error: 'Invoice not found' });
    else sendJson(res, 200, { state: inv.state, paidAt: inv.paidAt, txSignature: inv.txSignature });
    return true;
  }
  return false;
}
```

- [ ] **Step 6: Add the client script and styles**

```js
// tilda-server/public/link.js — copy buttons and status polling (served under CSP default-src 'self')
(() => {
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
      const old = b.textContent;
      b.textContent = document.getElementById('lk-status')?.dataset.copied || 'Copied';
      setTimeout(() => { b.textContent = old; }, 1500);
    });
  });
  const el = document.getElementById('lk-status');
  if (!el) return;
  const poll = async () => {
    try {
      const r = await fetch(`/api/invoices/${el.dataset.invoice}/status`, { cache: 'no-store' });
      const s = await r.json();
      if (s.state === 'paid') { el.textContent = el.dataset.paid; el.className = 'lk-status lk-paid'; return; }
      if (s.state === 'needs_review') { el.textContent = el.dataset.review; el.className = 'lk-status lk-needs_review'; return; }
      if (s.state === 'expired') { location.reload(); return; }
    } catch { /* retry */ }
    setTimeout(poll, 4000);
  };
  setTimeout(poll, 4000);
})();
```

```css
/* tilda-server/public/link.css */
:root { --fg:#111; --muted:#666; --accent:#6c4cf1; --ok:#0a7d38; --warn:#a15c00; --bg:#fafafa; }
* { box-sizing: border-box; }
body { margin:0; font:16px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:var(--fg); background:var(--bg); }
.lk { max-width:440px; margin:0 auto; padding:20px 16px 48px; }
.lk h1 { font-size:1.3rem; margin:8px 0; }
.lk-lang { float:right; color:var(--muted); text-decoration:none; }
.lk-desc, .lk-hint, small { color:var(--muted); }
.lk-qr svg { width:240px; height:240px; display:block; margin:12px auto; background:#fff; }
.lk-btn, button { display:inline-block; background:var(--accent); color:#fff; border:0; border-radius:10px; padding:12px 18px;
  text-decoration:none; font-size:1rem; cursor:pointer; }
.lk-btn { display:block; text-align:center; margin:12px 0; }
.lk-manual { margin-top:16px; background:#fff; border:1px solid #e5e5e5; border-radius:10px; padding:12px; }
.lk-copy { display:flex; gap:8px; align-items:center; margin:4px 0 10px; }
.lk-copy code { flex:1; overflow-wrap:anywhere; font-size:.85rem; }
.lk-copy button { padding:6px 10px; font-size:.85rem; }
.lk-warn { color:var(--warn); font-weight:600; }
.lk-status { margin-top:18px; font-weight:600; }
.lk-paid { color:var(--ok); } .lk-needs_review { color:var(--warn); }
form label { display:block; margin-top:10px; } input, select { width:100%; padding:10px; font-size:1rem; border:1px solid #ccc; border-radius:8px; }
table { width:100%; border-collapse:collapse; font-size:.9rem; } td, th { padding:6px 4px; border-bottom:1px solid #eee; text-align:left; }
nav a { margin-right:12px; }
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/links/routes-public.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/links/http.ts src/links/pages.ts src/links/routes-public.ts public/link.js public/link.css tests/links/routes-public.test.ts
git commit -m "feat(links): public invoice page, manual payment tab and Solana Pay transaction request"
```

---
### Task 13: Solana Actions (Blink) for invoices

**Files:**
- Create: `tilda-server/src/links/routes-actions.ts`
- Test: `tilda-server/tests/links/routes-actions.test.ts`

**Interfaces:**
- Consumes: `PublicDeps`, `buildInvoiceTransaction` (Task 12); `sendJson`, `readJson` (Task 12).
- Produces: `export async function handleActions(req, res, url, d: PublicDeps): Promise<boolean>` serving
  `GET /actions.json`, `OPTIONS|GET|POST /api/actions/i/:id`. Every response carries `ACTIONS_HEADERS`:
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,POST,PUT,OPTIONS`,
  `Access-Control-Allow-Headers: Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids`,
  `Access-Control-Expose-Headers: X-Action-Version, X-Blockchain-Ids`, `X-Action-Version: 2.4`,
  `X-Blockchain-Ids: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet) or `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet).

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/routes-actions.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { createInvoiceFor } from '../../src/links/invoices.js';
import { createRateLimiter } from '../../src/links/ratelimit.js';
import { handleActions } from '../../src/links/routes-actions.js';
import type { PublicDeps } from '../../src/links/routes-public.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BUYER = generateReference();
let server: http.Server; let base: string; let id: string;

beforeEach(async () => {
  const store = openLinksStore(':memory:');
  const d: PublicDeps = {
    store, links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000_000, quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
    publicUrl: 'https://pay.test', feeWallet: R, txLimiter: createRateLimiter(100, 60_000),
    latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
  };
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
  store.updateMerchant(m.id, { recipient: R, name: 'Shop A' });
  const r = createInvoiceFor(d, store.getMerchant(m.id)!, { amountKzt: '5000', description: 'Shirt' }, 'link');
  if (!r.ok) throw new Error('setup');
  id = r.invoice.id;
  server = http.createServer((req, res) => {
    void handleActions(req, res, new URL(req.url ?? '/', 'http://x'), d).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

describe('Solana Actions', () => {
  it('serves actions.json mapping invoice pages to the action API', async () => {
    const res = await fetch(`${base}/actions.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ rules: [{ pathPattern: '/i/*', apiPath: '/api/actions/i/*' }] });
  });

  it('describes the invoice with required headers', async () => {
    const res = await fetch(`${base}/api/actions/i/${id}`);
    expect(res.headers.get('x-action-version')).toBe('2.4');
    expect(res.headers.get('x-blockchain-ids')).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'action', label: expect.stringContaining('10.87'), title: expect.stringContaining('Shop A') });
    expect(String(body.icon)).toMatch(/^https:\/\//);
  });

  it('answers preflight and returns a transaction on POST', async () => {
    expect((await fetch(`${base}/api/actions/i/${id}`, { method: 'OPTIONS' })).status).toBe(200);
    const res = await fetch(`${base}/api/actions/i/${id}`, { method: 'POST', body: JSON.stringify({ account: BUYER }) });
    const body = await res.json() as { type: string; transaction: string };
    expect(body.type).toBe('transaction');
    expect(body.transaction.length).toBeGreaterThan(100);
  });

  it('returns an action error for a closed invoice', async () => {
    const res = await fetch(`${base}/api/actions/i/nope`, { method: 'POST', body: JSON.stringify({ account: BUYER }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Invoice not found' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/routes-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/routes-actions.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { formatUnits, resolveToken } from '@solanapaykz/core';
import { activeQuote } from './invoices.js';
import { readJson, sendJson } from './http.js';
import { buildInvoiceTransaction, type PublicDeps } from './routes-public.js';

const CHAIN_IDS = { mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' };
const ACTION = /^\/api\/actions\/i\/([A-Za-z0-9_-]{1,32})$/;

function actionsHeaders(cluster: 'mainnet' | 'devnet'): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids',
    'access-control-expose-headers': 'X-Action-Version, X-Blockchain-Ids',
    'x-action-version': '2.4',
    'x-blockchain-ids': CHAIN_IDS[cluster],
  };
}

export async function handleActions(req: IncomingMessage, res: ServerResponse, url: URL, d: PublicDeps): Promise<boolean> {
  const method = req.method ?? 'GET';
  const h = actionsHeaders(d.cluster);

  if (url.pathname === '/actions.json' && (method === 'GET' || method === 'OPTIONS')) {
    sendJson(res, 200, { rules: [{ pathPattern: '/i/*', apiPath: '/api/actions/i/*' }] }, h);
    return true;
  }

  const match = ACTION.exec(url.pathname);
  if (!match) return false;
  if (method === 'OPTIONS') { sendJson(res, 200, {}, h); return true; }

  if (method === 'GET') {
    const inv = d.store.getInvoice(match[1]!);
    const m = inv ? d.store.getMerchant(inv.merchantId) : null;
    if (!inv || !m) { sendJson(res, 404, { message: 'Invoice not found' }, h); return true; }
    const icon = new URL(d.links.iconUrl, d.publicUrl).toString();
    if (inv.state !== 'open') {
      sendJson(res, 200, { type: 'action', icon, title: m.name || 'SolanaPay-KZ', description: inv.description,
        label: inv.state, disabled: true }, h);
      return true;
    }
    const q = await activeQuote(d, inv);
    const amount = formatUnits(q.totalUnits, resolveToken(d.cluster, inv.token).decimals);
    sendJson(res, 200, { type: 'action', icon, title: `${m.name || 'SolanaPay-KZ'} — ${inv.amountKzt} KZT`,
      description: inv.description, label: `Pay ${amount} ${inv.token}` }, h);
    return true;
  }

  if (method === 'POST') {
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { sendJson(res, 400, { message: 'Invalid JSON' }, h); return true; }
    const r = await buildInvoiceTransaction(d, match[1]!, body.account);
    if (!r.ok) sendJson(res, r.status, { message: r.error }, h);
    else sendJson(res, 200, { type: 'transaction', transaction: r.transaction, message: r.message }, h);
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/links/routes-actions.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/links/routes-actions.ts tests/links/routes-actions.test.ts
git commit -m "feat(links): Solana Actions endpoints so invoice links work as Blinks"
```

---

### Task 14: Merchant sign-in, dashboard, CSV and fee repayment

**Files:**
- Create: `tilda-server/src/links/routes-merchant.ts`, `tilda-server/public/dashboard.js`
- Modify: `tilda-server/src/links/pages.ts` (append dashboard pages)
- Test: `tilda-server/tests/links/routes-merchant.test.ts`

**Interfaces:**
- Consumes: Tasks 3–9 and 12 (`AuthDeps`, `startEmailLogin`, `verifyEmailLogin`, `createSessionFor`, `readSession`,
  `clearSessionCookie`, `issueNonce`, `signInMessage`, `verifyWalletSignIn`, `checkRecipient`, `saveSettings`,
  `createInvoiceFor`, `buildPaymentTransaction`, `sendJson`, `sendHtml`, `readJson`, `clientIp`, `layout`).
- Produces:
  ```ts
  export interface MerchantDeps extends PublicDeps { auth: AuthDeps; probe: AccountProbe; host: string;
    authLimiter: RateLimiter; botUsername?: string }
  export async function handleMerchant(req, res, url: URL, d: MerchantDeps): Promise<boolean>
  export function invoicesCsv(invoices: Invoice[]): string
  ```
  Routes: `GET /m`, `GET /m/invoices`, `GET /m/settings`, `GET /m/invoices.csv`, `POST /api/auth/email/start`,
  `POST /api/auth/email/verify`, `POST /api/auth/wallet/nonce`, `POST /api/auth/wallet/verify`, `POST /api/auth/logout`,
  `POST /api/merchant/invoices`, `GET /api/merchant/invoices`, `PUT /api/merchant/settings`,
  `POST /api/merchant/fees/repay`, `POST /api/merchant/telegram-link`, `GET|POST /api/fees/:id` (public, wallet calls it).
  All `/api/merchant/*` mutations require header `x-csrf-token` equal to the session's csrf.

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/routes-merchant.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { createRateLimiter } from '../../src/links/ratelimit.js';
import { handleMerchant, invoicesCsv, type MerchantDeps } from '../../src/links/routes-merchant.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BUYER = generateReference();
let server: http.Server; let base: string; let d: MerchantDeps; let codes: string[];

beforeEach(async () => {
  codes = [];
  const store = openLinksStore(':memory:');
  d = {
    store, links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000_000, quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
    publicUrl: 'https://pay.test', feeWallet: R, txLimiter: createRateLimiter(100, 60_000), host: 'pay.test',
    latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
    auth: { store, pepper: 'pepper-pepper-pepper', now: () => 1_000_000, sendCode: async (_e, c) => { codes.push(c); } },
    probe: { exists: async () => true }, authLimiter: createRateLimiter(100, 60_000), botUsername: 'spk_bot',
  };
  server = http.createServer((req, res) => {
    void handleMerchant(req, res, new URL(req.url ?? '/', 'http://x'), d).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  await fetch(`${base}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email, lang: 'en' }) });
  const res = await fetch(`${base}/api/auth/email/verify`, { method: 'POST',
    body: JSON.stringify({ email, code: codes.at(-1), lang: 'en' }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = await res.json() as { csrf: string };
  return { cookie, csrf };
}

function call(path: string, s: { cookie: string; csrf: string }, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, { method, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

describe('merchant routes', () => {
  it('shows the sign-in page without a session and the dashboard with one', async () => {
    expect(await (await fetch(`${base}/m`)).text()).toContain('/api/auth/email/start');
    const s = await signIn('a@shop.kz');
    expect(await (await call('/m', s)).text()).toContain('data-csrf');
  });

  it('creates an invoice after setting a recipient, and refuses without csrf', async () => {
    const s = await signIn('a@shop.kz');
    expect((await call('/api/merchant/invoices', s, 'POST', { amountKzt: '5000', description: 'x' })).status).toBe(400);
    expect((await call('/api/merchant/settings', s, 'PUT', { recipient: R, name: 'Shop' })).status).toBe(200);
    const res = await call('/api/merchant/invoices', s, 'POST', { amountKzt: '5000', description: 'Shirt' });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; url: string };
    expect(body.url).toBe(`https://pay.test/i/${body.id}`);
    const noCsrf = await fetch(`${base}/api/merchant/invoices`, { method: 'POST', headers: { cookie: s.cookie },
      body: JSON.stringify({ amountKzt: '1', description: 'y' }) });
    expect(noCsrf.status).toBe(403);
  });

  it('isolates merchants from each other', async () => {
    const a = await signIn('a@shop.kz');
    await call('/api/merchant/settings', a, 'PUT', { recipient: R });
    await call('/api/merchant/invoices', a, 'POST', { amountKzt: '5000', description: 'A only' });
    const b = await signIn('b@shop.kz');
    expect(await (await call('/api/merchant/invoices', b)).json()).toEqual({ invoices: [] });
    expect(await (await call('/m/invoices.csv', b)).text()).not.toContain('A only');
    expect((await fetch(`${base}/api/merchant/invoices`)).status).toBe(401);
  });

  it('rejects a mint address as recipient with a readable error', async () => {
    const s = await signIn('a@shop.kz');
    const res = await call('/api/merchant/settings', s, 'PUT', { recipient: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'is_mint' });
  });

  it('creates a fee repayment and serves its transaction request', async () => {
    const s = await signIn('a@shop.kz');
    const m = d.store.findMerchantByEmail('a@shop.kz')!;
    d.store.addFeeEntry({ merchantId: m.id, token: 'USDC', amount: 54_350n, invoiceId: null, txSignature: null, createdAt: 1 });
    const res = await call('/api/merchant/fees/repay', s, 'POST', { token: 'USDC' });
    const { url } = await res.json() as { url: string };
    expect(url).toMatch(/^solana:https:\/\/pay\.test\/api\/fees\/\d+$/);
    const tx = await fetch(`${base}${new URL(url.slice('solana:'.length)).pathname}`, { method: 'POST',
      body: JSON.stringify({ account: BUYER }) });
    expect(tx.status).toBe(200);
  });

  it('issues a one-time Telegram link code', async () => {
    const s = await signIn('a@shop.kz');
    const { url } = await (await call('/api/merchant/telegram-link', s, 'POST', {})).json() as { url: string };
    expect(url).toMatch(/^https:\/\/t\.me\/spk_bot\?start=[A-Za-z0-9_-]+$/);
  });
});

describe('invoicesCsv', () => {
  it('quotes fields and neutralizes spreadsheet formulas', () => {
    const csv = invoicesCsv([{ id: 'i1', merchantId: 1, amountKzt: '5000', description: '=HYPERLINK("x"), "q"',
      token: 'USDC', recipient: R, feeBps: 50, state: 'paid', source: 'link', createdAt: 0, expiresAt: 0,
      paidAt: 0, txSignature: 'sig', paidMode: 'manual', reviewReason: null }]);
    expect(csv.split('\n')[0]).toBe('id,created_at,amount_kzt,description,token,state,paid_at,tx_signature,paid_mode');
    expect(csv).toContain(`"'=HYPERLINK(""x""), ""q"""`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/routes-merchant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Append dashboard pages to `pages.ts`**

```ts
// append to tilda-server/src/links/pages.ts
export function loginPage(lang: Lang): string {
  return layout(lang, t(lang, 'sign_in'), `${langSwitch('/m', lang)}<h1>${esc(t(lang, 'sign_in'))}</h1>
<form id="lk-email" data-start="/api/auth/email/start" data-verify="/api/auth/email/verify" data-lang="${lang}">
<label>${esc(t(lang, 'email'))}<input name="email" type="email" required autocomplete="email"></label>
<button type="submit">${esc(t(lang, 'send_code'))}</button>
<label hidden>${esc(t(lang, 'code'))}<input name="code" inputmode="numeric" pattern="\\d{6}"></label>
<button type="button" id="lk-verify" hidden>${esc(t(lang, 'verify'))}</button></form>
<p>${esc(t(lang, 'or'))}</p><button type="button" id="lk-wallet">${esc(t(lang, 'sign_in_wallet'))}</button>
<p id="lk-msg" class="lk-hint"></p>`, ['/assets/dashboard.js']);
}

function nav(lang: Lang): string {
  return `<nav><a href="/m">${esc(t(lang, 'new_invoice'))}</a><a href="/m/invoices">${esc(t(lang, 'invoices'))}</a>
<a href="/m/settings">${esc(t(lang, 'settings'))}</a></nav>`;
}

export function dashboardPage(m: Merchant, csrf: string, debts: { token: string; amount: string }[]): string {
  const lang = m.lang;
  const debt = debts.filter((x) => x.amount !== '0').map((x) =>
    `<p class="lk-warn">${esc(t(lang, 'fee_debt', { amount: x.amount, token: x.token }))}
 <button type="button" data-repay="${x.token}">${esc(t(lang, 'repay'))}</button></p>`).join('');
  return layout(lang, t(lang, 'new_invoice'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>${nav(lang)}
${m.recipient ? '' : `<p class="lk-warn">${esc(t(lang, 'err_no_recipient'))}</p>`}${debt}
<h1>${esc(t(lang, 'new_invoice'))}</h1><form id="lk-new">
<label>${esc(t(lang, 'amount_kzt'))}, ₸<input name="amountKzt" inputmode="decimal" required></label>
<label>${esc(t(lang, 'description'))}<input name="description" maxlength="140"></label>
<label>Token<select name="token"><option>USDC</option><option>SOL</option></select></label>
<button type="submit">${esc(t(lang, 'create'))}</button></form>
<div id="lk-result" hidden><code id="lk-url"></code> <button type="button" id="lk-share">${esc(t(lang, 'share'))}</button></div>
<p id="lk-msg" class="lk-hint"></p>`, ['/assets/dashboard.js']);
}

export function invoicesPage(m: Merchant, csrf: string, invoices: Invoice[], explorer: (sig: string) => string): string {
  const lang = m.lang;
  const rows = invoices.map((i) => `<tr id="${esc(i.id)}"><td>${new Date(i.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
<td>${esc(i.amountKzt)} ₸</td><td>${esc(i.description)}</td><td class="lk-${i.state}">${esc(t(lang, `status_${i.state}` as Key))}
${i.reviewReason ? ` (${esc(i.reviewReason)})` : ''}</td>
<td>${i.txSignature ? `<a href="${esc(explorer(i.txSignature))}" rel="noopener">tx</a>` : `<a href="/i/${esc(i.id)}">link</a>`}</td></tr>`).join('');
  return layout(lang, t(lang, 'invoices'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>${nav(lang)}
<h1>${esc(t(lang, 'invoices'))}</h1><p><a href="/m/invoices.csv">${esc(t(lang, 'export_csv'))}</a></p>
<table><tbody>${rows}</tbody></table>`, ['/assets/dashboard.js']);
}

export function settingsPage(m: Merchant, csrf: string, hasBot: boolean): string {
  const lang = m.lang;
  return layout(lang, t(lang, 'settings'), `<div data-csrf="${esc(csrf)}" id="lk-session"></div>${nav(lang)}
<h1>${esc(t(lang, 'settings'))}</h1><form id="lk-settings">
<label>${esc(t(lang, 'receiving_wallet'))}<input name="recipient" value="${esc(m.recipient ?? '')}" autocomplete="off" spellcheck="false"></label>
<label>${esc(t(lang, 'shop_name'))}<input name="name" maxlength="80" value="${esc(m.name)}"></label>
<label>${esc(t(lang, 'language'))}<select name="lang"><option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
<option value="ru"${lang === 'ru' ? ' selected' : ''}>Русский</option></select></label>
<button type="submit">${esc(t(lang, 'save'))}</button></form>
${hasBot ? `<p><button type="button" id="lk-tg">${esc(t(lang, 'link_telegram'))}</button></p>` : ''}
<form method="post" action="/api/auth/logout"><button type="submit">${esc(t(lang, 'sign_out'))}</button></form>
<p id="lk-msg" class="lk-hint" data-saved="${esc(t(lang, 'saved'))}"></p>`, ['/assets/dashboard.js']);
}
```

- [ ] **Step 4: Implement the merchant routes**

```ts
// tilda-server/src/links/routes-merchant.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { address } from '@solana/kit';
import { formatUnits, generateReference, resolveToken } from '@solanapaykz/core';
import { clearSessionCookie, createSessionFor, randomToken, readSession, startEmailLogin, verifyEmailLogin, type AuthDeps } from './auth.js';
import type { Invoice, Lang, Token } from './db.js';
import { clientIp, readJson, sendHtml, sendJson } from './http.js';
import { createInvoiceFor } from './invoices.js';
import { dashboardPage, invoicesPage, loginPage, settingsPage } from './pages.js';
import type { RateLimiter } from './ratelimit.js';
import { checkRecipient, saveSettings, type AccountProbe } from './recipient.js';
import type { PublicDeps } from './routes-public.js';
import { buildPaymentTransaction } from './tx.js';
import { issueNonce, signInMessage, verifyWalletSignIn } from './wallet-auth.js';

export interface MerchantDeps extends PublicDeps {
  auth: AuthDeps;
  probe: AccountProbe;
  host: string;
  authLimiter: RateLimiter;
  botUsername?: string;
}

const FEE_TX = /^\/api\/fees\/(\d{1,12})$/;

function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function invoicesCsv(invoices: Invoice[]): string {
  const head = 'id,created_at,amount_kzt,description,token,state,paid_at,tx_signature,paid_mode';
  const rows = invoices.map((i) => [i.id, new Date(i.createdAt).toISOString(), i.amountKzt, i.description, i.token, i.state,
    i.paidAt === null ? '' : new Date(i.paidAt).toISOString(), i.txSignature ?? '', i.paidMode ?? ''].map(csvCell).join(','));
  return [head, ...rows].join('\n') + '\n';
}

function explorer(cluster: 'mainnet' | 'devnet'): (sig: string) => string {
  return (sig) => `https://explorer.solana.com/tx/${sig}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}

function langOf(v: unknown): Lang { return v === 'ru' ? 'ru' : 'en'; }

async function body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  try { return await readJson(req); } catch { sendJson(res, 400, { error: 'invalid_json' }); return null; }
}

function signedIn(res: ServerResponse, d: MerchantDeps, merchantId: number): void {
  const s = createSessionFor(d.auth, merchantId);
  sendJson(res, 200, { ok: true, csrf: s.csrf }, { 'set-cookie': s.cookie });
}

export async function handleMerchant(req: IncomingMessage, res: ServerResponse, url: URL, d: MerchantDeps): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const now = d.now();

  // --- public: fee repayment transaction request (called by the wallet) ---
  const fee = FEE_TX.exec(path);
  if (fee) {
    const r = d.store.getRepayment(Number(fee[1]));
    if (method === 'GET') { sendJson(res, 200, { label: 'SolanaPay-KZ fee', icon: new URL(d.links.iconUrl, d.publicUrl).toString() }); return true; }
    if (method !== 'POST') return false;
    if (!r || r.state !== 'pending') { sendJson(res, 404, { error: 'Repayment not found' }); return true; }
    const b = await body(req, res); if (!b) return true;
    let buyer: string;
    try { buyer = address(String(b.account ?? '')); } catch { sendJson(res, 400, { error: 'Invalid account' }); return true; }
    const transaction = await buildPaymentTransaction({ cluster: d.cluster, token: r.token, buyer, merchant: d.feeWallet,
      feeWallet: d.feeWallet, merchantUnits: r.units, feeUnits: 0n, reference: r.reference, memo: `fee:${r.id}`,
      blockhash: await d.latestBlockhash() });
    sendJson(res, 200, { transaction, message: 'SolanaPay-KZ service fee' });
    return true;
  }

  // --- auth endpoints ---
  if (path.startsWith('/api/auth/') && method === 'POST') {
    if (!d.authLimiter.allow(clientIp(req), now)) { sendJson(res, 429, { error: 'too_many' }); return true; }
    if (path === '/api/auth/logout') {
      const s = readSession(d.auth, req.headers.cookie);
      if (s) d.store.deleteSession(s.id);
      res.writeHead(303, { location: '/m', 'set-cookie': clearSessionCookie() }); res.end();
      return true;
    }
    const b = await body(req, res); if (!b) return true;
    if (path === '/api/auth/email/start') {
      const r = await startEmailLogin(d.auth, b.email, langOf(b.lang));
      sendJson(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (path === '/api/auth/email/verify') {
      const r = verifyEmailLogin(d.auth, b.email, b.code, langOf(b.lang));
      if (r.ok) signedIn(res, d, r.merchantId); else sendJson(res, 400, r);
      return true;
    }
    if (path === '/api/auth/wallet/nonce') {
      const nonce = issueNonce(d.store, now);
      sendJson(res, 200, { nonce, message: signInMessage(d.host, nonce) });
      return true;
    }
    if (path === '/api/auth/wallet/verify') {
      const r = verifyWalletSignIn(d.store, now, { host: d.host, address: b.address, nonce: b.nonce, signature: b.signature, lang: langOf(b.lang) });
      if (r.ok) signedIn(res, d, r.merchantId); else sendJson(res, 400, r);
      return true;
    }
    return false;
  }

  const isPage = path === '/m' || path === '/m/invoices' || path === '/m/settings' || path === '/m/invoices.csv';
  const isApi = path.startsWith('/api/merchant/');
  if (!isPage && !isApi) return false;

  const session = readSession(d.auth, req.headers.cookie);
  const merchant = session ? d.store.getMerchant(session.merchantId) : null;
  if (!session || !merchant) {
    if (isApi) sendJson(res, 401, { error: 'unauthorized' });
    else if (path === '/m') sendHtml(res, 200, loginPage(langOf(url.searchParams.get('lang'))));
    else { res.writeHead(303, { location: '/m' }); res.end(); }
    return true;
  }

  if (method === 'GET' && path === '/m') {
    const debts = (['USDC', 'SOL'] as const).map((token) => ({ token,
      amount: formatUnits(d.store.feeDebt(merchant.id, token) > 0n ? d.store.feeDebt(merchant.id, token) : 0n,
        resolveToken(d.cluster, token).decimals) }));
    sendHtml(res, 200, dashboardPage(merchant, session.csrf, debts));
    return true;
  }
  if (method === 'GET' && path === '/m/invoices') {
    sendHtml(res, 200, invoicesPage(merchant, session.csrf, d.store.listInvoices(merchant.id, 200), explorer(d.cluster)));
    return true;
  }
  if (method === 'GET' && path === '/m/settings') {
    sendHtml(res, 200, settingsPage(merchant, session.csrf, Boolean(d.botUsername)));
    return true;
  }
  if (method === 'GET' && path === '/m/invoices.csv') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="invoices.csv"',
      'cache-control': 'no-store' });
    res.end(invoicesCsv(d.store.listInvoices(merchant.id, 10_000)));
    return true;
  }
  if (method === 'GET' && path === '/api/merchant/invoices') {
    sendJson(res, 200, { invoices: d.store.listInvoices(merchant.id, 200) });
    return true;
  }

  if (req.headers['x-csrf-token'] !== session.csrf) { sendJson(res, 403, { error: 'csrf' }); return true; }
  const b = await body(req, res); if (!b) return true;

  if (method === 'POST' && path === '/api/merchant/invoices') {
    const r = createInvoiceFor(d, merchant, { amountKzt: b.amountKzt, description: b.description, token: b.token }, 'link');
    if (!r.ok) sendJson(res, 400, r);
    else sendJson(res, 200, { id: r.invoice.id, url: `${d.publicUrl}/i/${r.invoice.id}` });
    return true;
  }
  if (method === 'PUT' && path === '/api/merchant/settings') {
    let recipient: string | undefined;
    if (b.recipient !== undefined && b.recipient !== merchant.recipient) {
      const c = await checkRecipient(d.probe, d.cluster, b.recipient);
      if (!c.ok) { sendJson(res, 400, c); return true; }
      recipient = c.address;
    }
    const r = saveSettings(d.store, merchant.id, { recipient, name: b.name, lang: b.lang });
    sendJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (method === 'POST' && path === '/api/merchant/fees/repay') {
    const token: Token = b.token === 'SOL' ? 'SOL' : 'USDC';
    const units = d.store.feeDebt(merchant.id, token);
    if (units <= 0n) { sendJson(res, 400, { error: 'no_debt' }); return true; }
    const r = d.store.createRepayment({ merchantId: merchant.id, token, units, reference: generateReference(), createdAt: now });
    sendJson(res, 200, { url: `solana:${d.publicUrl}/api/fees/${r.id}` });
    return true;
  }
  if (method === 'POST' && path === '/api/merchant/telegram-link') {
    if (!d.botUsername) { sendJson(res, 404, { error: 'no_bot' }); return true; }
    const code = randomToken(12);
    d.store.putBotLink(code, merchant.id, now + 15 * 60_000);
    sendJson(res, 200, { url: `https://t.me/${d.botUsername}?start=${code}` });
    return true;
  }
  return false;
}
```

- [ ] **Step 5: Add the dashboard script**

```js
// tilda-server/public/dashboard.js — sign-in, invoice creation, settings, repayment, Telegram link
(() => {
  const $ = (s) => document.querySelector(s);
  const msg = (text) => { const el = $('#lk-msg'); if (el) el.textContent = text; };
  const csrf = $('#lk-session')?.dataset.csrf;
  const api = async (path, method, body) => {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const b58 = (bytes) => { // minimal base58 encoder for the wallet signature
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; s = '1' + s; } return s;
  };

  const emailForm = $('#lk-email');
  if (emailForm) {
    const lang = emailForm.dataset.lang;
    emailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api(emailForm.dataset.start, 'POST', { email: emailForm.email.value, lang });
      if (r.status !== 200) return msg(r.data.error || 'error');
      emailForm.code.parentElement.hidden = false; $('#lk-verify').hidden = false;
    });
    $('#lk-verify').addEventListener('click', async () => {
      const r = await api(emailForm.dataset.verify, 'POST', { email: emailForm.email.value, code: emailForm.code.value, lang });
      if (r.status === 200) location.href = '/m'; else msg(r.data.error || 'error');
    });
    $('#lk-wallet').addEventListener('click', async () => {
      const w = window.phantom?.solana || window.solflare || window.solana;
      if (!w) return msg('Install Phantom or Solflare, or open this page in the wallet browser.');
      const { publicKey } = await w.connect();
      const n = await api('/api/auth/wallet/nonce', 'POST', {});
      const signed = await w.signMessage(new TextEncoder().encode(n.data.message), 'utf8');
      const sig = signed.signature || signed;
      const r = await api('/api/auth/wallet/verify', 'POST', { address: publicKey.toString(), nonce: n.data.nonce, signature: b58(sig), lang });
      if (r.status === 200) location.href = '/m'; else msg(r.data.error || 'error');
    });
  }

  const newForm = $('#lk-new');
  if (newForm) newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/merchant/invoices', 'POST', { amountKzt: newForm.amountKzt.value, description: newForm.description.value, token: newForm.token.value });
    if (r.status !== 200) return msg(r.data.error || 'error');
    $('#lk-url').textContent = r.data.url; $('#lk-result').hidden = false;
    $('#lk-share').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ url: r.data.url }); return; } catch { /* fall through */ } }
      await navigator.clipboard.writeText(r.data.url);
    };
  });

  document.querySelectorAll('[data-repay]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('/api/merchant/fees/repay', 'POST', { token: b.dataset.repay });
    if (r.status === 200) location.href = r.data.url; else msg(r.data.error || 'error');
  }));

  const settings = $('#lk-settings');
  if (settings) settings.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/merchant/settings', 'PUT', { recipient: settings.recipient.value.trim(), name: settings.name.value, lang: settings.lang.value });
    msg(r.status === 200 ? $('#lk-msg').dataset.saved : (r.data.error || 'error'));
  });

  const tg = $('#lk-tg');
  if (tg) tg.addEventListener('click', async () => {
    const r = await api('/api/merchant/telegram-link', 'POST', {});
    if (r.status === 200) location.href = r.data.url;
  });
})();
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/links/routes-merchant.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/links/routes-merchant.ts src/links/pages.ts public/dashboard.js tests/links/routes-merchant.test.ts
git commit -m "feat(links): merchant sign-in, dashboard, CSV export and fee repayment"
```

---

### Task 15: Telegram bot (first to cut if behind schedule)

**Files:**
- Create: `tilda-server/src/links/bot.ts`
- Test: `tilda-server/tests/links/bot.test.ts`

**Interfaces:**
- Consumes: `InvoiceDeps`, `createInvoiceFor` (Task 8); `t` (Task 7); `LinksStore`.
- Produces:
  ```ts
  export interface BotDeps extends InvoiceDeps { publicUrl: string; send: (chatId: string, text: string) => Promise<void> }
  export async function handleUpdate(d: BotDeps, update: unknown): Promise<void>
  export function telegramSender(botToken: string, fetchImpl?: typeof fetch): (chatId: string, text: string) => Promise<void>
  ```
  The HTTP webhook (`POST /tg/<webhookSecret>`) is wired in Task 16.

- [ ] **Step 1: Write the failing test**

```ts
// tilda-server/tests/links/bot.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { handleUpdate, telegramSender, type BotDeps } from '../../src/links/bot.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const msg = (chatId: number, text: string, language_code = 'en') =>
  ({ message: { chat: { id: chatId }, from: { language_code }, text } });

function setup() {
  const sent: { chatId: string; text: string }[] = [];
  const store = openLinksStore(':memory:');
  const d: BotDeps = {
    store, links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000, quoter: { quote: async () => ({ amountToken: '1', rate: '1', rateSource: 'x' }) },
    publicUrl: 'https://pay.test', send: async (chatId, text) => { sent.push({ chatId, text }); },
  };
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'ru', now: 1 });
  store.updateMerchant(m.id, { recipient: R });
  return { d, sent, store, m };
}

describe('telegram bot', () => {
  it('links a chat with a one-time code, then creates invoices', async () => {
    const { d, sent, store, m } = setup();
    store.putBotLink('code1', m.id, 10_000);
    await handleUpdate(d, msg(42, '/start code1'));
    expect(store.getMerchant(m.id)!.telegramChatId).toBe('42');
    expect(sent.at(-1)!.text).toContain('/invoice');
    await handleUpdate(d, msg(42, '/invoice 5000 Футболка синяя'));
    expect(sent.at(-1)!.text).toMatch(/^https:\/\/pay\.test\/i\/[A-Za-z0-9_-]+$/);
    expect(store.listInvoices(m.id, 10)[0]).toMatchObject({ amountKzt: '5000', description: 'Футболка синяя', source: 'bot' });
  });

  it('refuses unlinked chats and a reused code', async () => {
    const { d, sent, store, m } = setup();
    await handleUpdate(d, msg(7, '/invoice 100 x', 'ru'));
    expect(sent.at(-1)!.text).toContain('Настройки');
    store.putBotLink('c', m.id, 10_000);
    await handleUpdate(d, msg(1, '/start c'));
    await handleUpdate(d, msg(2, '/start c'));
    expect(store.getMerchant(m.id)!.telegramChatId).toBe('1');
  });

  it('reports a bad amount and lists recent invoices', async () => {
    const { d, sent, store, m } = setup();
    store.updateMerchant(m.id, { telegramChatId: '42' });
    await handleUpdate(d, msg(42, '/invoice abc'));
    expect(sent.at(-1)!.text).toContain('5000');
    await handleUpdate(d, msg(42, '/invoice 700 Cap'));
    await handleUpdate(d, msg(42, '/list'));
    expect(sent.at(-1)!.text).toContain('700');
  });

  it('ignores updates without text', async () => {
    const { d, sent } = setup();
    await handleUpdate(d, { edited_message: {} });
    expect(sent).toEqual([]);
  });

  it('sends through the Bot API', async () => {
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string, init?: RequestInit) => { calls.push({ url, body: String(init?.body) }); return new Response('{}'); }) as typeof fetch;
    await telegramSender('TOKEN', fake)('42', 'hi');
    expect(calls[0]!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: '42', text: 'hi', disable_web_page_preview: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/bot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// tilda-server/src/links/bot.ts
import type { Lang } from './db.js';
import { t } from './i18n.js';
import { createInvoiceFor, type InvoiceDeps } from './invoices.js';

export interface BotDeps extends InvoiceDeps {
  publicUrl: string;
  send: (chatId: string, text: string) => Promise<void>;
}

export function telegramSender(botToken: string, fetchImpl: typeof fetch = fetch): (chatId: string, text: string) => Promise<void> {
  return async (chatId, text) => {
    await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  };
}

export async function handleUpdate(d: BotDeps, update: unknown): Promise<void> {
  const message = (update as { message?: { chat?: { id?: number }; from?: { language_code?: string }; text?: string } }).message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (chatId === undefined || !text) return;
  const chat = String(chatId);
  const guess: Lang = message?.from?.language_code?.startsWith('ru') ? 'ru' : 'en';

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1] ?? '';
    const merchantId = code ? d.store.takeBotLink(code, d.now()) : null;
    if (merchantId === null) { await d.send(chat, t(guess, 'bot_unknown')); return; }
    d.store.updateMerchant(merchantId, { telegramChatId: chat });
    await d.send(chat, t(d.store.getMerchant(merchantId)!.lang, 'bot_linked'));
    return;
  }

  const merchant = d.store.findMerchantByTelegram(chat);
  if (!merchant) { await d.send(chat, t(guess, 'bot_unknown')); return; }

  if (text.startsWith('/invoice')) {
    const [, amount = '', ...rest] = text.split(/\s+/);
    const r = createInvoiceFor(d, merchant, { amountKzt: amount, description: rest.join(' ') }, 'bot');
    if (!r.ok) {
      const key = r.error === 'no_recipient' ? 'err_no_recipient' : r.error === 'debt_limit' ? 'err_debt_limit' : 'err_bad_amount';
      await d.send(chat, t(merchant.lang, key));
      return;
    }
    await d.send(chat, `${d.publicUrl}/i/${r.invoice.id}`);
    return;
  }

  if (text.startsWith('/list')) {
    const lines = d.store.listInvoices(merchant.id, 10)
      .map((i) => `${i.amountKzt} ₸ — ${i.description} — ${t(merchant.lang, `status_${i.state}`)}`);
    await d.send(chat, lines.join('\n') || '—');
    return;
  }
  await d.send(chat, t(merchant.lang, 'bot_help'));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/links/bot.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/links/bot.ts tests/links/bot.test.ts
git commit -m "feat(links): Telegram bot for creating invoices and payment alerts"
```

---

### Task 16: Wire the subsystem into the server

**Files:**
- Create: `tilda-server/src/links/app.ts`, `tilda-server/tests/links/app.test.ts`, `tilda-server/tests/integration/links-devnet.test.ts`
- Modify: `tilda-server/src/http/server.ts` (interface `ЗависимостиСервера` line 55; `обработатьЗапрос` just before the final 404 at line ~228; `запуститьСервер` line ~268), `tilda-server/config.example.json`

**Interfaces:**
- Consumes: everything above; `SolanaPayKZ` from `@solanapaykz/core` (quotes); `createTransport` from nodemailer.
- Produces:
  ```ts
  export interface LinksApp { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>; stop(): void }
  export interface LinksAppOptions { links: LinksConfig; cluster: 'mainnet' | 'devnet'; rpcUrl: string; publicUrl: string;
    databasePath: string; smtp: { host: string; port: number; user: string; pass: string; from: string };
    log: { info(m: string, f?: object): void; warn(m: string, f?: object): void };
    overrides?: Partial<{ quoter: Quoter; rpc: DetectRpc; probe: AccountProbe; sendMail: (to: string, s: string, t: string) => Promise<void>;
      latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>; now: () => number; startDetector: boolean }> }
  export function createLinksApp(o: LinksAppOptions): LinksApp
  ```

- [ ] **Step 1: Write the failing test (full stack through the real server)**

```ts
// tilda-server/tests/links/app.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateReference } from '@solanapaykz/core';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLinksApp, type LinksApp } from '../../src/links/app.js';
import { loadLinksConfig } from '../../src/links/config.js';
import http from 'node:http';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
let app: LinksApp; let server: Server; let base: string; const codes: string[] = [];

beforeEach(async () => {
  app = createLinksApp({
    links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com', publicUrl: 'https://pay.test', databasePath: ':memory:',
    smtp: { host: 'smtp.test', port: 465, user: 'u', pass: 'p', from: 'noreply@pay.test' },
    log: { info: () => {}, warn: () => {} },
    overrides: {
      quoter: { quote: async () => ({ amountToken: '10.87', rate: '460', rateSource: 'binance' }) },
      probe: { exists: async () => true }, startDetector: false,
      sendMail: async (_to, _s, text) => { codes.push(/\d{6}/.exec(text)![0]); },
      latestBlockhash: async () => ({ blockhash: generateReference(), lastValidBlockHeight: 1n }),
    },
  });
  server = http.createServer((req, res) => { void app.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { app.stop(); return new Promise<void>((ok) => server.close(() => ok())); });

describe('links app', () => {
  it('runs the merchant journey: sign in → settings → invoice → public page → blink metadata', async () => {
    await fetch(`${base}/api/auth/email/start`, { method: 'POST', body: JSON.stringify({ email: 'a@shop.kz' }) });
    const v = await fetch(`${base}/api/auth/email/verify`, { method: 'POST', body: JSON.stringify({ email: 'a@shop.kz', code: codes.at(-1) }) });
    const cookie = v.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf } = await v.json() as { csrf: string };
    const h = { cookie, 'x-csrf-token': csrf };
    await fetch(`${base}/api/merchant/settings`, { method: 'PUT', headers: h, body: JSON.stringify({ recipient: R, name: 'Shop' }) });
    const inv = await (await fetch(`${base}/api/merchant/invoices`, { method: 'POST', headers: h,
      body: JSON.stringify({ amountKzt: '5000', description: 'Shirt' }) })).json() as { id: string };
    expect((await fetch(`${base}/i/${inv.id}`)).status).toBe(200);
    expect((await fetch(`${base}/api/actions/i/${inv.id}`)).status).toBe(200);
    expect((await fetch(`${base}/assets/link.js`)).status).toBe(200);
  });

  it('does not claim unrelated paths', async () => {
    expect((await fetch(`${base}/tilda/pay`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links/app.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app.ts`**

```ts
// tilda-server/src/links/app.ts
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { address, createSolanaRpc } from '@solana/kit';
import nodemailer from 'nodemailer';
import { SolanaPayKZ } from '@solanapaykz/core';
import { createRateLimiter } from './ratelimit.js';
import type { AuthDeps } from './auth.js';
import { handleUpdate, telegramSender } from './bot.js';
import type { LinksConfig } from './config.js';
import { openLinksStore } from './db.js';
import { createRpc, startDetector, type DetectRpc } from './detect.js';
import { readJson, sendJson } from './http.js';
import { t } from './i18n.js';
import type { Quoter } from './invoices.js';
import { createNotifier } from './notify.js';
import type { AccountProbe } from './recipient.js';
import { handleActions } from './routes-actions.js';
import { handleMerchant, type MerchantDeps } from './routes-merchant.js';
import { handlePublic } from './routes-public.js';

export interface LinksApp { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>; stop(): void }

export interface LinksAppOptions {
  links: LinksConfig;
  cluster: 'mainnet' | 'devnet';
  rpcUrl: string;
  publicUrl: string;
  databasePath: string;
  smtp: { host: string; port: number; user: string; pass: string; from: string };
  log: { info(m: string, f?: object): void; warn(m: string, f?: object): void };
  overrides?: Partial<{
    quoter: Quoter; rpc: DetectRpc; probe: AccountProbe;
    sendMail: (to: string, subject: string, text: string) => Promise<void>;
    latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
    now: () => number; startDetector: boolean;
  }>;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const ASSETS: Record<string, string> = {
  '/assets/link.js': 'text/javascript; charset=utf-8',
  '/assets/dashboard.js': 'text/javascript; charset=utf-8',
  '/assets/link.css': 'text/css; charset=utf-8',
};

export function createLinksApp(o: LinksAppOptions): LinksApp {
  const ov = o.overrides ?? {};
  const now = ov.now ?? (() => Date.now());
  const store = openLinksStore(o.databasePath);
  const rpc = createSolanaRpc(o.rpcUrl);
  const sdk = new SolanaPayKZ({ recipient: o.links.feeWallet, rpcUrl: o.rpcUrl, cluster: o.cluster });

  const quoter: Quoter = ov.quoter ?? {
    quote: async (amountKzt, token) => {
      const q = await sdk.createQuote({ amountKzt, token });
      return { amountToken: q.amountToken, rate: q.rate, rateSource: q.rateSource };
    },
  };
  const probe: AccountProbe = ov.probe ?? {
    exists: async (a) => (await rpc.getAccountInfo(address(a), { encoding: 'base64' }).send()).value !== null,
  };
  const latestBlockhash = ov.latestBlockhash ?? (async () => (await rpc.getLatestBlockhash().send()).value);
  const transport = nodemailer.createTransport({ host: o.smtp.host, port: o.smtp.port, secure: o.smtp.port === 465,
    auth: { user: o.smtp.user, pass: o.smtp.pass } });
  const sendMail = ov.sendMail ?? (async (to: string, subject: string, text: string) => {
    await transport.sendMail({ from: o.smtp.from, to, subject, text });
  });
  const sendTelegram = o.links.telegram ? telegramSender(o.links.telegram.botToken) : undefined;

  const auth: AuthDeps = { store, pepper: o.links.sessionPepper, now,
    sendCode: (email, code, lang) => sendMail(email, t(lang, 'email_subject'), t(lang, 'email_body', { code })) };
  const deps: MerchantDeps = {
    store, links: o.links, cluster: o.cluster, now, quoter, publicUrl: o.publicUrl, feeWallet: o.links.feeWallet,
    latestBlockhash, txLimiter: createRateLimiter(30, 60_000), auth, probe, host: new URL(o.publicUrl).host,
    authLimiter: createRateLimiter(10, 60_000), botUsername: o.links.telegram?.botUsername,
  };

  const stopDetector = ov.startDetector === false ? () => {} : startDetector({
    store, rpc: ov.rpc ?? createRpc(o.rpcUrl), cluster: o.cluster, feeWallet: o.links.feeWallet, now, log: o.log,
    onEvent: createNotifier({ store, publicUrl: o.publicUrl, sendMail, sendTelegram }),
  }, o.links.detectIntervalMs);

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const type = ASSETS[url.pathname];
      if (type && req.method === 'GET') {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=300' });
        res.end(readFileSync(join(PUBLIC_DIR, url.pathname.slice('/assets/'.length))));
        return true;
      }
      const tg = o.links.telegram;
      if (tg && req.method === 'POST' && url.pathname === `/tg/${tg.webhookSecret}`) {
        try { await handleUpdate({ ...deps, send: sendTelegram! }, await readJson(req)); } catch (e) {
          o.log.warn('links: telegram update failed', { message: (e as Error).message });
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (await handleActions(req, res, url, deps)) return true;
      if (await handlePublic(req, res, url, deps)) return true;
      return handleMerchant(req, res, url, deps);
    },
    stop() { stopDetector(); store.close(); },
  };
}
```

- [ ] **Step 4: Hook into `server.ts`**

In `ЗависимостиСервера` (line 55) add the optional field:

```ts
  /** Chat payment links subsystem (src/links); absent when the "links" config section is missing. */
  links?: import('../links/app.js').LinksApp;
```

In `обработатьЗапрос`, immediately before the final `res.writeHead(404, ...)`:

```ts
  if (deps.links && (await deps.links.handle(req, res))) return;
```

In `запуститьСервер`, after `const client = создатьКлиент(config);` and before `createServer(...)`:

```ts
  const сырыеСсылки = (JSON.parse(readFileSync(путь, 'utf8')) as { links?: unknown }).links;
  const links = сырыеСсылки === undefined ? undefined : createLinksApp({
    links: loadLinksConfig(сырыеСсылки), cluster: config.cluster, rpcUrl: config.rpcUrl, publicUrl: config.publicUrl,
    databasePath: config.databasePath, smtp: config.smtp, log,
  });
```

pass `links` into `createServer({ config, store, client, log, links })`, and in `остановить()` call `links?.stop();`
after `остановитьОбход();`. Add the imports at the top of `server.ts`:

```ts
import { createLinksApp } from '../links/app.js';
import { loadLinksConfig } from '../links/config.js';
```

Add `sessionPepper` to the secrets passed to `createLog` so it never reaches logs:
`секретыНастроек(config)` → `[...секретыНастроек(config), ...(сырыеСсылки ? [String((сырыеСсылки as Record<string, unknown>).sessionPepper ?? '')] : [])]`
(read `сырыеСсылки` before creating the log).

- [ ] **Step 5: Extend `config.example.json`**

Add (values are placeholders the operator replaces):

```json
  "links": {
    "feeWallet": "<SERVICE_FEE_WALLET_ADDRESS>",
    "feeBps": 50,
    "invoiceTtlDays": 7,
    "debtLimit": { "USDC": "20", "SOL": "0.15" },
    "sessionPepper": "<32+ random characters>",
    "iconUrl": "/assets/icon.png",
    "telegram": { "botToken": "<BOT_TOKEN>", "botUsername": "<bot_username>", "webhookSecret": "<32+ random characters>" }
  }
```

Copy `docs/assets/` logo (or any 256×256 PNG) to `tilda-server/public/icon.png` and add `'/assets/icon.png': 'image/png'` to `ASSETS` in `app.ts` (Blink and Solana Pay wallets fetch the icon).

- [ ] **Step 6: Add the devnet integration test**

```ts
// tilda-server/tests/integration/links-devnet.test.ts — run manually: DEVNET_PAYER_SECRET=<base58 64-byte secret> npx vitest run tests/integration
import { describe, expect, it } from 'vitest';
import { createKeyPairSignerFromBytes, createSolanaRpc, getBase58Encoder, getBase64Encoder, getTransactionDecoder,
  signTransaction, getBase64EncodedWireTransaction, address } from '@solana/kit';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { activeQuote, createInvoiceFor } from '../../src/links/invoices.js';
import { buildPaymentTransaction } from '../../src/links/tx.js';
import { createRpc, detectOnce } from '../../src/links/detect.js';

const secret = process.env.DEVNET_PAYER_SECRET;
const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';

describe.skipIf(!secret)('devnet: pay an invoice in SOL and detect it', () => {
  it('turns the invoice paid', async () => {
    const rpc = createSolanaRpc(RPC);
    const payer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret!));
    const merchant = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    const store = openLinksStore(':memory:');
    const links = loadLinksConfig({ feeWallet: 'BPFLoaderUpgradeab1e11111111111111111111111', sessionPepper: 'pepper-pepper-pepper' });
    const deps = { store, links, cluster: 'devnet' as const, now: () => Date.now(),
      quoter: { quote: async () => ({ amountToken: '0.001', rate: '1', rateSource: 'test' }) } };
    const m = store.createMerchant({ email: 'it@test', walletLogin: null, lang: 'en', now: Date.now() });
    store.updateMerchant(m.id, { recipient: merchant });
    const r = createInvoiceFor(deps, store.getMerchant(m.id)!, { amountKzt: '1', description: 'it', token: 'SOL' }, 'link');
    if (!r.ok) throw new Error(r.error);
    const q = await activeQuote(deps, r.invoice);
    const b64 = await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: payer.address, merchant,
      feeWallet: links.feeWallet, merchantUnits: q.merchantUnits, feeUnits: q.feeUnits, reference: q.reference,
      memo: `inv:${r.invoice.id}`, blockhash: (await rpc.getLatestBlockhash().send()).value });
    const signed = await signTransaction([payer.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(b64)));
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    const events: string[] = [];
    for (let i = 0; i < 20 && store.getInvoice(r.invoice.id)!.state === 'open'; i++) {
      await new Promise((ok) => setTimeout(ok, 3000));
      await detectOnce({ store, rpc: createRpc(RPC), cluster: 'devnet', feeWallet: links.feeWallet, now: () => Date.now(),
        onEvent: async (e) => { events.push(e.kind); }, log: { warn: () => {} } });
    }
    expect(store.getInvoice(r.invoice.id)!.state).toBe('paid');
    expect(events).toEqual(['paid']);
  }, 90_000);
});
```

Note: `tests/integration` must be excluded from the default unit run if `vitest.config.ts` includes it — the
existing config includes `tests/**/*.test.ts`, and the test self-skips without `DEVNET_PAYER_SECRET`, so no change is needed.

- [ ] **Step 7: Run all tests and the build**

Run: `npx vitest run && npm run build`
Expected: all unit tests PASS (links + pre-existing Tilda tests); the devnet test is reported as skipped; `tsc` succeeds.
Then once, with a funded devnet keypair: `DEVNET_PAYER_SECRET=<secret> npx vitest run tests/integration/links-devnet.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/links/app.ts src/http/server.ts config.example.json public/icon.png tests/links/app.test.ts tests/integration/links-devnet.test.ts
git commit -m "feat(links): wire chat payment links into the server, with devnet end-to-end test"
```

---

### Task 17: Documentation, prior-work disclosure and deployment

**Files:**
- Modify: `README.md` (English), `tilda-server/README.md` (append an English "Chat payment links" section)
- Create: `docs/links.md`

**Interfaces:** none (documentation only). Every claim must match the code; no screenshots or numbers that were not produced.

- [ ] **Step 1: README — add these sections**

```markdown
## Chat payment links (Colosseum Crypto World's Fair, Sept–Oct 2026)

Sellers who trade in WhatsApp, Instagram or Telegram create a payment link priced in tenge and paste it into the
chat. The buyer pays USDC or SOL on Solana in one tap (Solana Pay transaction request), by a manual transfer from any
wallet or exchange, or as a Blink. Funds go straight to the seller's own wallet; the service takes 0.5% inside the
same transaction and never holds funds or keys. See [docs/links.md](docs/links.md).

## Prior work disclosure

Before the contest period (2026-09-14) this repository already contained the core SDK, the WooCommerce plugin and a
single-merchant Tilda payment server — release [`v0.1.0`](../../releases/tag/v0.1.0) (2026-09-13). Everything after
that tag was built during the hackathon: multi-merchant accounts, email and wallet sign-in, chat payment links,
the on-chain fee split, manual exchange payments with unique amounts, Solana Actions (Blinks), the merchant
dashboard, the fee ledger and the Telegram bot. Full diff: [`v0.1.0...main`](../../compare/v0.1.0...main).

## Legal status and roadmap

Kazakhstan currently does not allow crypto-assets to be used as payment for goods and services; the legal route is
conversion to tenge through a licensed provider (since July 2026 the National Bank's unified QR accepts crypto
wallets with conversion through AIFC exchanges). This project lets merchants receive to their own wallets and is
demonstrated on mainnet with team-owned test merchants and pilot merchants recruited by the team.

Roadmap:
1. Partner with a licensed AIFC provider to accept SOL/USDC on Solana and settle merchants in tenge.
2. Settlement mode in the product: route payments to the partner's address with a merchant identifier.
3. More local currencies (the quote engine already prices from fiat).
4. Optional on-chain splitter program so manual payments also pay the fee on-chain.
```

- [ ] **Step 2: `docs/links.md`**

Write an English operator and merchant guide with these sections, each filled from the code:
1. **For merchants** — sign up (email code or wallet), set the receiving wallet (must have a USDC account), create a
   link, share it, statuses (`open`, `paid`, `needs_review`, `expired`) and what each means, the fee (0.5% on-chain;
   manual payments accrue the fee as debt; above the `debtLimit` new invoices are blocked; repay from the dashboard).
2. **For buyers** — one tap with Phantom/Solflare/Backpack, or manual: Solana network only, exact amount, exchange
   withdrawal fee must be added on top.
3. **For operators** — the `links` config keys and defaults (copy the table from `src/links/config.ts`), required
   nginx routes (`/i/`, `/m`, `/api/`, `/actions.json`, `/assets/`, `/tg/` to the server; `actions.json` at the domain
   root), TLS, mainnet RPC (paid provider), Telegram `setWebhook` command:
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<host>/tg/<webhookSecret>"`.
4. **Security** — no private keys anywhere; email codes hashed; nonces single-use; sessions httpOnly; CSRF header;
   rate limits; frozen recipient per invoice.

- [ ] **Step 3: Verify the docs against the code**

Run: `grep -n "feeBps\|invoiceTtlDays\|debtLimit\|detectIntervalMs\|iconUrl\|sessionPepper" src/links/config.ts docs/links.md`
Expected: every config key in `config.ts` appears in `docs/links.md` with the same default.

- [ ] **Step 4: Commit**

```bash
git add README.md tilda-server/README.md docs/links.md
git commit -m "docs: chat payment links guide, prior-work disclosure, legal status and roadmap"
```

---

## Deployment checklist (after Task 17, needs the host owner for root steps)

- [ ] Build and run: `cd tilda-server && docker compose up -d --build` with `config.json` containing the `links` section,
  `cluster: "mainnet"`, a paid `rpcUrl`, `publicUrl: "https://solanapaykz.site"`.
- [ ] Root (host owner): nginx site for `solanapaykz.site` proxying to the container port, certbot TLS, then `nginx -t` and reload.
- [ ] `curl -s https://solanapaykz.site/actions.json` → `{"rules":[...]}`; `curl -sI https://solanapaykz.site/assets/link.js` → `text/javascript`.
- [ ] Telegram `setWebhook` (see docs/links.md).
- [ ] Mainnet smoke: create an invoice, pay from Phantom (check two transfers in the explorer), pay a second invoice
  manually with the exact amount, open the same invoice on dial.to as a Blink, confirm statuses and the fee debt.
