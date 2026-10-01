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
  const until = d.store.getCheckpoint(key);
  const list = await d.rpc.signaturesFor(watched, { limit: 50, ...(until ? { until } : {}) });
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
