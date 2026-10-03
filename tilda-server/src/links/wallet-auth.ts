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
    return verify(null, message, key, Buffer.from(sig));
  } catch {
    return false;
  }
}

type SignedNonce = { host: string; address: unknown; nonce: unknown; signature: unknown };

/** Checks a signed sign-in message: the nonce is single-use and bound to this host. */
function checkSignedNonce(store: LinksStore, now: number, p: SignedNonce):
  { ok: true; address: string } | { ok: false; error: 'bad_request' | 'nonce' | 'signature' } {
  if (typeof p.address !== 'string' || typeof p.nonce !== 'string' || typeof p.signature !== 'string') {
    return { ok: false, error: 'bad_request' };
  }
  if (!store.takeNonce(p.nonce, now)) return { ok: false, error: 'nonce' };
  const message = Buffer.from(signInMessage(p.host, p.nonce), 'utf8');
  if (!verifyEd25519(p.address, message, p.signature)) return { ok: false, error: 'signature' };
  return { ok: true, address: p.address };
}

export function verifyWalletSignIn(
  store: LinksStore,
  now: number,
  p: SignedNonce & { lang: Lang },
): { ok: true; merchantId: number } | { ok: false; error: 'bad_request' | 'nonce' | 'signature' } {
  const c = checkSignedNonce(store, now, p);
  if (!c.ok) return c;
  const merchant = store.findMerchantByWallet(c.address)
    ?? store.createMerchant({ email: null, walletLogin: c.address, lang: p.lang, now });
  return { ok: true, merchantId: merchant.id };
}

/** Links a wallet to an existing (for example email) account, so the wallet signs in to that account. */
export function linkWalletLogin(store: LinksStore, now: number, merchantId: number, p: SignedNonce):
  { ok: true } | { ok: false; error: 'bad_request' | 'nonce' | 'signature' | 'wallet_taken' } {
  const c = checkSignedNonce(store, now, p);
  if (!c.ok) return c;
  const owner = store.findMerchantByWallet(c.address);
  if (owner && owner.id !== merchantId) return { ok: false, error: 'wallet_taken' };
  store.updateMerchant(merchantId, { walletLogin: c.address });
  return { ok: true };
}
