import { address, createSolanaRpc } from '@solana/kit';
import type { Cluster, TokenSymbol } from './config.js';
import { DEFAULT_QUOTE_TTL_MS } from './config.js';
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
    this.rateProvider = new RateProvider(
      [new BinanceRateSource(), new SyntheticRateSource()],
      this.options.quoteTtlMs,
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
    });
  }
}
