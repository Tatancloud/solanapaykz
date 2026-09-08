<?php
// demo-shop/plugin/tests/QuoteFormatVersionTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Cache;
use SolanaPayKZ\Quote;
use SolanaPayKZ\QuoteException;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;

/**
 * Отдельный файл, а не дополнение к QuoteTest.php: правка узкая (задача
 * B12, поле версии формата котировки), и Quote.php в остальном
 * принадлежит другому автору — так правки не пересекаются в одном файле.
 */
final class QuoteFormatVersionTest extends TestCase
{
    private function rates(): RateProvider
    {
        $source = new class implements RateSource {
            public function get_name(): string
            {
                return 'binance';
            }

            public function get_kzt_per_token(string $token): string
            {
                return '459.60000000';
            }
        };

        $cache = new class implements Cache {
            /** @var array<string, string> */
            private array $store = [];

            public function get(string $key): ?string
            {
                return $this->store[$key] ?? null;
            }

            public function set(string $key, string $value, int $ttl_seconds): void
            {
                $this->store[$key] = $value;
            }
        };

        return new RateProvider([$source], $cache, 60);
    }

    public function test_to_array_несёт_текущую_версию_формата(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertSame(Quote::FORMAT_VERSION, $quote->to_array()['format_version']);
    }

    public function test_запись_без_поля_версии_читается_как_версия_1(): void
    {
        $data = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();
        unset($data['format_version']);

        // Котировки, выпущенные до появления этого поля, не должны
        // обесцениться разом — отсутствие поля равнозначно версии 1.
        $restored = Quote::from_array($data);

        self::assertSame($data['quote_id'], $restored->quote_id);
    }

    public function test_версия_новее_понимаемой_помечена_отдельным_кодом_исключения(): void
    {
        $data = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();
        $data['format_version'] = Quote::FORMAT_VERSION + 1;

        try {
            Quote::from_array($data);
            self::fail('Запись с более новой версией формата должна быть отвергнута.');
        } catch (QuoteException $error) {
            // Код исключения — единственный способ отличить «формат
            // неизвестен» от порчи данных, раз QuoteException объявлен
            // final и подкласса завести нельзя.
            self::assertSame(Quote::ERROR_UNKNOWN_FORMAT_VERSION, $error->getCode());
        }
    }

    public function test_версия_меньше_единицы_это_обычная_порча_данных(): void
    {
        $data = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();
        $data['format_version'] = 0;

        try {
            Quote::from_array($data);
            self::fail('Запись с версией формата 0 должна быть отвергнута.');
        } catch (QuoteException $error) {
            self::assertNotSame(Quote::ERROR_UNKNOWN_FORMAT_VERSION, $error->getCode());
        }
    }

    public function test_нечисловая_версия_формата_это_порча_данных(): void
    {
        $data = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();
        $data['format_version'] = 'мусор';

        $this->expectException(QuoteException::class);
        Quote::from_array($data);
    }
}
