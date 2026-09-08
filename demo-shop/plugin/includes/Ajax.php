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

    /**
     * Заказы в терминальном статусе (уже оплачен, отменён дольше окна
     * поздних платежей и т. п.) отдают один и тот же ответ на любое число
     * запросов подряд — RPC-узел за это время ничего не подтвердит и не
     * опровергнет заново. Несколько секунд кеша убирают повторный поход в
     * платный узел на каждый запрос без изменения поведения для покупателя:
     * опрос из браузера всё равно раз в 5 секунд.
     */
    private const POLL_CACHE_TTL_SECONDS = 3;

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

        // Ссылка на страницу «спасибо» содержит ключ заказа прямо в адресе
        // и легко попадает не только к покупателю (пересылка, скриншот).
        // За пределами pending/cancelled решение всегда 'wait' независимо
        // от ответа блокчейна (см. PaymentDecision — там же и настоящая
        // причина: только эти два статуса вообще меняют заказ) — значит,
        // поход в платный RPC-узел продавца тут ничего не решает и его
        // можно не делать. Без этой проверки цикл параллельных запросов на
        // уже оплаченный заказ жёг бы чужую квоту без остановки, пока не
        // закроется вкладка.
        $order_status = $order->get_status();

        if (!in_array($order_status, ['pending', 'cancelled'], true)) {
            wp_send_json_success(CustomerMessage::for_order_status($order_status));
        }

        $cache = new TransientCache();
        $cache_key = 'poll_' . $order->get_id();
        $cached = $cache->get($cache_key);

        if ($cached !== null) {
            $decoded = json_decode($cached, true);

            if (is_array($decoded)) {
                wp_send_json_success($decoded);
            }
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

        // 'mutated' — служебный признак для Scheduler (см. там же), а не
        // для браузера: наружу нужны только status и message. Безвредно
        // оставлять как есть, но незачем и передавать лишнее наружу.
        unset($result['mutated']);

        $cache->set($cache_key, (string) wp_json_encode($result), self::POLL_CACHE_TTL_SECONDS);

        wp_send_json_success($result);
    }
}
