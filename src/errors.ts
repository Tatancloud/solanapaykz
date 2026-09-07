/** Базовая ошибка SDK. Все остальные наследуются от неё. */
export class SolanaPayKzError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Один источник курса недоступен или вернул бессмысленный ответ. */
export class RateSourceError extends SolanaPayKzError {}

/** Ни один источник курса не ответил. */
export class RateUnavailableError extends SolanaPayKzError {}

/** Котировка просрочена. */
export class QuoteExpiredError extends SolanaPayKzError {}

/** Неверная конфигурация SDK. */
export class ConfigError extends SolanaPayKzError {}
