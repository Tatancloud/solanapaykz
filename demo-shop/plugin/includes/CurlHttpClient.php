<?php
// demo-shop/plugin/includes/CurlHttpClient.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

final class CurlHttpClient implements HttpClient
{
    public function post_json(string $url, array $payload, int $timeout_seconds): array
    {
        $handle = curl_init($url);

        if ($handle === false) {
            throw new RpcException('Не удалось инициализировать curl.');
        }

        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($payload, JSON_THROW_ON_ERROR),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT        => $timeout_seconds,
            CURLOPT_CONNECTTIMEOUT => $timeout_seconds,
        ]);

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
