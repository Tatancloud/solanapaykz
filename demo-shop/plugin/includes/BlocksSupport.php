<?php
// demo-shop/plugin/includes/BlocksSupport.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

/**
 * Регистрация способа оплаты в блочном оформлении заказа (Cart & Checkout
 * blocks) — умолчание для новых установок WooCommerce.
 *
 * Обычные шлюзы (наследники WC_Payment_Gateway, как наш Gateway) в блочном
 * оформлении не появляются сами: это отдельная система, ей нужна отдельная
 * регистрация через AbstractPaymentMethodType и хук
 * woocommerce_blocks_payment_method_type_registration. Без этого класса
 * продавец включает плагин, видит его в списке способов оплаты в админке —
 * и не видит на странице оформления заказа, без единой ошибки в журнале.
 *
 * Файл подключается и класс регистрируется только тогда, когда WooCommerce
 * Blocks действительно загружены (см. solanapaykz.php, хук
 * woocommerce_blocks_loaded) — на старой версии WooCommerce без Blocks
 * класса AbstractPaymentMethodType не существует, и объявление `extends`
 * было бы фатальной ошибкой. Плагин обязан продолжать работать в
 * классическом оформлении в этом случае, а не падать.
 *
 * Класс намеренно тонкий, как и Gateway: правило видимости и состав данных
 * для браузера — в BlocksPaymentMethodData, классе без зависимости от
 * WordPress и покрытом тестами напрямую (сам этот класс тестами не
 * покрыть — не создать в тестовом окружении без WooCommerce Blocks).
 */
final class BlocksSupport extends AbstractPaymentMethodType
{
    /** Совпадает с Gateway::$id — так блочное оформление находит наш шлюз. */
    protected $name = 'solanapaykz';

    /**
     * Вызывается WooCommerce Blocks перед каждым использованием способа
     * оплаты. Настройки читаются напрямую из wp_options, как и в
     * официальных интеграциях WooCommerce (BankTransfer, Cheque) — здесь
     * ещё нет ни экземпляра Gateway, ни WC()->payment_gateways().
     */
    public function initialize(): void
    {
        $this->settings = get_option('woocommerce_' . $this->name . '_settings', []);
    }

    /** Показывать ли способ оплаты. Правило — в BlocksPaymentMethodData. */
    public function is_active(): bool
    {
        $enabled = filter_var($this->get_setting('enabled', false), FILTER_VALIDATE_BOOLEAN);

        return BlocksPaymentMethodData::is_active($enabled, $this->settings_for_validation(), get_woocommerce_currency());
    }

    /** @return string[] */
    public function get_payment_method_script_handles(): array
    {
        wp_register_script(
            'solanapaykz-blocks-checkout',
            plugins_url('assets/blocks-checkout.js', PLUGIN_FILE),
            ['wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities'],
            VERSION,
            true
        );

        return ['solanapaykz-blocks-checkout'];
    }

    /** @return array<string, mixed> */
    public function get_payment_method_data(): array
    {
        return BlocksPaymentMethodData::payment_method_data(
            (string) $this->get_setting('title', 'Оплата криптовалютой (USDC)'),
            (string) $this->get_setting('description', '')
        );
    }

    /**
     * Те же имена полей и значения по умолчанию, что и в
     * Gateway::settings_for_validation() — умышленно не единый метод на
     * двоих: у Gateway это get_option() экземпляра шлюза, а здесь —
     * $this->settings, массив из wp_options, который читает сам
     * AbstractPaymentMethodType. Расхождение в списке полей заметит
     * GatewaySettingsTest / BlocksPaymentMethodDataTest при следующем
     * добавлении настройки — оба теста перечисляют одни и те же ключи.
     *
     * @return array<string, string>
     */
    private function settings_for_validation(): array
    {
        return [
            'recipient' => (string) $this->get_setting('recipient', ''),
            'cluster' => (string) $this->get_setting('cluster', 'devnet'),
            'rpc_url' => (string) $this->get_setting('rpc_url', ''),
            'token' => (string) $this->get_setting('token', 'USDC'),
            'markup_percent' => (string) $this->get_setting('markup_percent', '0'),
            'quote_ttl' => (string) $this->get_setting('quote_ttl', '900'),
            'late_window' => (string) $this->get_setting('late_window', '86400'),
        ];
    }
}
