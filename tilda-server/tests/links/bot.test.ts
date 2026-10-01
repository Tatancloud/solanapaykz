// tilda-server/tests/links/bot.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { handleUpdate, telegramSender, type BotDeps } from '../../src/links/bot.js';

const R = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const msg = (chatId: number, text: string, language_code = 'en') =>
  ({ message: { chat: { id: chatId }, from: { language_code }, text } });

function setup() {
  const sent: { chatId: string; text: string }[] = [];
  const store = openLinksStore(':memory:');
  const d: BotDeps = {
    store, links: loadLinksConfig({ feeWallet: R, sessionPepper: 'pepper-pepper-pepper' }), cluster: 'devnet',
    now: () => 1_000, quoter: { quote: async () => ({ amountToken: '1', rate: '1', rateSource: 'x' }) },
    publicUrl: 'https://pay.test', send: async (chatId, text) => { sent.push({ chatId, text }); },
  };
  const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'ru', now: 1 });
  store.updateMerchant(m.id, { recipient: R });
  return { d, sent, store, m };
}

describe('telegram bot', () => {
  it('links a chat with a one-time code, then creates invoices', async () => {
    const { d, sent, store, m } = setup();
    store.putBotLink('code1', m.id, 10_000);
    await handleUpdate(d, msg(42, '/start code1'));
    expect(store.getMerchant(m.id)!.telegramChatId).toBe('42');
    expect(sent.at(-1)!.text).toContain('/invoice');
    await handleUpdate(d, msg(42, '/invoice 5000 Футболка синяя'));
    expect(sent.at(-1)!.text).toMatch(/^https:\/\/pay\.test\/i\/[A-Za-z0-9_-]+$/);
    expect(store.listInvoices(m.id, 10)[0]).toMatchObject({ amountKzt: '5000', description: 'Футболка синяя', source: 'bot' });
  });

  it('refuses unlinked chats and a reused code', async () => {
    const { d, sent, store, m } = setup();
    await handleUpdate(d, msg(7, '/invoice 100 x', 'ru'));
    expect(sent.at(-1)!.text).toContain('Настройки');
    store.putBotLink('c', m.id, 10_000);
    await handleUpdate(d, msg(1, '/start c'));
    await handleUpdate(d, msg(2, '/start c'));
    expect(store.getMerchant(m.id)!.telegramChatId).toBe('1');
  });

  it('reports a bad amount and lists recent invoices', async () => {
    const { d, sent, store, m } = setup();
    store.updateMerchant(m.id, { telegramChatId: '42' });
    await handleUpdate(d, msg(42, '/invoice abc'));
    expect(sent.at(-1)!.text).toContain('5000');
    await handleUpdate(d, msg(42, '/invoice 700 Cap'));
    await handleUpdate(d, msg(42, '/list'));
    expect(sent.at(-1)!.text).toContain('700');
  });

  it('ignores updates without text', async () => {
    const { d, sent } = setup();
    await handleUpdate(d, { edited_message: {} });
    expect(sent).toEqual([]);
  });

  it('sends through the Bot API', async () => {
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string, init?: RequestInit) => { calls.push({ url, body: String(init?.body) }); return new Response('{}'); }) as typeof fetch;
    await telegramSender('TOKEN', fake)('42', 'hi');
    expect(calls[0]!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: '42', text: 'hi', disable_web_page_preview: true });
  });
});
