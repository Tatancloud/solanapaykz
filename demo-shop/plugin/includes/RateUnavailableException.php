<?php
// demo-shop/plugin/includes/RateUnavailableException.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use RuntimeException;

/** Ни один источник курса не ответил. */
final class RateUnavailableException extends RuntimeException
{
}
