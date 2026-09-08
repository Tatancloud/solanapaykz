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
    /**
     * Максимальное отклонение свежего курса от последнего принятого значения
     * того же токена, в процентах. Курс токена законно движется за минуты,
     * но скачок больше пятой части — не рыночное движение, а признак того,
     * что источник поменял базовую пару или отдал цену другого инструмента
     * (см. RateSource::USD_KZT_MIN/MAX — там тот же принцип для курса
     * доллара). Двадцать процентов с большим запасом переживают и то, что
     * резервный источник обновляется раз в сутки и обычно даёт значение
     * примерно на процент ниже биржевого.
     */
    private const MAX_DEVIATION_PERCENT = '20';

    /**
     * Срок памяти о последнем принятом курсе — для сверки, а не для показа
     * покупателю: это не тот кеш, что $cache_ttl_seconds (обычно минута),
     * а куда более долгая память, переживающая обычные перерывы в трафике
     * магазина. Сутки — тот же срок, что и предельный TTL самой котировки
     * (Quote::from_array()), с той же логикой: дольше — уже не «недавняя
     * проверка», а решение, которое стоит доверить администратору, а не
     * автоматике.
     */
    public const LAST_KNOWN_TTL_SECONDS = 86400;

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

        $last_known_key = 'rate_last_known_' . $token;
        $last_known = $this->read_last_known($last_known_key);

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

            // Сверка с предыдущим принятым значением ловит то, что полоса
            // правдоподобия внутри источников не видит: подмену пары или
            // инструмента, которая всё ещё укладывается в 400–600 (например,
            // источник молча вернул курс евро вместо доллара). Пропускаем
            // сверку, если памяти ещё нет (первый запуск) или она устарела.
            if ($last_known !== null && $this->deviates_too_much($rate, $last_known)) {
                $failures[] = sprintf(
                    '%s: курс %s отклоняется от последнего принятого значения %s больше чем на %s%%.',
                    $source->get_name(),
                    $rate,
                    $last_known,
                    self::MAX_DEVIATION_PERCENT
                );
                continue;
            }

            if ($this->cache_ttl_seconds > 0) {
                $this->cache->set($key, $rate . '|' . $source->get_name(), $this->cache_ttl_seconds);
            }

            $this->cache->set($last_known_key, $rate, self::LAST_KNOWN_TTL_SECONDS);

            return ['rate' => $rate, 'source' => $source->get_name()];
        }

        throw new RateUnavailableException(
            'Ни один источник курса не ответил. ' . implode('; ', $failures)
        );
    }

    /** Читает память о последнем принятом курсе, отбрасывая повреждённую запись без падения. */
    private function read_last_known(string $key): ?string
    {
        $value = $this->cache->get($key);

        if ($value === null || !Money::is_valid_decimal($value) || bccomp($value, '0', Money::RATE_DECIMALS) <= 0) {
            return null;
        }

        return $value;
    }

    /** Отклонение больше MAX_DEVIATION_PERCENT % от предыдущего значения — точной арифметикой bcmath. */
    private function deviates_too_much(string $rate, string $previous): bool
    {
        $scale = Money::RATE_DECIMALS + 6;
        $diff = bcsub($rate, $previous, $scale);

        if (bccomp($diff, '0', $scale) < 0) {
            $diff = bcmul($diff, '-1', $scale);
        }

        $threshold = bcmul($previous, bcdiv(self::MAX_DEVIATION_PERCENT, '100', $scale), $scale);

        return bccomp($diff, $threshold, $scale) > 0;
    }
}
