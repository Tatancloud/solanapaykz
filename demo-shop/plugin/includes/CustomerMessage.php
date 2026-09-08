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
                return ['status' => 'pending', 'message' => 'Ожидаем оплату.'];

            case 'processing':
            case 'completed':
                return ['status' => 'paid', 'message' => 'Оплата получена. Спасибо!'];

            case 'refunded':
                return [
                    'status' => 'paid',
                    'message' => 'Заказ оплачен и возвращён. Если у вас остались вопросы, напишите в магазин.',
                ];

            case 'cancelled':
                return ['status' => 'expired', 'message' => 'Срок оплаты истёк, заказ отменён.'];

            case 'on-hold':
                return [
                    'status' => 'mismatch',
                    'message' => 'Платёж проверяется вручную. Продавец свяжется с вами.',
                ];

            default:
                // Неизвестный или редкий статус: кастомный статус другого
                // плагина, «failed», «checkout-draft». Нейтральное сообщение
                // без QR и без обещания дождаться оплаты — вместо того,
                // чтобы бесконечно повторять «ожидаем оплату» на заказе,
                // который плагин больше не тронет (см. PaymentDecision).
                return [
                    'status' => 'mismatch',
                    'message' => 'Оплата криптовалютой для этого заказа сейчас недоступна. Свяжитесь с магазином.',
                ];
        }
    }
}
