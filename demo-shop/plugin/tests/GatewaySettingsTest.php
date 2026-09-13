<?php
// demo-shop/plugin/tests/GatewaySettingsTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\GatewaySettings;

final class GatewaySettingsTest extends TestCase
{
    private const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    private const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    // Валюта, для которой рассчитан плагин: курс берётся только к тенге.
    // Функция get_woocommerce_currency() в тестовом окружении недоступна,
    // поэтому валюта передаётся в validate() отдельным аргументом.
    private const CURRENCY = 'KZT';

    /** @return array<string, string> */
    private function valid(array $overrides = []): array
    {
        return array_merge([
            'recipient'      => self::MERCHANT,
            'cluster'        => 'mainnet',
            'rpc_url'        => 'https://rpc.example.com',
            'token'          => 'USDC',
            'markup_percent' => '0',
            'quote_ttl'      => '900',
            'late_window'    => '86400',
        ], $overrides);
    }

    public function test_верные_настройки_не_дают_ошибок(): void
    {
        self::assertSame([], GatewaySettings::validate($this->valid(), self::CURRENCY));
    }

    public function test_требует_адрес_продавца(): void
    {
        $errors = GatewaySettings::validate($this->valid(['recipient' => '']), self::CURRENCY);

        self::assertCount(1, $errors);
        self::assertStringContainsString('address', mb_strtolower($errors[0]));
    }

    public function test_отвергает_адрес_неверной_длины_в_байтах(): void
    {
        // Строка из допустимых символов правильной длины может не быть
        // адресом: настоящий адрес Solana — ровно 32 байта.
        $errors = GatewaySettings::validate($this->valid(['recipient' => str_repeat('z', 44)]), self::CURRENCY);

        self::assertCount(1, $errors);
    }

    public function test_отвергает_адрес_монеты_вместо_кошелька(): void
    {
        // Частая ошибка настройки: платежи по такому адресу уходят безвозвратно.
        $errors = GatewaySettings::validate($this->valid(['recipient' => self::USDC_MINT]), self::CURRENCY);

        self::assertCount(1, $errors);
        self::assertStringContainsString('coin', mb_strtolower($errors[0]));
    }

    public function test_адрес_монеты_другой_сети_тоже_отвергается(): void
    {
        $errors = GatewaySettings::validate($this->valid([
            'cluster' => 'devnet',
            'recipient' => '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        ]), self::CURRENCY);

        self::assertCount(1, $errors);
    }

    public function test_требует_адрес_узла(): void
    {
        $errors = GatewaySettings::validate($this->valid(['rpc_url' => '']), self::CURRENCY);

        self::assertCount(1, $errors);
        self::assertStringContainsString('node', mb_strtolower($errors[0]));
    }

    public function test_отвергает_адрес_узла_не_похожий_на_ссылку(): void
    {
        foreach (['не-ссылка', 'ftp://узел', 'httpsx://a.b', '//rpc.example.com'] as $bad) {
            $errors = GatewaySettings::validate($this->valid(['rpc_url' => $bad]), self::CURRENCY);

            self::assertNotSame([], $errors, "Адрес «{$bad}» должен быть отвергнут.");
        }
    }

    public function test_принимает_адрес_узла_по_http_и_https(): void
    {
        foreach (['https://rpc.example.com', 'http://127.0.0.1:8899'] as $good) {
            self::assertSame([], GatewaySettings::validate($this->valid(['rpc_url' => $good]), self::CURRENCY));
        }
    }

    public function test_отвергает_неизвестную_сеть(): void
    {
        self::assertNotSame([], GatewaySettings::validate($this->valid(['cluster' => 'testnet']), self::CURRENCY));
    }

    public function test_отвергает_неизвестную_монету(): void
    {
        self::assertNotSame([], GatewaySettings::validate($this->valid(['token' => 'BTC']), self::CURRENCY));
    }

    public function test_отвергает_наценку_вне_допустимых_границ(): void
    {
        foreach (['-1', '101', 'не-число'] as $bad) {
            self::assertNotSame([], GatewaySettings::validate($this->valid(['markup_percent' => $bad]), self::CURRENCY));
        }
    }

    public function test_принимает_дробную_наценку(): void
    {
        self::assertSame([], GatewaySettings::validate($this->valid(['markup_percent' => '2.5']), self::CURRENCY));
    }

    public function test_отвергает_наценку_меньше_минимального_шага(): void
    {
        // 0,004 процента после округления превращается в ноль: продавец
        // настроит наценку и не заметит, что её нет.
        self::assertNotSame([], GatewaySettings::validate($this->valid(['markup_percent' => '0.004']), self::CURRENCY));
    }

    public function test_отвергает_срок_жизни_котировки_вне_разумных_границ(): void
    {
        foreach (['0', '-60', '90000', 'не-число'] as $bad) {
            self::assertNotSame([], GatewaySettings::validate($this->valid(['quote_ttl' => $bad]), self::CURRENCY));
        }
    }

    public function test_принимает_срок_действия_котировки_на_верхней_границе(): void
    {
        // Ровно сутки — ещё допустимое значение, а не «больше границы».
        self::assertSame([], GatewaySettings::validate($this->valid(['quote_ttl' => '86400']), self::CURRENCY));
    }

    public function test_ноль_в_сроке_проверки_отменённых_допустим(): void
    {
        // Ноль означает «не проверять отменённые заказы» — осознанный выбор
        // продавца, а не ошибка.
        self::assertSame([], GatewaySettings::validate($this->valid(['late_window' => '0']), self::CURRENCY));
    }

    public function test_принимает_срок_проверки_отменённых_на_верхней_границе(): void
    {
        // Ровно неделя — ещё допустимое значение, а не «больше границы».
        self::assertSame([], GatewaySettings::validate($this->valid(['late_window' => '604800']), self::CURRENCY));
    }

    public function test_отвергает_валюту_магазина_не_тенге(): void
    {
        // Курс берётся только к тенге: магазин в другой валюте посчитает
        // сумму заказа как тенге и недоплатит продавцу в разы. Молча этого
        // не спустить.
        $errors = GatewaySettings::validate($this->valid(), 'USD');

        self::assertCount(1, $errors);
        self::assertStringContainsString('tenge', mb_strtolower($errors[0]));
    }

    public function test_собирает_все_ошибки_а_не_первую(): void
    {
        $errors = GatewaySettings::validate([
            'recipient' => '',
            'cluster' => 'testnet',
            'rpc_url' => '',
            'token' => 'BTC',
            'markup_percent' => '200',
            'quote_ttl' => '0',
            'late_window' => '-1',
        ], self::CURRENCY);

        // Продавец должен увидеть весь список сразу, а не исправлять по одной.
        self::assertGreaterThanOrEqual(5, count($errors));
    }

    public function test_описание_полей_содержит_все_настройки(): void
    {
        $fields = GatewaySettings::fields(self::CURRENCY);

        foreach (['enabled', 'title', 'description', 'recipient', 'cluster',
                  'rpc_url', 'token', 'markup_percent', 'quote_ttl', 'late_window'] as $key) {
            self::assertArrayHasKey($key, $fields);
        }
    }

    public function test_при_валюте_тенге_блок_информации_говорит_что_плагин_работает(): void
    {
        $fields = GatewaySettings::fields('KZT');

        // Первое поле должно быть информационный блок типа 'title'
        $keys = array_keys($fields);
        self::assertSame('currency_notice', $keys[0]);
        self::assertSame('title', $fields['currency_notice']['type']);

        // Текст должен содержать "работает" и указание валюты
        self::assertStringContainsString('works', mb_strtolower($fields['currency_notice']['description']));
        self::assertStringContainsString('kzt', mb_strtolower($fields['currency_notice']['description']));
    }

    public function test_при_валюте_не_тенге_блок_информации_говорит_что_плагин_отключён(): void
    {
        $fields = GatewaySettings::fields('USD');

        // Первое поле должно быть информационный блок типа 'title'
        $keys = array_keys($fields);
        self::assertSame('currency_notice', $keys[0]);
        self::assertSame('title', $fields['currency_notice']['type']);

        // Текст должен содержать "отключён" и название валюты
        $description = mb_strtolower($fields['currency_notice']['description']);
        self::assertStringContainsString('disabled', $description);
        self::assertStringContainsString('usd', $description);
    }

    public function test_при_валюте_евро_блок_информации_указывает_евро(): void
    {
        $fields = GatewaySettings::fields('EUR');

        $description = mb_strtolower($fields['currency_notice']['description']);
        self::assertStringContainsString('eur', $description);
    }

    /**
     * Gateway (классическое оформление) и BlocksSupport (блочное) берут
     * список полей для validate() из одного места —
     * collect_for_validation() — вместо собственных копий. Проверяем, что
     * этот общий список не разошёлся с полями, которые продавец видит в
     * форме настроек: раньше расхождение было бы молчаливым — в одном
     * оформлении новая настройка учлась бы, в другом нет.
     */
    public function test_список_полей_для_валидации_совпадает_с_полями_формы(): void
    {
        // Читатель просто возвращает умолчание — нас интересует только
        // набор ключей, а не конкретные значения.
        $validation_keys = array_keys(GatewaySettings::collect_for_validation(
            static fn (string $key, string $default): string => $default
        ));

        // Поля формы, которые не участвуют в проверке настроек: чекбокс
        // включения, информационный блок про валюту и текстовые поля
        // названия/описания, которые видит только покупатель.
        $non_validation_fields = ['currency_notice', 'enabled', 'title', 'description'];
        $form_keys = array_values(array_diff(array_keys(GatewaySettings::fields('KZT')), $non_validation_fields));

        sort($validation_keys);
        sort($form_keys);

        self::assertSame(
            $form_keys,
            $validation_keys,
            'Список полей для validate() разошёлся со списком настроек формы — значит, '
            . 'классическое и блочное оформление увидят разный набор настроек.'
        );
    }

    /**
     * Умолчания для validate() должны совпадать с умолчаниями, которые
     * продавец видит в форме настроек (GatewaySettings::fields()) — иначе
     * до первого сохранения формы шлюз считал бы настройку по одному
     * значению, а форма показывала бы продавцу другое.
     */
    public function test_умолчания_для_валидации_совпадают_с_умолчаниями_формы(): void
    {
        $validation_defaults = GatewaySettings::collect_for_validation(
            static fn (string $key, string $default): string => $default
        );
        $fields = GatewaySettings::fields('KZT');

        foreach ($validation_defaults as $key => $default) {
            self::assertSame(
                $fields[$key]['default'],
                $default,
                "Умолчание поля «{$key}» для validate() разошлось с умолчанием в форме продавца."
            );
        }
    }
}
