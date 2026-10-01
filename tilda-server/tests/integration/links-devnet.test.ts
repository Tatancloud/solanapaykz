// tilda-server/tests/integration/links-devnet.test.ts — run manually: DEVNET_PAYER_SECRET=<base58 64-byte secret> npx vitest run tests/integration
import { describe, expect, it } from 'vitest';
import { createKeyPairSignerFromBytes, createSolanaRpc, getBase58Encoder, getBase64Encoder, getTransactionDecoder,
  signTransaction, getBase64EncodedWireTransaction, address } from '@solana/kit';
import { openLinksStore } from '../../src/links/db.js';
import { loadLinksConfig } from '../../src/links/config.js';
import { activeQuote, createInvoiceFor } from '../../src/links/invoices.js';
import { buildPaymentTransaction } from '../../src/links/tx.js';
import { createRpc, detectOnce } from '../../src/links/detect.js';
import { generateReference } from '@solanapaykz/core';

const secret = process.env.DEVNET_PAYER_SECRET;
const RPC = process.env.DEVNET_RPC ?? 'https://api.devnet.solana.com';

describe.skipIf(!secret)('devnet: pay an invoice in SOL and detect it', () => {
  it('turns the invoice paid', async () => {
    const rpc = createSolanaRpc(RPC);
    const payer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret!));
    const merchant = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    const store = openLinksStore(':memory:');
    // A fresh fee wallet, funded above rent-exemption first: a fee below that minimum to a new account fails on-chain,
    // and using the payer as the fee wallet makes its balance delta negative (the split check then says mismatch).
    const feeWallet = address(generateReference());
    const fund = await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: payer.address, merchant: feeWallet,
      feeWallet, merchantUnits: 2_000_000n, feeUnits: 0n, reference: generateReference(), memo: 'fund fee wallet',
      blockhash: (await rpc.getLatestBlockhash().send()).value });
    const fundSigned = await signTransaction([payer.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(fund)));
    const fundSig = await rpc.sendTransaction(getBase64EncodedWireTransaction(fundSigned), { encoding: 'base64' }).send();
    for (let i = 0; i < 20; i++) {
      const st = (await rpc.getSignatureStatuses([fundSig]).send()).value[0];
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    const links = loadLinksConfig({ feeWallet, sessionPepper: 'pepper-pepper-pepper' });
    const deps = { store, links, cluster: 'devnet' as const, now: () => Date.now(),
      quoter: { quote: async () => ({ amountToken: '0.001', rate: '1', rateSource: 'test' }) } };
    const m = store.createMerchant({ email: 'it@test', walletLogin: null, lang: 'en', now: Date.now() });
    store.updateMerchant(m.id, { recipient: merchant });
    const r = createInvoiceFor(deps, store.getMerchant(m.id)!, { amountKzt: '1', description: 'it', token: 'SOL' }, 'link');
    if (!r.ok) throw new Error(r.error);
    const q = await activeQuote(deps, r.invoice);
    const b64 = await buildPaymentTransaction({ cluster: 'devnet', token: 'SOL', buyer: payer.address, merchant,
      feeWallet: links.feeWallet, merchantUnits: q.merchantUnits, feeUnits: q.feeUnits, reference: q.reference,
      memo: `inv:${r.invoice.id}`, blockhash: (await rpc.getLatestBlockhash().send()).value });
    const signed = await signTransaction([payer.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(b64)));
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    const events: string[] = [];
    for (let i = 0; i < 20 && store.getInvoice(r.invoice.id)!.state === 'open'; i++) {
      await new Promise((ok) => setTimeout(ok, 3000));
      await detectOnce({ store, rpc: createRpc(RPC), cluster: 'devnet', feeWallet: links.feeWallet, now: () => Date.now(),
        onEvent: async (e) => { events.push(e.kind); }, log: { warn: (m, f) => console.warn(m, f) } });
    }
    expect(store.getInvoice(r.invoice.id)!.state).toBe('paid');
    expect(events).toEqual(['paid']);
  }, 90_000);
});
