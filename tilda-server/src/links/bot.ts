// tilda-server/src/links/bot.ts
import type { Lang } from './db.js';
import { t } from './i18n.js';
import { createInvoiceFor, type InvoiceDeps } from './invoices.js';

export interface BotDeps extends InvoiceDeps {
  publicUrl: string;
  send: (chatId: string, text: string) => Promise<void>;
}

export function telegramSender(botToken: string, fetchImpl: typeof fetch = fetch): (chatId: string, text: string) => Promise<void> {
  return async (chatId, text) => {
    await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  };
}

export async function handleUpdate(d: BotDeps, update: unknown): Promise<void> {
  const message = (update as { message?: { chat?: { id?: number }; from?: { language_code?: string }; text?: string } }).message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (chatId === undefined || !text) return;
  const chat = String(chatId);
  const guess: Lang = message?.from?.language_code?.startsWith('ru') ? 'ru' : 'en';

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1] ?? '';
    const merchantId = code ? d.store.takeBotLink(code, d.now()) : null;
    if (merchantId === null) { await d.send(chat, t(guess, 'bot_unknown')); return; }
    d.store.updateMerchant(merchantId, { telegramChatId: chat });
    await d.send(chat, t(d.store.getMerchant(merchantId)!.lang, 'bot_linked'));
    return;
  }

  const merchant = d.store.findMerchantByTelegram(chat);
  if (!merchant) { await d.send(chat, t(guess, 'bot_unknown')); return; }

  if (text.startsWith('/invoice')) {
    const [, amount = '', ...rest] = text.split(/\s+/);
    const r = createInvoiceFor(d, merchant, { amountKzt: amount, description: rest.join(' ') }, 'bot');
    if (!r.ok) {
      const key = r.error === 'no_recipient' ? 'err_no_recipient' : r.error === 'debt_limit' ? 'err_debt_limit' : 'err_bad_amount';
      await d.send(chat, t(merchant.lang, key));
      return;
    }
    await d.send(chat, `${d.publicUrl}/i/${r.invoice.id}`);
    return;
  }

  if (text.startsWith('/list')) {
    const lines = d.store.listInvoices(merchant.id, 10)
      .map((i) => `${i.amountKzt} ₸ — ${i.description} — ${t(merchant.lang, `status_${i.state}`)}`);
    await d.send(chat, lines.join('\n') || '—');
    return;
  }
  await d.send(chat, t(merchant.lang, 'bot_help'));
}
