import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { resolveToken } from '../src/config.js';

describe('конфигурация токенов', () => {
  it('отдаёт mint и decimals для USDC в mainnet', () => {
    const t = resolveToken('mainnet', 'USDC');
    expect(t.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(t.decimals).toBe(6);
  });

  it('отдаёт другой mint для devnet', () => {
    expect(resolveToken('devnet', 'USDC').mint)
      .toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });

  it('у SOL нет mint и 9 знаков', () => {
    const t = resolveToken('mainnet', 'SOL');
    expect(t.mint).toBeUndefined();
    expect(t.decimals).toBe(9);
  });

  it('бросает ConfigError на неизвестном токене', () => {
    // @ts-expect-error проверяем поведение в рантайме
    expect(() => resolveToken('mainnet', 'BTC')).toThrow(ConfigError);
  });
});
