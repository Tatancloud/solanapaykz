<?php
// demo-shop/plugin/includes/Cache.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Хранилище с ограниченным сроком жизни.
 *
 * Вынесено в интерфейс, потому что транзиенты WordPress недоступны в тестах,
 * а набор обязан работать без поднятия WordPress.
 */
interface Cache
{
    public function get(string $key): ?string;

    public function set(string $key, string $value, int $ttl_seconds): void;
}
