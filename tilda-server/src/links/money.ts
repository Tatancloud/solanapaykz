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
