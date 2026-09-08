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
        $this->form_fields = GatewaySettings::fields(get_woocommerce_currency());
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

        $errors = GatewaySettings::validate($this->settings_for_validation(), get_woocommerce_currency());

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

        return GatewaySettings::validate($this->settings_for_validation(), get_woocommerce_currency()) === [];
    }

    /**
     * Собирает текущие настройки в формате, который принимает
     * GatewaySettings::validate(). Единственное место, где перечислены
     * имена полей и их значения по умолчанию (те же, что в описании полей
     * GatewaySettings::fields()): и process_admin_options(), и is_available()
     * берут их отсюда, чтобы новое поле не пришлось добавлять в двух местах
     * с риском разойтись.
     *
     * @return array<string, string>
     */
    private function settings_for_validation(): array
    {
        return [
            'recipient' => $this->get_option('recipient', ''),
            'cluster' => $this->get_option('cluster', 'devnet'),
            'rpc_url' => $this->get_option('rpc_url', ''),
            'token' => $this->get_option('token', 'USDC'),
            'markup_percent' => $this->get_option('markup_percent', '0'),
            'quote_ttl' => $this->get_option('quote_ttl', '900'),
            'late_window' => $this->get_option('late_window', '86400'),
        ];
    }

    /**
     * @param int $order_id
     * @return array<string, string>
     */
    public function process_payment($order_id): array
    {
        $order = wc_get_order($order_id);

        if (!$order instanceof WC_Order) {
            // Без сообщения покупатель просто вернётся на форму оформления
            // без единого слова о причине: WooCommerce в этом случае никуда
            // не перенаправляет.
            wc_add_notice('Не удалось найти заказ для оплаты. Попробуйте оформить заказ заново.', 'error');

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

        // Адрес получателя замораживаем на момент создания заказа: продавец
        // может сменить кошелёк в настройках позже, а показ страницы и
        // будущая проверка платежа должны сверяться с тем, что покупатель
        // реально увидел в QR-коде, а не с текущими настройками.
        OrderMeta::save_quote(
            $order,
            $quote,
            PaymentRequest::generate_reference(),
            (string) $this->get_option('recipient', '')
        );

        $order->update_status(
            'pending',
            sprintf('Ожидается оплата %s %s. Курс %s от «%s».',
                $quote->amount_token, $quote->token, $quote->rate, $quote->rate_source)
        );

        // Корзину очищаем только если она ещё соответствует этому заказу:
        // иначе покупатель, оплачивающий старый заказ по ссылке «оплатить»,
        // потерял бы содержимое новой корзины. Так же поступают встроенные
        // шлюзы WooCommerce (BACS, Cheque, COD).
        if (WC()->cart && $order->has_cart_hash(WC()->cart->get_cart_hash())) {
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
        $recipient = OrderMeta::read_recipient($order);

        if ($quote === null || $reference === null || $recipient === null) {
            echo '<p>Не удалось загрузить данные оплаты. Свяжитесь с магазином.</p>';

            return;
        }

        // Ссылка строится здесь же, а не при создании платежа: метка
        // магазина и номер заказа нужны только для показа, и здесь же (а не
        // в двух разных местах порознь) собираются вместе с адресом и меткой
        // платежа, сохранёнными в заказе.
        try {
            $request = PaymentRequest::create($quote, $recipient, [
                'reference' => $reference,
                'label' => (string) get_bloginfo('name'),
                'message' => sprintf('Заказ №%s', $order->get_order_number()),
            ]);
        } catch (Throwable $error) {
            // Котировка истекла к моменту показа страницы — обычное дело,
            // если покупатель вернулся по ссылке позже.
            error_log(sprintf(
                'SolanaPay-KZ: заказ %d — не удалось построить платёжную ссылку: %s',
                $order->get_id(),
                $error->getMessage()
            ));
            printf(
                '<p>Срок оплаты этого заказа истёк (цена действовала до %s). '
                . 'Оформите заказ заново.</p>',
                esc_html(wp_date('d.m.Y H:i', $quote->expires_at))
            );

            return;
        }

        wp_enqueue_style(
            'solanapaykz-checkout',
            plugins_url('assets/checkout.css', PLUGIN_FILE),
            [],
            '0.1.0'
        );

        wp_enqueue_script(
            'solanapaykz-qrcode',
            plugins_url('assets/qrcode.js', PLUGIN_FILE),
            [],
            '0.1.0',
            true
        );

        wp_enqueue_script(
            'solanapaykz-checkout',
            plugins_url('assets/checkout.js', PLUGIN_FILE),
            ['solanapaykz-qrcode'],
            '0.1.0',
            true
        );

        wp_localize_script('solanapaykz-checkout', 'solanapaykzData', [
            'url' => $request->url,
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'action' => Ajax::ACTION,
            'orderId' => $order->get_id(),
            'orderKey' => $order->get_order_key(),
            'expiresAt' => $quote->expires_at,
            'intervalMs' => 5000,
        ]);

        ?>
        <section class="solanapaykz" id="solanapaykz">
            <h2>Оплата криптовалютой</h2>

            <p class="solanapaykz__amount">
                К оплате: <strong><?php echo esc_html($quote->amount_token); ?>
                <?php echo esc_html($quote->token); ?></strong>
                <span class="solanapaykz__kzt">(<?php echo esc_html($quote->amount_kzt_charged); ?> ₸
                по курсу <?php echo esc_html($quote->rate); ?>)</span>
            </p>

            <div class="solanapaykz__qr" id="solanapaykz-qr"></div>

            <p class="solanapaykz__hint">
                Отсканируйте код кошельком Solana. Деньги придут продавцу напрямую.
            </p>

            <p class="solanapaykz__timer" id="solanapaykz-timer"></p>

            <p class="solanapaykz__status" id="solanapaykz-status">Ожидаем оплату…</p>

            <p class="solanapaykz__link">
                <a href="<?php echo esc_url($request->url); ?>">Открыть в кошельке на этом устройстве</a>
            </p>
        </section>
        <?php
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
