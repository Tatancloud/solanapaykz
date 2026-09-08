<?php
// demo-shop/plugin/includes/RateSource.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/** Источник курса. Возвращает, сколько тенге стоит один токен. */
interface RateSource
{
    /** Короткое имя для записи в заказ — по нему разбирают спорные случаи. */
    public function get_name(): string;

    /** @return string Курс десятичной строкой. */
    public function get_kzt_per_token(string $token): string;
}
