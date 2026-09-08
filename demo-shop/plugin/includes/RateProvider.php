<?php
// demo-shop/plugin/includes/RateProvider.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;

/**
 * Опрашивает источники по порядку и отдаёт первый успешный ответ.
 *
 * Устаревший курс не подставляется никогда: если все источники недоступны,
 * вызывающая сторона получает ошибку. Продавец, получивший деньги по
 * неизвестному курсу, — хуже продавца, увидевшего явный отказ.
 */
final class RateProvider
{
    /** @param list<RateSource> $sources Порядок задаёт приоритет. */
    public function __construct(
        private array $sources,
        private Cache $cache,
        private int $cache_ttl_seconds
    ) {
    }

    /** @return array{rate: string, source: string} */
    public function get_kzt_per_token(string $token): array
    {
        $key = 'rate_' . $token;
        $cached = $this->cache->get($key);

        if ($cached !== null) {
            $parts = explode('|', $cached, 2);

            if (count($parts) === 2 && $parts[1] !== '' && Money::is_valid_decimal($parts[0])
                && bccomp($parts[0], '0', Money::RATE_DECIMALS) > 0
            ) {
                return ['rate' => $parts[0], 'source' => $parts[1]];
            }

            // Запись кеша повреждена, логируем это.
            error_log(sprintf(
                'SolanaPay-KZ: Повреждённая запись кеша для %s: %s',
                $key,
                var_export($cached, true)
            ));
        }

        $failures = [];

        foreach ($this->sources as $source) {
            try {
                $rate = $source->get_kzt_per_token($token);
            } catch (Throwable $error) {
                // Ловим любую ошибку, а не только свою: контракт источников
                // держится на дисциплине, и его нарушение не должно ронять заказ.
                $failures[] = $source->get_name() . ': ' . $error->getMessage();
                continue;
            }

            // Проверяем полученный курс, как внутри источников.
            // Это единственный рубеж между источником и заказом.
            if (!Money::is_valid_decimal($rate) || bccomp($rate, '0', Money::RATE_DECIMALS) <= 0) {
                $failures[] = $source->get_name() . ': непригодный курс ' . var_export($rate, true);
                continue;
            }

            if ($this->cache_ttl_seconds > 0) {
                $this->cache->set($key, $rate . '|' . $source->get_name(), $this->cache_ttl_seconds);
            }

            return ['rate' => $rate, 'source' => $source->get_name()];
        }

        throw new RateUnavailableException(
            'Ни один источник курса не ответил. ' . implode('; ', $failures)
        );
    }
}
