<?php
// demo-shop/plugin/includes/SolanaChain.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Две операции чтения из блокчейна, нужные для проверки платежа.
 *
 * Вынесено в интерфейс, чтобы проверка платежа не зависела от способа
 * обращения к узлу и тестировалась без сети.
 */
interface SolanaChain
{
    /** @return list<array<string, mixed>> */
    public function get_signatures_for_address(string $address, int $limit = 10): array;

    /** @return array<string, mixed>|null */
    public function get_transaction(string $signature): ?array;
}
