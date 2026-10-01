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
