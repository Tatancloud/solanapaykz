<?php
// demo-shop/plugin/includes/Quote.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;

/**
 * Зафиксированная цена заказа в криптовалюте.
 *
 * QR-код несёт неизменную сумму, а платит покупатель когда захочет, поэтому
 * курс замораживается на ограниченный срок: риск его сдвига несёт продавец.
 *
 * Свойства объявлены readonly: котировку хранят в заказе и потом сверяют с
 * пришедшим платежом, поэтому менять её после создания нельзя.
 */
final class Quote
{
    /** Пятнадцать минут. Обоснование срока — в спецификации, раздел 7. */
    public const DEFAULT_TTL_SECONDS = 900;

    private function __construct(
        public readonly string $quote_id,
        public readonly string $amount_kzt,
        public readonly string $amount_kzt_charged,
        public readonly string $token,
        public readonly string $cluster,
        public readonly string $amount_token,
        public readonly string $rate,
        public readonly string $rate_source,
        public readonly int $created_at,
        public readonly int $expires_at
    ) {
    }

    public static function create(
        RateProvider $rates,
        string $amount_kzt,
        string $token,
        string $cluster,
        float $markup_percent = 0.0,
        int $ttl_seconds = self::DEFAULT_TTL_SECONDS
    ): self {
        if ($ttl_seconds <= 0) {
            throw new QuoteException(
                sprintf('Срок жизни котировки должен быть положительным, получено %d.', $ttl_seconds)
            );
        }

        // Всё дешёвое и синхронное — до сетевого запроса за курсом: нет смысла
        // ходить к бирже ради заведомо неверной суммы.
        $decimals = Tokens::resolve($cluster, $token)['decimals'];

        try {
            $charged = Money::apply_markup($amount_kzt, $markup_percent);
        } catch (Throwable $error) {
            throw new QuoteException($error->getMessage(), 0, $error);
        }

        if (bccomp(Money::parse_decimal_to_units($charged, Money::KZT_DECIMALS), '0') <= 0) {
            throw new QuoteException('Сумма заказа должна быть больше нуля.');
        }

        $rate = $rates->get_kzt_per_token($token);

        try {
            $units = Money::convert_kzt_to_token_units($charged, $rate['rate'], $decimals);
        } catch (Throwable $error) {
            throw new QuoteException($error->getMessage(), 0, $error);
        }

        $now = time();

        return new self(
            bin2hex(random_bytes(16)),
            $amount_kzt,
            $charged,
            $token,
            $cluster,
            Money::format_units($units, $decimals),
            $rate['rate'],
            $rate['source'],
            $now,
            $now + $ttl_seconds
        );
    }

    /** Котировка просрочена начиная с момента истечения включительно. */
    public function is_expired(?int $now = null): bool
    {
        return ($now ?? time()) >= $this->expires_at;
    }

    /** @return array<string, string|int> */
    public function to_array(): array
    {
        return [
            'quote_id'           => $this->quote_id,
            'amount_kzt'         => $this->amount_kzt,
            'amount_kzt_charged' => $this->amount_kzt_charged,
            'token'              => $this->token,
            'cluster'            => $this->cluster,
            'amount_token'       => $this->amount_token,
            'rate'               => $this->rate,
            'rate_source'        => $this->rate_source,
            'created_at'         => $this->created_at,
            'expires_at'         => $this->expires_at,
        ];
    }

    /**
     * Восстанавливает котировку из записи заказа.
     *
     * Каждое поле проверяется заново: запись пролежала в базе магазина и
     * пришла к нам извне. Пустое поле суммы из-за неудачной миграции
     * означало бы проверку платежа на нулевую сумму, то есть подтверждение
     * любого перевода.
     *
     * @param array<string, mixed> $data
     */
    public static function from_array(array $data): self
    {
        foreach (['quote_id', 'amount_kzt', 'amount_kzt_charged', 'token', 'cluster',
                  'amount_token', 'rate', 'rate_source', 'created_at', 'expires_at'] as $field) {
            if (!array_key_exists($field, $data)) {
                throw new QuoteException(sprintf('В записи котировки нет поля «%s».', $field));
            }
        }

        $decimals = Tokens::resolve((string) $data['cluster'], (string) $data['token'])['decimals'];

        $quote_id = (string) $data['quote_id'];

        if ($quote_id === '') {
            throw new QuoteException('Идентификатор котировки пуст.');
        }

        self::require_positive_amount((string) $data['amount_token'], $decimals, 'Сумма к оплате');
        self::require_positive_amount((string) $data['rate'], Money::RATE_DECIMALS, 'Курс');

        $created_at = (int) $data['created_at'];
        $expires_at = (int) $data['expires_at'];

        if ($expires_at <= $created_at) {
            throw new QuoteException('Срок истечения котировки не позже момента её создания.');
        }

        return new self(
            $quote_id,
            (string) $data['amount_kzt'],
            (string) $data['amount_kzt_charged'],
            (string) $data['token'],
            (string) $data['cluster'],
            (string) $data['amount_token'],
            (string) $data['rate'],
            (string) $data['rate_source'],
            $created_at,
            $expires_at
        );
    }

    private static function require_positive_amount(string $value, int $decimals, string $label): void
    {
        // Точность в сравнении обязательна: без неё сверяются только целые
        // части, и любое значение меньше единицы считается нулём.
        if (!Money::is_valid_decimal($value) || bccomp($value, '0', $decimals) <= 0) {
            throw new QuoteException(sprintf(
                '%s в записи котировки непригодна: %s.',
                $label,
                var_export($value, true)
            ));
        }
    }
}
