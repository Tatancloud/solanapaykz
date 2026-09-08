<?php
// demo-shop/plugin/includes/SyntheticRateSource.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Резервный источник: курс доллара к тенге × цена токена в долларах.
 *
 * Прямой запрос цены в тенге у CoinGecko невозможен: тенге нет в списке его
 * валют, а на такой запрос он отвечает HTTP 200 и пустым объектом. Принять
 * это за ответ — значит выставить покупателю счёт на ноль.
 *
 * Курс доллара берётся у агрегатора и обновляется раз в сутки, поэтому его
 * значение отличается от биржевого примерно на процент. Для резервного
 * варианта это приемлемо, но должно быть названо в документации.
 */
final class SyntheticRateSource implements RateSource
{
    private const FX_ENDPOINT = 'https://open.er-api.com/v6/latest/USD';
    private const PRICE_ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';

    private const IDS = ['USDC' => 'usd-coin', 'SOL' => 'solana'];

    public function __construct(
        private HttpClient $http,
        private int $timeout_seconds = 10
    ) {
    }

    public function get_name(): string
    {
        return 'synthetic';
    }

    public function get_kzt_per_token(string $token): string
    {
        return Money::multiply_rates($this->fetch_kzt_per_usd(), $this->fetch_usd_per_token($token));
    }

    private function fetch_kzt_per_usd(): string
    {
        $data = $this->http->get_json(self::FX_ENDPOINT, $this->timeout_seconds);

        if (($data['result'] ?? null) !== 'success') {
            throw new RpcException('Курс валют: ответ без признака успеха.');
        }

        $rates = $data['rates'] ?? null;

        return $this->to_rate(
            is_array($rates) ? ($rates['KZT'] ?? null) : null,
            'Курс валют: в ответе нет тенге'
        );
    }

    private function fetch_usd_per_token(string $token): string
    {
        $id = self::IDS[$token] ?? null;

        if ($id === null) {
            throw new RpcException(sprintf('Неизвестный токен %s.', $token));
        }

        $url = self::PRICE_ENDPOINT . '?ids=' . $id . '&vs_currencies=usd';
        $data = $this->http->get_json($url, $this->timeout_seconds);
        $entry = $data[$id] ?? null;

        return $this->to_rate(
            is_array($entry) ? ($entry['usd'] ?? null) : null,
            sprintf('CoinGecko: нет цены для %s', $id)
        );
    }

    /**
     * Приводит число к строке курса, отвергая всё непригодное.
     *
     * Проверяется не только исходное число, но и результат форматирования:
     * очень большое значение даёт экспоненциальную запись, очень маленькое
     * округляется до нулей — и то, и другое непригодно как курс.
     */
    private function to_rate(mixed $value, string $error_message): string
    {
        if (!is_int($value) && !is_float($value)) {
            throw new RpcException(sprintf('%s (получено %s).', $error_message, var_export($value, true)));
        }

        if (!is_finite((float) $value) || $value <= 0) {
            throw new RpcException(sprintf('%s (непригодное значение %s).', $error_message, var_export($value, true)));
        }

        $formatted = number_format((float) $value, Money::RATE_DECIMALS, '.', '');

        // Точность обязательна по той же причине, что и в источнике Binance:
        // цена USDC к доллару меньше единицы, и сравнение по целым частям
        // отвергло бы её как нулевую.
        if (!Money::is_valid_decimal($formatted) || bccomp($formatted, '0', Money::RATE_DECIMALS) <= 0) {
            throw new RpcException(sprintf('%s (после форматирования получилось %s).', $error_message, $formatted));
        }

        return $formatted;
    }
}
