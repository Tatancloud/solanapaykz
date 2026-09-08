<?php
// demo-shop/plugin/includes/CurlHttpClient.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use JsonException;

final class CurlHttpClient implements HttpClient
{
    /** Представляемся: сервер вправе знать, кто к нему обращается. */
    private const USER_AGENT = 'SolanaPayKZ-WooCommerce/0.1 (+https://github.com/Tatancloud/solanapaykz)';

    public function post_json(string $url, array $payload, int $timeout_seconds): array
    {
        return $this->request($url, $payload, $timeout_seconds);
    }

    public function get_json(string $url, int $timeout_seconds): array
    {
        return $this->request($url, null, $timeout_seconds);
    }

    private function request(string $url, ?array $payload, int $timeout_seconds): array
    {
        $handle = curl_init($url);

        if ($handle === false) {
            throw new RpcException('Не удалось инициализировать curl.');
        }

        try {
            $json_payload = $payload !== null ? json_encode($payload, JSON_THROW_ON_ERROR) : null;
        } catch (JsonException $e) {
            throw new RpcException(sprintf('%s: не удалось закодировать параметры запроса (%s).', $url, $e->getMessage()));
        }

        $options = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $timeout_seconds,
            CURLOPT_CONNECTTIMEOUT => $timeout_seconds,
            CURLOPT_USERAGENT      => self::USER_AGENT,
        ];

        if ($payload !== null) {
            $options[CURLOPT_POST]       = true;
            $options[CURLOPT_POSTFIELDS] = $json_payload;
            $options[CURLOPT_HTTPHEADER] = ['Content-Type: application/json'];
        }

        curl_setopt_array($handle, $options);

        $body   = curl_exec($handle);
        $errno  = curl_errno($handle);
        $error  = curl_error($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if ($errno !== 0 || !is_string($body)) {
            throw new RpcException(sprintf('%s: запрос не удался (%s).', $url, $error));
        }

        if ($status < 200 || $status >= 300) {
            throw new RpcException(sprintf('%s: HTTP %d.', $url, $status));
        }

        $decoded = json_decode($body, true);

        if (!is_array($decoded)) {
            throw new RpcException(sprintf('%s: ответ не является объектом JSON.', $url));
        }

        return $decoded;
    }
}
