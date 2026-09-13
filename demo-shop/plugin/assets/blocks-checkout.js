// demo-shop/plugin/assets/blocks-checkout.js
//
// Регистрация способа оплаты SolanaPay-KZ в блочном оформлении заказа
// WooCommerce (Cart & Checkout blocks) — умолчание для новых установок.
// Без этого файла способ оплаты доступен только в классическом
// оформлении: блочное оформление не подхватывает шлюзы WooCommerce
// автоматически, ему нужна отдельная регистрация через
// window.wc.wcBlocksRegistry.registerPaymentMethod (см. BlocksSupport.php).
//
// У плагина нет сборки JavaScript, и заводить её не нужно: пишем на
// обычном JavaScript через wp.element.createElement, без JSX и без шага
// сборки — одна из ценностей плагина в том, что он ставится копированием
// папки.
(function () {
    'use strict';

    var registry = window.wc && window.wc.wcBlocksRegistry;
    var settingsApi = window.wc && window.wc.wcSettings;
    var element = window.wp && window.wp.element;

    // Любой из трёх глобальных объектов может отсутствовать на старой
    // версии WooCommerce Blocks или при поломке порядка подключения
    // скриптов — тогда просто не регистрируем способ оплаты, а не падаем
    // с ошибкой в консоли покупателя посреди страницы оформления.
    if (!registry || !settingsApi || !element) {
        return;
    }

    var h = element.createElement;

    // wp-i18n подключён как зависимость скрипта (см.
    // BlocksSupport::get_payment_method_script_handles()), а перевод строк —
    // через wp_set_script_translations(). В норме defaultTitle никогда не
    // используется: сервер уже проверил доступность способа оплаты и прислал
    // настоящее название (см. is_active() и его вызов ниже), но на случай,
    // если данные всё же не пришли, показываем английский исходник, а не
    // падаем без wp-i18n.
    var i18n = window.wp && window.wp.i18n;
    var __ = i18n ? i18n.__ : function (text) { return text; };

    // 'solanapaykz' — id способа оплаты: BlocksSupport::$name в PHP,
    // тот же, что и Gateway::$id. Второй аргумент — данные по умолчанию
    // на случай, если сервер почему-то не прислал их.
    var data = settingsApi.getPaymentMethodData('solanapaykz', {});

    var defaultTitle = __('Pay with cryptocurrency (USDC)', 'solanapaykz');
    var title = data.title || defaultTitle;
    var description = data.description || '';

    // Название способа оплаты в списке методов на странице оформления.
    function Label() {
        return h('span', null, title);
    }

    // Пояснение под способом оплаты. Пустая строка в настройках —
    // осознанный выбор продавца (снял описание), тогда не рисуем ничего,
    // а не пустой абзац.
    function Content() {
        if (!description) {
            return null;
        }

        return h('p', { className: 'solanapaykz-blocks__description' }, description);
    }

    registry.registerPaymentMethod({
        name: 'solanapaykz',
        label: h(Label),
        content: h(Content),
        edit: h(Content),
        // Валюту магазина и корректность настроек уже проверил сервер в
        // BlocksSupport::is_active(): если бы способ оплаты был недоступен,
        // WooCommerce не подключил бы этот скрипт и не прислал бы data.
        // Дополнительных условий здесь нет.
        canMakePayment: function () {
            return true;
        },
        ariaLabel: title,
        supports: {
            features: data.supports || ['products']
        }
    });
})();
