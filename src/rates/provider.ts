import type { TokenSymbol } from '../config.js';
import { RateUnavailableError } from '../errors.js';
import type { RateSource } from './types.js';

interface CacheEntry {
  rate: string;
  source: string;
  expiresAt: number;
}

export interface RateResult {
  rate: string;
  source: string;
}

/**
 * Опрашивает источники по порядку и отдаёт первый успешный ответ.
 *
 * Устаревший курс не подставляется никогда: если все источники недоступны,
 * вызывающая сторона получает ошибку. Продавец, получивший деньги по
 * неизвестно какому курсу, — хуже, чем продавец, увидевший явный отказ.
 */
export class RateProvider {
  private readonly cache = new Map<TokenSymbol, CacheEntry>();

  constructor(
    private readonly sources: readonly RateSource[],
    private readonly cacheTtlMs: number,
  ) {}

  async getKztPerToken(token: TokenSymbol): Promise<RateResult> {
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return { rate: cached.rate, source: cached.source };
    }

    const failures: unknown[] = [];
    for (const source of this.sources) {
      try {
        const rate = await source.getKztPerToken(token);
        if (this.cacheTtlMs > 0) {
          this.cache.set(token, { rate, source: source.name, expiresAt: Date.now() + this.cacheTtlMs });
        }
        return { rate, source: source.name };
      } catch (error) {
        failures.push(error);
      }
    }

    const names = this.sources.map((s) => s.name).join(', ');
    throw new RateUnavailableError(
      `Ни один источник курса не ответил (${names})`,
      { cause: failures },
    );
  }
}
