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

        // Покупатель мог уже отсканировать QR по этому заказу раньше и уйти,
        // не дождавшись подтверждения (finalized занимает до 15 секунд, при
        // перегрузке сети — дольше), а вернуться оплатить его повторно
        // штатным путём WooCommerce — по ссылке «Оплатить» из письма или из
        // «Мой аккаунт → Заказы». Новая котировка означает новую метку
        // платежа: проверка станет искать транзакции по ней, а деньги
        // ушли со старой меткой — платёж не найдётся никогда. Пока прежняя
        // котировка ещё не истекла, переиспользуем её и метку вместо того,
        // чтобы выпускать новые. Требуем, чтобы метка и адрес получателя
        // тоже сохранились: без них старую котировку показать нечем, и
        // это тот же случай, что и полное отсутствие данных оплаты —
        // выпускаем всё заново.
        $existing_quote = OrderMeta::read_quote($order);
        $existing_reference = OrderMeta::read_reference($order);
        $existing_recipient = OrderMeta::read_recipient($order);

        $reuse = $existing_quote instanceof Quote
            && !$existing_quote->is_expired()
            && $existing_reference !== null
            && $existing_recipient !== null;

        if ($reuse) {
            $quote = $existing_quote;
        } else {
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
        }

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

        // Хук woocommerce_thankyou_{method} срабатывает при любом статусе
        // заказа, кроме failed, — не только при pending. Без этой проверки
        // уже оплаченный заказ показал бы тот же QR повторно (checkout.js
        // перезагружает страницу сразу после оплаты), а по QR отменённого
        // заказа можно было бы всё равно отправить деньги — тот самый
        // случай поздних платежей, который потом разбирают вручную.
        if (!CustomerMessage::should_show_qr($order->get_status())) {
            printf('<p>%s</p>', esc_html(CustomerMessage::for_order_status($order->get_status())['message']));

            return;
        }

        $quote = OrderMeta::read_quote($order);
        $reference = OrderMeta::read_reference($order);
        $recipient = OrderMeta::read_recipient($order);

        if ($quote === null || $reference === null || $recipient === null) {
            echo '<p>Не удалось загрузить данные оплаты. Свяжитесь с магазином.</p>';

            return;
        }

        // Котировка истекла к моменту показа страницы — обычное дело, если
        // покупатель вернулся по ссылке позже. Проверяется отдельно, до
        // вызова PaymentRequest::create(): та бросает QuoteException не
        // только на истёкшей котировке, но и на невалидном адресе
        // получателя, и на совпадении адреса получателя с адресом монеты,
        // и на неизвестной паре сеть/монета — единый catch(Throwable) ниже
        // объявлял бы любую из этих причин истечением срока, и покупателю
        // предлагали бы оформить заказ заново, что не помогло бы никогда
        // (например, если продавец по ошибке вписал в поле получателя
        // адрес самого USDC-минта).
        if ($quote->is_expired()) {
            printf(
                '<p>Срок оплаты этого заказа истёк (цена действовала до %s). '
                . 'Оформите заказ заново.</p>',
                esc_html(wp_date('d.m.Y H:i', $quote->expires_at))
            );

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
            // Котировка не истекла (проверено выше) — значит, дело в
            // настройках (адрес получателя, сеть/монета), а не во времени.
            // Продавцу это видно в журнале; покупателю — нейтральный текст,
            // а не совет переоформить заказ, который тут не поможет.
            error_log(sprintf(
                'SolanaPay-KZ: заказ %d — не удалось построить платёжную ссылку: %s',
                $order->get_id(),
                $error->getMessage()
            ));
            echo '<p>Оплата временно недоступна, свяжитесь с продавцом.</p>';

            return;
        }

        wp_enqueue_style(
            'solanapaykz-checkout',
            plugins_url('assets/checkout.css', PLUGIN_FILE),
            [],
            VERSION
        );

        wp_enqueue_script(
            'solanapaykz-qrcode',
            plugins_url('assets/qrcode.js', PLUGIN_FILE),
            [],
            VERSION,
            true
        );

        wp_enqueue_script(
            'solanapaykz-checkout',
            plugins_url('assets/checkout.js', PLUGIN_FILE),
            ['solanapaykz-qrcode'],
            VERSION,
            true
        );

        // Значения идут через wp_add_inline_script() с wp_json_encode(), а
        // не через wp_localize_script(): тот приводит все значения к
        // строкам, и арифметике таймера в JS пришлось бы полагаться на
        // неявное приведение типов.
        //
        // Браузер получает оставшиеся секунды, а не абсолютный expires_at:
        // отсчёт по часам покупателя от абсолютного времени истечения на
        // сбитых часах (частый случай на телефоне — часовой пояс, севшая
        // батарейка) сразу показывал бы «срок истёк» на живой ещё котировке
        // или наоборот. Секунды, отсчитываемые локально от момента загрузки
        // страницы (см. checkout.js), от показаний часов уже не зависят.
        // Путь без схемы и хоста: admin_url() отдаёт их из настроек сайта
        // (FORCE_SSL_ADMIN, отдельный домен админки), и на сайте, где они
        // расходятся с фронтендом, запрос со страницы оплаты упёрся бы в
        // CORS — обработчик ошибки в checkout.js молча перепланирует опрос,
        // и покупатель до конца грейса видит «ожидаем оплату» даже на уже
        // оплаченном заказе. Относительный путь резолвится браузером от
        // текущего origin и этой проблемы не знает.
        $ajax_path = (string) wp_parse_url(admin_url('admin-ajax.php'), PHP_URL_PATH);

        wp_add_inline_script(
            'solanapaykz-checkout',
            // JSON_HEX_TAG: результат вставляется внутрь тега <script> —
            // сейчас безопасно (значения не несут пользовательской разметки
            // с «</script»), но флаг стоит копейки и на будущее не помешает.
            'var solanapaykzData = ' . wp_json_encode([
                'url' => $request->url,
                'ajaxUrl' => $ajax_path,
                'action' => Ajax::ACTION,
                'orderId' => $order->get_id(),
                'orderKey' => $order->get_order_key(),
                'secondsLeft' => max(0, $quote->expires_at - time()),
                'intervalMs' => 5000,
            ], JSON_HEX_TAG) . ';',
            'before'
        );

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

            <p class="solanapaykz__timer" id="solanapaykz-timer" aria-live="polite"></p>

            <p class="solanapaykz__status" id="solanapaykz-status" role="status" aria-live="polite">
                Ожидаем оплату…
            </p>

            <p class="solanapaykz__link">
                <a href="<?php echo esc_url($request->url, ['solana']); ?>">Открыть в кошельке на этом устройстве</a>
            </p>

            <noscript>
                <p class="solanapaykz__hint">
                    В браузере отключён JavaScript: код QR и статус оплаты не отобразятся, а
                    страница не обновится сама после оплаты. Платёж всё равно можно отправить
                    по ссылке «Открыть в кошельке» выше — после оплаты обновите эту страницу
                    вручную, чтобы увидеть её текущий статус.
                </p>
            </noscript>
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
