<?php
// demo-shop/plugin/includes/Rpc.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use JsonException;

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

        if (!is_array($response)) {
            throw new RpcException(sprintf(
                'Узел блокчейна вернул неожиданный формат ответа (ожидается массив): %s.',
                gettype($response)
            ));
        }

        return $response;
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

        if ($response === null) {
            return null;
        }

        if (!is_array($response)) {
            throw new RpcException(sprintf(
                'Узел блокчейна вернул неожиданный формат ответа (ожидается массив или null): %s.',
                gettype($response)
            ));
        }

        return $response;
    }

    /**
     * @param list<mixed> $params
     * @return mixed Содержимое поля result.
     */
    private function call(string $method, array $params): mixed
    {
        try {
            $decoded = $this->http->post_json($this->url, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => $method,
                'params' => $params,
            ], $this->timeout_seconds);
        } catch (JsonException $e) {
            throw new RpcException(sprintf('%s: не удалось закодировать параметры запроса (%s).', $this->url, $e->getMessage()));
        }

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
