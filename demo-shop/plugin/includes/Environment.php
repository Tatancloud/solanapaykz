<?php
declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Проверяет, пригодна ли среда для работы плагина.
 *
 * Без bcmath расчёт суммы к оплате молча теряет точность на заказах
 * дороже 92 233,72 ₸ — предел целых чисел PHP. Поэтому плагин лучше
 * не включить вовсе, чем обсчитать продавца на крупной покупке.
 */
final class Environment
{
    /**
     * @param array{php: string, extensions: list<string>} $requirements
     * @return list<string> Человекочитаемые описания недостающего.
     */
    public static function check(array $requirements): array
    {
        $missing = [];

        if (version_compare(PHP_VERSION, $requirements['php'], '<')) {
            $missing[] = sprintf(
                'Требуется PHP %s или новее, установлен %s.',
                $requirements['php'],
                PHP_VERSION
            );
        }

        foreach ($requirements['extensions'] as $extension) {
            if (!extension_loaded($extension)) {
                $missing[] = sprintf('Не установлено расширение PHP «%s».', $extension);
            }
        }

        return $missing;
    }
}
