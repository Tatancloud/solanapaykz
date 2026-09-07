import { address, createSolanaRpc } from '@solana/kit';
import type { Cluster, TokenSymbol } from './config.js';
import { DEFAULT_QUOTE_TTL_MS, DEFAULT_RATE_CACHE_TTL_MS } from './config.js';
import { ConfigError } from './errors.js';
import { createPaymentRequest, type PaymentRequest, type PaymentRequestOptions } from './payment/request.js';
import { createQuote, type Quote } from './quote/quote.js';
import { BinanceRateSource } from './rates/binance.js';
import { RateProvider } from './rates/provider.js';
import { SyntheticRateSource } from './rates/synthetic.js';
import { checkPayment, type PaymentStatus } from './verify/verify.js';

export interface SolanaPayKZOptions {
  /** Solana-адрес продавца. */
  recipient: string;
  /**
   * Адрес RPC. Обязателен и не имеет значения по умолчанию: публичный узел
   * жёстко лимитирован и не хранит достаточно истории для поиска транзакции.
   */
  rpcUrl: string;
  cluster: Cluster;
  /** Надбавка к сумме в тенге, процент. По умолчанию 0. */
  markupPercent?: number;
  /** Срок жизни котировки. По умолчанию 15 минут. */
  quoteTtlMs?: number;
}

/**
 * Параметры, которые реально принимает `SolanaPayKZ.createPaymentRequest` —
 * то же самое, что `PaymentRequestOptions`, но без `recipient`: адрес
 * получателя уже зафиксирован в конструкторе клиента и не может быть
 * переопределён на уровне отдельного запроса.
 */
export type CreatePaymentRequestOptions = Omit<PaymentRequestOptions, 'recipient'>;

export class SolanaPayKZ {
  private readonly rateProvider: RateProvider;
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  private readonly options: Required<Pick<SolanaPayKZOptions, 'markupPercent' | 'quoteTtlMs'>> &
    SolanaPayKZOptions;

  constructor(options: SolanaPayKZOptions) {
    if (!options.rpcUrl) {
      throw new ConfigError('Не указан rpcUrl — адрес RPC обязателен');
    }
    // Проверка через конструктор URL — опечатка в адресе должна всплыть
    // сразу как явная ошибка конфигурации, а не как непонятный сетевой сбой
    // при первом обращении к RPC.
    try {
      new URL(options.rpcUrl);
    } catch (error) {
      throw new ConfigError(`Некорректный rpcUrl: ${options.rpcUrl}`, { cause: error });
    }
    try {
      address(options.recipient);
    } catch (error) {
      throw new ConfigError(`Некорректный адрес получателя: ${options.recipient}`, { cause: error });
    }

    this.options = {
      ...options,
      markupPercent: options.markupPercent ?? 0,
      quoteTtlMs: options.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS,
    };
    this.rpc = createSolanaRpc(options.rpcUrl);
    // Срок жизни кеша курса — независимая от quoteTtlMs величина. См.
    // DEFAULT_RATE_CACHE_TTL_MS в config.ts: раньше quoteTtlMs управлял и
    // сроком котировки, и сроком кеша курса одновременно, что удваивало
    // окно ценового риска (а для quoteTtlMs в сутки — растягивало кеш курса
    // на сутки).
    this.rateProvider = new RateProvider(
      [new BinanceRateSource(), new SyntheticRateSource()],
      DEFAULT_RATE_CACHE_TTL_MS,
    );
  }

  createQuote(params: { amountKzt: string; token: TokenSymbol }): Promise<Quote> {
    return createQuote({
      amountKzt: params.amountKzt,
      token: params.token,
      cluster: this.options.cluster,
      rateProvider: this.rateProvider,
      markupPercent: this.options.markupPercent,
      ttlMs: this.options.quoteTtlMs,
    });
  }

  createPaymentRequest(
    quote: Quote,
    options: CreatePaymentRequestOptions = {},
  ): Promise<PaymentRequest> {
    return createPaymentRequest(quote, { ...options, recipient: this.options.recipient });
  }

  checkPayment(params: { reference: string; quote: Quote }): Promise<PaymentStatus> {
    return checkPayment(this.rpc, {
      reference: params.reference,
      quote: params.quote,
      recipient: this.options.recipient,
      cluster: this.options.cluster,
    });
  }
}
