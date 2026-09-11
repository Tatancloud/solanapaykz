/**
 * Тонкая обёртка над `@solanapaykz/core`.
 *
 * Своих расчётов здесь нет и быть не должно: формулы конвертации тенге в
 * токен, наценки и котировки уже прошли ревью и сверены с реализацией на
 * PHP на 243 случаях — переписывать их заново означало бы рисковать теми
 * же ошибками заново.
 */
import { SolanaPayKZ } from '@solanapaykz/core';
import type { Config } from './config.js';

export function создатьКлиент(config: Config): SolanaPayKZ {
  return new SolanaPayKZ({
    recipient: config.recipient,
    rpcUrl: config.rpcUrl,
    cluster: config.cluster,
    markupPercent: config.markupPercent,
    quoteTtlMs: config.quoteTtlSeconds * 1000,
  });
}
