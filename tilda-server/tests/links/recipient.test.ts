// tilda-server/tests/links/recipient.test.ts
import { describe, expect, it } from 'vitest';
import { openLinksStore } from '../../src/links/db.js';
import { checkRecipient, saveSettings, usdcAccountOf } from '../../src/links/recipient.js';

const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('checkRecipient', () => {
  it('accepts a wallet that already has a USDC account', async () => {
    const ata = await usdcAccountOf('devnet', OWNER);
    const probe = { exists: async (a: string) => a === ata };
    expect(await checkRecipient(probe, 'devnet', ` ${OWNER} `)).toEqual({ ok: true, address: OWNER });
  });

  it('rejects malformed input, the USDC mint itself and wallets without a USDC account', async () => {
    const none = { exists: async () => false };
    expect(await checkRecipient(none, 'devnet', 'abc')).toEqual({ ok: false, error: 'format' });
    expect(await checkRecipient(none, 'devnet', DEVNET_USDC)).toEqual({ ok: false, error: 'is_mint' });
    expect(await checkRecipient(none, 'devnet', OWNER)).toEqual({ ok: false, error: 'no_usdc_account' });
  });
});

describe('saveSettings', () => {
  it('changes the recipient without touching invoices already created', () => {
    const store = openLinksStore(':memory:');
    const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    expect(saveSettings(store, m.id, { recipient: OWNER, name: 'Shop', lang: 'en' })).toEqual({ ok: true });
    store.createInvoice({ id: 'i1', merchantId: m.id, amountKzt: '100', description: 'x', token: 'USDC',
      recipient: OWNER, feeBps: 50, source: 'link', createdAt: 1, expiresAt: 2 });
    const NEW = 'So11111111111111111111111111111111111111112';
    saveSettings(store, m.id, { recipient: NEW });
    expect(store.getMerchant(m.id)!.recipient).toBe(NEW);
    expect(store.getInvoice('i1')!.recipient).toBe(OWNER);
  });

  it('validates name length and language', () => {
    const store = openLinksStore(':memory:');
    const m = store.createMerchant({ email: 'a@shop.kz', walletLogin: null, lang: 'en', now: 1 });
    expect(saveSettings(store, m.id, { name: 'x'.repeat(81) })).toEqual({ ok: false, error: 'name' });
    expect(saveSettings(store, m.id, { lang: 'de' })).toEqual({ ok: false, error: 'lang' });
  });
});
