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
