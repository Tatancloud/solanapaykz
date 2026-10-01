// tilda-server/src/links/detect.ts
import { address, createSolanaRpc, type Signature } from '@solana/kit';
import { resolveToken } from '@solanapaykz/core';
import type { Invoice, LinksStore, QuoteRow } from './db.js';
import { usdcAccountOf } from './recipient.js';
import { balanceDelta, checkSplitPayment, type ParsedTx } from './validate.js';

export interface DetectRpc {
  /** Newest first. `before`/`until` bound the page exclusively, as in getSignaturesForAddress. */
  signaturesFor(address: string, opts: { limit: number; before?: string; until?: string }):
    Promise<{ signature: string; err: unknown; blockTime?: number | null }[]>;
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
const PAGE = 50;
const MAX_PAGES = 10;

// Processed keys are namespaced per scan: the same signature is a request payment for one scan and noise for another.
// A key is written only after its transaction was fetched and handled, in the same SQLite transaction as the result.

function mintOf(d: DetectDeps, token: Invoice['token']): string | null {
  return token === 'SOL' ? null : resolveToken(d.cluster, 'USDC').mint!;
}

function record(d: DetectDeps, invoice: Invoice, quote: QuoteRow, signature: string, tx: ParsedTx,
  verdict: 'ok' | 'mismatch', mode: 'request' | 'manual'): PaymentEvent {
  const current = d.store.getInvoice(invoice.id)!;
  // Number(): @solana/kit returns blockTime as a bigint.
  const paidAtMs = (tx.blockTime == null ? Math.floor(d.now() / 1000) : Number(tx.blockTime)) * 1000;
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
  return { kind: state, invoice: d.store.getInvoice(invoice.id)! };
}

async function emit(d: DetectDeps, e: PaymentEvent): Promise<void> {
  try { await d.onEvent(e); } catch (err) { d.log.warn('links: notification failed', { message: (err as Error).message }); }
}

async function scanRequests(d: DetectDeps, invoice: Invoice, since: number): Promise<void> {
  for (const quote of d.store.quotesForInvoice(invoice.id)) {
    if (quote.expiresAt <= since) continue;
    for (const s of await d.rpc.signaturesFor(quote.reference, { limit: 10 })) {
      const key = `req:${s.signature}`;
      if (s.err !== null || d.store.isProcessed(key)) continue;
      const tx = await d.rpc.transaction(s.signature);
      if (!tx) { d.log.warn('links: transaction not found yet', { signature: s.signature }); continue; }
      const verdict = checkSplitPayment(tx, { mint: mintOf(d, invoice.token), merchant: invoice.recipient,
        feeWallet: d.feeWallet, merchantUnits: quote.merchantUnits, feeUnits: quote.feeUnits });
      if (verdict === 'failed') { d.store.markProcessed(key); continue; }
      const event = d.store.atomic(() => { d.store.markProcessed(key); return record(d, invoice, quote, s.signature, tx, verdict, 'request'); });
      await emit(d, event);
    }
  }
}

async function scanManual(d: DetectDeps, recipient: string, token: Invoice['token'], invoices: Invoice[],
  references: Set<string>, since: number): Promise<void> {
  const watched = token === 'SOL' ? recipient : await usdcAccountOf(d.cluster, recipient);
  const checkpointKey = `manual:${watched}`;
  const until = d.store.getCheckpoint(checkpointKey);
  // A payment cannot predate its invoice; 60 s of slack for server vs. chain clock skew.
  const oldestSec = Math.floor(Math.min(...invoices.map((i) => i.createdAt)) / 1000) - 60;

  // Page back to the checkpoint, or past the oldest candidate invoice when there is none yet.
  const list: { signature: string; err: unknown; blockTime?: number | null }[] = [];
  let complete = false;
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await d.rpc.signaturesFor(watched, { limit: PAGE, ...(before ? { before } : {}), ...(until ? { until } : {}) });
    list.push(...batch);
    const last = batch.at(-1);
    if (batch.length < PAGE || !last || (last.blockTime != null && last.blockTime < oldestSec)) { complete = true; break; }
    before = last.signature;
  }
  if (!complete) d.log.warn('links: manual scan truncated', { watched, pages: MAX_PAGES });
  if (list.length === 0) return;

  const quotes = invoices.flatMap((inv) => d.store.quotesForInvoice(inv.id)
    .filter((q) => q.expiresAt > since).map((q) => ({ inv, q })));
  for (const s of [...list].reverse()) {
    const key = `man:${s.signature}`;
    if (s.err !== null || d.store.isProcessed(key)) continue;
    if (s.blockTime != null && s.blockTime < oldestSec) continue;
    const tx = await d.rpc.transaction(s.signature);
    if (!tx) { complete = false; continue; }
    // A wallet payment carries a quote reference; the request scan owns it.
    if (tx.transaction.message.accountKeys.some((k) => references.has(k.pubkey))) { d.store.markProcessed(key); continue; }
    const got = balanceDelta(tx, recipient, mintOf(d, token));
    const match = quotes.find(({ q }) => q.manualUnits === got);
    if (!match) { d.store.markProcessed(key); continue; }
    const event = d.store.atomic(() => { d.store.markProcessed(key); return record(d, match.inv, match.q, s.signature, tx, 'ok', 'manual'); });
    await emit(d, event);
  }
  if (complete) d.store.setCheckpoint(checkpointKey, list[0]!.signature);
}

async function scanRepayments(d: DetectDeps, since: number): Promise<number> {
  let errors = 0;
  for (const r of d.store.pendingRepayments(since)) {
    try {
      for (const s of await d.rpc.signaturesFor(r.reference, { limit: 5 })) {
        const key = `rep:${s.signature}`;
        if (s.err !== null || d.store.isProcessed(key)) continue;
        const tx = await d.rpc.transaction(s.signature);
        if (!tx) continue;
        if (balanceDelta(tx, d.feeWallet, mintOf(d, r.token)) !== r.units) { d.store.markProcessed(key); continue; }
        d.store.atomic(() => {
          d.store.markProcessed(key);
          d.store.markRepaymentPaid(r.id, s.signature);
          d.store.addFeeEntry({ merchantId: r.merchantId, token: r.token, amount: -r.units, invoiceId: null,
            txSignature: s.signature, createdAt: d.now() });
        });
      }
    } catch (e) {
      errors++;
      d.log.warn('links: repayment scan failed', { id: r.id, message: (e as Error).message });
    }
  }
  return errors;
}

/** One detection pass. Errors are isolated per invoice / wallet and counted, so one bad item never stops the rest. */
export async function detectOnce(d: DetectDeps): Promise<{ errors: number }> {
  const now = d.now();
  const since = now - LATE_WINDOW_MS;
  let errors = 0;
  d.store.expireInvoices(now);
  const candidates = d.store.candidateInvoices(now, LATE_WINDOW_MS);
  for (const invoice of candidates) {
    try { await scanRequests(d, invoice, since); } catch (e) {
      errors++;
      d.log.warn('links: request scan failed', { invoice: invoice.id, message: (e as Error).message });
    }
  }

  const references = new Set(candidates.flatMap((inv) => d.store.quotesForInvoice(inv.id).map((q) => q.reference)));
  const groups = new Map<string, Invoice[]>();
  for (const inv of candidates) {
    const k = `${inv.recipient}|${inv.token}`;
    groups.set(k, [...(groups.get(k) ?? []), inv]);
  }
  for (const [k, invoices] of groups) {
    const [recipient, token] = k.split('|') as [string, Invoice['token']];
    try { await scanManual(d, recipient, token, invoices, references, since); } catch (e) {
      errors++;
      d.log.warn('links: manual scan failed', { recipient, token, message: (e as Error).message });
    }
  }
  errors += await scanRepayments(d, since);
  return { errors };
}

/** Runs detectOnce every intervalMs; after a pass with errors it waits 2, 4, … up to 32 intervals. */
export function startDetector(d: DetectDeps, intervalMs: number): () => void {
  let running = false;
  let failures = 0;
  let skip = 0;
  const timer = setInterval(() => {
    if (running) return;
    if (skip > 0) { skip--; return; }
    running = true;
    detectOnce(d)
      .then(({ errors }) => { failures = errors > 0 ? failures + 1 : 0; })
      .catch((e: unknown) => { failures++; d.log.warn('links: detector pass failed', { message: (e as Error).message }); })
      .finally(() => { skip = failures > 0 ? 2 ** Math.min(failures, 5) - 1 : 0; running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function createRpc(rpcUrl: string): DetectRpc {
  const rpc = createSolanaRpc(rpcUrl);
  return {
    async signaturesFor(addr, opts) {
      const res = await rpc.getSignaturesForAddress(address(addr), {
        limit: opts.limit, commitment: 'confirmed',
        ...(opts.before ? { before: opts.before as Signature } : {}), ...(opts.until ? { until: opts.until as Signature } : {}),
      }).send();
      return res.map((r) => ({ signature: String(r.signature), err: r.err,
        blockTime: r.blockTime === null ? null : Number(r.blockTime) }));
    },
    async transaction(signature) {
      const tx = await rpc.getTransaction(signature as Signature, {
        encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed',
      }).send();
      if (!tx) return null;
      return { ...(tx as unknown as ParsedTx), blockTime: tx.blockTime === null ? null : Number(tx.blockTime) };
    },
  };
}
