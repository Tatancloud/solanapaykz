<?php
// demo-shop/plugin/includes/BinanceRateSource.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Основной источник курса.
 *
 * На бирже существует ровно одна пара с тенге — USDTKZT, поэтому курс токена
 * собирается из двух тикеров: USDTKZT × USDCUSDT для USDC и USDTKZT × SOLUSDT
 * для SOL. Пар KZTUSDC или KZTSOL не существует.
 */
final class BinanceRateSource implements RateSource
{
    private const ENDPOINT = 'https://api.binance.com/api/v3/ticker/price';

    public function __construct(
        private HttpClient $http,
        private int $timeout_seconds = 10
    ) {
    }

    public function get_name(): string
    {
        return 'binance';
    }

    public function get_kzt_per_token(string $token): string
    {
        $kzt_per_usdt  = $this->fetch_price('USDTKZT');

        // Полоса — только на курс доллара: цена самого токена (USDCUSDT
        // около единицы, SOLUSDT — десятки-сотни) к тенге отношения не
        // имеет, и диапазон 400–600 к ней неприменим.
        $this->assert_plausible_usd_rate($kzt_per_usdt);

        $usdt_per_token = $this->fetch_price($token === 'USDC' ? 'USDCUSDT' : 'SOLUSDT');

        return Money::multiply_rates($kzt_per_usdt, $usdt_per_token);
    }

    private function fetch_price(string $symbol): string
    {
        $data = $this->http->get_json(self::ENDPOINT . '?symbol=' . $symbol, $this->timeout_seconds);
        $price = $data['price'] ?? null;

        // Формат проверяется тем же предикатом, что и в денежном модуле:
        // иначе непригодное значение упадёт двумя слоями выше чужой ошибкой.
        // Точность в bccomp обязательна: без неё сравниваются только целые
        // части, и любая цена меньше единицы (а USDCUSDT колеблется около неё)
        // будет принята за ноль и отвергнута. Проверено.
        if (!is_string($price) || !Money::is_valid_decimal($price)
            || bccomp($price, '0', Money::RATE_DECIMALS) <= 0
        ) {
            throw new RpcException(sprintf(
                'Binance %s: непригодная цена %s.',
                $symbol,
                var_export($price, true)
            ));
        }

        return $price;
    }

    /**
     * Отвергает курс доллара к тенге вне полосы правдоподобия (см.
     * RateSource::USD_KZT_MIN/MAX). Единственный признак завышения курса
     * при смене базовой пары биржей — иначе заказ на тысячи тенге
     * превращается в доли токена, а покупатель платит копейку и получает
     * подтверждение.
     */
    private function assert_plausible_usd_rate(string $rate): void
    {
        if (bccomp($rate, self::USD_KZT_MIN, Money::RATE_DECIMALS) < 0
            || bccomp($rate, self::USD_KZT_MAX, Money::RATE_DECIMALS) > 0
        ) {
            throw new RpcException(sprintf(
                'Binance USDTKZT: курс %s вне полосы правдоподобия [%s; %s] для курса доллара к тенге.',
                $rate,
                self::USD_KZT_MIN,
                self::USD_KZT_MAX
            ));
        }
    }
}
