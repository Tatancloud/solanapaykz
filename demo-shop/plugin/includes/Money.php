<?php
// demo-shop/plugin/includes/Money.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use InvalidArgumentException;
use RuntimeException;

/**
 * Арифметика денег на bcmath.
 *
 * Обычные целые PHP 64-битные, и промежуточное произведение в формуле
 * конвертации переполняется на сумме 92 233,72 ₸, молча превращаясь в
 * число с плавающей точкой. Поэтому все величины — строки, все действия
 * через bcmath.
 *
 * Три округления смещены в одну сторону, в пользу продавца: сумма токена
 * округляется вверх, курс при разборе усекается вниз (меньше тенге за
 * токен — больше токенов к оплате), наценка тоже вверх.
 */
final class Money
{
    /** Тенге хранятся с точностью до тиына. */
    public const KZT_DECIMALS = 2;

    /** Курсы бирж приходят с восемью знаками. */
    public const RATE_DECIMALS = 8;

    private const DECIMAL_PATTERN = '/^\d+(\.\d+)?$/';

    public static function is_valid_decimal(string $value): bool
    {
        return (bool) preg_match(self::DECIMAL_PATTERN, $value);
    }

    /**
     * Переводит десятичную строку в целые минимальные единицы.
     *
     * Лишние знаки по умолчанию отбрасываются: курсы бирж приходят с
     * большей точностью, чем нам нужна, и усечение курса вниз играет в
     * пользу продавца. Для сумм в тенге обрезание запрещается: тенге не
     * бывает точнее тиына, и молча терять копейки продавца нельзя.
     */
    public static function parse_decimal_to_units(
        string $value,
        int $decimals,
        bool $allow_truncation = true
    ): string {
        if (!self::is_valid_decimal($value)) {
            throw new InvalidArgumentException(
                sprintf('Некорректное десятичное число: «%s».', $value)
            );
        }

        $parts = explode('.', $value, 2);
        $whole = $parts[0];
        $frac  = $parts[1] ?? '';

        if (!$allow_truncation && strlen($frac) > $decimals) {
            throw new InvalidArgumentException(sprintf(
                'Сумма «%s» имеет %d знаков после запятой, допустимо не более %d.',
                $value,
                strlen($frac),
                $decimals
            ));
        }

        $frac = substr($frac . str_repeat('0', $decimals), 0, $decimals);

        return ltrim($whole . $frac, '0') ?: '0';
    }

    /** Обратное преобразование: целые единицы в десятичную строку. */
    public static function format_units(string $units, int $decimals): string
    {
        if (strpos($units, '.') !== false) {
            throw new InvalidArgumentException(
                sprintf('Единицы должны быть целым числом, получено «%s».', $units)
            );
        }

        if (!preg_match('/^-?\d+$/', $units)) {
            throw new InvalidArgumentException(
                sprintf('Единицы должны быть целым числом, получено «%s».', $units)
            );
        }

        if (bccomp($units, '0') < 0) {
            throw new InvalidArgumentException(
                sprintf('Сумма не может быть отрицательной: %s.', $units)
            );
        }

        if ($decimals === 0) {
            return $units;
        }

        $padded = str_pad($units, $decimals + 1, '0', STR_PAD_LEFT);

        return substr($padded, 0, -$decimals) . '.' . substr($padded, -$decimals);
    }

    /** Целочисленное деление с округлением вверх. */
    public static function ceil_div(string $a, string $b): string
    {
        if (strpos($a, '.') !== false) {
            throw new InvalidArgumentException(
                sprintf('Делимое должно быть целым числом, получено «%s».', $a)
            );
        }

        if (strpos($b, '.') !== false) {
            throw new InvalidArgumentException(
                sprintf('Делитель должен быть целым числом, получено «%s».', $b)
            );
        }

        if (bccomp($b, '0') <= 0) {
            throw new InvalidArgumentException('Делитель должен быть положительным.');
        }

        return bcdiv(bcadd($a, bcsub($b, '1')), $b, 0);
    }

    /** Перемножает два курса, сохраняя точность RATE_DECIMALS. */
    public static function multiply_rates(string $a, string $b): string
    {
        $product = bcmul(
            self::parse_decimal_to_units($a, self::RATE_DECIMALS),
            self::parse_decimal_to_units($b, self::RATE_DECIMALS)
        );

        $scale = bcpow('10', (string) self::RATE_DECIMALS);

        return self::format_units(bcdiv($product, $scale, 0), self::RATE_DECIMALS);
    }

    /**
     * Добавляет наценку продавца к сумме в тенге.
     *
     * Наценка применяется к сумме, а не к курсу: «беру процент сверху» —
     * однозначная формулировка, поправка к курсу читается двусмысленно.
     */
    public static function apply_markup(string $amount_kzt, float $percent): string
    {
        if (!is_finite($percent) || $percent < 0) {
            throw new InvalidArgumentException(
                sprintf('Наценка должна быть неотрицательным числом, получено %s.', $percent)
            );
        }

        if ($percent > 100) {
            throw new InvalidArgumentException(
                sprintf('Наценка не может превышать 100%%, получено %s%%.', $percent)
            );
        }

        $base = self::parse_decimal_to_units($amount_kzt, self::KZT_DECIMALS, false);

        // Процент переводим в сотые доли процента, чтобы принимать 0,5% и 2,5%.
        $permyriad = (string) (int) round($percent * 100);

        if ($percent > 0 && $permyriad === '0') {
            throw new InvalidArgumentException(sprintf(
                'Наценка %s%% меньше минимального шага 0,01 процентного пункта.',
                $percent
            ));
        }

        $with_markup = bcadd($base, self::ceil_div(bcmul($base, $permyriad), '10000'));

        return self::format_units($with_markup, self::KZT_DECIMALS);
    }

    /**
     * Сколько минимальных единиц токена соответствует сумме в тенге.
     *
     * Округление вверх: покупатель никогда не платит меньше запрошенного.
     */
    public static function convert_kzt_to_token_units(
        string $amount_kzt,
        string $rate,
        int $decimals
    ): string {
        $kzt_units  = self::parse_decimal_to_units($amount_kzt, self::KZT_DECIMALS, false);
        $rate_units = self::parse_decimal_to_units($rate, self::RATE_DECIMALS);

        if (bccomp($rate_units, '0') <= 0) {
            throw new RuntimeException('Курс должен быть положительным.');
        }

        $scale = bcpow('10', (string) ($decimals + self::RATE_DECIMALS - self::KZT_DECIMALS));

        return self::ceil_div(bcmul($kzt_units, $scale), $rate_units);
    }
}
