<?php
// demo-shop/plugin/uninstall.php

declare(strict_types=1);

/**
 * Полная зачистка после удаления плагина через админку.
 *
 * Плагин не заводит своих таблиц — всё живёт в опциях и мете заказа
 * (мета WooCommerce переносит вместе с заказом сама и её мы не трогаем).
 * Но в опциях остаётся адрес RPC-узла с ключом провайдера и адрес
 * кошелька продавца: без этого файла они лежат в базе бессрочно, и через
 * год после того, как продавец попробовал и удалил плагин, они всё ещё
 * там — в любом дампе базы, у любого, кому передали доступ к сайту.
 *
 * WordPress подключает этот файл сам при удалении плагина через админку,
 * определив константу WP_UNINSTALL_PLUGIN. Прямой запуск файла — не тот
 * случай, поэтому без константы выходим сразу же.
 */
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

/**
 * Событие расписания — то же имя, что и Scheduler::HOOK. Не подключаем
 * файл класса ради одной строки: uninstall.php должен зачищать сеть,
 * даже если что-то в подключении классов плагина уже не работает
 * (например, хостер убрал bcmath уже после того, как продавец решил
 * удалить плагин из-за этого же).
 */
const SOLANAPAYKZ_SCHEDULE_HOOK = 'solanapaykz_check_orders';

/** Токены, для которых RateProvider кладёт курс в транзиент. */
const SOLANAPAYKZ_RATE_TOKENS = ['USDC', 'SOL'];

/** Зачистка одного сайта: опции, транзиенты, локи, расписание. */
function solanapaykz_uninstall_site(): void
{
    global $wpdb;

    delete_option('woocommerce_solanapaykz_settings');

    foreach (SOLANAPAYKZ_RATE_TOKENS as $token) {
        delete_transient('solanapaykz_rate_' . $token);
    }

    // Локи заказов (includes/OrderLock.php) живут в wp_options напрямую,
    // в обход API транзиентов и опций — под именами solanapaykz_lock_<id>.
    // Точных имён мы не знаем (id заказов), поэтому чистим по маске.
    $wpdb->query($wpdb->prepare(
        "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s",
        $wpdb->esc_like('solanapaykz_lock_') . '%'
    ));

    wp_clear_scheduled_hook(SOLANAPAYKZ_SCHEDULE_HOOK);
}

if (is_multisite()) {
    $site_ids = get_sites(['fields' => 'ids']);

    foreach ($site_ids as $site_id) {
        switch_to_blog((int) $site_id);
        solanapaykz_uninstall_site();
        restore_current_blog();
    }
} else {
    solanapaykz_uninstall_site();
}
