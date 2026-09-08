<?php
// demo-shop/plugin/includes/OrderMeta.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;
use WC_Order;

/**
 * Чтение и запись данных плагина в заказе.
 *
 * Своих таблиц в базе плагин не создаёт: всё живёт в метаданных заказа,
 * которые WooCommerce переносит вместе с ним при переезде магазина.
 */
final class OrderMeta
{
    public const QUOTE = '_solanapaykz_quote';
    public const REFERENCE = '_solanapaykz_reference';
    public const RECIPIENT = '_solanapaykz_recipient';
    public const SIGNATURE = '_solanapaykz_signature';
    public const LATE_PAYMENT = '_solanapaykz_late_payment';

    /**
     * Адрес получателя сохраняется вместе с котировкой и меткой платежа:
     * это то, что покупатель реально увидел в QR-коде. Продавец может
     * сменить кошелёк в настройках позже — платёж уже создан по старому
     * адресу, и показ страницы, и последующая проверка платежа должны
     * сверяться с ним, а не с текущими настройками.
     */
    public static function save_quote(WC_Order $order, Quote $quote, string $reference, string $recipient): void
    {
        $order->update_meta_data(self::QUOTE, wp_json_encode($quote->to_array()));
        $order->update_meta_data(self::REFERENCE, $reference);
        $order->update_meta_data(self::RECIPIENT, $recipient);
        $order->save();
    }

    /**
     * Возвращает котировку заказа или null, если её нет либо запись испорчена.
     *
     * Испорченная запись — это не «платежа нет», а сломанный заказ, поэтому
     * причина пишется в журнал: иначе продавец увидит вечное «ожидаем оплату»
     * без единого следа о том, что пошло не так.
     */
    public static function read_quote(WC_Order $order): ?Quote
    {
        $raw = $order->get_meta(self::QUOTE);

        if (!is_string($raw) || $raw === '') {
            return null;
        }

        $data = json_decode($raw, true);

        if (!is_array($data)) {
            error_log(sprintf('SolanaPay-KZ: заказ %d — котировка не разбирается как JSON.', $order->get_id()));

            return null;
        }

        try {
            return Quote::from_array($data);
        } catch (Throwable $error) {
            error_log(sprintf(
                'SolanaPay-KZ: заказ %d — котировка непригодна: %s',
                $order->get_id(),
                $error->getMessage()
            ));

            return null;
        }
    }

    public static function read_reference(WC_Order $order): ?string
    {
        $reference = $order->get_meta(self::REFERENCE);

        return is_string($reference) && $reference !== '' ? $reference : null;
    }

    public static function read_recipient(WC_Order $order): ?string
    {
        $recipient = $order->get_meta(self::RECIPIENT);

        return is_string($recipient) && $recipient !== '' ? $recipient : null;
    }

    public static function save_signature(WC_Order $order, string $signature): void
    {
        $order->update_meta_data(self::SIGNATURE, $signature);
        $order->save();
    }

    public static function mark_late_payment(WC_Order $order, string $signature): void
    {
        $order->update_meta_data(self::LATE_PAYMENT, $signature);
        $order->save();
    }
}
