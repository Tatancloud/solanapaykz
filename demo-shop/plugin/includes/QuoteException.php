<?php
// demo-shop/plugin/includes/QuoteException.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use RuntimeException;

/** Котировка непригодна: неверные данные на входе или испорченная запись заказа. */
final class QuoteException extends RuntimeException
{
}
