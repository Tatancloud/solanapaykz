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

    /**
     * @param array<string, mixed> $values
     * @return list<string> Сообщения об ошибках на русском.
     */
    public static function validate(array $values): array
    {
        $errors = [];

        $cluster = (string) ($values['cluster'] ?? '');
        $token = (string) ($values['token'] ?? '');

        if (!in_array($cluster, ['mainnet', 'devnet'], true)) {
            $errors[] = 'Выберите сеть: основную или тестовую.';
        }

        if (!in_array($token, Tokens::SUPPORTED, true)) {
            $errors[] = sprintf('Монета «%s» не поддерживается.', $token);
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
            'Срок жизни котировки',
            1,
            self::MAX_QUOTE_TTL
        ));

        $errors = array_merge($errors, self::check_seconds(
            (string) ($values['late_window'] ?? ''),
            'Срок проверки отменённых заказов',
            0,
            self::MAX_LATE_WINDOW
        ));

        return $errors;
    }

    /** @return list<string> */
    private static function check_recipient(string $recipient, string $cluster, string $token): array
    {
        if ($recipient === '') {
            return ['Укажите адрес кошелька Solana, на который будут приходить платежи.'];
        }

        // decode возвращает null на строке с недопустимыми символами, а не
        // бросает исключение — это его контракт из задачи 7.
        $decoded = Base58::decode($recipient);

        if ($decoded === null) {
            return ['Адрес кошелька записан не в том формате: допустимы только символы base58.'];
        }

        if (strlen($decoded) !== 32) {
            return ['Адрес кошелька неверной длины. Проверьте, что скопировали его целиком.'];
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
                    return ['Это адрес монеты, а не кошелька. Укажите адрес своего кошелька — '
                        . 'платежи на адрес монеты вернуть невозможно.'];
                }
            }
        }

        return [];
    }

    /** @return list<string> */
    private static function check_rpc_url(string $url): array
    {
        if ($url === '') {
            return ['Укажите адрес узла Solana. Публичный узел для приёма платежей не подходит: '
                . 'он ограничивает запросы и не хранит историю, нужную для поиска платежа.'];
        }

        $parts = parse_url($url);

        if ($parts === false || !isset($parts['scheme'], $parts['host'])
            || !in_array($parts['scheme'], ['http', 'https'], true)
        ) {
            return ['Адрес узла должен начинаться с http:// или https://.'];
        }

        return [];
    }

    /** @return list<string> */
    private static function check_markup(string $value): array
    {
        if (!is_numeric($value)) {
            return ['Наценка должна быть числом.'];
        }

        $percent = (float) $value;

        if ($percent < 0 || $percent > 100) {
            return ['Наценка должна быть от 0 до 100 процентов.'];
        }

        // Меньше сотой доли процента округлится до нуля, и продавец будет
        // думать, что наценка работает.
        if ($percent > 0 && (int) round($percent * 100) === 0) {
            return ['Наценка меньше 0,01 процента не применяется. Укажите большее значение или ноль.'];
        }

        return [];
    }

    /** @return list<string> */
    private static function check_seconds(string $value, string $label, int $min, int $max): array
    {
        if (!is_numeric($value) || (string) (int) $value !== trim($value)) {
            return [sprintf('%s должен быть целым числом секунд.', $label)];
        }

        $seconds = (int) $value;

        if ($seconds < $min || $seconds > $max) {
            return [sprintf('%s должен быть от %d до %d секунд.', $label, $min, $max)];
        }

        return [];
    }

    /**
     * Описание полей для админки WooCommerce.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function fields(): array
    {
        return [
            'enabled' => [
                'title' => 'Включить',
                'type' => 'checkbox',
                'label' => 'Принимать оплату криптовалютой',
                'default' => 'no',
            ],
            'title' => [
                'title' => 'Название способа оплаты',
                'type' => 'text',
                'description' => 'Что увидит покупатель при оформлении заказа.',
                'default' => 'Оплата криптовалютой (USDC)',
                'desc_tip' => true,
            ],
            'description' => [
                'title' => 'Описание',
                'type' => 'textarea',
                'default' => 'Отсканируйте QR-код кошельком Solana. Деньги придут продавцу напрямую.',
            ],
            'recipient' => [
                'title' => 'Адрес кошелька продавца',
                'type' => 'text',
                'description' => 'Адрес Solana, на который придут платежи. Это адрес вашего кошелька, '
                    . 'а не адрес монеты.',
                'default' => '',
                'desc_tip' => true,
            ],
            'cluster' => [
                'title' => 'Сеть',
                'type' => 'select',
                'options' => [
                    'mainnet' => 'Основная сеть (настоящие деньги)',
                    'devnet' => 'Тестовая сеть (бесплатные монеты, для проверки)',
                ],
                'default' => 'devnet',
                'description' => 'Начните с тестовой сети и переключитесь на основную, '
                    . 'когда убедитесь, что всё работает.',
                'desc_tip' => true,
            ],
            'rpc_url' => [
                'title' => 'Адрес узла Solana',
                'type' => 'text',
                'description' => 'Публичный узел не подходит: он ограничивает запросы и не хранит '
                    . 'историю, нужную для поиска платежа. Нужен собственный провайдер.',
                'default' => '',
                'desc_tip' => true,
            ],
            'token' => [
                'title' => 'Монета',
                'type' => 'select',
                'options' => ['USDC' => 'USDC (стейблкоин)', 'SOL' => 'SOL'],
                'default' => 'USDC',
            ],
            'markup_percent' => [
                'title' => 'Наценка, %',
                'type' => 'text',
                'description' => 'Добавляется к сумме заказа до пересчёта в криптовалюту. '
                    . 'Страховка от движения курса, пока покупатель платит.',
                'default' => '0',
                'desc_tip' => true,
            ],
            'quote_ttl' => [
                'title' => 'Срок действия цены, секунд',
                'type' => 'text',
                'description' => 'Сколько времени действует зафиксированный курс. По умолчанию 15 минут.',
                'default' => '900',
                'desc_tip' => true,
            ],
            'late_window' => [
                'title' => 'Проверять отменённые заказы, секунд',
                'type' => 'text',
                'description' => 'Отмена заказа не отменяет QR-код: покупатель может заплатить позже. '
                    . 'В течение этого времени плагин продолжит проверять отменённые заказы и '
                    . 'предупредит вас о позднем платеже. Ноль отключает проверку.',
                'default' => '86400',
                'desc_tip' => true,
            ],
        ];
    }
}
