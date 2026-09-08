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
    /** Заказ с испорченными данными оплаты — обе ветки ниже пишут один и тот же текст покупателю. */
    private const CORRUPTED_PAYMENT_DATA_MESSAGE =
        'Данные оплаты повреждены, автоматическая проверка невозможна. Магазин свяжется с вами.';

    /** Сбой связи с узлом или ошибка конфигурации — обе ветки не отвечают на вопрос о платеже. */
    private const UNAVAILABLE_MESSAGE = 'Не удалось проверить оплату. Пробуем ещё раз.';

    /**
     * @param ?SolanaChain $chain Только для тестов: подменяет настоящий
     *     RPC-клиент, чтобы проверить check() без обращения к узлу
     *     блокчейна. В рабочем коде всегда null — check() создаёт клиент
     *     сам, по rpc_url из настроек, известному только на момент вызова.
     */
    public function __construct(private ?SolanaChain $chain = null)
    {
    }

    /**
     * @return array{status: string, message: string, mutated: bool} mutated —
     *     реально ли этот вызов изменил заказ в базе; для показа
     *     покупателю нужны только status и message.
     */
    public function check(WC_Order $order, array $settings): array
    {
        $order_id = $order->get_id();

        $lock_token = OrderLock::acquire($order_id);

        if ($lock_token === null) {
            // Другой процесс (браузерный опрос или крон) уже проверяет этот
            // заказ прямо сейчас. Это не ошибка — оба процесса опрашивают
            // независимо, и без лока оба могли бы дойти до payment_complete()
            // одновременно: два письма покупателю, двойное списание
            // остатков, дубли заметок заказа.
            return CustomerMessage::for_order_status($order->get_status()) + ['mutated' => false];
        }

        // try открывается сразу после захвата лока, а не после блока с
        // error_log ниже: исключение в этом блоке (даже маловероятное)
        // иначе оставило бы лок висеть на весь TTL — finally должен
        // накрывать всё, что происходит между acquire() и release().
        try {
            $quote = OrderMeta::read_quote($order);
            $reference = OrderMeta::read_reference($order);
            $recipient = OrderMeta::read_recipient($order);

            if ($quote === null && OrderMeta::quote_format_is_unknown($order)) {
                // Формат котировки не испорчен — он новее, чем понимает эта
                // версия плагина: заказ выпущен более новой сборкой (например,
                // после отката плагина на сервере). Это не повод проваливать
                // заказ: не трогаем его и ждём — либо обновления плагина, либо
                // ручного разбора продавцом.
                error_log(sprintf(
                    'SolanaPay-KZ: заказ %d — формат котировки не распознан этой версией плагина,'
                    . ' автоматическая проверка отложена.',
                    $order_id
                ));

                return ['status' => 'unknown', 'message' => self::UNAVAILABLE_MESSAGE, 'mutated' => false];
            }

            if ($quote === null || $reference === null || $recipient === null) {
                // Заказ с испорченными или отсутствующими данными оплаты через
                // наш шлюз оплатить нельзя никогда. Статус — failed, а не
                // on-hold: в WooCommerce на on-hold навешаны
                // wc_maybe_reduce_stock_levels (списывает остаток под заказ,
                // который никогда не будет оплачен) и письмо покупателю «ждём
                // подтверждения вашего платежа» — оба поведения неверны для
                // заказа, который провален окончательно. failed возвращает
                // остаток, письмо уходит администратору (WC_Email_Failed_Order),
                // а не покупателю, и заказ так же выпадает из выборки pending —
                // без специальной метки в мете (см. правку про meta_query,
                // который на этом магазине не работает без HPOS).
                //
                // Трогаем только заказы в pending: отменённый заказ не должен
                // воскресать ни при каких условиях — это ровно то, ради чего
                // белый список статусов в PaymentDecision существует, и эта
                // ветка стоит до него, поэтому обязана соблюдать то же правило
                // сама.
                if ($order->get_status() !== 'pending') {
                    return ['status' => 'error', 'message' => self::CORRUPTED_PAYMENT_DATA_MESSAGE, 'mutated' => false];
                }

                $order->update_status(
                    'failed',
                    'SolanaPay-KZ: не удалось прочитать данные оплаты (котировка, метка платежа '
                    . 'или адрес получателя повреждены либо отсутствуют). Автоматическая проверка '
                    . 'невозможна — оплату этого заказа нужно проверить вручную.'
                );

                return ['status' => 'error', 'message' => self::CORRUPTED_PAYMENT_DATA_MESSAGE, 'mutated' => true];
            }

            // rpc_url берётся из текущих настроек шлюза, а монета и число
            // знаков — из замороженной котировки заказа. Расхождение сети
            // здесь — ошибка настройки продавца (переключил сеть в
            // настройках уже после создания заказа, например ради тестов),
            // а не сигнал о платеже: base58-адрес получателя валиден в
            // обеих сетях Solana, и запрос в чужую сеть по адресу и минту
            // из старой котировки нашёл бы там платёж с той же меткой —
            // например, бесплатный devnet-перевод, закрывающий mainnet-заказ
            // как оплаченный. Заказ не трогаем, как при сбое сети, и пишем
            // в журнал: это требует вмешательства администратора, а не
            // повторной проверки.
            if (isset($settings['cluster']) && (string) $settings['cluster'] !== $quote->cluster) {
                error_log(sprintf(
                    'SolanaPay-KZ: заказ %d — сеть в настройках («%s») не совпадает с сетью котировки («%s»).'
                    . ' Проверка невозможна: это ошибка конфигурации, а не платёж, который нужно проверять.',
                    $order_id,
                    (string) $settings['cluster'],
                    $quote->cluster
                ));

                return ['status' => 'unknown', 'message' => self::UNAVAILABLE_MESSAGE, 'mutated' => false];
            }

            try {
                $token_info = Tokens::resolve($quote->cluster, $quote->token);
                $verify = new Verify($this->chain ?? new Rpc((string) $settings['rpc_url']));
                $result = $verify->check(
                    $reference,
                    $recipient,
                    // Честно передаём null дальше: подмена на '' заставляла
                    // Verify искать SPL-токен с пустым адресом минта,
                    // которого не существует ни в одной транзакции —
                    // платежи в нативном SOL никогда бы не засчитывались.
                    $token_info['mint'],
                    Money::parse_decimal_to_units($quote->amount_token, $token_info['decimals'])
                );
            } catch (Throwable $error) {
                // Сбой связи с узлом — не ответ о платеже. Заказ не трогаем,
                // покупателю говорим, что проверка временно недоступна.
                error_log('SolanaPay-KZ: ' . $error->getMessage());

                return ['status' => 'unknown', 'message' => self::UNAVAILABLE_MESSAGE, 'mutated' => false];
            }

            // Перечитываем заказ перед мутацией: за время RPC-запроса (до 10 секунд)
            // статус мог смениться другим процессом — лок не единственная защита.
            // clean_post_cache() сбрасывает кеш поста; на HPOS это не нужно и не сработает.
            if (function_exists('clean_post_cache')) {
                clean_post_cache($order_id);
            }

            $fresh_order = wc_get_order($order_id);

            if (!$fresh_order instanceof WC_Order) {
                return ['status' => 'error', 'message' => 'Заказ не найден.', 'mutated' => false];
            }

            $decision = PaymentDecision::decide(
                $result,
                $quote,
                $fresh_order->get_status(),
                (int) $settings['late_window'],
                time()
            );

            return $this->apply($fresh_order, $decision, $result);
        } finally {
            OrderLock::release($order_id, $lock_token);
        }
    }

    /**
     * @param array{action: string, note: string} $decision
     * @return array{status: string, message: string, mutated: bool}
     */
    private function apply(WC_Order $order, array $decision, array $result): array
    {
        $signature = (string) ($result['signature'] ?? '');

        switch ($decision['action']) {
            case 'complete':
                OrderMeta::save_signature($order, $signature);
                $order->payment_complete($signature);
                $order->add_order_note($decision['note']);

                break;

            case 'cancel':
                // PaymentDecision больше не выдаёт 'cancel' для заказа, уже
                // ставшего cancelled (см. правку про список «действовать
                // только на pending/cancelled»), но проверка здесь дёшева
                // и избавляет от лишнего save() при заказе, отменённом уже
                // другим путём в тот же момент.
                if ($order->get_status() !== 'cancelled') {
                    $order->update_status('cancelled', $decision['note']);
                }

                break;

            case 'hold':
                OrderMeta::save_signature($order, $signature);
                $order->update_status('on-hold', $decision['note']);

                break;

            case 'late':
                OrderMeta::mark_late_payment($order, $signature);
                $order->update_status('on-hold', $decision['note']);

                break;
        }

        // Текст для покупателя строится по фактическому статусу заказа на
        // случай «wait», а не по одному лишь факту «новое решение — ждать»:
        // за то время, что вкладка покупателя не опрашивала сервер, крон
        // мог перевести заказ в processing, cancelled или on-hold.
        //
        // «Мы что-то поменяли в базе» — отдельный вопрос от текста для
        // покупателя, и выводить один из другого нельзя: например, «wait»
        // на уже отменённом заказе показывает тот же текст, что и решение
        // 'cancel' (оба — «истёк срок»), хотя в первом случае в базе
        // ничего не поменялось.
        $response = CustomerMessage::for_decision($decision['action'], $order->get_status());
        $response['mutated'] = PaymentDecision::is_mutating($decision['action']);

        return $response;
    }
}
