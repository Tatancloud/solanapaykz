export {
  SolanaPayKZ,
  type SolanaPayKZOptions,
  type CreatePaymentRequestOptions,
} from './client.js';
export type { Quote } from './quote/quote.js';
export type { PaymentRequest } from './payment/request.js';
export { SIGNATURE_LIMIT } from './verify/verify.js';
export type { PaymentStatus } from './verify/verify.js';
export type { Cluster, TokenSymbol } from './config.js';
/**
 * Точность тенге (число знаков после запятой) — публичный экспорт,
 * находка ревью. `tilda-server/src/tilda/inbound.ts` строил из этого же
 * числа регулярное выражение допустимого формата суммы отдельной,
 * ничем не связанной копией (`\.\d{1,2}`) — измени `KZT_DECIMALS`
 * здесь, и вторая копия молча продолжила бы жить по старому значению:
 * либо отвергала бы верные суммы, либо пропускала те, на которых
 * `parseDecimalToUnits` уже падает. Экспорт делает связь настоящей —
 * `inbound.ts` строит своё выражение из этого же числа, а не повторяет
 * его руками.
 */
export { KZT_DECIMALS } from './money.js';
export {
  ConfigError,
  QuoteExpiredError,
  RateSourceError,
  RateUnavailableError,
  SolanaPayKzError,
} from './errors.js';
