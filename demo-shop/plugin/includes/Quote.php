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

        // Идентификатор должен быть ровно 32 шестнадцатеричных символа
        if (!preg_match('/^[0-9a-f]{32}$/', $quote_id)) {
            throw new QuoteException(sprintf(
                'Идентификатор котировки имеет неправильный формат: %s.',
                var_export($quote_id, true)
            ));
        }

        // Проверяем исходную и заряженную суммы в тенге
        self::require_valid_decimal((string) $data['amount_kzt'], Money::KZT_DECIMALS, 'Исходная сумма в тенге');
        self::require_valid_decimal((string) $data['amount_kzt_charged'], Money::KZT_DECIMALS, 'Сумма в тенге после наценки');

        // Проверяем имя источника курса
        $rate_source = (string) $data['rate_source'];
        if ($rate_source === '') {
            throw new QuoteException('Имя источника курса не может быть пустым.');
        }

        self::require_positive_amount((string) $data['amount_token'], $decimals, 'Сумма к оплате');
        self::require_positive_amount((string) $data['rate'], Money::RATE_DECIMALS, 'Курс');

        // Проверяем, что временные метки приводятся к int из числовых значений, а не из строк типа "abc"
        self::require_numeric_timestamp($data['created_at'], 'Время создания котировки');
        self::require_numeric_timestamp($data['expires_at'], 'Время истечения котировки');

        $created_at = (int) $data['created_at'];
        $expires_at = (int) $data['expires_at'];

        if ($expires_at <= $created_at) {
            throw new QuoteException('Срок истечения котировки не позже момента её создания.');
        }

        // Срок жизни котировки не должен превышать сутки (86400 секунд).
        // Обоснование: котировка замораживает курс, и риск его сдвига несёт продавец.
        // Сутки — разумный максимум для этого риска.
        $ttl = $expires_at - $created_at;
        if ($ttl > 86400) {
            throw new QuoteException(sprintf(
                'Срок жизни котировки превышает сутки: %d секунд.',
                $ttl
            ));
        }

        // Проверяем согласованность суммы токена: пересчитываем её из суммы в тенге и курса
        // и сравниваем с записанным значением. Это закрывает целый класс порчи записи вместо
        // перечисления отдельных видов.
        try {
            $recalculated_units = Money::convert_kzt_to_token_units(
                (string) $data['amount_kzt_charged'],
                (string) $data['rate'],
                $decimals
            );
            $recalculated_token = Money::format_units($recalculated_units, $decimals);
        } catch (Throwable $error) {
            throw new QuoteException(sprintf(
                'Не удалось пересчитать сумму токена при восстановлении: %s',
                $error->getMessage()
            ), 0, $error);
        }

        if ($recalculated_token !== (string) $data['amount_token']) {
            throw new QuoteException(sprintf(
                'Сумма токена в записи не совпадает с пересчётом из суммы в тенге и курса: '
                . 'запись содержит %s, а должно быть %s.',
                var_export((string) $data['amount_token'], true),
                var_export($recalculated_token, true)
            ));
        }

        return new self(
            $quote_id,
            (string) $data['amount_kzt'],
            (string) $data['amount_kzt_charged'],
            (string) $data['token'],
            (string) $data['cluster'],
            (string) $data['amount_token'],
            (string) $data['rate'],
            $rate_source,
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

    private static function require_valid_decimal(string $value, int $decimals, string $label): void
    {
        // Проверяем, что значение имеет правильный формат десятичного числа
        if (!Money::is_valid_decimal($value)) {
            throw new QuoteException(sprintf(
                '%s имеет неправильный формат: %s.',
                $label,
                var_export($value, true)
            ));
        }

        // Проверяем, что точность не превышает допустимую
        $parts = explode('.', $value, 2);
        $frac = $parts[1] ?? '';

        if (strlen($frac) > $decimals) {
            throw new QuoteException(sprintf(
                '%s имеет %d знаков после запятой, допустимо не более %d: %s.',
                $label,
                strlen($frac),
                $decimals,
                var_export($value, true)
            ));
        }
    }

    private static function require_numeric_timestamp(mixed $value, string $label): void
    {
        // Проверяем, что значение числовое до приведения к int.
        // Строка "abc" молча превращается в 0, "100abc" — в 100. Это ошибка.
        if (!is_int($value) && !is_numeric($value)) {
            throw new QuoteException(sprintf(
                '%s должна быть числовой, получено: %s.',
                $label,
                var_export($value, true)
            ));
        }
    }
}
