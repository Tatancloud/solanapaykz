<?php
/**
 * Plugin Name: SolanaPay-KZ для WooCommerce
 * Description: Приём оплаты в USDC на Solana с конвертацией из тенге. Деньги идут напрямую на кошелёк продавца.
 * Version: 0.1.0
 * Requires at least: 7.0
 * Requires PHP: 8.1
 * Requires Plugins: woocommerce
 * WC requires at least: 7.1
 * WC tested up to: 11.1
 * Author: Tatancloud
 * License: MIT
 * Update URI: false
 * Text Domain: solanapaykz
 */

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

const PLUGIN_FILE = __FILE__;
const PLUGIN_DIR  = __DIR__;

/**
 * Версия плагина в одном месте. Читается Gateway.php при подключении
 * стилей и скриптов (иначе браузер продолжит отдавать старую разметку
 * покупателям, открывавшим страницу оплаты раньше) и CurlHttpClient.php
 * в строке User-Agent. Число в шапке файла выше — для WordPress: это
 * поле парсится как обычный текст комментария, PHP-константой быть не
 * может, и его придётся менять тем же значением при следующем бампе.
 */
const VERSION = '0.1.0';

/**
 * Объявляем совместимость с новым хранилием заказов (HPOS) явно: без
 * этого продавец с включённым HPOS не получит ни разрешения, ни
 * запрета — просто тишину в списке совместимости WooCommerce. Код и так
 * работает на обоих хранилищах: wc_get_orders() с payment_method и
 * date_created поддерживается обоими, мета читается через методы
 * заказа, своих запросов к таблицам заказов плагин не делает.
 */
add_action('before_woocommerce_init', static function (): void {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility(
            'custom_order_tables',
            PLUGIN_FILE
        );
    }
});

require_once __DIR__ . '/includes/Environment.php';
require_once __DIR__ . '/includes/Money.php';
require_once __DIR__ . '/includes/RpcException.php';
require_once __DIR__ . '/includes/SolanaChain.php';
require_once __DIR__ . '/includes/HttpClient.php';
require_once __DIR__ . '/includes/CurlHttpClient.php';
require_once __DIR__ . '/includes/Rpc.php';
require_once __DIR__ . '/includes/Verify.php';
require_once __DIR__ . '/includes/RateUnavailableException.php';
require_once __DIR__ . '/includes/RateSource.php';
require_once __DIR__ . '/includes/Cache.php';
require_once __DIR__ . '/includes/TransientCache.php';
require_once __DIR__ . '/includes/BinanceRateSource.php';
require_once __DIR__ . '/includes/SyntheticRateSource.php';
require_once __DIR__ . '/includes/RateProvider.php';
require_once __DIR__ . '/includes/QuoteException.php';
require_once __DIR__ . '/includes/Tokens.php';
require_once __DIR__ . '/includes/Quote.php';
require_once __DIR__ . '/includes/Base58.php';
require_once __DIR__ . '/includes/PaymentRequest.php';
require_once __DIR__ . '/includes/GatewaySettings.php';

const REQUIREMENTS = [
    'php' => '8.1',
    'extensions' => ['bcmath', 'curl', 'json'],
];

/**
 * Не даём включить плагин на непригодной среде: молчаливый неверный
 * расчёт суммы хуже honest отказа при активации.
 */
register_activation_hook(__FILE__, static function (): void {
    $missing = Environment::check(REQUIREMENTS);

    if ($missing !== []) {
        deactivate_plugins(plugin_basename(__FILE__));
        wp_die(
            '<h1>SolanaPay-KZ не может быть включён</h1><p>'
            . implode('</p><p>', array_map('esc_html', $missing))
            . '</p><p>Обратитесь к вашему хостинг-провайдеру.</p>',
            'SolanaPay-KZ',
            ['back_link' => true]
        );
    }
});

/**
 * Среда могла измениться после активации — например, хостер отключил
 * расширение при обновлении PHP. Проверяем при каждой загрузке.
 */
add_action('plugins_loaded', static function (): void {
    $missing = Environment::check(REQUIREMENTS);

    if ($missing !== []) {
        add_action('admin_notices', static function () use ($missing): void {
            printf(
                '<div class="notice notice-error"><p><strong>SolanaPay-KZ отключён:</strong> %s</p></div>',
                esc_html(implode(' ', $missing))
            );
        });

        return;
    }

    if (!class_exists('WooCommerce')) {
        add_action('admin_notices', static function (): void {
            echo '<div class="notice notice-error"><p><strong>SolanaPay-KZ:</strong> '
                . 'плагин требует установленный и включённый WooCommerce.</p></div>';
        });

        return;
    }

    require_once __DIR__ . '/includes/OrderMeta.php';
    require_once __DIR__ . '/includes/Gateway.php';

    add_filter('woocommerce_payment_gateways', static function (array $gateways): array {
        $gateways[] = Gateway::class;

        return $gateways;
    });

    require_once __DIR__ . '/includes/PaymentDecision.php';
    require_once __DIR__ . '/includes/CustomerMessage.php';
    require_once __DIR__ . '/includes/OrderLock.php';
    require_once __DIR__ . '/includes/OrderChecker.php';
    require_once __DIR__ . '/includes/Ajax.php';
    require_once __DIR__ . '/includes/Scheduler.php';

    Ajax::register();
    Scheduler::register();
});

/**
 * Снимаем расписание при выключении плагина: иначе задача продолжит
 * пытаться выполниться на классах, которых уже нет в автозагрузке.
 */
register_deactivation_hook(__FILE__, static function (): void {
    if (class_exists(Scheduler::class)) {
        Scheduler::unregister();
    }
});
