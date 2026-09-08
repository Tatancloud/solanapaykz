<?php
// demo-shop/plugin/includes/PaymentDecision.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;

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
        // отменённый (окно поздних платежей). Любой другой статус —
        // кастомный статус стороннего плагина, новый статус самого
        // WooCommerce, «checkout-draft» — безопасно получает «wait» по
        // умолчанию, а не проваливается в общую логику отмены по таймауту
        // или повторного завершения.
        if ($order_status === 'cancelled') {
            if ($status === 'confirmed') {
                return self::late_payment($quote, $result, $late_window_seconds, $now);
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
                    'Платёж получен. Транзакция: %s. Ожидалось: %s %s. Получено: %s %s.',
                    $signature,
                    $quote->amount_token,
                    $quote->token,
                    self::received_amount($quote, $result),
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

        // signature непустая на статусе pending означает «подпись уже видна
        // в истории, тела транзакции ещё нет» (см. Verify::check) — это не
        // повод отменять заказ: платёж может обнаружиться на следующем
        // опросе. Отменяем только настоящее отсутствие подписей.
        if ($status === 'pending' && $signature === '' && $quote->is_expired($now)) {
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
     * @param array{status: string, signature?: ?string, reason?: ?string, received_units?: ?string} $result
     * @return array{action: string, note: string}
     */
    private static function late_payment(Quote $quote, array $result, int $window, int $now): array
    {
        if ($window <= 0 || $now > $quote->created_at + $window) {
            return self::wait();
        }

        return [
            'action' => 'late',
            'note' => sprintf(
                'Внимание: на отменённый заказ пришёл платёж. Транзакция: %s. Ожидалось: %s %s. '
                . 'Получено: %s %s. Решите, восстановить заказ или вернуть деньги покупателю.',
                (string) ($result['signature'] ?? ''),
                $quote->amount_token,
                $quote->token,
                self::received_amount($quote, $result),
                $quote->token
            ),
        ];
    }

    /**
     * Фактически полученная сумма — той же строкой, что и ожидаемая в
     * котировке, чтобы продавец в заметке заказа видел оба числа рядом.
     * Переплата принимается как оплата (см. Verify::validate), но заметка
     * не должна называть пришедшую сумму ожидаемой — это разные величины,
     * и обе уже посчитаны на момент решения.
     *
     * @param array{status: string, signature?: ?string, reason?: ?string, received_units?: ?string} $result
     */
    private static function received_amount(Quote $quote, array $result): string
    {
        $received_units = $result['received_units'] ?? null;

        if (!is_string($received_units) || $received_units === '') {
            return $quote->amount_token;
        }

        try {
            $decimals = Tokens::resolve($quote->cluster, $quote->token)['decimals'];

            return Money::format_units($received_units, $decimals);
        } catch (Throwable) {
            // Аномальное значение из Verify — не повод ронять формирование
            // заметки заказа: показываем ожидаемую сумму вместо необъяснимой ошибки.
            return $quote->amount_token;
        }
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
