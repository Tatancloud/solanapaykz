<?php
// demo-shop/plugin/includes/Rpc.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Минимальный клиент Solana JSON-RPC.
 *
 * Умеет ровно две операции чтения, нужные для проверки платежа. Сторонняя
 * библиотека здесь избыточна: она тянет криптографию, которой плагин по
 * требованию безопасности не должен касаться вовсе.
 */
final class Rpc implements SolanaChain
{
    private HttpClient $http;

    public function __construct(
        private string $url,
        private int $timeout_seconds = 10,
        ?HttpClient $http = null
    ) {
        $this->http = $http ?? new CurlHttpClient();
    }

    /**
     * Подписи транзакций, ссылающихся на адрес-метку.
     *
     * @return list<array<string, mixed>>
     */
    public function get_signatures_for_address(string $address, int $limit = 10): array
    {
        $response = $this->call('getSignaturesForAddress', [
            $address,
            ['commitment' => 'finalized', 'limit' => $limit],
        ]);

        return is_array($response) ? $response : [];
    }

    /**
     * Транзакция по подписи или null, если её нет.
     *
     * @return array<string, mixed>|null
     */
    public function get_transaction(string $signature): ?array
    {
        $response = $this->call('getTransaction', [
            $signature,
            [
                'commitment' => 'finalized',
                'encoding' => 'json',
                'maxSupportedTransactionVersion' => 0,
            ],
        ]);

        return is_array($response) ? $response : null;
    }

    /**
     * @param list<mixed> $params
     * @return mixed Содержимое поля result.
     */
    private function call(string $method, array $params): mixed
    {
        $decoded = $this->http->post_json($this->url, [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => $method,
            'params' => $params,
        ], $this->timeout_seconds);

        if (isset($decoded['error'])) {
            $message = is_array($decoded['error']) && isset($decoded['error']['message'])
                ? (string) $decoded['error']['message']
                : 'неизвестная ошибка';

            throw new RpcException(sprintf('Узел блокчейна вернул ошибку: %s.', $message));
        }

        if (!array_key_exists('result', $decoded)) {
            throw new RpcException('Ответ узла не содержит ни result, ни error.');
        }

        return $decoded['result'];
    }
}
