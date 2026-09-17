import { describe, expect, it } from 'vitest';
import { formatUnits, generateReference, parseDecimalToUnits, resolveToken } from '../src/index.js';

/**
 * Проверяет ровно то, что пакет отдаёт НАРУЖУ. Внутренние тесты этих же
 * функций живут в money.test.ts и payment.test.ts — здесь проверяется не
 * поведение, а сам факт экспорта: сервер Tilda (оплата по уникальной
 * сумме) считает суммы в минимальных единицах, и без этих экспортов у
 * него завелась бы вторая копия формул, которая молча разошлась бы с
 * этой. Ровно так уже случалось с KZT_DECIMALS — см. комментарий в
 * src/index.ts.
 */
describe('публичные экспорты пакета', () => {
  it('переводят десятичную сумму в минимальные единицы и обратно', () => {
    expect(parseDecimalToUnits('0.002300000', 9)).toBe(2_300_000n);
    expect(formatUnits(2_300_001n, 9)).toBe('0.002300001');
  });

  it('отдают точность и mint токена по сети', () => {
    expect(resolveToken('mainnet', 'SOL').decimals).toBe(9);
    expect(resolveToken('mainnet', 'SOL').mint).toBeUndefined();
    expect(resolveToken('mainnet', 'USDC')).toEqual({
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
    });
  });

  it('отдают генератор метки платежа', () => {
    expect(generateReference()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
