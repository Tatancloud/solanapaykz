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

    /**
     * Декодирование из base58 в байты.
     * Адрес Solana всегда декодируется ровно в 32 байта. Строки, которые
     * не попадают в это ограничение, — не адреса, даже если выглядят
     * правильно по алфавиту и длине.
     *
     * @return string|null Декодированные байты, или null если строка содержит
     *                     недопустимые символы либо декодируется не в 32 байта.
     */
    public static function decode(string $encoded): ?string
    {
        if ($encoded === '') {
            return null;
        }

        // Проверка, что все символы в алфавите.
        if (strspn($encoded, self::ALPHABET) !== strlen($encoded)) {
            return null;
        }

        $number = '0';

        for ($i = 0, $length = strlen($encoded); $i < $length; $i++) {
            $pos = strpos(self::ALPHABET, $encoded[$i]);
            $number = bcadd(bcmul($number, '58'), (string) $pos);
        }

        $decoded = '';

        while (bccomp($number, '0') > 0) {
            $decoded = chr((int) bcmod($number, '256')) . $decoded;
            $number = bcdiv($number, '256', 0);
        }

        // Ведущие единицы (которые кодировали нулевые байты) переводятся обратно.
        for ($i = 0, $length = strlen($encoded); $i < $length && $encoded[$i] === self::ALPHABET[0]; $i++) {
            $decoded = "\x00" . $decoded;
        }

        // Адрес должен декодироваться ровно в 32 байта.
        if (strlen($decoded) !== 32) {
            return null;
        }

        return $decoded;
    }
}
