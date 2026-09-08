<?php
// demo-shop/plugin/includes/OrderChecker.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;
use WC_Order;

/**
 * Проверяет платёж по заказу и применяет решение.
 *
 * Тонкая обвязка: вся логика решения — в PaymentDecision, вся проверка
 * блокчейна — в Verify. Здесь только связывание с заказом WooCommerce.
 */
final class OrderChecker
{
    /**
     * @return array{status: string, message: string} Для показа покупателю.
     */
    public function check(WC_Order $order, array $settings): array
    {
        $quote = OrderMeta::read_quote($order);
        $reference = OrderMeta::read_reference($order);
        $recipient = OrderMeta::read_recipient($order);

        if ($quote === null || $reference === null || $recipient === null) {
            return ['status' => 'error', 'message' => 'Данные оплаты не найдены.'];
        }

        try {
            $verify = new Verify(new Rpc((string) $settings['rpc_url']));
            $result = $verify->check(
                $reference,
                $recipient,
                (string) (Tokens::resolve($quote->cluster, $quote->token)['mint'] ?? ''),
                Money::parse_decimal_to_units(
                    $quote->amount_token,
                    Tokens::resolve($quote->cluster, $quote->token)['decimals']
                )
            );
        } catch (Throwable $error) {
            // Сбой связи с узлом — не ответ о платеже. Заказ не трогаем,
            // покупателю говорим, что проверка временно недоступна.
            error_log('SolanaPay-KZ: ' . $error->getMessage());

            return ['status' => 'unknown', 'message' => 'Не удалось проверить оплату. Пробуем ещё раз.'];
        }

        $decision = PaymentDecision::decide(
            $result,
            $quote,
            $order->get_status(),
            (int) $settings['late_window'],
            time()
        );

        return $this->apply($order, $decision, $result);
    }

    /**
     * @param array{action: string, note: string} $decision
     * @return array{status: string, message: string}
     */
    private function apply(WC_Order $order, array $decision, array $result): array
    {
        $signature = (string) ($result['signature'] ?? '');

        switch ($decision['action']) {
            case 'complete':
                OrderMeta::save_signature($order, $signature);
                $order->payment_complete($signature);
                $order->add_order_note($decision['note']);

                return ['status' => 'paid', 'message' => 'Оплата получена. Спасибо!'];

            case 'cancel':
                $order->update_status('cancelled', $decision['note']);

                return ['status' => 'expired', 'message' => 'Срок оплаты истёк. Оформите заказ заново.'];

            case 'hold':
                OrderMeta::save_signature($order, $signature);
                $order->update_status('on-hold', $decision['note']);

                return [
                    'status' => 'mismatch',
                    'message' => 'Платёж найден, но не сошёлся с суммой заказа. Магазин свяжется с вами.',
                ];

            case 'late':
                OrderMeta::mark_late_payment($order, $signature);
                $order->update_status('on-hold', $decision['note']);

                return [
                    'status' => 'late',
                    'message' => 'Платёж получен после отмены заказа. Магазин свяжется с вами.',
                ];

            default:
                return ['status' => 'pending', 'message' => 'Ожидаем оплату.'];
        }
    }
}
