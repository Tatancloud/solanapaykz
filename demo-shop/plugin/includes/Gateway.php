<?php
// demo-shop/plugin/includes/Gateway.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;
use WC_Order;
use WC_Payment_Gateway;

/**
 * Способ оплаты «криптовалютой» в WooCommerce.
 *
 * Класс намеренно тонкий: вся содержательная работа — расчёт, ссылка,
 * проверка платежа — лежит в классах, которые не зависят от WordPress и
 * покрыты тестами. Здесь только связывание с магазином.
 */
final class Gateway extends WC_Payment_Gateway
{
    public function __construct()
    {
        $this->id = 'solanapaykz';
        $this->method_title = 'SolanaPay-KZ';
        $this->method_description = 'Приём оплаты в криптовалюте на блокчейне Solana '
            . 'с автоматическим пересчётом из тенге. Деньги идут напрямую на кошелёк продавца.';
        $this->has_fields = false;
        $this->supports = ['products'];

        $this->init_form_fields();
        $this->init_settings();

        $this->title = $this->get_option('title', 'Оплата криптовалютой (USDC)');
        $this->description = $this->get_option('description', '');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
        add_action('woocommerce_thankyou_' . $this->id, [$this, 'render_payment_page']);
    }

    public function init_form_fields(): void
    {
        $this->form_fields = GatewaySettings::fields();
    }

    /**
     * Не даём сохранить заведомо нерабочие настройки: иначе продавец узнает
     * об ошибке от первого покупателя, который не смог заплатить.
     */
    public function process_admin_options(): bool
    {
        $saved = parent::process_admin_options();

        if ($this->get_option('enabled') !== 'yes') {
            return $saved;
        }

        $errors = GatewaySettings::validate([
            'recipient' => $this->get_option('recipient', ''),
            'cluster' => $this->get_option('cluster', ''),
            'rpc_url' => $this->get_option('rpc_url', ''),
            'token' => $this->get_option('token', ''),
            'markup_percent' => $this->get_option('markup_percent', '0'),
            'quote_ttl' => $this->get_option('quote_ttl', '900'),
            'late_window' => $this->get_option('late_window', '86400'),
        ]);

        foreach ($errors as $error) {
            \WC_Admin_Settings::add_error('SolanaPay-KZ: ' . $error);
        }

        if ($errors !== []) {
            $this->update_option('enabled', 'no');
            \WC_Admin_Settings::add_error(
                'SolanaPay-KZ выключен, пока настройки не исправлены.'
            );
        }

        return $saved;
    }

    /** Способ оплаты не показывается покупателю, пока настройки неверны. */
    public function is_available(): bool
    {
        if (!parent::is_available()) {
            return false;
        }

        return GatewaySettings::validate([
            'recipient' => $this->get_option('recipient', ''),
            'cluster' => $this->get_option('cluster', ''),
            'rpc_url' => $this->get_option('rpc_url', ''),
            'token' => $this->get_option('token', ''),
            'markup_percent' => $this->get_option('markup_percent', '0'),
            'quote_ttl' => $this->get_option('quote_ttl', '900'),
            'late_window' => $this->get_option('late_window', '86400'),
        ]) === [];
    }

    /**
     * @param int $order_id
     * @return array<string, string>
     */
    public function process_payment($order_id): array
    {
        $order = wc_get_order($order_id);

        if (!$order instanceof WC_Order) {
            return ['result' => 'failure'];
        }

        try {
            $quote = Quote::create(
                $this->build_rate_provider(),
                (string) $order->get_total(),
                (string) $this->get_option('token', 'USDC'),
                (string) $this->get_option('cluster', 'devnet'),
                (float) $this->get_option('markup_percent', '0'),
                (int) $this->get_option('quote_ttl', '900')
            );

            $request = PaymentRequest::create($quote, (string) $this->get_option('recipient', ''), [
                'label' => (string) get_bloginfo('name'),
                'message' => sprintf('Заказ №%s', $order->get_order_number()),
            ]);
        } catch (RateUnavailableException $error) {
            // Курс недоступен — заказ не создаём: продать по выдуманному курсу
            // хуже, чем не продать.
            error_log('SolanaPay-KZ: ' . $error->getMessage());
            wc_add_notice(
                'Оплата криптовалютой сейчас недоступна: не удалось получить курс. '
                . 'Выберите другой способ оплаты.',
                'error'
            );

            return ['result' => 'failure'];
        } catch (Throwable $error) {
            error_log('SolanaPay-KZ: ' . $error->getMessage());
            wc_add_notice('Не удалось подготовить оплату криптовалютой. Выберите другой способ.', 'error');

            return ['result' => 'failure'];
        }

        OrderMeta::save_quote($order, $quote, $request->reference);

        $order->update_status(
            'pending',
            sprintf('Ожидается оплата %s %s. Курс %s от «%s».',
                $quote->amount_token, $quote->token, $quote->rate, $quote->rate_source)
        );

        // Корзину очищаем: заказ уже создан, возвращаться к ней незачем.
        if (function_exists('WC') && WC()->cart !== null) {
            WC()->cart->empty_cart();
        }

        return [
            'result' => 'success',
            'redirect' => $this->get_return_url($order),
        ];
    }

    /** Страница «Спасибо за заказ»: сумма, QR и ожидание оплаты. */
    public function render_payment_page(int $order_id): void
    {
        $order = wc_get_order($order_id);

        if (!$order instanceof WC_Order || $order->get_payment_method() !== $this->id) {
            return;
        }

        $quote = OrderMeta::read_quote($order);
        $reference = OrderMeta::read_reference($order);

        if ($quote === null || $reference === null) {
            echo '<p>Не удалось загрузить данные оплаты. Свяжитесь с магазином.</p>';

            return;
        }

        // Разметка и опрос статуса — задача 9. Пока выводим сумму и ссылку,
        // чтобы страницу можно было проверить вручную.
        printf(
            '<section class="solanapaykz-payment"><h2>Оплата криптовалютой</h2>'
            . '<p>К оплате: <strong>%s %s</strong> (%s ₸ по курсу %s)</p>'
            . '<p><a href="%s">Открыть в кошельке</a></p></section>',
            esc_html($quote->amount_token),
            esc_html($quote->token),
            esc_html($quote->amount_kzt_charged),
            esc_html($quote->rate),
            esc_url(PaymentRequest::create($quote, (string) $this->get_option('recipient', ''), [
                'reference' => $reference,
            ])->url)
        );
    }

    private function build_rate_provider(): RateProvider
    {
        $http = new CurlHttpClient();

        return new RateProvider(
            [new BinanceRateSource($http), new SyntheticRateSource($http)],
            new TransientCache(),
            60
        );
    }
}
