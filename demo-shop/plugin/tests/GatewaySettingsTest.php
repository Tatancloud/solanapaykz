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
        self::assertStringContainsString('адрес', mb_strtolower($errors[0]));
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
        self::assertStringContainsString('монет', mb_strtolower($errors[0]));
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
        self::assertStringContainsString('узл', mb_strtolower($errors[0]));
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
        self::assertStringContainsString('тенге', mb_strtolower($errors[0]));
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
        $fields = GatewaySettings::fields();

        foreach (['enabled', 'title', 'description', 'recipient', 'cluster',
                  'rpc_url', 'token', 'markup_percent', 'quote_ttl', 'late_window'] as $key) {
            self::assertArrayHasKey($key, $fields);
        }
    }
}
