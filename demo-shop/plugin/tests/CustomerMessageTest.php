<?php
// demo-shop/plugin/tests/CustomerMessageTest.php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use SolanaPayKZ\CustomerMessage;

final class CustomerMessageTest extends TestCase
{
    public function test_qr_показывается_только_на_ожидающем_оплаты_заказе(): void
    {
        self::assertTrue(CustomerMessage::should_show_qr('pending'));

        foreach (['processing', 'completed', 'cancelled', 'on-hold', 'refunded', 'failed', 'checkout-draft'] as $status) {
            self::assertFalse(CustomerMessage::should_show_qr($status), "Статус «{$status}» не должен показывать QR.");
        }
    }

    public function test_текст_для_ожидающего_оплаты_заказа(): void
    {
        $view = CustomerMessage::for_order_status('pending');

        self::assertSame('pending', $view['status']);
    }

    #[DataProvider('paid_statuses')]
    public function test_текст_для_оплаченного_заказа(string $status): void
    {
        $view = CustomerMessage::for_order_status($status);

        self::assertSame('paid', $view['status']);
        self::assertStringContainsString('оплат', mb_strtolower($view['message']));
    }

    /** @return list<array{string}> */
    public static function paid_statuses(): array
    {
        return [['processing'], ['completed']];
    }

    public function test_текст_для_отменённого_заказа(): void
    {
        $view = CustomerMessage::for_order_status('cancelled');

        self::assertSame('expired', $view['status']);
        self::assertStringContainsString('отменён', mb_strtolower($view['message']));
    }

    public function test_текст_для_заказа_на_удержании(): void
    {
        $view = CustomerMessage::for_order_status('on-hold');

        self::assertSame('mismatch', $view['status']);
        self::assertStringContainsString('вручную', mb_strtolower($view['message']));
    }

    public function test_текст_для_неизвестного_статуса_нейтральный(): void
    {
        $view = CustomerMessage::for_order_status('checkout-draft');

        self::assertNotSame('pending', $view['status']);
        self::assertNotSame('', $view['message']);
    }

    // --- for_decision(): ответ AJAX-опроса. Действие «wait» не должно
    // выглядеть одинаково для оплаченного, отменённого и удерживаемого
    // заказа — иначе покупатель с открытой вкладкой не узнает, что заказ
    // сменил статус, пока он ждал. ---

    public function test_решение_complete_сообщает_об_оплате_независимо_от_статуса_заказа(): void
    {
        $view = CustomerMessage::for_decision('complete', 'pending');

        self::assertSame('paid', $view['status']);
    }

    public function test_решение_wait_на_обработанном_заказе_сообщает_об_оплате(): void
    {
        // Заказ уже переведён в processing (например, крон опередил вкладку
        // покупателя), а текущая проверка ничего нового не решила («wait»).
        // Ответ должен отражать то, что есть сейчас, а не молчать об этом.
        $view = CustomerMessage::for_decision('wait', 'processing');

        self::assertSame('paid', $view['status']);
    }

    public function test_решение_wait_на_отменённом_заказе_сообщает_об_отмене(): void
    {
        $view = CustomerMessage::for_decision('wait', 'cancelled');

        self::assertSame('expired', $view['status']);
    }

    public function test_решение_wait_на_удержании_сообщает_о_ручной_проверке(): void
    {
        $view = CustomerMessage::for_decision('wait', 'on-hold');

        self::assertSame('mismatch', $view['status']);
    }

    public function test_решение_wait_на_pending_заказе_ждём(): void
    {
        $view = CustomerMessage::for_decision('wait', 'pending');

        self::assertSame('pending', $view['status']);
    }
}
