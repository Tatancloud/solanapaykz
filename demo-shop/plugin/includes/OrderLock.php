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
 * Лок реализован напрямую через $wpdb, в обход add_option()/set_transient():
 * add_option() сама делает get_option() для проверки существования, а затем
 * INSERT ... ON DUPLICATE KEY UPDATE — при дубликате ключа это не отказ,
 * а перезапись чужого лока, и два процесса, прошедших проверку существования
 * до вставки соседа, оба получат true. delete_option() к тому же кладёт ключ
 * в кеш notoptions, из-за чего следующий add_option() пропускает проверку
 * существования вовсе. Настоящую атомарность даёт только сам INSERT IGNORE
 * поверх уникального индекса на option_name: при дубликате он не вставляет
 * и не перезаписывает ничего, а $wpdb->query() честно возвращает 0
 * задетых строк — выигрывает ровно один процесс, кто бы что ни проверял
 * до этого.
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
        global $wpdb;

        $key = self::option_name($order_id);

        if (self::insert_if_absent($key, time() + self::TTL_SECONDS)) {
            return true;
        }

        // Лок уже существует. Если он старше TTL — предыдущий процесс не
        // снял его (упал, был убит хостингом по таймауту): заказ не должен
        // остаться непроверяемым навсегда. Само удаление тоже атомарно:
        // условие "AND ...< сейчас" в WHERE гарантирует, что просроченную
        // запись реально удалит только один из конкурирующих процессов —
        // остальные получат 0 задетых строк на этом же запросе и не пойдут
        // дальше вставлять новый лок.
        $deleted = $wpdb->query($wpdb->prepare(
            "DELETE FROM {$wpdb->options} WHERE option_name = %s AND CAST(option_value AS UNSIGNED) < %d",
            $key,
            time()
        ));

        if ((int) $deleted !== 1) {
            return false;
        }

        self::forget_cache($key);

        // Забрать лок повторной вставкой может снова не тот же процесс,
        // который его удалил (в теории), но это ничего не портит: важна
        // только атомарность самой вставки, а не то, кто именно её выиграл.
        return self::insert_if_absent($key, time() + self::TTL_SECONDS);
    }

    /** Снимать строго в finally: и на успешном пути, и на исключении. */
    public static function release(int $order_id): void
    {
        global $wpdb;

        $key = self::option_name($order_id);

        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name = %s", $key));
        self::forget_cache($key);
    }

    private static function insert_if_absent(string $key, int $expires_at): bool
    {
        global $wpdb;

        $inserted = $wpdb->query($wpdb->prepare(
            "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
            $key,
            (string) $expires_at
        ));

        $won = 1 === (int) $inserted;

        if ($won) {
            self::forget_cache($key);
        }

        return $won;
    }

    /**
     * Опция создаётся и удаляется в обход add_option()/get_option(), поэтому
     * их собственный кеш (значение опции и отдельный кеш notoptions,
     * которым get_option() запоминает «такой опции точно нет») не узнаёт об
     * этом сам. Без сброса кеша здесь любой код, вызвавший get_option() на
     * этом же ключе, увидел бы устаревшее значение.
     */
    private static function forget_cache(string $key): void
    {
        wp_cache_delete($key, 'options');

        $notoptions = wp_cache_get('notoptions', 'options');

        if (is_array($notoptions) && array_key_exists($key, $notoptions)) {
            unset($notoptions[$key]);
            wp_cache_set('notoptions', $notoptions, 'options');
        }
    }

    private static function option_name(int $order_id): string
    {
        return 'solanapaykz_lock_' . $order_id;
    }
}
