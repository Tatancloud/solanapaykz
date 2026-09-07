import { describe, expect, it, vi } from 'vitest';
import { RateUnavailableError } from '../../src/errors.js';
import { RateProvider } from '../../src/rates/provider.js';
import type { RateSource } from '../../src/rates/types.js';

function source(name: string, behavior: () => Promise<string>): RateSource {
  return { name, getKztPerToken: vi.fn(behavior) };
}

describe('RateProvider', () => {
  it('берёт курс из первого источника', async () => {
    const provider = new RateProvider([source('binance', async () => '459.60000000')], 0);
    expect(await provider.getKztPerToken('USDC'))
      .toEqual({ rate: '459.60000000', source: 'binance' });
  });

  it('переходит к резервному, когда основной упал', async () => {
    const primary = source('binance', async () => { throw new Error('сеть недоступна'); });
    const backup = source('synthetic', async () => '455.29600000');
    const provider = new RateProvider([primary, backup], 0);

    const result = await provider.getKztPerToken('USDC');
    expect(result).toEqual({ rate: '455.29600000', source: 'synthetic' });
    expect(primary.getKztPerToken).toHaveBeenCalledOnce();
  });

  it('бросает RateUnavailableError, когда упали все', async () => {
    const provider = new RateProvider([
      source('binance', async () => { throw new Error('раз'); }),
      source('synthetic', async () => { throw new Error('два'); }),
    ], 0);
    await expect(provider.getKztPerToken('USDC')).rejects.toThrow(RateUnavailableError);
  });

  it('не подставляет устаревший курс вместо ошибки', async () => {
    let shouldFail = false;
    const flaky = source('binance', async () => {
      if (shouldFail) throw new Error('упал');
      return '459.60000000';
    });
    const provider = new RateProvider([flaky], 0); // кеш выключен
    await provider.getKztPerToken('USDC');
    shouldFail = true;
    await expect(provider.getKztPerToken('USDC')).rejects.toThrow(RateUnavailableError);
  });

  it('отдаёт закешированный курс, не обращаясь к источнику повторно', async () => {
    const primary = source('binance', async () => '459.60000000');
    const provider = new RateProvider([primary], 60_000);

    await provider.getKztPerToken('USDC');
    await provider.getKztPerToken('USDC');
    expect(primary.getKztPerToken).toHaveBeenCalledOnce();
  });

  it('кеширует токены раздельно', async () => {
    const primary = source('binance', async () => '459.60000000');
    const provider = new RateProvider([primary], 60_000);

    await provider.getKztPerToken('USDC');
    await provider.getKztPerToken('SOL');
    expect(primary.getKztPerToken).toHaveBeenCalledTimes(2);
  });

  it('обновляет курс после истечения кеша', async () => {
    vi.useFakeTimers();
    const primary = source('binance', async () => '459.60000000');
    const provider = new RateProvider([primary], 1000);

    await provider.getKztPerToken('USDC');
    vi.advanceTimersByTime(1001);
    await provider.getKztPerToken('USDC');

    expect(primary.getKztPerToken).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
