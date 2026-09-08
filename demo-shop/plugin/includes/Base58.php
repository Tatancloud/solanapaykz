<?php
// demo-shop/plugin/includes/Base58.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Кодирование в base58 — том виде, в котором Solana записывает адреса.
 *
 * Встроенного кодировщика в PHP нет, расширения gmp на типичном хостинге
 * тоже может не быть, поэтому считаем на bcmath. Алфавит без нуля,
 * заглавной O, заглавной I и строчной l: адрес не должен читаться
 * двусмысленно.
 */
final class Base58
{
    private const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    public static function encode(string $bytes): string
    {
        if ($bytes === '') {
            return '';
        }

        $number = '0';

        for ($i = 0, $length = strlen($bytes); $i < $length; $i++) {
            $number = bcadd(bcmul($number, '256'), (string) ord($bytes[$i]));
        }

        $encoded = '';

        while (bccomp($number, '0') > 0) {
            $encoded = self::ALPHABET[(int) bcmod($number, '58')] . $encoded;
            $number = bcdiv($number, '58', 0);
        }

        // Ведущие нулевые байты кодируются единицами: без этого адрес,
        // начинающийся с нулей, превратился бы в другой адрес.
        for ($i = 0, $length = strlen($bytes); $i < $length && $bytes[$i] === "\x00"; $i++) {
            $encoded = self::ALPHABET[0] . $encoded;
        }

        return $encoded;
    }
}
