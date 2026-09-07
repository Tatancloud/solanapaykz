export { SolanaPayKZ, type SolanaPayKZOptions } from './client.js';
export { createQuote, isQuoteExpired, type Quote } from './quote/quote.js';
export {
  createPaymentRequest,
  generateReference,
  type PaymentRequest,
  type PaymentRequestOptions,
} from './payment/request.js';
export { checkPayment, type PaymentStatus } from './verify/verify.js';
export { RateProvider } from './rates/provider.js';
export { BinanceRateSource } from './rates/binance.js';
export { SyntheticRateSource } from './rates/synthetic.js';
export type { RateSource } from './rates/types.js';
export type { Cluster, TokenSymbol } from './config.js';
export {
  ConfigError,
  PaymentValidationError,
  QuoteExpiredError,
  RateSourceError,
  RateUnavailableError,
  SolanaPayKzError,
} from './errors.js';

export const VERSION = '0.1.0';
