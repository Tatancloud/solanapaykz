<?php
// demo-shop/plugin/tests/Base58Test.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Base58;

final class Base58Test extends TestCase
{
    public function test_тридцать_два_нулевых_байта_дают_известный_адрес(): void
    {
        // Это System Program — адрес, который знает любой, кто работал с Solana.
        // Совпадение с ним подтверждает, что алгоритм реализован верно.
        self::assertSame(
            '11111111111111111111111111111111',
            Base58::encode(str_repeat("\x00", 32))
        );
    }

    public function test_короткие_последовательности(): void
    {
        self::assertSame('1', Base58::encode("\x00"));
        self::assertSame('2', Base58::encode("\x01"));
        self::assertSame('11', Base58::encode("\x00\x00"));
    }

    public function test_пустой_вход_даёт_пустую_строку(): void
    {
        self::assertSame('', Base58::encode(''));
    }

    public function test_ведущие_нули_сохраняются(): void
    {
        // Ведущие нулевые байты кодируются единицами и не должны теряться:
        // адрес с ними — другой адрес.
        self::assertSame('112', Base58::encode("\x00\x00\x01"));
    }

    public function test_алфавит_без_похожих_символов(): void
    {
        // В base58 нет нуля, заглавной O, заглавной I и строчной l —
        // чтобы адрес нельзя было перепутать при чтении глазами.
        for ($i = 0; $i < 50; $i++) {
            $encoded = Base58::encode(random_bytes(32));

            self::assertSame(
                strlen($encoded),
                strspn($encoded, '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'),
                'Встретился символ вне алфавита base58: ' . $encoded
            );
        }
    }

    public function test_длина_метки_из_тридцати_двух_байт(): void
    {
        for ($i = 0; $i < 50; $i++) {
            $length = strlen(Base58::encode(random_bytes(32)));

            self::assertGreaterThanOrEqual(32, $length);
            self::assertLessThanOrEqual(44, $length);
        }
    }

    public function test_декодирование_тридцати_двух_единиц_даёт_нулевые_байты(): void
    {
        // System Program декодируется в 32 нулевых байта.
        self::assertSame(
            str_repeat("\x00", 32),
            Base58::decode('11111111111111111111111111111111')
        );
    }

    public function test_взаимная_обратимость_кодирования_и_декодирования(): void
    {
        for ($i = 0; $i < 50; $i++) {
            $original = random_bytes(32);
            $encoded = Base58::encode($original);
            $decoded = Base58::decode($encoded);

            self::assertSame($original, $decoded);
        }
    }

    public function test_отклонение_неверных_адресов(): void
    {
        // 43 единицы и одна z — выглядит как адрес, но декодируется не в 32 байта
        $invalid1 = str_repeat('1', 43) . 'z';
        self::assertNull(Base58::decode($invalid1));

        // 44 буквы z — выглядит как адрес, но декодируется не в 32 байта
        $invalid2 = str_repeat('z', 44);
        self::assertNull(Base58::decode($invalid2));

        // Пустая строка — допустимо для кодирования, но не для адреса
        self::assertNull(Base58::decode(''));
    }
}
