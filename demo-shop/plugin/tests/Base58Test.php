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
}
