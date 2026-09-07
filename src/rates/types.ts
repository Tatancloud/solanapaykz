import type { TokenSymbol } from '../config.js';

/** Источник курса. Возвращает, сколько тенге стоит один токен. */
export interface RateSource {
  /** Короткое имя для журнала и поля rateSource в котировке. */
  readonly name: string;
  getKztPerToken(token: TokenSymbol): Promise<string>;
}
