<?php
// demo-shop/plugin/tests/QuoteTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Cache;
use SolanaPayKZ\Quote;
use SolanaPayKZ\QuoteException;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;

final class QuoteTest extends TestCase
{
    private function rates(string $rate = '459.60000000', string $name = 'binance'): RateProvider
    {
        $source = new class($rate, $name) implements RateSource {
            public function __construct(private string $rate, private string $name) {}
            public function get_name(): string { return $this->name; }
            public function get_kzt_per_token(string $token): string { return $this->rate; }
        };

        $cache = new class implements Cache {
            public function get(string $key): ?string { return null; }
            public function set(string $key, string $value, int $ttl_seconds): void {}
        };

        return new RateProvider([$source], $cache, 0);
    }

    public function test_считает_сумму_к_оплате(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertSame('21.758051', $quote->amount_token);
        self::assertSame('10000', $quote->amount_kzt);
        self::assertSame('10000.00', $quote->amount_kzt_charged);
        self::assertSame('459.60000000', $quote->rate);
        self::assertSame('binance', $quote->rate_source);
    }

    public function test_срок_жизни_по_умолчанию_пятнадцать_минут(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertSame(900, $quote->expires_at - $quote->created_at);
    }

    public function test_применяет_наценку_к_сумме_в_тенге(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet', 1.0);

        self::assertSame('10100.00', $quote->amount_kzt_charged);
        self::assertSame('21.975631', $quote->amount_token);
    }

    public function test_считает_sol_с_девятью_знаками(): void
    {
        $quote = Quote::create($this->rates('47758.44000000'), '10000', 'SOL', 'mainnet');

        self::assertSame('0.209387074', $quote->amount_token);
    }

    public function test_идентификатор_уникален(): void
    {
        $first = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');
        $second = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertNotSame($first->quote_id, $second->quote_id);
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $first->quote_id);
    }

    public function test_просрочена_начиная_с_момента_истечения(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertFalse($quote->is_expired($quote->expires_at - 1));
        self::assertTrue($quote->is_expired($quote->expires_at));
        self::assertTrue($quote->is_expired($quote->expires_at + 1));
    }

    public function test_отвергает_нулевую_сумму(): void
    {
        $this->expectException(QuoteException::class);
        Quote::create($this->rates(), '0', 'USDC', 'mainnet');
    }

    public function test_отвергает_сумму_с_избыточной_точностью(): void
    {
        $this->expectException(QuoteException::class);
        Quote::create($this->rates(), '100.999', 'USDC', 'mainnet');
    }

    public function test_отвергает_неположительный_срок_жизни(): void
    {
        $this->expectException(QuoteException::class);
        Quote::create($this->rates(), '10000', 'USDC', 'mainnet', 0.0, 0);
    }

    public function test_не_обращается_к_курсу_при_неверном_вводе(): void
    {
        // Сетевой запрос ради заведомо неверной суммы — лишняя задержка
        // на кассе и лишний запрос к бирже.
        $counting = new class implements RateSource {
            public int $calls = 0;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->calls++;

                return '459.60000000';
            }
        };

        $cache = new class implements Cache {
            public function get(string $key): ?string { return null; }
            public function set(string $key, string $value, int $ttl_seconds): void {}
        };

        try {
            Quote::create(new RateProvider([$counting], $cache, 0), 'мусор', 'USDC', 'mainnet');
        } catch (QuoteException) {
            // ожидаемо
        }

        self::assertSame(0, $counting->calls);
    }

    public function test_путешествие_через_массив_сохраняет_котировку(): void
    {
        $original = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');
        $restored = Quote::from_array($original->to_array());

        self::assertEquals($original, $restored);
    }

    public function test_восстановление_отвергает_испорченную_запись(): void
    {
        $valid = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();

        $broken = [
            'без суммы токена'      => ['amount_token' => null],
            'сумма токена нулевая'  => ['amount_token' => '0.000000'],
            'сумма токена мусор'    => ['amount_token' => 'не-число'],
            'нет курса'             => ['rate' => null],
            'курс нулевой'          => ['rate' => '0'],
            'неизвестная монета'    => ['token' => 'BTC'],
            'неизвестная сеть'      => ['cluster' => 'testnet'],
            'срок раньше создания'  => ['expires_at' => $valid['created_at'] - 1],
            'идентификатор пустой'  => ['quote_id' => ''],
        ];

        foreach ($broken as $label => $override) {
            try {
                Quote::from_array(array_merge($valid, $override));
                self::fail("Испорченная запись «{$label}» должна быть отвергнута.");
            } catch (QuoteException) {
                self::assertTrue(true);
            }
        }
    }

    public function test_восстановление_отвергает_отсутствующее_поле(): void
    {
        $valid = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();
        unset($valid['rate_source']);

        $this->expectException(QuoteException::class);
        Quote::from_array($valid);
    }
}
