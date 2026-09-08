<?php
// demo-shop/plugin/includes/TransientCache.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/** Кеш поверх транзиентов WordPress. */
final class TransientCache implements Cache
{
    private const PREFIX = 'solanapaykz_';

    public function get(string $key): ?string
    {
        $value = get_transient(self::PREFIX . $key);

        return is_string($value) ? $value : null;
    }

    public function set(string $key, string $value, int $ttl_seconds): void
    {
        set_transient(self::PREFIX . $key, $value, $ttl_seconds);
    }
}
