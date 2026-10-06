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

  /** Stores a new code. Attempts and the send counter carry over until `windowMs` after the first send. */
  putEmailCode(email: string, codeHash: string, createdAt: number, expiresAt: number, windowMs: number): void;
  getEmailCode(email: string): { codeHash: string; createdAt: number; expiresAt: number; attempts: number;
    sends: number; windowStart: number } | null;
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
  /** Removes an invoice and its quotes (callers allow this only for unpaid invoices). */
  deleteInvoice(id: string): void;
  listInvoices(merchantId: number, limit: number): Invoice[];
  candidateInvoices(now: number, lateWindowMs: number): Invoice[];
  updateInvoice(id: string, u: InvoiceUpdate): void;
  expireInvoices(now: number): number;

  insertQuote(q: NewQuote): QuoteRow;
  latestQuote(invoiceId: string): QuoteRow | null;
  quotesForInvoice(invoiceId: string): QuoteRow[];
  /** Manual amounts of quotes the detector may still match for this receiving wallet and token. */
  manualUnitsInUse(recipient: string, token: Token, since: number): bigint[];

  addFeeEntry(e: { merchantId: number; token: Token; amount: bigint; invoiceId: string | null;
    txSignature: string | null; createdAt: number }): void;
  feeDebt(merchantId: number, token: Token): bigint;
  createRepayment(r: { merchantId: number; token: Token; units: bigint; reference: string; createdAt: number }): Repayment;
  getRepayment(id: number): Repayment | null;
  pendingRepayments(since: number): Repayment[];
  markRepaymentPaid(id: number, txSignature: string): void;

  markProcessed(key: string): boolean;
  isProcessed(key: string): boolean;
  /** Runs fn inside one SQLite transaction. */
  atomic<T>(fn: () => T): T;
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
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 1, window_start INTEGER NOT NULL
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

    putEmailCode(email, codeHash, createdAt, expiresAt, windowMs) {
      const cur = store.getEmailCode(email);
      const fresh = !cur || cur.windowStart <= createdAt - windowMs;
      run(`INSERT INTO lk_email_codes (email, code_hash, created_at, expires_at, attempts, sends, window_start)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at,
           expires_at = excluded.expires_at, attempts = excluded.attempts, sends = excluded.sends,
           window_start = excluded.window_start`,
        email, codeHash, createdAt, expiresAt, fresh ? 0 : cur.attempts, fresh ? 1 : cur.sends + 1,
        fresh ? createdAt : cur.windowStart);
    },
    getEmailCode(email) {
      const r = one('SELECT * FROM lk_email_codes WHERE email = ?', email);
      return r ? { codeHash: String(r.code_hash), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
        attempts: Number(r.attempts), sends: Number(r.sends), windowStart: Number(r.window_start) } : null;
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
    deleteInvoice(id) {
      store.atomic(() => { run('DELETE FROM lk_quotes WHERE invoice_id = ?', id); run('DELETE FROM lk_invoices WHERE id = ?', id); });
    },
    listInvoices(merchantId, limit) {
      return all('SELECT * FROM lk_invoices WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?', merchantId, limit)
        .map(invoiceFrom);
    },
    candidateInvoices(now, lateWindowMs) {
      const since = now - lateWindowMs;
      return all(`SELECT * FROM lk_invoices WHERE state = 'open'
                  OR (state = 'expired' AND expires_at > ?)
                  OR (state IN ('paid', 'needs_review') AND COALESCE(paid_at, created_at) > ?)`, since, since)
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
    manualUnitsInUse(recipient, token, since) {
      return all(`SELECT q.manual_units FROM lk_quotes q JOIN lk_invoices i ON i.id = q.invoice_id
                  WHERE i.recipient = ? AND i.token = ? AND q.expires_at > ?`, recipient, token, since)
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
    pendingRepayments(since) {
      return all(`SELECT * FROM lk_repayments WHERE state = 'pending' AND created_at > ?`, since).map(repaymentFrom);
    },
    markRepaymentPaid(id, sig) { run(`UPDATE lk_repayments SET state = 'paid', tx_signature = ? WHERE id = ?`, sig, id); },

    isProcessed(key) { return one('SELECT 1 AS x FROM lk_processed WHERE signature = ?', key) !== undefined; },
    atomic(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    markProcessed(key) {
      return Number(run('INSERT OR IGNORE INTO lk_processed (signature) VALUES (?)', key).changes) === 1;
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
