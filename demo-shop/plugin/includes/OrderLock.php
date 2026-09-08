<?php
// demo-shop/plugin/includes/OrderLock.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Короткий лок по номеру заказа вокруг проверки платежа.
 *
 * Опрос из вкладки покупателя (раз в 5 секунд) и WP-Cron проверяют заказы
 * независимо друг от друга: оба могут прочитать один и тот же pending,
 * пройти проверку блокчейна и одновременно вызвать payment_complete() —
 * два письма покупателю, двойное списание остатков, дубли заметок заказа.
 * Наложение двух крон-проходов тоже реально: RPC-таймаут 10 секунд и до
 * 30 заказов за проход легко переваливают за WP_CRON_LOCK_TIMEOUT.
 *
 * Лок ставится через add_option(), а не через «прочитать транзиент, потом
 * записать» (так по сути делает set_transient(), когда транзиента ещё
 * нет — это read-then-write и есть гонка: оба процесса могут одновременно
 * увидеть «свободно»). У add_option() имя опции уникально на уровне СУБД
 * (уникальный индекс на option_name в wp_options), поэтому вторая
 * одновременная попытка вставить тот же ключ гарантированно проваливается
 * на уровне базы, а не «почти всегда» на уровне PHP.
 */
final class OrderLock
{
    private const TTL_SECONDS = 30;

    /**
     * Занять лок. Возвращает false, если лок уже держит другой процесс —
     * это следует читать как «ждём», а не как ошибку.
     */
    public static function acquire(int $order_id): bool
    {
        $key = self::option_name($order_id);

        if (add_option($key, time() + self::TTL_SECONDS, '', 'no')) {
            return true;
        }

        // Лок уже существует. Если он старше TTL — предыдущий процесс не
        // снял его (упал, был убит хостингом по таймауту): заказ не должен
        // остаться непроверяемым навсегда, поэтому лок забирается силой.
        $expires_at = get_option($key);

        if (is_numeric($expires_at) && (int) $expires_at < time()) {
            update_option($key, time() + self::TTL_SECONDS);

            return true;
        }

        return false;
    }

    /** Снимать строго в finally: и на успешном пути, и на исключении. */
    public static function release(int $order_id): void
    {
        delete_option(self::option_name($order_id));
    }

    private static function option_name(int $order_id): string
    {
        return 'solanapaykz_lock_' . $order_id;
    }
}
