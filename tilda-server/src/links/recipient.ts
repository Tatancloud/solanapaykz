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

export async function checkRecipient(probe: AccountProbe, cluster: 'mainnet' | 'devnet', raw: unknown,
  forbidden: string[] = []):
  Promise<{ ok: true; address: string } | { ok: false; error: 'format' | 'is_mint' | 'is_fee_wallet' | 'no_usdc_account' }> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  let owner: string;
  try {
    owner = address(value);
  } catch {
    return { ok: false, error: 'format' };
  }
  const mints = (['mainnet', 'devnet'] as const).map((c) => resolveToken(c, 'USDC').mint);
  if (mints.includes(owner)) return { ok: false, error: 'is_mint' };
  if (forbidden.includes(owner)) return { ok: false, error: 'is_fee_wallet' };
  if (!(await probe.exists(await usdcAccountOf(cluster, owner)))) return { ok: false, error: 'no_usdc_account' };
  return { ok: true, address: owner };
}

/** Startup check: fee transfers fail on-chain when the fee wallet has no USDC account. */
export async function feeWalletProblems(probe: AccountProbe, cluster: 'mainnet' | 'devnet', feeWallet: string):
  Promise<string[]> {
  return (await probe.exists(await usdcAccountOf(cluster, feeWallet))) ? [] : ['fee wallet has no USDC account'];
}

export function saveSettings(store: LinksStore, merchantId: number,
  p: { recipient?: string | undefined; name?: unknown; lang?: unknown }): { ok: true } | { ok: false; error: 'name' | 'lang' } {
  if (p.name !== undefined && (typeof p.name !== 'string' || p.name.trim().length > 80)) return { ok: false, error: 'name' };
  if (p.lang !== undefined && p.lang !== 'en' && p.lang !== 'ru') return { ok: false, error: 'lang' };
  store.updateMerchant(merchantId, {
    ...(p.recipient !== undefined ? { recipient: p.recipient } : {}),
    ...(typeof p.name === 'string' ? { name: p.name.trim() } : {}),
    ...(p.lang !== undefined ? { lang: p.lang as Lang } : {}),
  });
  return { ok: true };
}
