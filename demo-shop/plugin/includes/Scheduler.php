<?php
// demo-shop/plugin/includes/Scheduler.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use WC_Order;

/**
 * Проверка заказов по расписанию.
 *
 * Нужна потому, что покупатель может закрыть вкладку сразу после оплаты:
 * опрос из браузера прекратится, а платёж останется незамеченным.
 *
 * Встроенный планировщик WordPress срабатывает при заходе на сайт, поэтому
 * на малопосещаемом магазине задачи выполняются реже, чем задано. Для
 * подстраховки и существует опрос из браузера.
 */
final class Scheduler
{
    public const HOOK = 'solanapaykz_check_orders';

    public static function register(): void
    {
        add_filter('cron_schedules', static function (array $schedules): array {
            $schedules['solanapaykz_five_minutes'] = [
                'interval' => 300,
                'display' => 'Каждые 5 минут (SolanaPay-KZ)',
            ];

            return $schedules;
        });

        add_action(self::HOOK, [self::class, 'run']);

        if (wp_next_scheduled(self::HOOK) === false) {
            wp_schedule_event(time() + 300, 'solanapaykz_five_minutes', self::HOOK);
        }

        add_action('admin_notices', [self::class, 'maybe_warn_about_disabled_cron']);
    }

    /**
     * DISABLE_WP_CRON отключает встроенный псевдо-cron WordPress (он
     * срабатывает при заходе посетителя на сайт), а системный cron на
     * wp-cron.php — типовое сочетание с ним не настраивают. Эта задача
     * тогда не выполняется никогда: покупатель оплатил и закрыл вкладку —
     * заказ навсегда в ожидании, письмо не ушло, товар не отгружен. Плагин
     * без этого предупреждения молчит, и продавец узнаёт о проблеме только
     * от рассерженного покупателя.
     */
    public static function maybe_warn_about_disabled_cron(): void
    {
        if (!defined('DISABLE_WP_CRON') || !DISABLE_WP_CRON) {
            return;
        }

        $settings = get_option('woocommerce_solanapaykz_settings', []);

        if (!is_array($settings) || ($settings['enabled'] ?? 'no') !== 'yes') {
            return;
        }

        printf(
            '<div class="notice notice-warning"><p><strong>SolanaPay-KZ:</strong> %s</p></div>',
            esc_html(
                'На сайте отключён встроенный псевдо-cron WordPress (константа DISABLE_WP_CRON). '
                . 'Без настоящего системного cron на wp-cron.php фоновая проверка оплаты не '
                . 'сработает никогда — подтверждение платежа будет работать только пока '
                . 'покупатель держит вкладку с оплатой открытой.'
            )
        );
    }

    public static function unregister(): void
    {
        $timestamp = wp_next_scheduled(self::HOOK);

        if ($timestamp !== false) {
            wp_unschedule_event($timestamp, self::HOOK);
        }
    }

    public static function run(): void
    {
        $gateways = WC()->payment_gateways()->payment_gateways();
        $gateway = $gateways['solanapaykz'] ?? null;

        if ($gateway === null) {
            return;
        }

        $late_window = (int) $gateway->get_option('late_window', '86400');

        $settings = [
            'rpc_url' => $gateway->get_option('rpc_url', ''),
            'late_window' => $late_window,
            'cluster' => $gateway->get_option('cluster', 'devnet'),
        ];

        $checker = new OrderChecker();
        $checked = 0;
        $changed = 0;

        // Ожидающие оплаты — основной случай.
        foreach (self::orders_to_check('pending', 30) as $order) {
            $checked++;

            if (self::mutated($checker->check($order, $settings))) {
                $changed++;
            }
        }

        // Отменённые проверяются, пока не вышло окно: покупатель мог
        // заплатить по QR уже после отмены.
        if ($late_window > 0) {
            foreach (self::orders_to_check('cancelled', 30, $late_window) as $order) {
                $checked++;

                if (self::mutated($checker->check($order, $settings))) {
                    $changed++;
                }
            }
        }

        // Заказ с испорченной котировкой не может застрять в этой выборке
        // навсегда: OrderChecker переводит такие заказы в failed, и они
        // перестают быть pending сами, безо всякой особой пометки —
        // запрос ниже и так фильтрует по статусу. Если же весь проход из
        // непустой выборки не изменил ни одного заказа по другой причине
        // (например, RPC-узел лежит уже давно), это стоит записать в
        // журнал — это не единичный сбойный заказ, а признак, что
        // подстраховка перестала работать вовсе.
        if ($checked > 0 && $changed === 0) {
            error_log(sprintf(
                'SolanaPay-KZ: фоновая проверка отработала %d заказ(ов), ни один не изменил статус.',
                $checked
            ));
        }
    }

    /**
     * Признак «мы что-то поменяли в базе» берётся из OrderChecker напрямую
     * (тот, в свою очередь, — из PaymentDecision::is_mutating()), а не
     * угадывается по тексту для покупателя: например, «wait» на уже
     * отменённом заказе отдаёт покупателю тот же статус 'expired', что и
     * решение 'cancel' — тексты одинаковы, а изменение в базе было только
     * во втором случае. Отменённые заказы попадают в выборку каждый
     * проход, пока не вышло окно поздних платежей, и без этого различия
     * одного такого заказа хватило бы, чтобы счётчик изменений никогда не
     * обнулялся, а предупреждение о зависшей подстраховке не сработало ни
     * разу.
     *
     * @param array{status: string, message: string, mutated?: bool} $result
     */
    private static function mutated(array $result): bool
    {
        // Голое обращение к ключу при strict_types и возвращаемом bool
        // превратило бы забытый в какой-нибудь будущей ветке ключ 'mutated'
        // в фатальную ошибку вместо честного «изменений не было».
        return $result['mutated'] ?? false;
    }

    /** @return list<WC_Order> */
    private static function orders_to_check(string $status, int $limit, ?int $max_age = null): array
    {
        $args = [
            'status' => $status,
            'payment_method' => 'solanapaykz',
            'limit' => $limit,
            'orderby' => 'date',
            'order' => 'ASC',
        ];

        if ($max_age !== null) {
            $args['date_created'] = '>' . (time() - $max_age);
        }

        $orders = wc_get_orders($args);

        return is_array($orders) ? $orders : [];
    }
}
