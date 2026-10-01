// tilda-server/src/links/notify.ts
import type { LinksStore } from './db.js';
import type { PaymentEvent } from './detect.js';
import { t } from './i18n.js';

export interface NotifyDeps {
  store: LinksStore;
  publicUrl: string;
  sendMail?: (to: string, subject: string, text: string) => Promise<void>;
  sendTelegram?: (chatId: string, text: string) => Promise<void>;
}

export function createNotifier(d: NotifyDeps): (e: PaymentEvent) => Promise<void> {
  return async ({ kind, invoice }) => {
    const m = d.store.getMerchant(invoice.merchantId);
    if (!m) return;
    const vars = { amount: invoice.amountKzt, description: invoice.description, reason: invoice.reviewReason ?? '',
      link: `${d.publicUrl}/m/invoices#${invoice.id}` };
    const text = t(m.lang, kind === 'paid' ? 'bot_paid' : 'bot_review', vars);
    const subject = text.split('\n')[0]!;
    const jobs: Promise<void>[] = [];
    if (m.email && d.sendMail) jobs.push(d.sendMail(m.email, subject, text));
    if (m.telegramChatId && d.sendTelegram) jobs.push(d.sendTelegram(m.telegramChatId, text));
    await Promise.allSettled(jobs);
  };
}
