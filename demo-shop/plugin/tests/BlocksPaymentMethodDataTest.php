<?php
// demo-shop/plugin/tests/BlocksPaymentMethodDataTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\BlocksPaymentMethodData;

/**
 * BlocksSupport (реальный класс регистрации в блочном оформлении заказа)
 * нельзя создать в этом тестовом окружении: он наследует класс WooCommerce
 * Blocks, которого здесь нет. Поэтому тестируем то, что из-под него вынесено
 * в чистый PHP: правило видимости способа оплаты и состав данных для
 * браузера. Полную отрисовку в блочном оформлении проверяет живой браузер.
 */
final class BlocksPaymentMethodDataTest extends TestCase
{
    private const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

    /** @return array<string, string> */
    private function valid_settings(array $overrides = []): array
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

    public function test_активен_при_включённом_шлюзе_валидных_настройках_и_валюте_тенге(): void
    {
        self::assertTrue(
            BlocksPaymentMethodData::is_active(true, $this->valid_settings(), 'KZT')
        );
    }

    public function test_не_активен_если_продавец_не_включил_приём_оплаты(): void
    {
        // Настройки валидны, но галочка «Включить» снята — способ оплаты
        // не должен появиться ни в классическом, ни в блочном оформлении.
        self::assertFalse(
            BlocksPaymentMethodData::is_active(false, $this->valid_settings(), 'KZT')
        );
    }

    public function test_не_активен_если_валюта_магазина_не_тенге(): void
    {
        // Курс берётся только к тенге — при другой валюте магазина заказ
        // считался бы так, будто сумма уже в тенге, и продавец недополучил
        // бы деньги в разы. Ровно та же проверка, что в классическом
        // оформлении (Gateway::is_available()), обязана работать и здесь.
        self::assertFalse(
            BlocksPaymentMethodData::is_active(true, $this->valid_settings(), 'USD')
        );
    }

    public function test_не_активен_при_невалидных_настройках_даже_если_шлюз_включён(): void
    {
        // Пустой адрес кошелька — способ оплаты неработоспособен, значит
        // не должен появляться и в блочном оформлении.
        self::assertFalse(
            BlocksPaymentMethodData::is_active(true, $this->valid_settings(['recipient' => '']), 'KZT')
        );
    }

    public function test_данные_для_браузера_содержат_название_и_описание_из_настроек(): void
    {
        $data = BlocksPaymentMethodData::payment_method_data(
            'Оплата криптовалютой (USDC)',
            'Отсканируйте QR-код кошельком Solana.'
        );

        self::assertSame('Оплата криптовалютой (USDC)', $data['title']);
        self::assertSame('Отсканируйте QR-код кошельком Solana.', $data['description']);
    }

    public function test_данные_для_браузера_не_подменяют_пустое_описание_заглушкой(): void
    {
        // Пустая строка — тоже осознанный выбор продавца (снял описание в
        // настройках), а не повод для выдуманного текста от плагина.
        $data = BlocksPaymentMethodData::payment_method_data('Название', '');

        self::assertSame('', $data['description']);
    }

    public function test_данные_для_браузера_объявляют_поддержку_только_обычных_товаров(): void
    {
        // Тот же список возможностей, что и у классического шлюза
        // (Gateway::$supports = ['products']): ни подписок, ни повторных
        // списаний плагин не умеет.
        $data = BlocksPaymentMethodData::payment_method_data('Название', 'Описание');

        self::assertSame(['products'], $data['supports']);
    }
}
