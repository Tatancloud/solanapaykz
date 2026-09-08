<?php
// demo-shop/plugin/includes/HttpClient.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/** Отделяет сеть от логики, чтобы тесты работали без интернета. */
interface HttpClient
{
    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed> Разобранный JSON-ответ.
     */
    public function post_json(string $url, array $payload, int $timeout_seconds): array;
}
