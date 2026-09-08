<?php
// demo-shop/plugin/includes/PaymentDecision.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Что делать с заказом по результату проверки платежа.
 *
 * Вынесено в отдельный класс без единого вызова WordPress: здесь легко
 * ошибиться сразу в нескольких случаях, а проверить их поведением в живом
 * магазине почти невозможно — пришлось бы подгадывать сроки и состояния.
 */
final class PaymentDecision
{
    /**
     * @param array{status: string, signature?: ?string, reason?: ?string, received_units?: ?string} $result
     * @return array{action: string, note: string}
     */
    public static function decide(
        array $result,
        Quote $quote,
        string $order_status,
        int $late_window_seconds,
        int $now
    ): array {
        $status = $result['status'] ?? '';
        $signature = (string) ($result['signature'] ?? '');

        // Список разрешённых статусов, а не запрещённых: платёж может
        // всерьёз изменить только заказ, ожидающий оплаты, и недавно
        // отменённый (окно поздних платежей). Раньше здесь был список
        // «не трогать» (processing/completed/refunded/failed/on-hold) —
        // любой не предусмотренный статус (кастомный статус другого
        // плагина, новый статус самого WooCommerce, «checkout-draft»)
        // проваливался в общую логику и мог быть отменён по таймауту или
        // завершён повторно. Список «действовать только на» безопасен по
        // умолчанию: неизвестный статус всегда получает «wait».
        if ($order_status === 'cancelled') {
            if ($status === 'confirmed') {
                return self::late_payment($quote, $signature, $late_window_seconds, $now);
            }

            return self::wait();
        }

        if ($order_status !== 'pending') {
            return self::wait();
        }

        if ($status === 'confirmed') {
            return [
                'action' => 'complete',
                'note' => sprintf(
                    'Платёж получен. Транзакция: %s. Сумма: %s %s.',
                    $signature,
                    $quote->amount_token,
                    $quote->token
                ),
            ];
        }

        if ($status === 'mismatch') {
            // Не отменяем и не подтверждаем: транзакция есть, но не сходится.
            // Такое разбирают руками, глядя на саму транзакцию.
            return [
                'action' => 'hold',
                'note' => sprintf(
                    'Найдена транзакция %s, но она не прошла проверку: %s '
                    . 'Проверьте её вручную, прежде чем отгружать заказ.',
                    $signature,
                    (string) ($result['reason'] ?? 'причина не указана.')
                ),
            ];
        }

        if ($status === 'pending' && $quote->is_expired($now)) {
            return [
                'action' => 'cancel',
                'note' => sprintf(
                    'Срок оплаты истёк: цена была зафиксирована до %s.',
                    gmdate('d.m.Y H:i', $quote->expires_at) . ' UTC'
                ),
            ];
        }

        return self::wait();
    }

    /**
     * Платёж пришёл на отменённый заказ.
     *
     * Отмена заказа не отменяет QR-код: покупатель мог отсканировать его
     * раньше и заплатить позже. Транзакцию не вернуть, поэтому продавцу
     * нужно сказать — решение принимает он.
     *
     * @return array{action: string, note: string}
     */
    private static function late_payment(Quote $quote, string $signature, int $window, int $now): array
    {
        if ($window <= 0 || $now > $quote->created_at + $window) {
            return self::wait();
        }

        return [
            'action' => 'late',
            'note' => sprintf(
                'Внимание: на отменённый заказ пришёл платёж. Транзакция: %s. Сумма: %s %s. '
                . 'Решите, восстановить заказ или вернуть деньги покупателю.',
                $signature,
                $quote->amount_token,
                $quote->token
            ),
        ];
    }

    /** @return array{action: string, note: string} */
    private static function wait(): array
    {
        return ['action' => 'wait', 'note' => ''];
    }

    /**
     * Действие, которое реально меняет заказ — в отличие от «wait».
     *
     * Единственный источник истины для «проход что-то изменил»: текст для
     * покупателя (см. CustomerMessage) — это отдельный вопрос и выводить
     * одно из другого нельзя. Например, «wait» на уже отменённом заказе
     * показывает покупателю тот же текст, что и решение 'cancel' (оба —
     * «истёк срок»), хотя в базе в первом случае ничего не поменялось.
     */
    public static function is_mutating(string $action): bool
    {
        return $action !== 'wait';
    }
}
