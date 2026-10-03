// tilda-server/tests/links/wallet-auth.test.ts
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getAddressDecoder, getBase58Decoder } from '@solana/kit';
import { openLinksStore } from '../../src/links/db.js';
import { issueNonce, linkWalletLogin, signInMessage, verifyEd25519, verifyWalletSignIn } from '../../src/links/wallet-auth.js';

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

describe('linking a sign-in wallet to an existing account', () => {
  it('links, then wallet sign-in opens the same (email) account', () => {
    const store = openLinksStore(':memory:');
    const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    const w = wallet();
    const n = issueNonce(store, 1000);
    expect(linkWalletLogin(store, 2000, m.id, { host: 'pay.test', address: w.address, nonce: n,
      signature: w.signB58(signInMessage('pay.test', n)) })).toEqual({ ok: true });
    const n2 = issueNonce(store, 3000);
    expect(verifyWalletSignIn(store, 4000, { host: 'pay.test', address: w.address, nonce: n2,
      signature: w.signB58(signInMessage('pay.test', n2)), lang: 'en' })).toEqual({ ok: true, merchantId: m.id });
  });

  it('refuses a wallet that already signs in to another account, and a bad signature', () => {
    const store = openLinksStore(':memory:');
    const w = wallet();
    const other = store.createMerchant({ email: null, walletLogin: w.address, lang: 'en', now: 1 });
    const m = store.createMerchant({ email: 'b@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    const n = issueNonce(store, 1000);
    expect(linkWalletLogin(store, 2000, m.id, { host: 'pay.test', address: w.address, nonce: n,
      signature: w.signB58(signInMessage('pay.test', n)) })).toEqual({ ok: false, error: 'wallet_taken' });
    expect(store.getMerchant(other.id)!.walletLogin).toBe(w.address);
    const n2 = issueNonce(store, 3000);
    expect(linkWalletLogin(store, 4000, m.id, { host: 'pay.test', address: w.address, nonce: n2,
      signature: w.signB58('something else') })).toEqual({ ok: false, error: 'signature' });
  });
});
