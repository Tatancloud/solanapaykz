<?php
// demo-shop/plugin/tests/TokensTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\QuoteException;
use SolanaPayKZ\Tokens;

final class TokensTest extends TestCase
{
    public function test_usdc_в_основной_сети(): void
    {
        $token = Tokens::resolve('mainnet', 'USDC');

        self::assertSame('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', $token['mint']);
        self::assertSame(6, $token['decimals']);
    }

    public function test_usdc_в_тестовой_сети_имеет_другой_адрес(): void
    {
        self::assertSame(
            '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            Tokens::resolve('devnet', 'USDC')['mint']
        );
    }

    public function test_у_нативного_sol_нет_адреса_монеты(): void
    {
        $token = Tokens::resolve('mainnet', 'SOL');

        self::assertNull($token['mint']);
        self::assertSame(9, $token['decimals']);
    }

    public function test_отвергает_неизвестный_токен(): void
    {
        $this->expectException(QuoteException::class);
        Tokens::resolve('mainnet', 'BTC');
    }

    public function test_отвергает_неизвестную_сеть(): void
    {
        $this->expectException(QuoteException::class);
        Tokens::resolve('testnet', 'USDC');
    }
}
