<?php
// demo-shop/plugin/includes/Ajax.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use WC_Order;

/** Опрос состояния оплаты со страницы «Спасибо за заказ». */
final class Ajax
{
    public const ACTION = 'solanapaykz_check';

    public static function register(): void
    {
        add_action('wp_ajax_' . self::ACTION, [self::class, 'handle']);
        add_action('wp_ajax_nopriv_' . self::ACTION, [self::class, 'handle']);
    }

    public static function handle(): void
    {
        $order_id = isset($_GET['order_id']) ? absint($_GET['order_id']) : 0;
        $key = isset($_GET['key']) ? sanitize_text_field(wp_unslash($_GET['key'])) : '';

        $order = $order_id > 0 ? wc_get_order($order_id) : null;

        // Ключ заказа знает только тот, кому WooCommerce его выдал. Без
        // этой проверки любой смог бы перебирать номера заказов и узнавать
        // их состояние. Сравнение — константного времени: это единственный
        // гейт доступа к эндпоинту, а обычный !== может выдать через тайминг
        // ответа, сколько первых символов ключа угаданы верно.
        if (!$order instanceof WC_Order || !hash_equals($order->get_order_key(), $key)) {
            wp_send_json_error(['message' => 'Заказ не найден.'], 404);
        }

        if ($order->get_payment_method() !== 'solanapaykz') {
            wp_send_json_error(['message' => 'Заказ оплачивается другим способом.'], 400);
        }

        $gateways = WC()->payment_gateways()->payment_gateways();
        $gateway = $gateways['solanapaykz'] ?? null;

        if ($gateway === null) {
            wp_send_json_error(['message' => 'Способ оплаты недоступен.'], 503);
        }

        $result = (new OrderChecker())->check($order, [
            'rpc_url' => $gateway->get_option('rpc_url', ''),
            'late_window' => $gateway->get_option('late_window', '86400'),
            'cluster' => $gateway->get_option('cluster', 'devnet'),
        ]);

        wp_send_json_success($result);
    }
}
