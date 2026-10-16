// tilda-server/src/links/http.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { прочитатьТело } from '../http/routes-pay.js';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * CSP of every links page: our own files, plus Google Tag Manager / Analytics, which public/consent.js
 * loads only after the visitor accepts cookies. Inline scripts stay forbidden.
 */
export const PAGE_CSP = "default-src 'self'; script-src 'self' https://www.googletagmanager.com; "
  + "img-src 'self' https://*.google-analytics.com https://*.googletagmanager.com; "
  + "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; "
  + "frame-ancestors 'none'";

export function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, ...headers });
  res.end(html);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await прочитатьТело(req);
  if (text.trim() === '') return {};
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SyntaxError('JSON object expected');
  return v as Record<string, unknown>;
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Client address for rate limits. Forwarding headers are trusted only when the peer is one of `trustedProxies`
 * (config `trustedProxyAddresses`; in Docker the peer is the bridge gateway, not loopback).
 */
export function clientIp(req: IncomingMessage, trustedProxies: readonly string[] = LOOPBACK): string {
  const remote = req.socket.remoteAddress ?? '';
  const fwd = req.headers['x-forwarded-for'];
  if (!trustedProxies.includes(remote)) return remote;
  // Behind Cloudflare the edge sets CF-Connecting-IP; otherwise our proxy appended the real peer as the LAST
  // X-Forwarded-For entry. Earlier entries come from the client and can be forged.
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim() !== '') return cf.trim();
  if (typeof fwd === 'string' && fwd.trim() !== '') return fwd.split(',').at(-1)!.trim();
  return remote;
}
