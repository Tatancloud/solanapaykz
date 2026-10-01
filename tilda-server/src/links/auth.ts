// tilda-server/src/links/auth.ts
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Lang, LinksStore } from './db.js';

export const SESSION_COOKIE = 'spk_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Codes per email per window; wrong attempts also carry over within the window. */
const MAX_SENDS = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;

export interface AuthDeps {
  store: LinksStore;
  pepper: string;
  now: () => number;
  sendCode: (email: string, code: string, lang: Lang) => Promise<void>;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/.test(email) ? email : null;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

function hashCode(pepper: string, email: string, code: string): string {
  return createHash('sha256').update(`${pepper}\n${email}\n${code}`).digest('hex');
}

export async function startEmailLogin(d: AuthDeps, rawEmail: unknown, lang: Lang):
  Promise<{ ok: true } | { ok: false; error: 'invalid_email' | 'too_soon' }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: 'invalid_email' };
  const now = d.now();
  const existing = d.store.getEmailCode(email);
  if (existing && now - existing.createdAt < CODE_RESEND_MS) return { ok: false, error: 'too_soon' };
  if (existing && existing.sends >= MAX_SENDS && now - existing.windowStart < SEND_WINDOW_MS) {
    return { ok: false, error: 'too_soon' };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  d.store.putEmailCode(email, hashCode(d.pepper, email, code), now, now + CODE_TTL_MS, SEND_WINDOW_MS);
  await d.sendCode(email, code, lang);
  return { ok: true };
}

export function verifyEmailLogin(d: AuthDeps, rawEmail: unknown, rawCode: unknown, lang: Lang):
  { ok: true; merchantId: number } | { ok: false; error: 'invalid' | 'expired' | 'locked' } {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!email) return { ok: false, error: 'invalid' };
  const row = d.store.getEmailCode(email);
  if (!row || row.expiresAt <= d.now()) return { ok: false, error: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'locked' };
  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = Buffer.from(hashCode(d.pepper, email, code), 'hex');
  if (!/^\d{6}$/.test(code) || !timingSafeEqual(expected, actual)) {
    d.store.bumpEmailCodeAttempts(email);
    return { ok: false, error: 'invalid' };
  }
  d.store.deleteEmailCode(email);
  const merchant = d.store.findMerchantByEmail(email)
    ?? d.store.createMerchant({ email, walletLogin: null, lang, now: d.now() });
  return { ok: true, merchantId: merchant.id };
}

export function createSessionFor(d: AuthDeps, merchantId: number): { id: string; csrf: string; cookie: string } {
  const id = randomToken(32);
  const csrf = randomToken(24);
  d.store.createSession(id, merchantId, csrf, d.now() + SESSION_TTL_MS);
  const cookie = `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
  return { id, csrf, cookie };
}

export function readSession(d: AuthDeps, cookieHeader: string | undefined):
  { id: string; merchantId: number; csrf: string } | null {
  if (!cookieHeader) return null;
  const pair = cookieHeader.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  if (!pair) return null;
  const id = pair.slice(SESSION_COOKIE.length + 1);
  const s = d.store.getSession(id, d.now());
  return s ? { id, ...s } : null;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
