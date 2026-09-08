<?php
// demo-shop/plugin/tests/MoneyTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Money;

final class MoneyTest extends TestCase
{
    public function test_разбирает_десятичные_строки(): void
    {
        self::assertSame('45960000000', Money::parse_decimal_to_units('459.60', 8));
        self::assertSame('1000000', Money::parse_decimal_to_units('10000', 2));
    }

    public function test_обрезает_лишние_знаки_когда_разрешено(): void
    {
        self::assertSame('199', Money::parse_decimal_to_units('1.999', 2));
    }

    public function test_отвергает_избыточную_точность_когда_запрещено(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::parse_decimal_to_units('100.999', 2, false);
    }

    public function test_отвергает_мусор(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::parse_decimal_to_units('abc', 2);
    }

    public function test_форматирует_единицы(): void
    {
        self::assertSame('21.758051', Money::format_units('21758051', 6));
        self::assertSame('0.002176', Money::format_units('2176', 6));
        self::assertSame('1.000000', Money::format_units('1000000', 6));
    }

    public function test_отвергает_отрицательные_при_форматировании(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::format_units('-2176', 6);
    }

    public function test_делит_с_округлением_вверх(): void
    {
        self::assertSame('4', Money::ceil_div('10', '3'));
        self::assertSame('3', Money::ceil_div('9', '3'));
    }

    public function test_отвергает_неположительный_делитель(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::ceil_div('10', '0');
    }

    public function test_конвертирует_тенге_в_единицы_токена(): void
    {
        self::assertSame('1000000', Money::convert_kzt_to_token_units('459.60', '459.60', 6));
        self::assertSame('2000000', Money::convert_kzt_to_token_units('919.20', '459.60', 6));
        self::assertSame('21758051', Money::convert_kzt_to_token_units('10000', '459.60', 6));
        self::assertSame('2176', Money::convert_kzt_to_token_units('1', '459.60', 6));
        self::assertSame('209387074', Money::convert_kzt_to_token_units('10000', '47758.44', 9));
    }

    public function test_считает_точно_на_суммах_где_ломаются_обычные_целые(): void
    {
        // 92 233,72 ₸ — предел обычных целых PHP для этой формулы.
        self::assertSame('200683203', Money::convert_kzt_to_token_units('92234', '459.60', 6));
        self::assertSame('2175805048', Money::convert_kzt_to_token_units('1000000', '459.60', 6));
        self::assertSame('217580504787', Money::convert_kzt_to_token_units('100000000', '459.60', 6));
    }

    public function test_отвергает_неположительный_курс(): void
    {
        $this->expectException(RuntimeException::class);
        Money::convert_kzt_to_token_units('10000', '0', 6);
    }

    public function test_перемножает_курсы_без_потери_точности(): void
    {
        self::assertSame('459.63676800', Money::multiply_rates('459.60', '1.00008'));
    }

    public function test_применяет_наценку_к_сумме_в_тенге(): void
    {
        self::assertSame('10000.00', Money::apply_markup('10000', 0));
        self::assertSame('10100.00', Money::apply_markup('10000', 1));
        self::assertSame('1024.99', Money::apply_markup('999.99', 2.5));
    }

    public function test_наценка_с_конвертацией_даёт_тот_же_результат_что_sdk(): void
    {
        $charged = Money::apply_markup('10000', 1);
        $units = Money::convert_kzt_to_token_units($charged, '459.60000000', 6);
        self::assertSame('21.975631', Money::format_units($units, 6));
    }

    public function test_отвергает_наценку_меньше_минимального_шага(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::apply_markup('10000', 0.004);
    }

    public function test_отвергает_наценку_больше_ста_процентов(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::apply_markup('10000', 101);
    }
}
