// tilda-server/src/links/http.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { прочитатьТело } from '../http/routes-pay.js';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(html);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await прочитатьТело(req);
  if (text.trim() === '') return {};
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SyntaxError('JSON object expected');
  return v as Record<string, unknown>;
}

/** Remote address; behind the local nginx the first X-Forwarded-For entry is the client. */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const fwd = req.headers['x-forwarded-for'];
  if (local && typeof fwd === 'string' && fwd.trim() !== '') return fwd.split(',')[0]!.trim();
  return remote;
}
