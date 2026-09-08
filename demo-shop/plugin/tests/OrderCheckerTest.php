<?php
// demo-shop/plugin/tests/OrderCheckerTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Cache;
use SolanaPayKZ\OrderChecker;
use SolanaPayKZ\OrderMeta;
use SolanaPayKZ\Quote;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;
use SolanaPayKZ\SolanaChain;

/**
 * OrderLock работает напрямую через $wpdb (см. includes/OrderLock.php), а не
 * через транзиенты, поэтому даже минимальный тест на OrderChecker требует
 * фиктивной таблицы опций. Реального WordPress это не поднимает: три вида
 * запросов (INSERT IGNORE, DELETE просроченного, DELETE по токену)
 * распознаются по тексту SQL, а не выполняются по-настоящему.
 */
final class FakeWpdbForOrderChecker
{
    public string $options = 'wp_options';

    /** @var array<string, string> */
    public array $rows = [];

    /** @var array{op: string, key: string, value?: string, now?: int, like?: string}|null */
    private ?array $pending = null;

    public function prepare(string $query, mixed ...$args): string
    {
        if (str_contains($query, 'INSERT IGNORE')) {
            $this->pending = ['op' => 'insert', 'key' => (string) $args[0], 'value' => (string) $args[1]];
        } elseif (str_contains($query, 'SUBSTRING_INDEX')) {
            $this->pending = ['op' => 'delete_expired', 'key' => (string) $args[0], 'now' => (int) $args[1]];
        } else {
            $this->pending = ['op' => 'delete_token', 'key' => (string) $args[0], 'like' => (string) $args[1]];
        }

        return 'FAKE_SQL';
    }

    public function query(string $sql): int
    {
        $op = $this->pending;
        $this->pending = null;

        if ($op === null) {
            return 0;
        }

        switch ($op['op']) {
            case 'insert':
                if (array_key_exists($op['key'], $this->rows)) {
                    return 0;
                }

                $this->rows[$op['key']] = $op['value'];

                return 1;

            case 'delete_expired':
                if (!array_key_exists($op['key'], $this->rows)) {
                    return 0;
                }

                $expires_at = (int) substr((string) strrchr($this->rows[$op['key']], '|'), 1);

                if ($expires_at >= $op['now']) {
                    return 0;
                }

                unset($this->rows[$op['key']]);

                return 1;

            case 'delete_token':
                $prefix = rtrim($op['like'], '%');

                if (isset($this->rows[$op['key']]) && str_starts_with($this->rows[$op['key']], $prefix)) {
                    unset($this->rows[$op['key']]);

                    return 1;
                }

                return 0;
        }

        return 0;
    }

    public function esc_like(string $value): string
    {
        return $value;
    }
}

if (!function_exists('wp_cache_delete')) {
    function wp_cache_delete(string $key, string $group): bool
    {
        return true;
    }
}

if (!function_exists('wp_cache_get')) {
    function wp_cache_get(string $key, string $group): mixed
    {
        return false;
    }
}

if (!function_exists('wp_cache_set')) {
    function wp_cache_set(string $key, mixed $value, string $group): bool
    {
        return true;
    }
}

/** Минимальный двойник WC_Order: только то, что читает и пишет OrderChecker. */
if (!class_exists('WC_Order')) {
    class WC_Order
    {
        /** @var array<int, WC_Order> */
        private static array $registry = [];

        /** @var array<string, string> */
        private array $meta = [];

        /** @var list<string> */
        private array $notes = [];

        public function __construct(private int $id, private string $status = 'pending')
        {
            self::$registry[$id] = $this;
        }

        public static function find(int $id): ?self
        {
            return self::$registry[$id] ?? null;
        }

        public function get_id(): int
        {
            return $this->id;
        }

        public function get_status(): string
        {
            return $this->status;
        }

        public function get_meta(string $key): string
        {
            return $this->meta[$key] ?? '';
        }

        public function set_meta_for_test(string $key, string $value): void
        {
            $this->meta[$key] = $value;
        }

        public function update_meta_data(string $key, $value): void
        {
            $this->meta[$key] = (string) $value;
        }

        public function save(): void
        {
        }

        public function update_status(string $status, string $note = ''): void
        {
            $this->status = $status;
            $this->notes[] = $note;
        }

        public function add_order_note(string $note): void
        {
            $this->notes[] = $note;
        }

        public function payment_complete($transaction_id = ''): void
        {
            $this->status = 'processing';
        }

        /** @return list<string> */
        public function get_notes_for_test(): array
        {
            return $this->notes;
        }
    }
}

if (!function_exists('wc_get_order')) {
    function wc_get_order($id)
    {
        return WC_Order::find((int) $id);
    }
}

/**
 * Минимальный двойник WC_Data_Store: только то, что нужно проверить —
 * что перед перечитыванием заказа OrderChecker зовёт clear_cached_data()
 * так же, как реальный WooCommerce на HPOS (см. WC_Data_Store::__call(),
 * пробрасывающий вызов в Automattic\...\OrdersTableDataStore).
 */
if (!class_exists('WC_Data_Store')) {
    final class WC_Data_Store
    {
        /** @var list<list<int>> */
        public static array $clear_cached_data_calls = [];

        public static function load(string $object_type): self
        {
            return new self();
        }

        /** @param list<int> $order_ids */
        public function clear_cached_data(array $order_ids): void
        {
            self::$clear_cached_data_calls[] = $order_ids;
        }
    }
}

final class OrderCheckerTest extends TestCase
{
    protected function setUp(): void
    {
        global $wpdb;

        WC_Data_Store::$clear_cached_data_calls = [];

        $wpdb = new FakeWpdbForOrderChecker();
    }

    private function quote(string $cluster, string $token = 'SOL'): Quote
    {
        $source = new class implements RateSource {
            public function get_name(): string
            {
                return 'binance';
            }

            public function get_kzt_per_token(string $token): string
            {
                return '47752.44000000';
            }
        };

        $cache = new class implements Cache {
            public function get(string $key): ?string
            {
                return null;
            }

            public function set(string $key, string $value, int $ttl_seconds): void
            {
            }
        };

        return Quote::create(new RateProvider([$source], $cache, 0), '10000', $token, $cluster);
    }

    private function order_with_quote(int $id, Quote $quote): WC_Order
    {
        $order = new WC_Order($id, 'pending');
        $order->set_meta_for_test(OrderMeta::QUOTE, json_encode($quote->to_array()));
        $order->set_meta_for_test(OrderMeta::REFERENCE, 'МеткаПлатежа');
        $order->set_meta_for_test(OrderMeta::RECIPIENT, 'АдресПродавца');

        return $order;
    }

    public function test_расхождение_сети_настроек_и_котировки_не_трогает_заказ(): void
    {
        // Заказ создан при cluster=mainnet (котировка заморожена на mainnet),
        // продавец переключил настройки на devnet ради тестов — обычное
        // действие. Запрос в devnet по адресу и минту из mainnet-котировки
        // нашёл бы там чужой бесплатный платёж с той же меткой: заказ не
        // должен закрыться как оплаченный от такого расхождения.
        $quote = $this->quote('mainnet');
        $order = $this->order_with_quote(1, $quote);

        $checker = new OrderChecker();
        $result = $checker->check($order, [
            'cluster' => 'devnet',
            'rpc_url' => 'https://rpc.example',
            'late_window' => 86400,
        ]);

        self::assertSame('unknown', $result['status']);
        self::assertFalse($result['mutated']);
        self::assertSame('pending', $order->get_status(), 'Заказ не должен меняться при расхождении сетей.');
    }

    public function test_совпадение_сети_идёт_дальше_и_обращается_к_цепочке(): void
    {
        // Когда сеть в настройках совпадает с сетью котировки, ранний выход
        // из A1 не должен срабатывать — проверка обязана дойти до цепочки.
        $quote = $this->quote('mainnet');
        $order = $this->order_with_quote(2, $quote);

        $chain = $this->createMock(SolanaChain::class);
        $chain->expects(self::once())->method('get_signatures_for_address')->willReturn([]);

        $checker = new OrderChecker($chain);
        $result = $checker->check($order, [
            'cluster' => 'mainnet',
            'rpc_url' => 'https://rpc.example',
            'late_window' => 86400,
        ]);

        self::assertSame('pending', $result['status']);
        self::assertFalse($result['mutated']);
    }

    public function test_перечитывание_заказа_сбрасывает_кеш_обоих_хранилищ(): void
    {
        // Только clean_post_cache() не спасает на HPOS: заказ там хранится не
        // в постах, и она ничего не сбрасывает. OrderChecker обязан звать и
        // штатный сброс кеша хранилища заказов — тот, который на HPOS
        // реально имеет эффект.
        $quote = $this->quote('mainnet');
        $order = $this->order_with_quote(5, $quote);

        $chain = $this->createMock(SolanaChain::class);
        $chain->method('get_signatures_for_address')->willReturn([]);

        (new OrderChecker($chain))->check($order, [
            'cluster' => 'mainnet',
            'rpc_url' => 'https://rpc.example',
            'late_window' => 86400,
        ]);

        self::assertSame([[5]], WC_Data_Store::$clear_cached_data_calls);
    }

    public function test_неизвестный_формат_котировки_не_проваливает_заказ(): void
    {
        // Заказ выпущен более новой сборкой плагина (например, после отката
        // сервера на прежнюю версию) — поле версии есть, но значение не то,
        // что понимает текущий код. Это не порча данных: заказ должен
        // остаться нетронутым, а не уехать в failed вместе со всей пачкой
        // таких заказов.
        $quote = $this->quote('mainnet');
        $data = $quote->to_array();
        $data['format_version'] = Quote::FORMAT_VERSION + 1;

        $order = new WC_Order(3, 'pending');
        $order->set_meta_for_test(OrderMeta::QUOTE, json_encode($data));
        $order->set_meta_for_test(OrderMeta::REFERENCE, 'МеткаПлатежа');
        $order->set_meta_for_test(OrderMeta::RECIPIENT, 'АдресПродавца');

        $checker = new OrderChecker();
        $result = $checker->check($order, [
            'cluster' => 'mainnet',
            'rpc_url' => 'https://rpc.example',
            'late_window' => 86400,
        ]);

        self::assertSame('unknown', $result['status']);
        self::assertFalse($result['mutated']);
        self::assertSame(
            'pending',
            $order->get_status(),
            'Неизвестный формат котировки не должен проваливать заказ.'
        );
    }

    public function test_испорченная_котировка_проваливает_заказ(): void
    {
        // Регресс-тест на ветку рядом: неизвестный формат (проверено выше)
        // и настоящая порча данных не должны схлопнуться в одно поведение.
        $order = new WC_Order(4, 'pending');
        $order->set_meta_for_test(OrderMeta::QUOTE, 'это не json вовсе');
        $order->set_meta_for_test(OrderMeta::REFERENCE, 'МеткаПлатежа');
        $order->set_meta_for_test(OrderMeta::RECIPIENT, 'АдресПродавца');

        $checker = new OrderChecker();
        $result = $checker->check($order, [
            'cluster' => 'mainnet',
            'rpc_url' => 'https://rpc.example',
            'late_window' => 86400,
        ]);

        self::assertSame('error', $result['status']);
        self::assertTrue($result['mutated']);
        self::assertSame('failed', $order->get_status());
    }
}
