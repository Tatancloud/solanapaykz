<?php
// demo-shop/plugin/tests/VerifyTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\SolanaChain;
use SolanaPayKZ\Verify;

final class VerifyTest extends TestCase
{
    private const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    /** @return array<string, mixed> */
    private function fixture(string $name): array
    {
        $path = __DIR__ . '/fixtures/' . $name . '.json';
        $data = json_decode((string) file_get_contents($path), true);

        return $data['result'];
    }

    private function chain_returning(array $signatures, ?array $transaction): SolanaChain
    {
        $chain = $this->createMock(SolanaChain::class);
        $chain->method('get_signatures_for_address')->willReturn($signatures);
        $chain->method('get_transaction')->willReturn($transaction);

        return $chain;
    }

    public function test_без_транзакции_возвращает_pending(): void
    {
        $verify = new Verify($this->chain_returning([], null));
        $result = $verify->check('Метка', 'Продавец', self::USDC, '1000000');

        self::assertSame('pending', $result['status']);
    }

    public function test_провалившаяся_транзакция_не_считается_оплатой(): void
    {
        // Из реального блока mainnet: 20 из 48 транзакций с USDC были такими.
        $tx = $this->fixture('tx-failed-usdc');
        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));

        $result = $verify->check('Метка', 'Продавец', self::USDC, '1');

        self::assertSame('mismatch', $result['status']);
        self::assertStringContainsString('ошибк', mb_strtolower((string) $result['reason']));
    }

    public function test_успешная_транзакция_подтверждается(): void
    {
        $tx = $this->fixture('tx-successful-usdc');
        $reference = $tx['transaction']['message']['accountKeys'][0];
        $recipient = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check($reference, $recipient, self::USDC, '10960904');

        self::assertSame('confirmed', $result['status']);
        self::assertSame('10960904', $result['received_units']);
    }

    public function test_переплата_принимается(): void
    {
        $tx = $this->fixture('tx-successful-usdc');
        $reference = $tx['transaction']['message']['accountKeys'][0];
        $recipient = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check($reference, $recipient, self::USDC, '10000000');

        self::assertSame('confirmed', $result['status']);
    }

    public function test_заниженная_сумма_отвергается(): void
    {
        $tx = $this->fixture('tx-successful-usdc');
        $reference = $tx['transaction']['message']['accountKeys'][0];
        $recipient = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check($reference, $recipient, self::USDC, '99999999999');

        self::assertSame('mismatch', $result['status']);
        self::assertStringContainsString('сумм', mb_strtolower((string) $result['reason']));
    }

    public function test_чужой_получатель_отвергается(): void
    {
        $tx = $this->fixture('tx-successful-usdc');
        $reference = $tx['transaction']['message']['accountKeys'][0];

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check($reference, 'СовсемДругойПродавец', self::USDC, '1');

        self::assertSame('mismatch', $result['status']);
        self::assertStringContainsString('получател', mb_strtolower((string) $result['reason']));
    }

    public function test_отсутствие_метки_в_транзакции_отвергается(): void
    {
        $tx = $this->fixture('tx-successful-usdc');
        $recipient = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check('МеткиЗдесьНет', $recipient, self::USDC, '1');

        self::assertSame('mismatch', $result['status']);
        self::assertStringContainsString('метк', mb_strtolower((string) $result['reason']));
    }

    public function test_новый_токен_аккаунт_считается_с_нулевого_баланса(): void
    {
        // Если продавец получает USDC впервые, его токен-аккаунт создаётся
        // этой же транзакцией и записи в preTokenBalances нет вовсе.
        $tx = [
            'meta' => [
                'err' => null,
                'preTokenBalances' => [],
                'postTokenBalances' => [[
                    'accountIndex' => 3,
                    'mint' => self::USDC,
                    'owner' => 'НовыйПродавец',
                    'uiTokenAmount' => ['amount' => '5000000', 'decimals' => 6],
                ]],
            ],
            'transaction' => [
                'message' => ['accountKeys' => ['Метка', 'НовыйПродавец']],
                'signatures' => ['подпись'],
            ],
        ];

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check('Метка', 'НовыйПродавец', self::USDC, '5000000');

        self::assertSame('confirmed', $result['status']);
        self::assertSame('5000000', $result['received_units']);
    }

    public function test_чужой_токен_не_засчитывается(): void
    {
        $tx = [
            'meta' => [
                'err' => null,
                'preTokenBalances' => [],
                'postTokenBalances' => [[
                    'accountIndex' => 3,
                    'mint' => 'СовсемДругойТокен',
                    'owner' => 'Продавец',
                    'uiTokenAmount' => ['amount' => '999999999', 'decimals' => 6],
                ]],
            ],
            'transaction' => [
                'message' => ['accountKeys' => ['Метка', 'Продавец']],
                'signatures' => ['подпись'],
            ],
        ];

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check('Метка', 'Продавец', self::USDC, '1000');

        self::assertSame('mismatch', $result['status']);
    }

    public function test_отсутствие_ключа_err_не_считается_успехом(): void
    {
        // Найдено при проверке сырого ответа mainnet: поле meta.err
        // присутствует всегда и равно null при успехе. Полагаться на это
        // нельзя — усечённый ответ узла без ключа err не должен
        // истолковываться как успешный платёж.
        $tx = [
            'meta' => [
                'preTokenBalances' => [],
                'postTokenBalances' => [[
                    'accountIndex' => 3,
                    'mint' => self::USDC,
                    'owner' => 'Продавец',
                    'uiTokenAmount' => ['amount' => '5000000', 'decimals' => 6],
                ]],
            ],
            'transaction' => [
                'message' => ['accountKeys' => ['Метка', 'Продавец']],
                'signatures' => ['подпись'],
            ],
        ];

        $verify = new Verify($this->chain_returning([['signature' => 'подпись']], $tx));
        $result = $verify->check('Метка', 'Продавец', self::USDC, '1');

        self::assertSame('mismatch', $result['status']);
    }
}
