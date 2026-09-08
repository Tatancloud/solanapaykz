<?php
// demo-shop/plugin/tests/PaymentDecisionTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Cache;
use SolanaPayKZ\PaymentDecision;
use SolanaPayKZ\Quote;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;

final class PaymentDecisionTest extends TestCase
{
    private const DAY = 86400;

    private function quote(): Quote
    {
        $source = new class implements RateSource {
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string { return '459.60000000'; }
        };

        $cache = new class implements Cache {
            public function get(string $key): ?string { return null; }
            public function set(string $key, string $value, int $ttl_seconds): void {}
        };

        return Quote::create(new RateProvider([$source], $cache, 0), '10000', 'USDC', 'mainnet');
    }

    public function test_платежа_нет_котировка_жива_ждём(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'pending'],
            $quote,
            'pending',
            self::DAY,
            $quote->created_at + 60
        );

        self::assertSame('wait', $decision['action']);
    }

    public function test_платежа_нет_срок_вышел_отменяем(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'pending'],
            $quote,
            'pending',
            self::DAY,
            $quote->expires_at + 1
        );

        self::assertSame('cancel', $decision['action']);
        self::assertStringContainsString('срок', mb_strtolower($decision['note']));
    }

    public function test_платёж_подтверждён_завершаем_заказ(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'confirmed', 'signature' => 'подпись123', 'received_units' => '21758051'],
            $quote,
            'pending',
            self::DAY,
            $quote->created_at + 60
        );

        self::assertSame('complete', $decision['action']);
        self::assertStringContainsString('подпись123', $decision['note']);
    }

    public function test_платёж_после_истечения_срока_всё_равно_засчитывается(): void
    {
        // Транзакция в блокчейне необратима: отменить её плагин не может.
        // Деньги пришли — значит заказ оплачен, решение о судьбе принимает продавец.
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'confirmed', 'signature' => 'подпись', 'received_units' => '21758051'],
            $quote,
            'pending',
            self::DAY,
            $quote->expires_at + 600
        );

        self::assertSame('complete', $decision['action']);
    }

    public function test_платёж_на_отменённый_заказ_в_окне_уведомляем_продавца(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'confirmed', 'signature' => 'поздняя', 'received_units' => '21758051'],
            $quote,
            'cancelled',
            self::DAY,
            $quote->expires_at + 3600
        );

        self::assertSame('late', $decision['action']);
        self::assertStringContainsString('отменённ', mb_strtolower($decision['note']));
        self::assertStringContainsString('поздняя', $decision['note']);
    }

    public function test_платёж_на_отменённый_заказ_вне_окна_не_трогаем(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'confirmed', 'signature' => 'очень поздняя', 'received_units' => '21758051'],
            $quote,
            'cancelled',
            self::DAY,
            $quote->created_at + self::DAY * 3
        );

        self::assertSame('wait', $decision['action']);
    }

    public function test_окно_ноль_отключает_проверку_отменённых(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'confirmed', 'signature' => 'поздняя', 'received_units' => '21758051'],
            $quote,
            'cancelled',
            0,
            $quote->expires_at + 60
        );

        self::assertSame('wait', $decision['action']);
    }

    public function test_несовпадение_платежа_переводим_на_удержание(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'mismatch', 'signature' => 'подозрительная', 'reason' => 'Сумма меньше ожидаемой.'],
            $quote,
            'pending',
            self::DAY,
            $quote->created_at + 60
        );

        self::assertSame('hold', $decision['action']);
        self::assertStringContainsString('Сумма меньше ожидаемой', $decision['note']);
        self::assertStringContainsString('подозрительная', $decision['note']);
    }

    public function test_уже_оплаченный_заказ_не_трогаем(): void
    {
        // Повторный опрос не должен переоформлять заказ, который уже
        // переведён в обработку: продавец мог начать его собирать.
        $quote = $this->quote();

        foreach (['processing', 'completed', 'refunded'] as $status) {
            $decision = PaymentDecision::decide(
                ['status' => 'confirmed', 'signature' => 'подпись', 'received_units' => '21758051'],
                $quote,
                $status,
                self::DAY,
                $quote->created_at + 60
            );

            self::assertSame('wait', $decision['action'], "Статус «{$status}» трогать нельзя.");
        }
    }

    public function test_заказ_на_удержании_повторно_не_переводим(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'mismatch', 'signature' => 'подпись', 'reason' => 'что-то не так'],
            $quote,
            'on-hold',
            self::DAY,
            $quote->created_at + 60
        );

        self::assertSame('wait', $decision['action']);
    }

    public function test_неизвестный_статус_проверки_не_меняет_заказ(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'что-то новое'],
            $quote,
            'pending',
            self::DAY,
            $quote->created_at + 60
        );

        self::assertSame('wait', $decision['action']);
    }

    public function test_неизвестный_статус_заказа_не_завершается_подтверждённым_платежом(): void
    {
        // Список «действовать только на pending/cancelled», а не «не трогать
        // processing/completed/...»: кастомный статус другого плагина или
        // новый статус самого WooCommerce не должен провалиться в общую
        // логику завершения заказа.
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'confirmed', 'signature' => 'подпись', 'received_units' => '21758051'],
            $quote,
            'checkout-draft',
            self::DAY,
            $quote->created_at + 60
        );

        self::assertSame('wait', $decision['action']);
    }

    public function test_неизвестный_статус_заказа_не_отменяется_по_истечении_срока(): void
    {
        $quote = $this->quote();
        $decision = PaymentDecision::decide(
            ['status' => 'pending'],
            $quote,
            'checkout-draft',
            self::DAY,
            $quote->expires_at + 1
        );

        self::assertSame('wait', $decision['action']);
    }
}
