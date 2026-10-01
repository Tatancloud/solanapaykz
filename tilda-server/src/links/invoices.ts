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
