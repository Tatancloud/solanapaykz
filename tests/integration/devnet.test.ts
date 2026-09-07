// Запускается отдельно: npx vitest run --config vitest.integration.config.ts
// Требует сети. В обычный прогон не входит.
import { describe, expect, it } from 'vitest';
import { createSolanaRpc } from '@solana/kit';
import { checkPayment } from '../../src/verify/verify.js';
import { generateReference } from '../../src/payment/request.js';

const RPC_URL = process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';

describe('devnet', () => {
  it('на случайную метку отвечает pending, а не падает', async () => {
    const rpc = createSolanaRpc(RPC_URL);
    const status = await checkPayment(rpc, {
      reference: generateReference(),
      quote: {
        quoteId: 'test',
        amountKzt: '100',
        amountKztCharged: '100.00',
        token: 'USDC',
        cluster: 'devnet',
        amountToken: '0.217580',
        rate: '459.60000000',
        rateSource: 'binance',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
      // Валидный Solana-адрес, специально НЕ совпадающий с mint USDC devnet
      // (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU из config.ts).
      recipient: '11111111111111111111111111111111',
      cluster: 'devnet',
    });
    expect(status.status).toBe('pending');
  }, 30_000);
});
