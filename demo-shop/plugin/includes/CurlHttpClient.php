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
    private const USER_AGENT = 'SolanaPayKZ-WooCommerce/' . VERSION . ' (+https://github.com/Tatancloud/solanapaykz)';

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
            throw new RpcException(sprintf(
                '%s: не удалось закодировать параметры запроса (%s).',
                self::safe_host($url),
                $e->getMessage()
            ));
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
            throw new RpcException(sprintf('%s: запрос не удался (%s).', self::safe_host($url), $error));
        }

        if ($status < 200 || $status >= 300) {
            throw new RpcException(sprintf('%s: HTTP %d.', self::safe_host($url), $status));
        }

        $decoded = json_decode($body, true);

        if (!is_array($decoded)) {
            throw new RpcException(sprintf('%s: ответ не является объектом JSON.', self::safe_host($url)));
        }

        return $decoded;
    }

    /**
     * Схема и хост адреса узла, без пути, запроса и учётных данных.
     *
     * Продавцы вписывают в настройки платные RPC вида
     * `https://mainnet.helius-rpc.com/?api-key=...` — ключ провайдера лежит
     * прямо в строке адреса. Полный адрес в тексте исключения рано или
     * поздно оказывается в error_log или в журнале хостинга, который на
     * шаред-хостинге нередко отдаётся по HTTP кому угодно: чужой человек
     * получает платный ключ продавца.
     */
    private static function safe_host(string $url): string
    {
        $parts = parse_url($url);

        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return 'адрес узла';
        }

        return $parts['scheme'] . '://' . $parts['host'];
    }
}
