<?php
// demo-shop/plugin/includes/CustomerMessage.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Что показать покупателю по фактическому статусу заказа.
 *
 * Вынесено в отдельный класс без единого вызова WordPress по тем же
 * причинам, что и PaymentDecision: страница оплаты и опрос статуса должны
 * отличать «оплачено», «отменено» и «на проверке» друг от друга, а не
 * показывать одно и то же «ожидаем оплату» на любой стадии заказа.
 */
final class CustomerMessage
{
    /**
     * QR, сумму и таймер имеет смысл показывать только заказу, который
     * ещё ждёт оплаты. Хук woocommerce_thankyou_{method} вызывается на
     * любом статусе, кроме failed, поэтому без этой проверки уже
     * оплаченный или отменённый заказ показал бы тот же QR повторно —
     * заплатить второй раз или оплатить по QR отменённого заказа ничто
     * не мешало бы.
     */
    public static function should_show_qr(string $order_status): bool
    {
        return $order_status === 'pending';
    }

    /**
     * Текст и признак состояния для показа покупателю по фактическому
     * статусу заказа — а не по решению последней проверки платежа: заказ
     * мог смениться статус между двумя опросами (крон и вкладка браузера
     * работают параллельно), и ответ должен отражать то, что есть сейчас.
     *
     * @return array{status: string, message: string}
     */
    public static function for_order_status(string $order_status): array
    {
        switch ($order_status) {
            case 'pending':
                return ['status' => 'pending', 'message' => __('Awaiting payment.', 'solanapaykz')];

            case 'processing':
            case 'completed':
                return ['status' => 'paid', 'message' => __('Payment received. Thank you!', 'solanapaykz')];

            case 'refunded':
                return [
                    'status' => 'paid',
                    'message' => __(
                        'The order has been paid and refunded. If you still have questions, '
                        . 'please contact the store.',
                        'solanapaykz'
                    ),
                ];

            case 'cancelled':
                return [
                    'status' => 'expired',
                    'message' => __('The payment window has expired, the order has been cancelled.', 'solanapaykz'),
                ];

            case 'on-hold':
                return [
                    'status' => 'mismatch',
                    'message' => __('The payment is being verified manually. The seller will contact you.', 'solanapaykz'),
                ];

            default:
                // Неизвестный или редкий статус: кастомный статус другого
                // плагина, «failed», «checkout-draft». Нейтральное сообщение
                // без QR и без обещания дождаться оплаты — вместо того,
                // чтобы бесконечно повторять «ожидаем оплату» на заказе,
                // который плагин больше не тронет (см. PaymentDecision).
                return [
                    'status' => 'mismatch',
                    'message' => __(
                        'Cryptocurrency payment for this order is currently unavailable. '
                        . 'Please contact the store.',
                        'solanapaykz'
                    ),
                ];
        }
    }

    /**
     * Ответ AJAX-опроса по решению PaymentDecision.
     *
     * Действия complete/cancel/hold/late однозначны — их текст не зависит от
     * текущего статуса заказа. А «wait» смотрит на фактический статус
     * заказа, а не на сам факт «нового решения не было»: крон может
     * перевести заказ в processing, cancelled или on-hold, опередив опрос
     * вкладки покупателя — без этой сверки покупатель видел бы «ждём
     * оплату» на уже решённом заказе вплоть до следующей перезагрузки
     * страницы.
     *
     * @return array{status: string, message: string}
     */
    public static function for_decision(string $action, string $order_status): array
    {
        return match ($action) {
            'complete' => ['status' => 'paid', 'message' => __('Payment received. Thank you!', 'solanapaykz')],
            'cancel' => [
                'status' => 'expired',
                'message' => __('The payment window has expired. Please check out again.', 'solanapaykz'),
            ],
            'hold' => [
                'status' => 'mismatch',
                'message' => __(
                    'A payment was found, but it did not match the order amount. The store will contact you.',
                    'solanapaykz'
                ),
            ],
            'late' => [
                'status' => 'late',
                'message' => __(
                    'The payment was received after the order was cancelled. The store will contact you.',
                    'solanapaykz'
                ),
            ],
            default => self::for_order_status($order_status),
        };
    }
}
