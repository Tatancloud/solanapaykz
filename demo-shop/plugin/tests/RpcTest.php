<?php
// demo-shop/plugin/tests/RpcTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\HttpClient;
use SolanaPayKZ\Rpc;
use SolanaPayKZ\RpcException;

final class FakeHttpClient implements HttpClient
{
    /** @var list<array{url: string, payload: array}> */
    public array $calls = [];

    /** @param list<array|callable> $responses */
    public function __construct(private array $responses)
    {
    }

    public function post_json(string $url, array $payload, int $timeout_seconds): array
    {
        $this->calls[] = ['url' => $url, 'payload' => $payload];
        $next = array_shift($this->responses);

        if ($next === null) {
            throw new RuntimeException('Тест не задал ответ на этот запрос.');
        }

        if (is_callable($next)) {
            return $next();
        }

        return $next;
    }

    public function get_json(string $url, int $timeout_seconds): array
    {
        throw new RpcException('Клиент блокчейна ходит только методом POST.');
    }
}

final class RpcTest extends TestCase
{
    public function test_запрашивает_подписи_по_метке(): void
    {
        $http = new FakeHttpClient([
            ['result' => [['signature' => 'abc', 'err' => null]]],
        ]);

        $rpc = new Rpc('https://rpc.example', 10, $http);
        $signatures = $rpc->get_signatures_for_address('МеткаПлатежа');

        self::assertSame([['signature' => 'abc', 'err' => null]], $signatures);
        self::assertSame('getSignaturesForAddress', $http->calls[0]['payload']['method']);
        self::assertSame('МеткаПлатежа', $http->calls[0]['payload']['params'][0]);
    }

    public function test_запрашивает_подписи_с_уровнем_finalized(): void
    {
        $http = new FakeHttpClient([['result' => []]]);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address('Метка');

        self::assertSame('finalized', $http->calls[0]['payload']['params'][1]['commitment']);
    }

    public function test_запрашивает_транзакцию_с_уровнем_finalized(): void
    {
        $http = new FakeHttpClient([['result' => ['meta' => ['err' => null]]]]);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');

        $params = $http->calls[0]['payload']['params'][1];
        self::assertSame('finalized', $params['commitment']);
        self::assertSame(0, $params['maxSupportedTransactionVersion']);
    }

    public function test_отсутствующая_транзакция_даёт_null(): void
    {
        $http = new FakeHttpClient([['result' => null]]);
        $result = (new Rpc('https://rpc.example', 10, $http))->get_transaction('нет-такой');

        self::assertNull($result);
    }

    public function test_ошибка_rpc_превращается_в_исключение(): void
    {
        $http = new FakeHttpClient([
            ['error' => ['code' => -32602, 'message' => 'Invalid param']],
        ]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');
    }

    public function test_ответ_без_result_и_error_считается_ошибкой(): void
    {
        $http = new FakeHttpClient([['что-то' => 'непонятное']]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address('Метка');
    }

    public function test_невалидный_utf8_в_метке_даёт_rpc_exception(): void
    {
        $http = new FakeHttpClient([
            static function (): array {
                throw new \JsonException('Malformed UTF-8 characters');
            },
        ]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address("Некорректный\xFF UTF-8");
    }

    public function test_подписи_не_array_даёт_ошибку(): void
    {
        $http = new FakeHttpClient([['result' => false]]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address('Метка');
    }

    public function test_подписи_ноль_даёт_ошибку(): void
    {
        $http = new FakeHttpClient([['result' => 0]]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address('Метка');
    }

    public function test_подписи_строка_даёт_ошибку(): void
    {
        $http = new FakeHttpClient([['result' => 'unexpected string']]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address('Метка');
    }

    public function test_транзакция_false_даёт_ошибку(): void
    {
        $http = new FakeHttpClient([['result' => false]]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');
    }

    public function test_транзакция_ноль_даёт_ошибку(): void
    {
        $http = new FakeHttpClient([['result' => 0]]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');
    }

    public function test_транзакция_строка_даёт_ошибку(): void
    {
        $http = new FakeHttpClient([['result' => 'unexpected string']]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');
    }

    public function test_http_ошибка_даёт_rpc_exception(): void
    {
        $http = new FakeHttpClient([
            static function (): void {
                throw new RpcException('https://rpc.example: HTTP 500.');
            },
        ]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');
    }

    public function test_невалидный_json_даёт_rpc_exception(): void
    {
        $http = new FakeHttpClient([
            static function (): void {
                throw new RpcException('https://rpc.example: ответ не является объектом JSON.');
            },
        ]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');
    }
}
