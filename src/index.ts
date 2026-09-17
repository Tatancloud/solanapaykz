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
/**
 * Преобразование десятичной суммы в целые минимальные единицы токена и
 * обратно — публичный экспорт по той же причине, что и `KZT_DECIMALS`
 * выше: сервер Tilda сравнивает суммы поступлений с суммами заказов в
 * целых единицах (оплата по уникальной сумме), и вторая копия этих
 * формул у него молча разошлась бы с этой.
 */
export { formatUnits, parseDecimalToUnits } from './money.js';
/**
 * Точность и mint токена в конкретной сети — нужны тому же сравнению:
 * лампорты и микро-USDC считаются по `decimals`, а поступления USDC
 * ищутся по токен-аккаунту получателя, который узел находит по `mint`.
 */
export { resolveToken } from './config.js';
export type { TokenInfo } from './config.js';
/**
 * Метка платежа отдельно от построения ссылки — тому, кто записывает
 * метку в свой заказ РАНЬШЕ, чем строит ссылку (см. `reference` в
 * `PaymentRequestOptions`).
 */
export { generateReference } from './payment/request.js';
export {
  ConfigError,
  QuoteExpiredError,
  RateSourceError,
  RateUnavailableError,
  SolanaPayKzError,
} from './errors.js';
