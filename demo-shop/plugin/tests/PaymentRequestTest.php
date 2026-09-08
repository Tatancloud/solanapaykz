<?php
// demo-shop/plugin/tests/PaymentRequestTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Cache;
use SolanaPayKZ\PaymentRequest;
use SolanaPayKZ\Quote;
use SolanaPayKZ\QuoteException;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;

final class PaymentRequestTest extends TestCase
{
    private const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    private const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    private function quote(string $amount_kzt = '10000', string $token = 'USDC', string $rate = '459.60000000'): Quote
    {
        $source = new class($rate) implements RateSource {
            public function __construct(private string $rate) {}
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string { return $this->rate; }
        };

        $cache = new class implements Cache {
            public function get(string $key): ?string { return null; }
            public function set(string $key, string $value, int $ttl_seconds): void {}
        };

        return Quote::create(new RateProvider([$source], $cache, 0), $amount_kzt, $token, 'mainnet');
    }

    public function test_метка_уникальна_и_имеет_вид_адреса(): void
    {
        $first = PaymentRequest::generate_reference();
        $second = PaymentRequest::generate_reference();

        self::assertNotSame($first, $second);
        self::assertMatchesRegularExpression('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $first);
    }

    public function test_ссылка_совпадает_с_эталоном_библиотеки(): void
    {
        // Эталон получен запуском @solana/pay — той самой библиотеки, которую
        // используют кошельки. Совпадение означает, что наш URL будет прочитан
        // ровно так же, как её собственный.
        $request = PaymentRequest::create($this->quote(), self::MERCHANT, [
            'reference' => 'DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh',
            'label' => 'Магазин',
            'message' => 'Заказ №123',
        ]);

        self::assertSame(
            'solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
            . '?amount=21.758051'
            . '&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
            . '&reference=DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh'
            . '&label=%D0%9C%D0%B0%D0%B3%D0%B0%D0%B7%D0%B8%D0%BD'
            . '&message=%D0%97%D0%B0%D0%BA%D0%B0%D0%B7+%E2%84%96123',
            $request->url
        );
    }

    public function test_для_нативного_sol_нет_адреса_монеты(): void
    {
        $request = PaymentRequest::create($this->quote('10000', 'SOL', '47758.44000000'), self::MERCHANT, [
            'reference' => 'DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh',
        ]);

        self::assertSame(
            'solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
            . '?amount=0.209387074'
            . '&reference=DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh',
            $request->url
        );
        self::assertStringNotContainsString('spl-token', $request->url);
    }

    public function test_незначащие_нули_в_сумме_обрезаются(): void
    {
        // Библиотека выводит «1», а не «1.000000». Совпадение важно:
        // одинаковая сумма должна давать одинаковый QR-код.
        $request = PaymentRequest::create($this->quote('459.60'), self::MERCHANT, [
            'reference' => 'DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh',
        ]);

        self::assertStringContainsString('amount=1&', $request->url);
    }

    public function test_необязательные_поля_отсутствуют_когда_не_переданы(): void
    {
        $request = PaymentRequest::create($this->quote(), self::MERCHANT, [
            'reference' => 'DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh',
        ]);

        self::assertStringNotContainsString('label=', $request->url);
        self::assertStringNotContainsString('message=', $request->url);
        self::assertStringNotContainsString('memo=', $request->url);
    }

    public function test_memo_попадает_в_ссылку(): void
    {
        $request = PaymentRequest::create($this->quote(), self::MERCHANT, [
            'reference' => 'DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh',
            'memo' => 'order-42',
        ]);

        self::assertStringContainsString('&memo=order-42', $request->url);
    }

    public function test_метка_создаётся_автоматически_если_не_передана(): void
    {
        $request = PaymentRequest::create($this->quote(), self::MERCHANT);

        self::assertMatchesRegularExpression('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $request->reference);
        self::assertStringContainsString('reference=' . $request->reference, $request->url);
    }

    public function test_отвергает_просроченную_котировку(): void
    {
        $quote = $this->quote();
        $expired = Quote::from_array(array_merge($quote->to_array(), [
            'created_at' => time() - 3600,
            'expires_at' => time() - 1800,
        ]));

        $this->expectException(QuoteException::class);
        PaymentRequest::create($expired, self::MERCHANT);
    }

    public function test_отвергает_пустой_адрес_получателя(): void
    {
        $this->expectException(QuoteException::class);
        PaymentRequest::create($this->quote(), '');
    }

    public function test_отвергает_адрес_получателя_не_в_формате_base58(): void
    {
        // Символы 0, O, I и l в base58 не встречаются: адрес с ними заведомо
        // неверен, и лучше сказать об этом продавцу при настройке, чем
        // отправить покупателя платить в никуда.
        $this->expectException(QuoteException::class);
        PaymentRequest::create($this->quote(), 'НеАдрес0OIl');
    }

    public function test_отвергает_адрес_совпадающий_с_адресом_монеты(): void
    {
        // Частая ошибка при настройке: в поле адреса продавца вписывают
        // адрес самой монеты. Платежи туда уходят безвозвратно.
        $this->expectException(QuoteException::class);
        PaymentRequest::create($this->quote(), self::USDC_MINT);
    }
}
