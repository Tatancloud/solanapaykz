<?php
// demo-shop/plugin/includes/RpcException.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use RuntimeException;

/** Ошибка обращения к узлу блокчейна: сеть, таймаут или ответ с error. */
final class RpcException extends RuntimeException
{
}
