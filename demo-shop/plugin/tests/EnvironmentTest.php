<?php
// demo-shop/plugin/tests/EnvironmentTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Environment;

final class EnvironmentTest extends TestCase
{
    public function test_на_пригодной_среде_возвращает_пустой_список(): void
    {
        $missing = Environment::check([
            'php' => '8.1',
            'extensions' => ['bcmath', 'curl', 'json'],
        ]);

        self::assertSame([], $missing);
    }

    public function test_называет_недостающее_расширение(): void
    {
        $missing = Environment::check([
            'php' => '8.1',
            'extensions' => ['bcmath', 'расширения-которого-нет'],
        ]);

        self::assertCount(1, $missing);
        self::assertStringContainsString('расширения-которого-нет', $missing[0]);
    }

    public function test_называет_недостаточную_версию_php(): void
    {
        $missing = Environment::check([
            'php' => '99.0',
            'extensions' => [],
        ]);

        self::assertCount(1, $missing);
        self::assertStringContainsString('99.0', $missing[0]);
    }
}
