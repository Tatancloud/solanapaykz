<?php
// demo-shop/plugin/tests/RatesTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\BinanceRateSource;
use SolanaPayKZ\Cache;
use SolanaPayKZ\HttpClient;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;
use SolanaPayKZ\RateUnavailableException;
use SolanaPayKZ\RpcException;
use SolanaPayKZ\SyntheticRateSource;

/** Отдаёт заранее заданные ответы вместо обращения к сети. */
final class StubHttpClient implements HttpClient
{
    /** @var list<string> */
    public array $urls = [];

    /** @param array<string, array> $routes Часть URL => ответ */
    public function __construct(private array $routes)
    {
    }

    public function post_json(string $url, array $payload, int $timeout_seconds): array
    {
        throw new RuntimeException('Курс запрашивается через get_json, не post_json.');
    }

    public function get_json(string $url, int $timeout_seconds): array
    {
        $this->urls[] = $url;

        foreach ($this->routes as $needle => $response) {
            if (str_contains($url, $needle)) {
                if ($response instanceof RpcException) {
                    throw $response;
                }

                return $response;
            }
        }

        throw new RpcException('Тест не задал ответ для ' . $url);
    }
}

final class ArrayCache implements Cache
{
    /** @var array<string, array{value: string, expires: int}> */
    private array $items = [];

    public int $now = 1000;

    public function get(string $key): ?string
    {
        $item = $this->items[$key] ?? null;

        return $item !== null && $item['expires'] > $this->now ? $item['value'] : null;
    }

    public function set(string $key, string $value, int $ttl_seconds): void
    {
        $this->items[$key] = ['value' => $value, 'expires' => $this->now + $ttl_seconds];
    }
}

final class RatesTest extends TestCase
{
    public function test_binance_считает_курс_usdc_из_двух_тикеров(): void
    {
        $http = new StubHttpClient([
            'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => '459.60000000'],
            'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '1.00008000'],
        ]);

        self::assertSame('459.63676800', (new BinanceRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_binance_считает_курс_sol(): void
    {
        $http = new StubHttpClient([
            'symbol=USDTKZT' => ['symbol' => 'USDTKZT', 'price' => '459.60000000'],
            'symbol=SOLUSDT' => ['symbol' => 'SOLUSDT', 'price' => '103.90000000'],
        ]);

        self::assertSame('47752.44000000', (new BinanceRateSource($http))->get_kzt_per_token('SOL'));
    }

    public function test_binance_отвергает_ответ_без_цены(): void
    {
        $http = new StubHttpClient(['symbol=USDTKZT' => ['symbol' => 'USDTKZT']]);

        $this->expectException(RpcException::class);
        (new BinanceRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_binance_отвергает_непригодную_цену(): void
    {
        foreach (['0', '-1', 'abc', '1e400', ' 1.5 '] as $price) {
            $http = new StubHttpClient([
                'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => $price],
                'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '1.00000000'],
            ]);

            try {
                (new BinanceRateSource($http))->get_kzt_per_token('USDC');
                self::fail("Цена «{$price}» должна быть отвергнута.");
            } catch (RpcException) {
                self::assertTrue(true);
            }
        }
    }

    public function test_binance_отвергает_курс_доллара_выше_полосы_правдоподобия(): void
    {
        // Источник сменил базовую пару или вернул цену другого инструмента —
        // например, 100000000 вместо 459.6. Без полосы заказ на 10 000 ₸
        // превратился бы в 0.0001 USDC.
        $http = new StubHttpClient([
            'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => '100000000.00000000'],
            'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '1.00000000'],
        ]);

        $this->expectException(RpcException::class);
        (new BinanceRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_binance_отвергает_курс_доллара_ниже_полосы_правдоподобия(): void
    {
        $http = new StubHttpClient([
            'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => '1.00000000'],
            'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '1.00000000'],
        ]);

        $this->expectException(RpcException::class);
        (new BinanceRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_binance_принимает_курс_доллара_на_границах_полосы(): void
    {
        foreach (['400.00000000', '600.00000000'] as $boundary) {
            $http = new StubHttpClient([
                'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => $boundary],
                'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '1.00000000'],
            ]);

            self::assertSame($boundary, (new BinanceRateSource($http))->get_kzt_per_token('USDC'));
        }
    }

    public function test_binance_принимает_цену_меньше_единицы(): void
    {
        // Цена USDC к доллару колеблется около единицы и регулярно бывает
        // меньше её. Сравнение без указания точности отвергло бы такую цену.
        $http = new StubHttpClient([
            'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => '459.60000000'],
            'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '0.99980800'],
        ]);

        self::assertSame('459.51175680', (new BinanceRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_синтетика_принимает_цену_меньше_единицы(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['KZT' => 455.296]],
            'coingecko'       => ['usd-coin' => ['usd' => 0.999808]],
        ]);

        self::assertSame('455.20858316', (new SyntheticRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_синтетика_собирает_курс_из_двух_источников(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['KZT' => 455.296]],
            'coingecko'       => ['usd-coin' => ['usd' => 1.0]],
        ]);

        self::assertSame('455.29600000', (new SyntheticRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_синтетика_считает_молчаливый_отказ_отказом(): void
    {
        // CoinGecko не знает тенге и на запрос цены в KZT отвечает HTTP 200
        // и пустым объектом. Принять это за ответ — значит выставить счёт на ноль.
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['KZT' => 455.296]],
            'coingecko'       => ['usd-coin' => []],
        ]);

        $this->expectException(RpcException::class);
        (new SyntheticRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_синтетика_отвергает_ответ_без_тенге(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['EUR' => 0.9]],
            'coingecko'       => ['usd-coin' => ['usd' => 1.0]],
        ]);

        $this->expectException(RpcException::class);
        (new SyntheticRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_синтетика_отвергает_тело_null(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => [],
            'coingecko'       => ['usd-coin' => ['usd' => 1.0]],
        ]);

        $this->expectException(RpcException::class);
        (new SyntheticRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_синтетика_отвергает_курс_доллара_вне_полосы_правдоподобия(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['KZT' => 100000000.0]],
            'coingecko'       => ['usd-coin' => ['usd' => 1.0]],
        ]);

        $this->expectException(RpcException::class);
        (new SyntheticRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_провайдер_берёт_курс_из_первого_источника(): void
    {
        $provider = new RateProvider([$this->source('binance', '459.60000000')], new ArrayCache(), 60);

        self::assertSame(
            ['rate' => '459.60000000', 'source' => 'binance'],
            $provider->get_kzt_per_token('USDC')
        );
    }

    public function test_провайдер_переключается_на_резервный(): void
    {
        $provider = new RateProvider([
            $this->failing_source('binance'),
            $this->source('synthetic', '455.29600000'),
        ], new ArrayCache(), 60);

        self::assertSame(
            ['rate' => '455.29600000', 'source' => 'synthetic'],
            $provider->get_kzt_per_token('USDC')
        );
    }

    public function test_провайдер_ловит_любую_ошибку_источника(): void
    {
        // Контракт источников держится на дисциплине, а не на типах: если
        // источник нарушит его, переключение всё равно должно сработать.
        $broken = new class implements RateSource {
            public function get_name(): string { return 'broken'; }
            public function get_kzt_per_token(string $token): string { throw new TypeError('что угодно'); }
        };

        $provider = new RateProvider([$broken, $this->source('synthetic', '455.00000000')], new ArrayCache(), 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_бросает_когда_упали_все(): void
    {
        $provider = new RateProvider([
            $this->failing_source('binance'),
            $this->failing_source('synthetic'),
        ], new ArrayCache(), 60);

        $this->expectException(RateUnavailableException::class);
        $provider->get_kzt_per_token('USDC');
    }

    public function test_провайдер_не_подставляет_устаревший_курс(): void
    {
        // Устаревший курс хуже явной ошибки: продавец получит деньги
        // неизвестно по какой цене и не узнает об этом.
        $cache = new ArrayCache();
        $flaky = new class implements RateSource {
            public bool $fail = false;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                if ($this->fail) { throw new RuntimeException('упал'); }

                return '459.60000000';
            }
        };

        $provider = new RateProvider([$flaky], $cache, 60);
        $provider->get_kzt_per_token('USDC');

        $flaky->fail = true;
        $cache->now += 120; // кеш истёк

        $this->expectException(RateUnavailableException::class);
        $provider->get_kzt_per_token('USDC');
    }

    public function test_провайдер_кеширует_успешный_ответ(): void
    {
        $counting = new class implements RateSource {
            public int $calls = 0;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->calls++;

                return '459.60000000';
            }
        };

        $provider = new RateProvider([$counting], new ArrayCache(), 60);
        $provider->get_kzt_per_token('USDC');
        $provider->get_kzt_per_token('USDC');

        self::assertSame(1, $counting->calls);
    }

    public function test_провайдер_не_кеширует_ошибку(): void
    {
        // Закешированная ошибка означала бы, что после единственного сбоя
        // биржи заказы падают до истечения срока, хотя биржа уже ожила.
        $cache = new ArrayCache();
        $flaky = new class implements RateSource {
            public int $calls = 0;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->calls++;
                if ($this->calls === 1) { throw new RuntimeException('первый раз упал'); }

                return '459.60000000';
            }
        };

        $provider = new RateProvider([$flaky], $cache, 60);

        try { $provider->get_kzt_per_token('USDC'); } catch (RateUnavailableException) { }

        self::assertSame('459.60000000', $provider->get_kzt_per_token('USDC')['rate']);
    }

    public function test_провайдер_кеширует_токены_раздельно(): void
    {
        $counting = new class implements RateSource {
            /** @var list<string> */
            public array $tokens = [];
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->tokens[] = $token;

                return $token === 'USDC' ? '459.60000000' : '47752.44000000';
            }
        };

        $provider = new RateProvider([$counting], new ArrayCache(), 60);
        $provider->get_kzt_per_token('USDC');
        $provider->get_kzt_per_token('SOL');
        $provider->get_kzt_per_token('USDC');

        self::assertSame(['USDC', 'SOL'], $counting->tokens);
    }

    private function source(string $name, string $rate): RateSource
    {
        return new class($name, $rate) implements RateSource {
            public function __construct(private string $name, private string $rate) {}
            public function get_name(): string { return $this->name; }
            public function get_kzt_per_token(string $token): string { return $this->rate; }
        };
    }

    private function failing_source(string $name): RateSource
    {
        return new class($name) implements RateSource {
            public function __construct(private string $name) {}
            public function get_name(): string { return $this->name; }
            public function get_kzt_per_token(string $token): string
            {
                throw new RpcException('источник недоступен');
            }
        };
    }

    public function test_провайдер_отвергает_пустую_строку_от_источника(): void
    {
        $broken = new class implements RateSource {
            public function get_name(): string { return 'broken'; }
            public function get_kzt_per_token(string $token): string { return ''; }
        };

        $provider = new RateProvider([$broken, $this->source('synthetic', '455.00000000')], new ArrayCache(), 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_отвергает_нулевой_курс_от_источника(): void
    {
        $broken = new class implements RateSource {
            public function get_name(): string { return 'broken'; }
            public function get_kzt_per_token(string $token): string { return '0'; }
        };

        $provider = new RateProvider([$broken, $this->source('synthetic', '455.00000000')], new ArrayCache(), 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_отвергает_отрицательный_курс_от_источника(): void
    {
        $broken = new class implements RateSource {
            public function get_name(): string { return 'broken'; }
            public function get_kzt_per_token(string $token): string { return '-5'; }
        };

        $provider = new RateProvider([$broken, $this->source('synthetic', '455.00000000')], new ArrayCache(), 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_отвергает_невалидный_формат_от_источника(): void
    {
        $broken = new class implements RateSource {
            public function get_name(): string { return 'broken'; }
            public function get_kzt_per_token(string $token): string { return 'не-число'; }
        };

        $provider = new RateProvider([$broken, $this->source('synthetic', '455.00000000')], new ArrayCache(), 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_отвергает_курс_с_пробелами_от_источника(): void
    {
        $broken = new class implements RateSource {
            public function get_name(): string { return 'broken'; }
            public function get_kzt_per_token(string $token): string { return ' 459.6 '; }
        };

        $provider = new RateProvider([$broken, $this->source('synthetic', '455.00000000')], new ArrayCache(), 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_отвергает_повреждённую_запись_кеша_без_источника(): void
    {
        $cache = new ArrayCache();
        $cache->set('rate_USDC', '459.6|', 60);

        $provider = new RateProvider([$this->source('synthetic', '455.00000000')], $cache, 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_отвергает_большое_отклонение_от_предыдущего_курса(): void
    {
        $cache = new ArrayCache();
        $provider = new RateProvider([$this->source('binance', '459.60000000')], $cache, 60);
        $provider->get_kzt_per_token('USDC');

        $cache->now += 120; // истёк только кеш свежести (60с) — память о курсе (сутки) ещё жива

        // Рост более чем на 20% за один опрос — полоса 400–600 такое пропустит
        // (1000 не выходит из диапазона), но резкая смена уже не рыночное
        // движение, а признак того, что источник подменил инструмент.
        $spiked = $this->source('binance', '552.00000000'); // +20.1% от 459.6
        $fallback = $this->source('synthetic', '460.00000000');
        $provider = new RateProvider([$spiked, $fallback], $cache, 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_отвергает_большое_падение_курса(): void
    {
        // Отклонение считается по модулю: падение больше чем на 20% так же
        // подозрительно, как и рост — сверка не должна замечать только рост.
        $cache = new ArrayCache();
        $provider = new RateProvider([$this->source('binance', '459.60000000')], $cache, 60);
        $provider->get_kzt_per_token('USDC');

        $cache->now += 120;

        $dropped = $this->source('binance', '367.00000000'); // -20.1% от 459.6
        $fallback = $this->source('synthetic', '460.00000000');
        $provider = new RateProvider([$dropped, $fallback], $cache, 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_принимает_рост_курса_в_пределах_допустимого(): void
    {
        $cache = new ArrayCache();
        $provider = new RateProvider([$this->source('binance', '459.60000000')], $cache, 60);
        $provider->get_kzt_per_token('USDC');

        $cache->now += 120;

        $provider = new RateProvider([$this->source('binance', '551.00000000')], $cache, 60); // +19.9%

        self::assertSame('551.00000000', $provider->get_kzt_per_token('USDC')['rate']);
    }

    public function test_провайдер_не_отвергает_обычное_расхождение_резервного_источника(): void
    {
        // Резервный источник обновляется раз в сутки и обычно даёт значение
        // примерно на процент ниже биржевого — это не подозрительное
        // отклонение, полоса в 20% должна пережить его с большим запасом.
        $cache = new ArrayCache();
        $provider = new RateProvider([$this->source('binance', '459.60000000')], $cache, 60);
        $provider->get_kzt_per_token('USDC');

        $cache->now += 120;

        $provider = new RateProvider([
            $this->failing_source('binance'),
            $this->source('synthetic', '455.20858316'), // ~1% ниже
        ], $cache, 60);

        self::assertSame('455.20858316', $provider->get_kzt_per_token('USDC')['rate']);
    }

    public function test_провайдер_не_сверяет_курс_без_прежнего_принятого_значения(): void
    {
        // Первый запуск (или память ещё не наполнилась) — сравнивать не с
        // чем, поэтому любой валидный курс проходит без сверки.
        $provider = new RateProvider([$this->source('binance', '459.60000000')], new ArrayCache(), 60);

        self::assertSame('459.60000000', $provider->get_kzt_per_token('USDC')['rate']);
    }

    public function test_провайдер_забывает_память_о_курсе_по_истечении_срока(): void
    {
        // Спустя сутки без запросов старое значение больше не используется
        // как ориентир: долгий перерыв в трафике не должен намертво
        // блокировать магазин, если курс за это время закономерно уехал.
        $cache = new ArrayCache();
        $provider = new RateProvider([$this->source('binance', '459.60000000')], $cache, 60);
        $provider->get_kzt_per_token('USDC');

        $cache->now += RateProvider::LAST_KNOWN_TTL_SECONDS + 60;

        $provider = new RateProvider([$this->source('binance', '900.00000000')], $cache, 60);

        self::assertSame('900.00000000', $provider->get_kzt_per_token('USDC')['rate']);
    }

    public function test_провайдер_игнорирует_повреждённую_память_о_курсе(): void
    {
        $cache = new ArrayCache();
        $cache->set('rate_last_known_USDC', 'не-число', RateProvider::LAST_KNOWN_TTL_SECONDS);

        $provider = new RateProvider([$this->source('binance', '900.00000000')], $cache, 60);

        self::assertSame('900.00000000', $provider->get_kzt_per_token('USDC')['rate']);
    }
}
