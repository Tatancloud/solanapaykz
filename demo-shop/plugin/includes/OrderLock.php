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
 *
 * Значение лока несёт токен владельца и срок истечения (`токен|expires_at`).
 * Токен обязателен: без него release() удалял бы строку по одному только
 * имени, не проверяя, что удаляет именно свою запись. Если держатель
 * превысит TTL (запрос к узлу — 10 секунд, плюс payment_complete(), плюс
 * синхронная отправка писем — это реально), сосед перехватит лок, а
 * release() первого процесса без токена снял бы уже чужой, свежий лок —
 * внутрь вошли бы двое. С токеном release() удаляет строку только тогда,
 * когда её значение всё ещё начинается с его собственного токена.
 */
final class OrderLock
{
    private const TTL_SECONDS = 30;

    /**
     * Занять лок. Возвращает токен владельца, который затем обязателен
     * для release(), либо null, если лок уже держит другой процесс — это
     * следует читать как «ждём», а не как ошибку.
     */
    public static function acquire(int $order_id): ?string
    {
        global $wpdb;

        $key = self::option_name($order_id);
        $token = bin2hex(random_bytes(16));
        $value = self::encode($token, time() + self::TTL_SECONDS);

        if (self::insert_if_absent($key, $value)) {
            return $token;
        }

        // Лок уже существует. Если он старше TTL — предыдущий процесс не
        // снял его (упал, был убит хостингом по таймауту): заказ не должен
        // остаться непроверяемым навсегда. Само удаление тоже атомарно:
        // условие "AND ...< сейчас" в WHERE гарантирует, что просроченную
        // запись реально удалит только один из конкурирующих процессов —
        // остальные получат 0 задетых строк на этом же запросе и не пойдут
        // дальше вставлять новый лок.
        $deleted = $wpdb->query($wpdb->prepare(
            "DELETE FROM {$wpdb->options} WHERE option_name = %s"
            . " AND CAST(SUBSTRING_INDEX(option_value, '|', -1) AS UNSIGNED) < %d",
            $key,
            time()
        ));

        if ((int) $deleted !== 1) {
            return null;
        }

        self::forget_cache($key);

        // Забрать лок повторной вставкой может снова не тот же процесс,
        // который его удалил (в теории), но это ничего не портит: важна
        // только атомарность самой вставки, а не то, кто именно её выиграл.
        return self::insert_if_absent($key, $value) ? $token : null;
    }

    /**
     * Снимать строго в finally: и на успешном пути, и на исключении.
     * Удаляет запись, только если она всё ещё несёт этот же токен —
     * просроченный и уже перехваченный кем-то лок этим вызовом не тронуть.
     */
    public static function release(int $order_id, string $token): void
    {
        global $wpdb;

        $key = self::option_name($order_id);

        $wpdb->query($wpdb->prepare(
            "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value LIKE %s",
            $key,
            $wpdb->esc_like($token) . '|%'
        ));

        self::forget_cache($key);
    }

    private static function encode(string $token, int $expires_at): string
    {
        return $token . '|' . $expires_at;
    }

    private static function insert_if_absent(string $key, string $value): bool
    {
        global $wpdb;

        $inserted = $wpdb->query($wpdb->prepare(
            "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
            $key,
            $value
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
