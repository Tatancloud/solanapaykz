<?php
// demo-shop/plugin/includes/GatewaySettings.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;

/**
 * Настройки продавца и их проверка.
 *
 * Проверка вынесена из класса шлюза, чтобы её можно было покрыть тестами:
 * сам шлюз завязан на функции WordPress и в тестовом окружении не работает.
 *
 * Ошибки собираются списком, а не выбрасываются на первой: продавец должен
 * увидеть всё, что нужно исправить, за один заход.
 */
final class GatewaySettings
{
    /** Верхняя граница срока жизни котировки — сутки. */
    private const MAX_QUOTE_TTL = 86400;

    /** Верхняя граница окна проверки отменённых заказов — неделя. */
    private const MAX_LATE_WINDOW = 604800;

    /** Единственная валюта, для которой верен расчёт: курс берётся к тенге. */
    private const REQUIRED_CURRENCY = 'KZT';

    /**
     * Единственный список полей, которые идут в validate(), и их значений
     * по умолчанию — единственное место, которое их перечисляет.
     *
     * И Gateway (классическое оформление), и BlocksSupport (блочное) берут
     * список отсюда через collect_for_validation(), а не хранят собственную
     * копию: раньше каждый класс перечислял имена полей и умолчания сам, и
     * расхождение — забыли обновить одно из двух мест при добавлении новой
     * настройки — прошло бы молча: в одном оформлении настройка учлась бы,
     * в другом нет.
     *
     * @var array<string, string>
     */
    private const VALIDATION_FIELD_DEFAULTS = [
        'recipient' => '',
        'cluster' => 'devnet',
        'rpc_url' => '',
        'token' => 'USDC',
        'markup_percent' => '0',
        'quote_ttl' => '900',
        'late_window' => '86400',
    ];

    /**
     * Собирает значения настроек для validate() по единому списку полей и
     * умолчаний (см. VALIDATION_FIELD_DEFAULTS). $reader получает имя поля
     * и умолчание и возвращает значение — Gateway передаёт сюда
     * $this->get_option(...) экземпляра шлюза, BlocksSupport — чтение из
     * сырого массива $this->settings (wp_options). Источники разные, а
     * список имён и умолчаний — один на двоих.
     *
     * @param callable(string, string): mixed $reader
     * @return array<string, string>
     */
    public static function collect_for_validation(callable $reader): array
    {
        $values = [];

        foreach (self::VALIDATION_FIELD_DEFAULTS as $key => $default) {
            $values[$key] = (string) $reader($key, $default);
        }

        return $values;
    }

    /**
     * Валюта магазина передаётся аргументом, а не читается внутри через
     * get_woocommerce_currency(): эта функция WordPress недоступна в
     * тестовом окружении, а проверка настроек должна оставаться чистой
     * логикой без него.
     *
     * @param array<string, mixed> $values
     * @return list<string> Сообщения об ошибках на русском.
     */
    public static function validate(array $values, string $currency): array
    {
        $errors = [];

        if ($currency !== self::REQUIRED_CURRENCY) {
            // Молчаливая, но дорогая ошибка: единственный источник курса даёт
            // тенге за токен, и при другой валюте магазина сумма заказа
            // считается так, будто она уже в тенге — продавец недополучит
            // деньги в разы, и заметит это не раньше, чем сверит выручку.
            $errors[] = sprintf(
                /* translators: %s: store currency code, e.g. "USD" */
                __(
                    'This plugin is designed for stores priced in tenge, because the exchange rate is '
                    . 'quoted in tenge. Your store currency is currently "%s".',
                    'solanapaykz'
                ),
                $currency
            );
        }

        $cluster = (string) ($values['cluster'] ?? '');
        $token = (string) ($values['token'] ?? '');

        if (!in_array($cluster, ['mainnet', 'devnet'], true)) {
            $errors[] = __('Choose a network: mainnet or devnet (test network).', 'solanapaykz');
        }

        if (!in_array($token, Tokens::SUPPORTED, true)) {
            /* translators: %s: coin symbol, e.g. "BTC" */
            $errors[] = sprintf(__('Coin "%s" is not supported.', 'solanapaykz'), $token);
        }

        $errors = array_merge($errors, self::check_recipient(
            (string) ($values['recipient'] ?? ''),
            $cluster,
            $token
        ));

        $errors = array_merge($errors, self::check_rpc_url((string) ($values['rpc_url'] ?? '')));
        $errors = array_merge($errors, self::check_markup((string) ($values['markup_percent'] ?? '0')));

        $errors = array_merge($errors, self::check_seconds(
            (string) ($values['quote_ttl'] ?? ''),
            __('Quote lifetime', 'solanapaykz'),
            1,
            self::MAX_QUOTE_TTL
        ));

        $errors = array_merge($errors, self::check_seconds(
            (string) ($values['late_window'] ?? ''),
            __('Cancelled order check window', 'solanapaykz'),
            0,
            self::MAX_LATE_WINDOW
        ));

        return $errors;
    }

    /** @return list<string> */
    private static function check_recipient(string $recipient, string $cluster, string $token): array
    {
        if ($recipient === '') {
            return [__('Enter the Solana wallet address that will receive payments.', 'solanapaykz')];
        }

        // decode возвращает null на строке с недопустимыми символами, а не
        // бросает исключение — это его контракт из задачи 7.
        $decoded = Base58::decode($recipient);

        if ($decoded === null) {
            return [__(
                'The wallet address is in the wrong format: only base58 characters are allowed.',
                'solanapaykz'
            )];
        }

        if (strlen($decoded) !== 32) {
            return [__('The wallet address has the wrong length. Check that you copied it in full.', 'solanapaykz')];
        }

        // Адрес монеты в поле кошелька — частая ошибка настройки, и платежи
        // по нему уходят безвозвратно. Проверяем обе сети: продавец мог
        // переключить сеть уже после того, как вписал адрес.
        foreach (['mainnet', 'devnet'] as $known_cluster) {
            foreach (Tokens::SUPPORTED as $known_token) {
                try {
                    $mint = Tokens::resolve($known_cluster, $known_token)['mint'];
                } catch (Throwable) {
                    continue;
                }

                if ($mint !== null && $recipient === $mint) {
                    return [__(
                        'This is the coin\'s address, not a wallet address. Enter your own wallet '
                        . 'address — payments sent to the coin\'s address cannot be recovered.',
                        'solanapaykz'
                    )];
                }
            }
        }

        return [];
    }

    /** @return list<string> */
    private static function check_rpc_url(string $url): array
    {
        if ($url === '') {
            return [__(
                'Enter the Solana node URL. A public node is not suitable for accepting payments: '
                . 'it rate-limits requests and does not keep the history needed to find a payment.',
                'solanapaykz'
            )];
        }

        $parts = parse_url($url);

        if ($parts === false || !isset($parts['scheme'], $parts['host'])
            || !in_array($parts['scheme'], ['http', 'https'], true)
        ) {
            return [__('The node address must start with http:// or https://.', 'solanapaykz')];
        }

        return [];
    }

    /** @return list<string> */
    private static function check_markup(string $value): array
    {
        if (!is_numeric($value)) {
            return [__('Markup must be a number.', 'solanapaykz')];
        }

        $percent = (float) $value;

        if ($percent < 0 || $percent > 100) {
            return [__('Markup must be between 0 and 100 percent.', 'solanapaykz')];
        }

        // Меньше сотой доли процента округлится до нуля, и продавец будет
        // думать, что наценка работает.
        if ($percent > 0 && (int) round($percent * 100) === 0) {
            return [__(
                'A markup smaller than 0.01 percent has no effect. Enter a larger value or zero.',
                'solanapaykz'
            )];
        }

        return [];
    }

    /** @return list<string> */
    private static function check_seconds(string $value, string $label, int $min, int $max): array
    {
        if (!is_numeric($value) || (string) (int) $value !== trim($value)) {
            /* translators: %s: name of the setting being validated */
            return [sprintf(__('%s must be a whole number of seconds.', 'solanapaykz'), $label)];
        }

        $seconds = (int) $value;

        if ($seconds < $min || $seconds > $max) {
            return [sprintf(
                /* translators: 1: name of the setting, 2: minimum seconds, 3: maximum seconds */
                __('%1$s must be between %2$d and %3$d seconds.', 'solanapaykz'),
                $label,
                $min,
                $max
            )];
        }

        return [];
    }

    /**
     * Описание полей для админки WooCommerce.
     *
     * Валюта магазина передаётся аргументом (как в validate()), чтобы текст
     * информационного блока зависел от неё, и тесты могли проверять разные
     * валюты без функций WordPress.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function fields(string $currency = 'KZT'): array
    {
        return [
            'currency_notice' => self::build_currency_notice($currency),
            'enabled' => [
                'title' => __('Enable', 'solanapaykz'),
                'type' => 'checkbox',
                'label' => __('Accept cryptocurrency payments', 'solanapaykz'),
                'default' => 'no',
            ],
            'title' => [
                'title' => __('Payment method title', 'solanapaykz'),
                'type' => 'text',
                'description' => __('What the customer sees at checkout.', 'solanapaykz'),
                'default' => __('Pay with cryptocurrency (USDC)', 'solanapaykz'),
                'desc_tip' => true,
            ],
            'description' => [
                'title' => __('Description', 'solanapaykz'),
                'type' => 'textarea',
                'default' => __(
                    'Scan the QR code with a Solana wallet. Funds go directly to the seller.',
                    'solanapaykz'
                ),
            ],
            'recipient' => [
                'title' => __('Merchant wallet address', 'solanapaykz'),
                'type' => 'text',
                'description' => __(
                    'The Solana address that will receive payments. This is your wallet address, '
                    . 'not the coin address.',
                    'solanapaykz'
                ),
                'default' => '',
                'desc_tip' => true,
            ],
            'cluster' => [
                'title' => __('Network', 'solanapaykz'),
                'type' => 'select',
                'options' => [
                    'mainnet' => __('Mainnet (real money)', 'solanapaykz'),
                    'devnet' => __('Devnet (free test coins)', 'solanapaykz'),
                ],
                'default' => 'devnet',
                'description' => __(
                    'Start on the test network and switch to mainnet once you\'ve confirmed everything works.',
                    'solanapaykz'
                ),
                'desc_tip' => true,
            ],
            'rpc_url' => [
                'title' => __('Solana node URL', 'solanapaykz'),
                'type' => 'text',
                'description' => __(
                    'A public node is not suitable: it rate-limits requests and does not keep the '
                    . 'history needed to find a payment. You need your own provider.',
                    'solanapaykz'
                ),
                'default' => '',
                'desc_tip' => true,
            ],
            'token' => [
                'title' => __('Coin', 'solanapaykz'),
                'type' => 'select',
                'options' => ['USDC' => __('USDC (stablecoin)', 'solanapaykz'), 'SOL' => 'SOL'],
                'default' => 'USDC',
            ],
            'markup_percent' => [
                'title' => __('Markup, %', 'solanapaykz'),
                'type' => 'text',
                'description' => __(
                    'Added to the order total before converting to cryptocurrency. '
                    . 'Insurance against the rate moving while the customer is paying.',
                    'solanapaykz'
                ),
                'default' => '0',
                'desc_tip' => true,
            ],
            'quote_ttl' => [
                'title' => __('Price validity, seconds', 'solanapaykz'),
                'type' => 'text',
                'description' => __(
                    'How long the locked-in rate stays valid. 15 minutes by default.',
                    'solanapaykz'
                ),
                'default' => '900',
                'desc_tip' => true,
            ],
            'late_window' => [
                'title' => __('Check cancelled orders for, seconds', 'solanapaykz'),
                'type' => 'text',
                'description' => __(
                    'Cancelling an order does not cancel its QR code: the customer may still pay '
                    . 'later. For this long, the plugin keeps checking cancelled orders and warns '
                    . 'you about a late payment. Zero disables the check.',
                    'solanapaykz'
                ),
                'default' => '86400',
                'desc_tip' => true,
            ],
        ];
    }

    /**
     * Собирает информационный блок о поддержке валюты.
     *
     * @return array<string, string>
     */
    private static function build_currency_notice(string $currency): array
    {
        // htmlspecialchars(), а не esc_html(): валюта магазина в WooCommerce
        // всегда из закрытого списка кодов, эксплуатации тут нет, но класс
        // сознательно не зовёт функции WordPress ни в одном другом месте
        // (см. комментарий у validate()) — так его можно тестировать без
        // поднятия WordPress, и эта правка не должна быть исключением.
        $safe_currency = htmlspecialchars($currency, ENT_QUOTES, 'UTF-8');

        if ($currency === self::REQUIRED_CURRENCY) {
            return [
                'type' => 'title',
                'title' => __('Plugin status', 'solanapaykz'),
                'description' => sprintf(
                    /* translators: %s: store currency code */
                    __('Store currency: <strong>%s</strong> — the plugin works.', 'solanapaykz'),
                    $safe_currency
                ),
            ];
        }

        return [
            'type' => 'title',
            'title' => __('Plugin status', 'solanapaykz'),
            'description' => sprintf(
                /* translators: %s: store currency code */
                __(
                    'Store currency: <strong>%s</strong> — the plugin is disabled. '
                    . 'The exchange rate is quoted in tenge, so the store must price in tenge. '
                    . 'Change the currency in WooCommerce settings: Settings → General → Currency.',
                    'solanapaykz'
                ),
                $safe_currency
            ),
        ];
    }
}
