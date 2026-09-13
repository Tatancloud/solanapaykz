<?php
/**
 * Bootstrap для PHPUnit тестов.
 *
 * Загружает composer autoloader и определяет ABSPATH фиктивным значением.
 * Тесты не поднимают WordPress, но файлы плагина обязаны иметь защиту от
 * прямого обращения (if (!defined('ABSPATH')) { exit; }), поэтому ABSPATH
 * должен быть определён перед загрузкой любого файла плагина.
 */

define('ABSPATH', true);

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Часть классов (CustomerMessage, PaymentDecision, GatewaySettings, Verify,
 * OrderChecker) намеренно не зовёт WordPress вовсе — это и позволяет
 * тестировать их без поднятия WordPress (см. комментарии в этих файлах). Но
 * после перевода строк их текст обёрнут в __()/esc_html__() — эти функции
 * реального WordPress здесь никто не поднимает, поэтому определяем
 * заглушки: они ничего не переводят и не экранируют, просто возвращают
 * строку как есть. В настоящем WordPress эти функции уже есть, и заглушки
 * там не используются вовсе (function_exists ниже).
 */
if (!function_exists('__')) {
    function __(string $text, string $domain = 'default'): string
    {
        return $text;
    }
}

if (!function_exists('_x')) {
    function _x(string $text, string $context, string $domain = 'default'): string
    {
        return $text;
    }
}

if (!function_exists('esc_html__')) {
    function esc_html__(string $text, string $domain = 'default'): string
    {
        return $text;
    }
}

if (!function_exists('esc_attr__')) {
    function esc_attr__(string $text, string $domain = 'default'): string
    {
        return $text;
    }
}
