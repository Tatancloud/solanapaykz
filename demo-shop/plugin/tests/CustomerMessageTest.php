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
}
