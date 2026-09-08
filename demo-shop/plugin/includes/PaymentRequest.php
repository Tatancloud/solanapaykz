<?php
// demo-shop/plugin/includes/PaymentRequest.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Ссылка Solana Pay, которую покупатель открывает кошельком.
 *
 * Метка платежа — 32 случайных байта в виде адреса. Пара ключей при этом
 * не создаётся и приватного ключа не существует: метка только помечает
 * транзакцию, средств не касается. Требование безопасности из технического
 * задания соблюдается буквально.
 */
final class PaymentRequest
{
    /** Адрес в base58 короче 32 символов заведомо неверен. */
    private const ADDRESS_PATTERN = '/^[1-9A-HJ-NP-Za-km-z]{32,44}$/';

    private function __construct(
        public readonly Quote $quote,
        public readonly string $reference,
        public readonly string $url
    ) {
    }

    /** Случайная метка платежа. Пара ключей не создаётся. */
    public static function generate_reference(): string
    {
        return Base58::encode(random_bytes(32));
    }

    /**
     * @param array{reference?: string, label?: string, message?: string, memo?: string} $options
     */
    public static function create(Quote $quote, string $recipient, array $options = []): self
    {
        if ($quote->is_expired()) {
            throw new QuoteException(sprintf(
                'Котировка %s просрочена, платёжную ссылку по ней выпустить нельзя.',
                $quote->quote_id
            ));
        }

        self::require_valid_address($recipient, 'Адрес получателя');

        $token = Tokens::resolve($quote->cluster, $quote->token);

        // Частая ошибка при настройке: в поле адреса продавца вписывают адрес
        // самой монеты. Владельца у такого счёта нет, и платежи туда уходят
        // безвозвратно — лучше отказать сейчас, чем потерять деньги покупателя.
        if ($token['mint'] !== null && $recipient === $token['mint']) {
            throw new QuoteException(
                'Адрес получателя совпадает с адресом монеты. Укажите адрес кошелька продавца.'
            );
        }

        $reference = $options['reference'] ?? self::generate_reference();
        self::require_valid_address($reference, 'Метка платежа');

        $params = ['amount' => self::trim_zeros($quote->amount_token)];

        if ($token['mint'] !== null) {
            $params['spl-token'] = $token['mint'];
        }

        $params['reference'] = $reference;

        foreach (['label', 'message', 'memo'] as $field) {
            $value = $options[$field] ?? '';

            if ($value !== '') {
                $params[$field] = $value;
            }
        }

        return new self(
            $quote,
            $reference,
            // PHP_QUERY_RFC3986: по умолчанию http_build_query() кодирует
            // пробел как '+' (устаревшее application/x-www-form-urlencoded),
            // а кошелёк декодирует ссылку по RFC3986, где '+' — обычный
            // символ. Покупатель увидел бы «Мой+магазин» и «Заказ+№11» в
            // момент подтверждения платежа.
            'solana:' . $recipient . '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986)
        );
    }

    /**
     * Убирает незначащие нули: библиотека, на которую ориентируются кошельки,
     * выводит «1», а не «1.000000». Одинаковая сумма должна давать одинаковый
     * QR-код независимо от того, чем он построен.
     */
    private static function trim_zeros(string $amount): string
    {
        if (!str_contains($amount, '.')) {
            return $amount;
        }

        return rtrim(rtrim($amount, '0'), '.');
    }

    private static function require_valid_address(string $address, string $label): void
    {
        if ($address === '') {
            throw new QuoteException(sprintf('%s: значение не указано.', $label));
        }

        if (preg_match(self::ADDRESS_PATTERN, $address) !== 1) {
            throw new QuoteException(sprintf(
                '%s: не похож на адрес Solana: %s.',
                $label,
                $address
            ));
        }

        // Адрес должен декодироваться ровно в 32 байта.
        if (Base58::decode($address) === null) {
            throw new QuoteException(sprintf(
                '%s: не похож на адрес Solana: %s.',
                $label,
                $address
            ));
        }
    }
}
