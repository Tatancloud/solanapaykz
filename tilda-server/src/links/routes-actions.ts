// tilda-server/src/links/routes-actions.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { formatUnits, resolveToken } from '@solanapaykz/core';
import { activeQuote } from './invoices.js';
import { readJson, sendJson } from './http.js';
import { buildInvoiceTransaction, type PublicDeps } from './routes-public.js';

const CHAIN_IDS = { mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' };
const ACTION = /^\/api\/actions\/i\/([A-Za-z0-9_-]{1,32})$/;

function actionsHeaders(cluster: 'mainnet' | 'devnet'): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids',
    'access-control-expose-headers': 'X-Action-Version, X-Blockchain-Ids',
    'x-action-version': '2.4',
    'x-blockchain-ids': CHAIN_IDS[cluster],
  };
}

export async function handleActions(req: IncomingMessage, res: ServerResponse, url: URL, d: PublicDeps): Promise<boolean> {
  const method = req.method ?? 'GET';
  const h = actionsHeaders(d.cluster);

  if (url.pathname === '/actions.json' && (method === 'GET' || method === 'OPTIONS')) {
    sendJson(res, 200, { rules: [{ pathPattern: '/i/*', apiPath: '/api/actions/i/*' }] }, h);
    return true;
  }

  const match = ACTION.exec(url.pathname);
  if (!match) return false;
  if (method === 'OPTIONS') { sendJson(res, 200, {}, h); return true; }

  if (method === 'GET') {
    const inv = d.store.getInvoice(match[1]!);
    const m = inv ? d.store.getMerchant(inv.merchantId) : null;
    if (!inv || !m) { sendJson(res, 404, { message: 'Invoice not found' }, h); return true; }
    const icon = new URL(d.links.iconUrl, d.publicUrl).toString();
    if (inv.state !== 'open') {
      sendJson(res, 200, { type: 'action', icon, title: m.name || 'SolanaPay-KZ', description: inv.description,
        label: inv.state, disabled: true }, h);
      return true;
    }
    const q = await activeQuote(d, inv);
    const amount = formatUnits(q.totalUnits, resolveToken(d.cluster, inv.token).decimals);
    sendJson(res, 200, { type: 'action', icon, title: `${m.name || 'SolanaPay-KZ'} — ${inv.amountKzt} KZT`,
      description: inv.description, label: `Pay ${amount} ${inv.token}` }, h);
    return true;
  }

  if (method === 'POST') {
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch { sendJson(res, 400, { message: 'Invalid JSON' }, h); return true; }
    const r = await buildInvoiceTransaction(d, match[1]!, body.account);
    if (!r.ok) sendJson(res, r.status, { message: r.error }, h);
    else sendJson(res, 200, { type: 'transaction', transaction: r.transaction, message: r.message }, h);
    return true;
  }
  return false;
}
