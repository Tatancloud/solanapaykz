# Плагин WooCommerce — план реализации

> **Для агентов:** ОБЯЗАТЕЛЬНАЯ СУБ-СКИЛЛ: используйте
> superpowers:subagent-driven-development (рекомендуется) или
> superpowers:executing-plans для выполнения по задачам. Шаги отмечаются
> чекбоксами `- [ ]`.

**Цель:** Плагин WooCommerce, принимающий оплату в USDC на Solana с
автоматической конвертацией из тенге, работающий без серверов проекта.

**Архитектура:** Восемь классов с одной ответственностью каждый. Классы
расчёта и работы с блокчейном не зависят от WordPress и тестируются
отдельно; классы интеграции подключают их к WooCommerce. Вся арифметика
на `bcmath`, все запросы на встроенном `curl`, сторонних библиотек нет.

**Стек:** PHP 8.1+, WordPress 7.0+, WooCommerce 9.0+, расширения bcmath и
curl, PHPUnit 11 для тестов.

**Спека:** `docs/superpowers/specs/2026-09-08-woocommerce-plugin-design.md`

## Глобальные ограничения

- Вся арифметика денег — через `bcmath` со строками. Обычные целые PHP
  теряют точность на сумме **92 233,72 ₸** (проверено).
- Округление суммы токена — вверх, в пользу продавца.
- Наценка применяется к сумме в тенге до конвертации, по умолчанию 0.
- Уровень подтверждения транзакции — `finalized`.
- Плагин не создаёт, не хранит и не запрашивает приватные ключи.
- Проверка платежа обязана проверять `meta.err === null`: в произвольном
  блоке mainnet 20 из 48 транзакций с USDC оказались провалившимися.
- Сбой сети или RPC пробрасывается как ошибка и не меняет статус заказа.
- Никаких обращений к серверам проекта, никаких таблиц в базе, никаких
  зависимостей composer в поставке.
- Комментарии, сообщения об ошибках и тексты для покупателя — на русском.
- Каждая задача — отдельная ветка `feat/wc-<имя>` и слияние в `main`.

**Рабочий каталог плагина:** `demo-shop/plugin/`
Он смонтирован в контейнер `solanapaykz_shop` как
`/var/www/html/wp-content/plugins/solanapaykz`.

**Как запускать тесты:** на хосте нет расширения bcmath, поэтому PHPUnit
запускается внутри контейнера:

```bash
docker exec -w /var/www/html/wp-content/plugins/solanapaykz \
  solanapaykz_shop php vendor/bin/phpunit
```

Зависимости ставятся на хосте (`composer install`), внутрь контейнера
`vendor/` попадает через тот же смонтированный каталог.

---

### Задача 1: Точка входа и проверка окружения

**Файлы:**
- Создать: `demo-shop/plugin/solanapaykz.php`
- Создать: `demo-shop/plugin/includes/class-environment.php`
- Тест: `demo-shop/plugin/tests/EnvironmentTest.php`

**Интерфейсы:**
- Отдаёт: `SolanaPayKZ\Environment::check(): array` — список недостающих
  требований, пустой массив если всё на месте.

Каркас (composer.json, phpunit.xml, tests/SmokeTest.php) уже создан и
работает — задача добавляет к нему точку входа плагина.

- [ ] **Шаг 1: Создать ветку**

```bash
cd /var/www/solanapaykz && git checkout main && git pull
git checkout -b feat/wc-bootstrap
```

- [ ] **Шаг 2: Написать падающий тест**

```php
<?php
// demo-shop/plugin/tests/EnvironmentTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Environment;

final class EnvironmentTest extends TestCase
{
    public function test_на_пригодной_среде_возвращает_пустой_список(): void
    {
        $missing = Environment::check([
            'php' => '8.1',
            'extensions' => ['bcmath', 'curl', 'json'],
        ]);

        self::assertSame([], $missing);
    }

    public function test_называет_недостающее_расширение(): void
    {
        $missing = Environment::check([
            'php' => '8.1',
            'extensions' => ['bcmath', 'расширения-которого-нет'],
        ]);

        self::assertCount(1, $missing);
        self::assertStringContainsString('расширения-которого-нет', $missing[0]);
    }

    public function test_называет_недостаточную_версию_php(): void
    {
        $missing = Environment::check([
            'php' => '99.0',
            'extensions' => [],
        ]);

        self::assertCount(1, $missing);
        self::assertStringContainsString('99.0', $missing[0]);
    }
}
```

- [ ] **Шаг 3: Запустить тест и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter EnvironmentTest`
Ожидается: FAIL — класс `SolanaPayKZ\Environment` не найден.

- [ ] **Шаг 4: Реализовать проверку окружения**

```php
<?php
// demo-shop/plugin/includes/class-environment.php

declare(strict_types=1);

namespace SolanaPayKZ;

/**
 * Проверяет, пригодна ли среда для работы плагина.
 *
 * Без bcmath расчёт суммы к оплате молча теряет точность на заказах
 * дороже 92 233,72 ₸ — предел целых чисел PHP. Поэтому плагин лучше
 * не включить вовсе, чем обсчитать продавца на крупной покупке.
 */
final class Environment
{
    /**
     * @param array{php: string, extensions: list<string>} $requirements
     * @return list<string> Человекочитаемые описания недостающего.
     */
    public static function check(array $requirements): array
    {
        $missing = [];

        if (version_compare(PHP_VERSION, $requirements['php'], '<')) {
            $missing[] = sprintf(
                'Требуется PHP %s или новее, установлен %s.',
                $requirements['php'],
                PHP_VERSION
            );
        }

        foreach ($requirements['extensions'] as $extension) {
            if (!extension_loaded($extension)) {
                $missing[] = sprintf('Не установлено расширение PHP «%s».', $extension);
            }
        }

        return $missing;
    }
}
```

- [ ] **Шаг 5: Запустить тест**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter EnvironmentTest`
Ожидается: PASS, 3 теста.

- [ ] **Шаг 6: Создать точку входа плагина**

```php
<?php
/**
 * Plugin Name: SolanaPay-KZ для WooCommerce
 * Description: Приём оплаты в USDC на Solana с конвертацией из тенге. Деньги идут напрямую на кошелёк продавца.
 * Version: 0.1.0
 * Requires at least: 7.0
 * Requires PHP: 8.1
 * Author: Tatancloud
 * License: MIT
 * Text Domain: solanapaykz
 */

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

const PLUGIN_FILE = __FILE__;
const PLUGIN_DIR  = __DIR__;

require_once __DIR__ . '/includes/class-environment.php';

const REQUIREMENTS = [
    'php' => '8.1',
    'extensions' => ['bcmath', 'curl', 'json'],
];

/**
 * Не даём включить плагин на непригодной среде: молчаливый неверный
 * расчёт суммы хуже honest отказа при активации.
 */
register_activation_hook(__FILE__, static function (): void {
    $missing = Environment::check(REQUIREMENTS);

    if ($missing !== []) {
        deactivate_plugins(plugin_basename(__FILE__));
        wp_die(
            '<h1>SolanaPay-KZ не может быть включён</h1><p>'
            . implode('</p><p>', array_map('esc_html', $missing))
            . '</p><p>Обратитесь к вашему хостинг-провайдеру.</p>',
            'SolanaPay-KZ',
            ['back_link' => true]
        );
    }
});

/**
 * Среда могла измениться после активации — например, хостер отключил
 * расширение при обновлении PHP. Проверяем при каждой загрузке.
 */
add_action('plugins_loaded', static function (): void {
    $missing = Environment::check(REQUIREMENTS);

    if ($missing !== []) {
        add_action('admin_notices', static function () use ($missing): void {
            printf(
                '<div class="notice notice-error"><p><strong>SolanaPay-KZ отключён:</strong> %s</p></div>',
                esc_html(implode(' ', $missing))
            );
        });

        return;
    }

    if (!class_exists('WooCommerce')) {
        add_action('admin_notices', static function (): void {
            echo '<div class="notice notice-error"><p><strong>SolanaPay-KZ:</strong> '
                . 'плагин требует установленный и включённый WooCommerce.</p></div>';
        });

        return;
    }

    // Платёжный шлюз подключается в задаче 8.
});
```

- [ ] **Шаг 7: Проверить, что WordPress видит плагин**

Запустить:
```bash
cd /var/www/solanapaykz/demo-shop && source .env
docker run --rm --network demo-shop_default --volumes-from solanapaykz_shop -u 33:33 \
  -e WORDPRESS_DB_HOST=db -e WORDPRESS_DB_NAME=wordpress -e WORDPRESS_DB_USER=wordpress \
  -e WORDPRESS_DB_PASSWORD="$MARIADB_PASSWORD" \
  wordpress:cli wp plugin list --name=solanapaykz
```
Ожидается: строка с плагином в статусе `inactive`.

- [ ] **Шаг 8: Включить плагин и убедиться, что активация проходит**

Запустить (та же обвязка): `wp plugin activate solanapaykz`
Ожидается: `Plugin 'solanapaykz' activated.` Затем `wp plugin list --name=solanapaykz` показывает `active`.

- [ ] **Шаг 9: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: каркас плагина WooCommerce и проверка окружения"
git push -u origin feat/wc-bootstrap
```

---

### Задача 2: Арифметика денег

**Файлы:**
- Создать: `demo-shop/plugin/includes/class-money.php`
- Тест: `demo-shop/plugin/tests/MoneyTest.php`

**Интерфейсы:**
- Отдаёт: класс `SolanaPayKZ\Money` со статическими методами
  `is_valid_decimal(string): bool`,
  `parse_decimal_to_units(string $value, int $decimals, bool $allow_truncation = true): string`,
  `format_units(string $units, int $decimals): string`,
  `ceil_div(string $a, string $b): string`,
  `multiply_rates(string $a, string $b): string`,
  `apply_markup(string $amount_kzt, float $percent): string`,
  `convert_kzt_to_token_units(string $amount_kzt, string $rate, int $decimals): string`;
  константы `KZT_DECIMALS = 2`, `RATE_DECIMALS = 8`.

Все ожидаемые значения в тестах ниже прогнаны на реальном PHP с bcmath и
совпадают с эталонной реализацией SDK на TypeScript. Если результат
разойдётся — ошибка в реализации, а не в тесте; ожидания не подгонять.

- [ ] **Шаг 1: Создать ветку**

```bash
cd /var/www/solanapaykz && git checkout main && git pull
git checkout -b feat/wc-money
```

- [ ] **Шаг 2: Написать падающий тест**

```php
<?php
// demo-shop/plugin/tests/MoneyTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Money;

final class MoneyTest extends TestCase
{
    public function test_разбирает_десятичные_строки(): void
    {
        self::assertSame('45960000000', Money::parse_decimal_to_units('459.60', 8));
        self::assertSame('1000000', Money::parse_decimal_to_units('10000', 2));
    }

    public function test_обрезает_лишние_знаки_когда_разрешено(): void
    {
        self::assertSame('199', Money::parse_decimal_to_units('1.999', 2));
    }

    public function test_отвергает_избыточную_точность_когда_запрещено(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::parse_decimal_to_units('100.999', 2, false);
    }

    public function test_отвергает_мусор(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::parse_decimal_to_units('abc', 2);
    }

    public function test_форматирует_единицы(): void
    {
        self::assertSame('21.758051', Money::format_units('21758051', 6));
        self::assertSame('0.002176', Money::format_units('2176', 6));
        self::assertSame('1.000000', Money::format_units('1000000', 6));
    }

    public function test_отвергает_отрицательные_при_форматировании(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::format_units('-2176', 6);
    }

    public function test_делит_с_округлением_вверх(): void
    {
        self::assertSame('4', Money::ceil_div('10', '3'));
        self::assertSame('3', Money::ceil_div('9', '3'));
    }

    public function test_отвергает_неположительный_делитель(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::ceil_div('10', '0');
    }

    public function test_конвертирует_тенге_в_единицы_токена(): void
    {
        self::assertSame('1000000', Money::convert_kzt_to_token_units('459.60', '459.60', 6));
        self::assertSame('2000000', Money::convert_kzt_to_token_units('919.20', '459.60', 6));
        self::assertSame('21758051', Money::convert_kzt_to_token_units('10000', '459.60', 6));
        self::assertSame('2176', Money::convert_kzt_to_token_units('1', '459.60', 6));
        self::assertSame('209387074', Money::convert_kzt_to_token_units('10000', '47758.44', 9));
    }

    public function test_считает_точно_на_суммах_где_ломаются_обычные_целые(): void
    {
        // 92 233,72 ₸ — предел обычных целых PHP для этой формулы.
        self::assertSame('200683203', Money::convert_kzt_to_token_units('92234', '459.60', 6));
        self::assertSame('2175805048', Money::convert_kzt_to_token_units('1000000', '459.60', 6));
        self::assertSame('217580504787', Money::convert_kzt_to_token_units('100000000', '459.60', 6));
    }

    public function test_отвергает_неположительный_курс(): void
    {
        $this->expectException(RuntimeException::class);
        Money::convert_kzt_to_token_units('10000', '0', 6);
    }

    public function test_перемножает_курсы_без_потери_точности(): void
    {
        self::assertSame('459.63676800', Money::multiply_rates('459.60', '1.00008'));
    }

    public function test_применяет_наценку_к_сумме_в_тенге(): void
    {
        self::assertSame('10000.00', Money::apply_markup('10000', 0));
        self::assertSame('10100.00', Money::apply_markup('10000', 1));
        self::assertSame('1024.99', Money::apply_markup('999.99', 2.5));
    }

    public function test_наценка_с_конвертацией_даёт_тот_же_результат_что_sdk(): void
    {
        $charged = Money::apply_markup('10000', 1);
        $units = Money::convert_kzt_to_token_units($charged, '459.60000000', 6);
        self::assertSame('21.975631', Money::format_units($units, 6));
    }

    public function test_отвергает_наценку_меньше_минимального_шага(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::apply_markup('10000', 0.004);
    }

    public function test_отвергает_наценку_больше_ста_процентов(): void
    {
        $this->expectException(InvalidArgumentException::class);
        Money::apply_markup('10000', 101);
    }
}
```

- [ ] **Шаг 3: Запустить тест и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter MoneyTest`
Ожидается: FAIL — класс `SolanaPayKZ\Money` не найден.

- [ ] **Шаг 4: Реализовать арифметику**

```php
<?php
// demo-shop/plugin/includes/class-money.php

declare(strict_types=1);

namespace SolanaPayKZ;

use InvalidArgumentException;
use RuntimeException;

/**
 * Арифметика денег на bcmath.
 *
 * Обычные целые PHP 64-битные, и промежуточное произведение в формуле
 * конвертации переполняется на сумме 92 233,72 ₸, молча превращаясь в
 * число с плавающей точкой. Поэтому все величины — строки, все действия
 * через bcmath.
 *
 * Три округления смещены в одну сторону, в пользу продавца: сумма токена
 * округляется вверх, курс при разборе усекается вниз (меньше тенге за
 * токен — больше токенов к оплате), наценка тоже вверх.
 */
final class Money
{
    /** Тенге хранятся с точностью до тиына. */
    public const KZT_DECIMALS = 2;

    /** Курсы бирж приходят с восемью знаками. */
    public const RATE_DECIMALS = 8;

    private const DECIMAL_PATTERN = '/^\d+(\.\d+)?$/';

    public static function is_valid_decimal(string $value): bool
    {
        return (bool) preg_match(self::DECIMAL_PATTERN, $value);
    }

    /**
     * Переводит десятичную строку в целые минимальные единицы.
     *
     * Лишние знаки по умолчанию отбрасываются: курсы бирж приходят с
     * большей точностью, чем нам нужна, и усечение курса вниз играет в
     * пользу продавца. Для сумм в тенге обрезание запрещается: тенге не
     * бывает точнее тиына, и молча терять копейки продавца нельзя.
     */
    public static function parse_decimal_to_units(
        string $value,
        int $decimals,
        bool $allow_truncation = true
    ): string {
        if (!self::is_valid_decimal($value)) {
            throw new InvalidArgumentException(
                sprintf('Некорректное десятичное число: «%s».', $value)
            );
        }

        $parts = explode('.', $value, 2);
        $whole = $parts[0];
        $frac  = $parts[1] ?? '';

        if (!$allow_truncation && strlen($frac) > $decimals) {
            throw new InvalidArgumentException(sprintf(
                'Сумма «%s» имеет %d знаков после запятой, допустимо не более %d.',
                $value,
                strlen($frac),
                $decimals
            ));
        }

        $frac = substr($frac . str_repeat('0', $decimals), 0, $decimals);

        return ltrim($whole . $frac, '0') ?: '0';
    }

    /** Обратное преобразование: целые единицы в десятичную строку. */
    public static function format_units(string $units, int $decimals): string
    {
        if (bccomp($units, '0') < 0) {
            throw new InvalidArgumentException(
                sprintf('Сумма не может быть отрицательной: %s.', $units)
            );
        }

        if ($decimals === 0) {
            return $units;
        }

        $padded = str_pad($units, $decimals + 1, '0', STR_PAD_LEFT);

        return substr($padded, 0, -$decimals) . '.' . substr($padded, -$decimals);
    }

    /** Целочисленное деление с округлением вверх. */
    public static function ceil_div(string $a, string $b): string
    {
        if (bccomp($b, '0') <= 0) {
            throw new InvalidArgumentException('Делитель должен быть положительным.');
        }

        return bcdiv(bcadd($a, bcsub($b, '1')), $b, 0);
    }

    /** Перемножает два курса, сохраняя точность RATE_DECIMALS. */
    public static function multiply_rates(string $a, string $b): string
    {
        $product = bcmul(
            self::parse_decimal_to_units($a, self::RATE_DECIMALS),
            self::parse_decimal_to_units($b, self::RATE_DECIMALS)
        );

        $scale = bcpow('10', (string) self::RATE_DECIMALS);

        return self::format_units(bcdiv($product, $scale, 0), self::RATE_DECIMALS);
    }

    /**
     * Добавляет наценку продавца к сумме в тенге.
     *
     * Наценка применяется к сумме, а не к курсу: «беру процент сверху» —
     * однозначная формулировка, поправка к курсу читается двусмысленно.
     */
    public static function apply_markup(string $amount_kzt, float $percent): string
    {
        if (!is_finite($percent) || $percent < 0) {
            throw new InvalidArgumentException(
                sprintf('Наценка должна быть неотрицательным числом, получено %s.', $percent)
            );
        }

        if ($percent > 100) {
            throw new InvalidArgumentException(
                sprintf('Наценка не может превышать 100%%, получено %s%%.', $percent)
            );
        }

        $base = self::parse_decimal_to_units($amount_kzt, self::KZT_DECIMALS, false);

        // Процент переводим в сотые доли процента, чтобы принимать 0,5% и 2,5%.
        $permyriad = (string) (int) round($percent * 100);

        if ($percent > 0 && $permyriad === '0') {
            throw new InvalidArgumentException(sprintf(
                'Наценка %s%% меньше минимального шага 0,01 процентного пункта.',
                $percent
            ));
        }

        $with_markup = bcadd($base, self::ceil_div(bcmul($base, $permyriad), '10000'));

        return self::format_units($with_markup, self::KZT_DECIMALS);
    }

    /**
     * Сколько минимальных единиц токена соответствует сумме в тенге.
     *
     * Округление вверх: покупатель никогда не платит меньше запрошенного.
     */
    public static function convert_kzt_to_token_units(
        string $amount_kzt,
        string $rate,
        int $decimals
    ): string {
        $kzt_units  = self::parse_decimal_to_units($amount_kzt, self::KZT_DECIMALS, false);
        $rate_units = self::parse_decimal_to_units($rate, self::RATE_DECIMALS);

        if (bccomp($rate_units, '0') <= 0) {
            throw new RuntimeException('Курс должен быть положительным.');
        }

        $scale = bcpow('10', (string) ($decimals + self::RATE_DECIMALS - self::KZT_DECIMALS));

        return self::ceil_div(bcmul($kzt_units, $scale), $rate_units);
    }
}
```

- [ ] **Шаг 5: Подключить класс к автозагрузке**

В `solanapaykz.php` после `require_once` для `class-environment.php` добавить:

```php
require_once __DIR__ . '/includes/class-money.php';
```

- [ ] **Шаг 6: Запустить тесты**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit`
Ожидается: PASS, все тесты включая SmokeTest и EnvironmentTest.

- [ ] **Шаг 7: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: арифметика денег на bcmath"
git push -u origin feat/wc-money
```

---

### Задача 3: Клиент Solana JSON-RPC

**Файлы:**
- Создать: `demo-shop/plugin/includes/class-rpc.php`
- Тест: `demo-shop/plugin/tests/RpcTest.php`

**Интерфейсы:**
- Отдаёт: интерфейс `SolanaPayKZ\SolanaChain` с методами
  `get_signatures_for_address(string $address, int $limit = 10): array` и
  `get_transaction(string $signature): ?array`.
- Отдаёт: класс `SolanaPayKZ\Rpc implements SolanaChain` с конструктором
  `__construct(string $url, int $timeout_seconds = 10, ?HttpClient $http = null)`;
  исключение `SolanaPayKZ\RpcException`.

Интерфейс нужен не ради абстракции как таковой: `Rpc` объявлен `final`, а
PHPUnit не умеет подменять final-классы — проверено, тесты падают с
`ClassIsFinalException`. Проверка платежа принимает интерфейс, и тесты
подставляют свою реализацию.
- Отдаёт: интерфейс `SolanaPayKZ\HttpClient` с методом
  `post_json(string $url, array $payload, int $timeout_seconds): array`
  и реализацию `SolanaPayKZ\CurlHttpClient`.

HTTP вынесен в отдельный интерфейс, чтобы тесты подставляли ответы без
обращения к сети: набор тестов обязан работать без интернета.

- [ ] **Шаг 1: Создать ветку**

```bash
cd /var/www/solanapaykz && git checkout main && git pull
git checkout -b feat/wc-rpc
```

- [ ] **Шаг 2: Написать падающий тест**

```php
<?php
// demo-shop/plugin/tests/RpcTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\HttpClient;
use SolanaPayKZ\Rpc;
use SolanaPayKZ\RpcException;

final class FakeHttpClient implements HttpClient
{
    /** @var list<array{url: string, payload: array}> */
    public array $calls = [];

    /** @param list<array|callable> $responses */
    public function __construct(private array $responses)
    {
    }

    public function post_json(string $url, array $payload, int $timeout_seconds): array
    {
        $this->calls[] = ['url' => $url, 'payload' => $payload];
        $next = array_shift($this->responses);

        if ($next === null) {
            throw new RuntimeException('Тест не задал ответ на этот запрос.');
        }

        if (is_callable($next)) {
            return $next();
        }

        return $next;
    }
}

final class RpcTest extends TestCase
{
    public function test_запрашивает_подписи_по_метке(): void
    {
        $http = new FakeHttpClient([
            ['result' => [['signature' => 'abc', 'err' => null]]],
        ]);

        $rpc = new Rpc('https://rpc.example', 10, $http);
        $signatures = $rpc->get_signatures_for_address('МеткаПлатежа');

        self::assertSame([['signature' => 'abc', 'err' => null]], $signatures);
        self::assertSame('getSignaturesForAddress', $http->calls[0]['payload']['method']);
        self::assertSame('МеткаПлатежа', $http->calls[0]['payload']['params'][0]);
    }

    public function test_запрашивает_подписи_с_уровнем_finalized(): void
    {
        $http = new FakeHttpClient([['result' => []]]);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address('Метка');

        self::assertSame('finalized', $http->calls[0]['payload']['params'][1]['commitment']);
    }

    public function test_запрашивает_транзакцию_с_уровнем_finalized(): void
    {
        $http = new FakeHttpClient([['result' => ['meta' => ['err' => null]]]]);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');

        $params = $http->calls[0]['payload']['params'][1];
        self::assertSame('finalized', $params['commitment']);
        self::assertSame(0, $params['maxSupportedTransactionVersion']);
    }

    public function test_отсутствующая_транзакция_даёт_null(): void
    {
        $http = new FakeHttpClient([['result' => null]]);
        $result = (new Rpc('https://rpc.example', 10, $http))->get_transaction('нет-такой');

        self::assertNull($result);
    }

    public function test_ошибка_rpc_превращается_в_исключение(): void
    {
        $http = new FakeHttpClient([
            ['error' => ['code' => -32602, 'message' => 'Invalid param']],
        ]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_transaction('подпись');
    }

    public function test_ответ_без_result_и_error_считается_ошибкой(): void
    {
        $http = new FakeHttpClient([['что-то' => 'непонятное']]);

        $this->expectException(RpcException::class);
        (new Rpc('https://rpc.example', 10, $http))->get_signatures_for_address('Метка');
    }
}
```

- [ ] **Шаг 3: Запустить тест и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter RpcTest`
Ожидается: FAIL — классы не найдены.

- [ ] **Шаг 4: Реализовать HTTP-клиент и RPC**

```php
<?php
// demo-shop/plugin/includes/class-rpc.php

declare(strict_types=1);

namespace SolanaPayKZ;

use RuntimeException;

/** Ошибка обращения к узлу блокчейна: сеть, таймаут или ответ с error. */
final class RpcException extends RuntimeException
{
}

/**
 * Две операции чтения из блокчейна, нужные для проверки платежа.
 *
 * Вынесено в интерфейс, чтобы проверка платежа не зависела от способа
 * обращения к узлу и тестировалась без сети.
 */
interface SolanaChain
{
    /** @return list<array<string, mixed>> */
    public function get_signatures_for_address(string $address, int $limit = 10): array;

    /** @return array<string, mixed>|null */
    public function get_transaction(string $signature): ?array;
}

/** Отделяет сеть от логики, чтобы тесты работали без интернета. */
interface HttpClient
{
    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed> Разобранный JSON-ответ.
     */
    public function post_json(string $url, array $payload, int $timeout_seconds): array;
}

final class CurlHttpClient implements HttpClient
{
    public function post_json(string $url, array $payload, int $timeout_seconds): array
    {
        $handle = curl_init($url);

        if ($handle === false) {
            throw new RpcException('Не удалось инициализировать curl.');
        }

        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($payload, JSON_THROW_ON_ERROR),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT        => $timeout_seconds,
            CURLOPT_CONNECTTIMEOUT => $timeout_seconds,
        ]);

        $body   = curl_exec($handle);
        $errno  = curl_errno($handle);
        $error  = curl_error($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if ($errno !== 0 || !is_string($body)) {
            throw new RpcException(sprintf('%s: запрос не удался (%s).', $url, $error));
        }

        if ($status < 200 || $status >= 300) {
            throw new RpcException(sprintf('%s: HTTP %d.', $url, $status));
        }

        $decoded = json_decode($body, true);

        if (!is_array($decoded)) {
            throw new RpcException(sprintf('%s: ответ не является объектом JSON.', $url));
        }

        return $decoded;
    }
}

/**
 * Минимальный клиент Solana JSON-RPC.
 *
 * Умеет ровно две операции чтения, нужные для проверки платежа. Сторонняя
 * библиотека здесь избыточна: она тянет криптографию, которой плагин по
 * требованию безопасности не должен касаться вовсе.
 */
final class Rpc implements SolanaChain
{
    private HttpClient $http;

    public function __construct(
        private string $url,
        private int $timeout_seconds = 10,
        ?HttpClient $http = null
    ) {
        $this->http = $http ?? new CurlHttpClient();
    }

    /**
     * Подписи транзакций, ссылающихся на адрес-метку.
     *
     * @return list<array<string, mixed>>
     */
    public function get_signatures_for_address(string $address, int $limit = 10): array
    {
        $response = $this->call('getSignaturesForAddress', [
            $address,
            ['commitment' => 'finalized', 'limit' => $limit],
        ]);

        return is_array($response) ? $response : [];
    }

    /**
     * Транзакция по подписи или null, если её нет.
     *
     * @return array<string, mixed>|null
     */
    public function get_transaction(string $signature): ?array
    {
        $response = $this->call('getTransaction', [
            $signature,
            [
                'commitment' => 'finalized',
                'encoding' => 'json',
                'maxSupportedTransactionVersion' => 0,
            ],
        ]);

        return is_array($response) ? $response : null;
    }

    /**
     * @param list<mixed> $params
     * @return mixed Содержимое поля result.
     */
    private function call(string $method, array $params): mixed
    {
        $decoded = $this->http->post_json($this->url, [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => $method,
            'params' => $params,
        ], $this->timeout_seconds);

        if (isset($decoded['error'])) {
            $message = is_array($decoded['error']) && isset($decoded['error']['message'])
                ? (string) $decoded['error']['message']
                : 'неизвестная ошибка';

            throw new RpcException(sprintf('Узел блокчейна вернул ошибку: %s.', $message));
        }

        if (!array_key_exists('result', $decoded)) {
            throw new RpcException('Ответ узла не содержит ни result, ни error.');
        }

        return $decoded['result'];
    }
}
```

- [ ] **Шаг 5: Подключить к автозагрузке**

В `solanapaykz.php` добавить: `require_once __DIR__ . '/includes/class-rpc.php';`

- [ ] **Шаг 6: Запустить тесты**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit`
Ожидается: PASS, все тесты.

- [ ] **Шаг 7: Проверить на живом узле**

```bash
docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php -r '
require "includes/class-rpc.php";
$rpc = new SolanaPayKZ\Rpc("https://api.devnet.solana.com");
$sigs = $rpc->get_signatures_for_address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", 2);
echo "подписей получено: ", count($sigs), PHP_EOL;
'
```
Ожидается: число подписей (девнетовский mint активен, там всегда есть транзакции).

- [ ] **Шаг 8: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: минимальный клиент Solana JSON-RPC"
git push -u origin feat/wc-rpc
```

---

### Задача 4: Проверка платежа

**Файлы:**
- Создать: `demo-shop/plugin/includes/class-verify.php`
- Тест: `demo-shop/plugin/tests/VerifyTest.php`
- Использует: `demo-shop/plugin/tests/fixtures/tx-successful-usdc.json`,
  `demo-shop/plugin/tests/fixtures/tx-failed-usdc.json` (уже созданы из
  реальных транзакций mainnet)

**Интерфейсы:**
- Потребляет: интерфейс `SolanaChain` (реализуется классом `Rpc`), `Money`.
- Отдаёт: класс `SolanaPayKZ\Verify` с конструктором
  `__construct(SolanaChain $chain)` и методом
  `check(string $reference, string $recipient, string $mint, string $expected_units): array`,
  возвращающим `['status' => 'pending'|'confirmed'|'mismatch', 'signature' => ?string, 'reason' => ?string, 'received_units' => ?string]`.

**Это самая ответственная часть плагина.** Ошибка означает, что продавец
отдаст товар за чужой или заниженный платёж. В SDK эту работу делала
проверенная сообществом библиотека; здесь её пишем сами, поэтому каждая
проверка обязательна и покрыта тестом.

- [ ] **Шаг 1: Создать ветку**

```bash
cd /var/www/solanapaykz && git checkout main && git pull
git checkout -b feat/wc-verify
```

- [ ] **Шаг 2: Написать падающий тест**

```php
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
}
```

- [ ] **Шаг 3: Запустить тест и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter VerifyTest`
Ожидается: FAIL — класс `SolanaPayKZ\Verify` не найден.

- [ ] **Шаг 4: Реализовать проверку**

```php
<?php
// demo-shop/plugin/includes/class-verify.php

declare(strict_types=1);

namespace SolanaPayKZ;

/**
 * Поиск платежа в блокчейне и его проверка.
 *
 * Самая ответственная часть плагина: ошибка означает, что продавец отдаст
 * товар за чужой или заниженный платёж. Каждая проверка ниже обязательна,
 * пропуск любой открывает дыру.
 */
final class Verify
{
    public function __construct(private SolanaChain $chain)
    {
    }

    /**
     * @return array{status: string, signature: ?string, reason: ?string, received_units: ?string}
     */
    public function check(
        string $reference,
        string $recipient,
        string $mint,
        string $expected_units
    ): array {
        $signatures = $this->chain->get_signatures_for_address($reference);

        if ($signatures === []) {
            return $this->result('pending');
        }

        // По спецификации Solana Pay метка уникальна на платёж, поэтому
        // берём самую раннюю транзакцию — она и есть искомая оплата.
        $signature = (string) ($signatures[count($signatures) - 1]['signature'] ?? '');

        if ($signature === '') {
            return $this->result('pending');
        }

        $transaction = $this->chain->get_transaction($signature);

        if ($transaction === null) {
            // Подпись есть, а транзакции ещё нет: узел не догнал.
            return $this->result('pending');
        }

        return $this->validate($transaction, $signature, $reference, $recipient, $mint, $expected_units);
    }

    /**
     * @param array<string, mixed> $transaction
     * @return array{status: string, signature: ?string, reason: ?string, received_units: ?string}
     */
    private function validate(
        array $transaction,
        string $signature,
        string $reference,
        string $recipient,
        string $mint,
        string $expected_units
    ): array {
        $meta = is_array($transaction['meta'] ?? null) ? $transaction['meta'] : [];

        // 1. Транзакция должна быть успешной. В произвольном блоке mainnet
        // 20 из 48 транзакций с USDC оказались провалившимися: они
        // финализированы и находятся поиском, но денег не переводят.
        if (($meta['err'] ?? null) !== null) {
            return $this->result('mismatch', $signature, 'Транзакция завершилась с ошибкой.');
        }

        // 2. Метка платежа должна присутствовать среди аккаунтов транзакции.
        $keys = $transaction['transaction']['message']['accountKeys'] ?? [];

        if (!is_array($keys) || !in_array($reference, $keys, true)) {
            return $this->result('mismatch', $signature, 'В транзакции нет метки платежа.');
        }

        // 3 и 4. Ищем поступление нужного токена нужному получателю.
        $received = $this->received_units($meta, $recipient, $mint);

        if ($received === null) {
            return $this->result(
                'mismatch',
                $signature,
                'В транзакции нет перевода нужного токена нужному получателю.'
            );
        }

        if (bccomp($received, $expected_units) < 0) {
            return $this->result('mismatch', $signature, sprintf(
                'Сумма меньше ожидаемой: получено %s, требуется %s.',
                $received,
                $expected_units
            ), $received);
        }

        return $this->result('confirmed', $signature, null, $received);
    }

    /**
     * Сколько единиц токена поступило получателю.
     *
     * Считается как разница балансов до и после. Если записи «до» нет,
     * значит токен-аккаунт создан этой же транзакцией и прежний баланс
     * равен нулю — иначе первый в жизни платёж продавцу не засчитается.
     *
     * @param array<string, mixed> $meta
     */
    private function received_units(array $meta, string $recipient, string $mint): ?string
    {
        $before = [];

        foreach ($this->balances($meta, 'preTokenBalances', $recipient, $mint) as $index => $amount) {
            $before[$index] = $amount;
        }

        foreach ($this->balances($meta, 'postTokenBalances', $recipient, $mint) as $index => $after) {
            $delta = bcsub($after, $before[$index] ?? '0');

            if (bccomp($delta, '0') > 0) {
                return $delta;
            }
        }

        return null;
    }

    /**
     * @param array<string, mixed> $meta
     * @return array<int, string> Индекс аккаунта => баланс в минимальных единицах.
     */
    private function balances(array $meta, string $key, string $recipient, string $mint): array
    {
        $result = [];
        $list = is_array($meta[$key] ?? null) ? $meta[$key] : [];

        foreach ($list as $entry) {
            if (!is_array($entry)) {
                continue;
            }

            if (($entry['mint'] ?? null) !== $mint || ($entry['owner'] ?? null) !== $recipient) {
                continue;
            }

            $amount = $entry['uiTokenAmount']['amount'] ?? null;

            if (is_string($amount) && Money::is_valid_decimal($amount)) {
                $result[(int) ($entry['accountIndex'] ?? -1)] = $amount;
            }
        }

        return $result;
    }

    /**
     * @return array{status: string, signature: ?string, reason: ?string, received_units: ?string}
     */
    private function result(
        string $status,
        ?string $signature = null,
        ?string $reason = null,
        ?string $received = null
    ): array {
        return [
            'status' => $status,
            'signature' => $signature,
            'reason' => $reason,
            'received_units' => $received,
        ];
    }
}
```

- [ ] **Шаг 5: Подключить к автозагрузке**

В `solanapaykz.php` добавить: `require_once __DIR__ . '/includes/class-verify.php';`

- [ ] **Шаг 6: Запустить тесты**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit`
Ожидается: PASS, все тесты включая девять новых в VerifyTest.

- [ ] **Шаг 7: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: проверка платежа в блокчейне"
git push -u origin feat/wc-verify
```

---

### Задача 5: Курс тенге к токену

**Файлы:**
- Создать: `demo-shop/plugin/includes/RateSource.php`, `includes/Cache.php`,
  `includes/TransientCache.php`, `includes/BinanceRateSource.php`,
  `includes/SyntheticRateSource.php`, `includes/RateProvider.php`,
  `includes/RateUnavailableException.php`
- Изменить: `demo-shop/plugin/solanapaykz.php` (подключение)
- Тест: `demo-shop/plugin/tests/RatesTest.php`

**Интерфейсы:**
- Потребляет: `HttpClient` и `RpcException` из задачи 3, `Money::multiply_rates`.
- Отдаёт: интерфейс `RateSource` с `get_kzt_per_token(string $token): string`;
  интерфейс `Cache` с `get(string $key): ?string` и `set(string $key, string $value, int $ttl_seconds): void`;
  классы `BinanceRateSource`, `SyntheticRateSource`, `TransientCache`,
  `RateProvider` с `get_kzt_per_token(string $token): array{rate: string, source: string}`;
  исключение `RateUnavailableException`.

Кеш вынесен в интерфейс, потому что транзиенты WordPress недоступны в тестах,
а набор обязан работать без поднятия WordPress.

- [ ] **Шаг 1: Создать ветку**

```bash
cd /var/www/solanapaykz && git checkout main && git pull
git checkout -b feat/wc-rates
```

- [ ] **Шаг 2: Написать падающий тест**

```php
<?php
// demo-shop/plugin/tests/RatesTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\BinanceRateSource;
use SolanaPayKZ\Cache;
use SolanaPayKZ\HttpClient;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;
use SolanaPayKZ\RateUnavailableException;
use SolanaPayKZ\RpcException;
use SolanaPayKZ\SyntheticRateSource;

/** Отдаёт заранее заданные ответы вместо обращения к сети. */
final class StubHttpClient implements HttpClient
{
    /** @var list<string> */
    public array $urls = [];

    /** @param array<string, array> $routes Часть URL => ответ */
    public function __construct(private array $routes)
    {
    }

    public function post_json(string $url, array $payload, int $timeout_seconds): array
    {
        throw new RuntimeException('Курс запрашивается через get_json, не post_json.');
    }

    public function get_json(string $url, int $timeout_seconds): array
    {
        $this->urls[] = $url;

        foreach ($this->routes as $needle => $response) {
            if (str_contains($url, $needle)) {
                if ($response instanceof RpcException) {
                    throw $response;
                }

                return $response;
            }
        }

        throw new RpcException('Тест не задал ответ для ' . $url);
    }
}

final class ArrayCache implements Cache
{
    /** @var array<string, array{value: string, expires: int}> */
    private array $items = [];

    public int $now = 1000;

    public function get(string $key): ?string
    {
        $item = $this->items[$key] ?? null;

        return $item !== null && $item['expires'] > $this->now ? $item['value'] : null;
    }

    public function set(string $key, string $value, int $ttl_seconds): void
    {
        $this->items[$key] = ['value' => $value, 'expires' => $this->now + $ttl_seconds];
    }
}

final class RatesTest extends TestCase
{
    public function test_binance_считает_курс_usdc_из_двух_тикеров(): void
    {
        $http = new StubHttpClient([
            'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => '459.60000000'],
            'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '1.00008000'],
        ]);

        self::assertSame('459.63676800', (new BinanceRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_binance_считает_курс_sol(): void
    {
        $http = new StubHttpClient([
            'symbol=USDTKZT' => ['symbol' => 'USDTKZT', 'price' => '459.60000000'],
            'symbol=SOLUSDT' => ['symbol' => 'SOLUSDT', 'price' => '103.90000000'],
        ]);

        self::assertSame('47752.44000000', (new BinanceRateSource($http))->get_kzt_per_token('SOL'));
    }

    public function test_binance_отвергает_ответ_без_цены(): void
    {
        $http = new StubHttpClient(['symbol=USDTKZT' => ['symbol' => 'USDTKZT']]);

        $this->expectException(RpcException::class);
        (new BinanceRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_binance_отвергает_непригодную_цену(): void
    {
        foreach (['0', '-1', 'abc', '1e400', ' 1.5 '] as $price) {
            $http = new StubHttpClient([
                'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => $price],
                'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '1.00000000'],
            ]);

            try {
                (new BinanceRateSource($http))->get_kzt_per_token('USDC');
                self::fail("Цена «{$price}» должна быть отвергнута.");
            } catch (RpcException) {
                self::assertTrue(true);
            }
        }
    }

    public function test_binance_принимает_цену_меньше_единицы(): void
    {
        // Цена USDC к доллару колеблется около единицы и регулярно бывает
        // меньше её. Сравнение без указания точности отвергло бы такую цену.
        $http = new StubHttpClient([
            'symbol=USDTKZT'  => ['symbol' => 'USDTKZT', 'price' => '459.60000000'],
            'symbol=USDCUSDT' => ['symbol' => 'USDCUSDT', 'price' => '0.99980800'],
        ]);

        self::assertSame('459.51175680', (new BinanceRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_синтетика_принимает_цену_меньше_единицы(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['KZT' => 455.296]],
            'coingecko'       => ['usd-coin' => ['usd' => 0.999808]],
        ]);

        self::assertSame('455.20858316', (new SyntheticRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_синтетика_собирает_курс_из_двух_источников(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['KZT' => 455.296]],
            'coingecko'       => ['usd-coin' => ['usd' => 1.0]],
        ]);

        self::assertSame('455.29600000', (new SyntheticRateSource($http))->get_kzt_per_token('USDC'));
    }

    public function test_синтетика_считает_молчаливый_отказ_отказом(): void
    {
        // CoinGecko не знает тенге и на запрос цены в KZT отвечает HTTP 200
        // и пустым объектом. Принять это за ответ — значит выставить счёт на ноль.
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['KZT' => 455.296]],
            'coingecko'       => ['usd-coin' => []],
        ]);

        $this->expectException(RpcException::class);
        (new SyntheticRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_синтетика_отвергает_ответ_без_тенге(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => ['result' => 'success', 'rates' => ['EUR' => 0.9]],
            'coingecko'       => ['usd-coin' => ['usd' => 1.0]],
        ]);

        $this->expectException(RpcException::class);
        (new SyntheticRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_синтетика_отвергает_тело_null(): void
    {
        $http = new StubHttpClient([
            'open.er-api.com' => [],
            'coingecko'       => ['usd-coin' => ['usd' => 1.0]],
        ]);

        $this->expectException(RpcException::class);
        (new SyntheticRateSource($http))->get_kzt_per_token('USDC');
    }

    public function test_провайдер_берёт_курс_из_первого_источника(): void
    {
        $provider = new RateProvider([$this->source('binance', '459.60000000')], new ArrayCache(), 60);

        self::assertSame(
            ['rate' => '459.60000000', 'source' => 'binance'],
            $provider->get_kzt_per_token('USDC')
        );
    }

    public function test_провайдер_переключается_на_резервный(): void
    {
        $provider = new RateProvider([
            $this->failing_source('binance'),
            $this->source('synthetic', '455.29600000'),
        ], new ArrayCache(), 60);

        self::assertSame(
            ['rate' => '455.29600000', 'source' => 'synthetic'],
            $provider->get_kzt_per_token('USDC')
        );
    }

    public function test_провайдер_ловит_любую_ошибку_источника(): void
    {
        // Контракт источников держится на дисциплине, а не на типах: если
        // источник нарушит его, переключение всё равно должно сработать.
        $broken = new class implements RateSource {
            public function get_name(): string { return 'broken'; }
            public function get_kzt_per_token(string $token): string { throw new TypeError('что угодно'); }
        };

        $provider = new RateProvider([$broken, $this->source('synthetic', '455.00000000')], new ArrayCache(), 60);

        self::assertSame('synthetic', $provider->get_kzt_per_token('USDC')['source']);
    }

    public function test_провайдер_бросает_когда_упали_все(): void
    {
        $provider = new RateProvider([
            $this->failing_source('binance'),
            $this->failing_source('synthetic'),
        ], new ArrayCache(), 60);

        $this->expectException(RateUnavailableException::class);
        $provider->get_kzt_per_token('USDC');
    }

    public function test_провайдер_не_подставляет_устаревший_курс(): void
    {
        // Устаревший курс хуже явной ошибки: продавец получит деньги
        // неизвестно по какой цене и не узнает об этом.
        $cache = new ArrayCache();
        $flaky = new class implements RateSource {
            public bool $fail = false;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                if ($this->fail) { throw new RuntimeException('упал'); }

                return '459.60000000';
            }
        };

        $provider = new RateProvider([$flaky], $cache, 60);
        $provider->get_kzt_per_token('USDC');

        $flaky->fail = true;
        $cache->now += 120; // кеш истёк

        $this->expectException(RateUnavailableException::class);
        $provider->get_kzt_per_token('USDC');
    }

    public function test_провайдер_кеширует_успешный_ответ(): void
    {
        $counting = new class implements RateSource {
            public int $calls = 0;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->calls++;

                return '459.60000000';
            }
        };

        $provider = new RateProvider([$counting], new ArrayCache(), 60);
        $provider->get_kzt_per_token('USDC');
        $provider->get_kzt_per_token('USDC');

        self::assertSame(1, $counting->calls);
    }

    public function test_провайдер_не_кеширует_ошибку(): void
    {
        // Закешированная ошибка означала бы, что после единственного сбоя
        // биржи заказы падают до истечения срока, хотя биржа уже ожила.
        $cache = new ArrayCache();
        $flaky = new class implements RateSource {
            public int $calls = 0;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->calls++;
                if ($this->calls === 1) { throw new RuntimeException('первый раз упал'); }

                return '459.60000000';
            }
        };

        $provider = new RateProvider([$flaky], $cache, 60);

        try { $provider->get_kzt_per_token('USDC'); } catch (RateUnavailableException) { }

        self::assertSame('459.60000000', $provider->get_kzt_per_token('USDC')['rate']);
    }

    public function test_провайдер_кеширует_токены_раздельно(): void
    {
        $counting = new class implements RateSource {
            /** @var list<string> */
            public array $tokens = [];
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->tokens[] = $token;

                return $token === 'USDC' ? '459.60000000' : '47752.44000000';
            }
        };

        $provider = new RateProvider([$counting], new ArrayCache(), 60);
        $provider->get_kzt_per_token('USDC');
        $provider->get_kzt_per_token('SOL');
        $provider->get_kzt_per_token('USDC');

        self::assertSame(['USDC', 'SOL'], $counting->tokens);
    }

    private function source(string $name, string $rate): RateSource
    {
        return new class($name, $rate) implements RateSource {
            public function __construct(private string $name, private string $rate) {}
            public function get_name(): string { return $this->name; }
            public function get_kzt_per_token(string $token): string { return $this->rate; }
        };
    }

    private function failing_source(string $name): RateSource
    {
        return new class($name) implements RateSource {
            public function __construct(private string $name) {}
            public function get_name(): string { return $this->name; }
            public function get_kzt_per_token(string $token): string
            {
                throw new RpcException('источник недоступен');
            }
        };
    }
}
```

- [ ] **Шаг 3: Запустить тест и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter RatesTest`
Ожидается: FAIL — классов нет.

- [ ] **Шаг 4: Добавить получение по HTTP в интерфейс клиента**

Курс запрашивается методом GET, а существующий `HttpClient` умеет только POST.
Добавить в `includes/HttpClient.php` метод в интерфейс:

```php
    /**
     * @return array<string, mixed> Разобранный JSON-ответ.
     */
    public function get_json(string $url, int $timeout_seconds): array;
```

И реализовать в `includes/CurlHttpClient.php`, рядом с `post_json`:

```php
    public function get_json(string $url, int $timeout_seconds): array
    {
        return $this->request($url, null, $timeout_seconds);
    }
```

Общую часть `post_json` и `get_json` вынести в приватный `request()`: он
принимает `?array $payload` и при `null` не ставит `CURLOPT_POST`. Тело
метода `post_json` становится `return $this->request($url, $payload, $timeout_seconds);`.

Там же добавить в набор опций curl заголовок с названием клиента:

```php
    /** Представляемся: сервер вправе знать, кто к нему обращается. */
    private const USER_AGENT = 'SolanaPayKZ-WooCommerce/0.1 (+https://github.com/Tatancloud/solanapaykz)';
```

и `CURLOPT_USERAGENT => self::USER_AGENT` в массиве опций. **Без этого
резервный источник курса не работает:** CoinGecko отвечает 403 на запрос без
такого заголовка. Проверено — тот же запрос с заголовком возвращает 200.

Заголовок `Content-Type: application/json` перенести внутрь ветки для POST:
на запросе методом GET он бессмыслен.

**И обязательно:** добавление метода в интерфейс `HttpClient` ломает
существующий тест задачи 3 — его `FakeHttpClient` реализует только
`post_json` и перестаёт удовлетворять интерфейсу. В `tests/RpcTest.php`
добавить в `FakeHttpClient` метод `get_json`, бросающий исключение с
пояснением, что клиент блокчейна ходит только методом POST. Проверено:
без этой правки весь набор падает с фатальной ошибкой.

- [ ] **Шаг 5: Реализовать исключение и интерфейсы**

```php
<?php
// demo-shop/plugin/includes/RateUnavailableException.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use RuntimeException;

/** Ни один источник курса не ответил. */
final class RateUnavailableException extends RuntimeException
{
}
```

```php
<?php
// demo-shop/plugin/includes/RateSource.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/** Источник курса. Возвращает, сколько тенге стоит один токен. */
interface RateSource
{
    /** Короткое имя для записи в заказ — по нему разбирают спорные случаи. */
    public function get_name(): string;

    /** @return string Курс десятичной строкой. */
    public function get_kzt_per_token(string $token): string;
}
```

```php
<?php
// demo-shop/plugin/includes/Cache.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Хранилище с ограниченным сроком жизни.
 *
 * Вынесено в интерфейс, потому что транзиенты WordPress недоступны в тестах,
 * а набор обязан работать без поднятия WordPress.
 */
interface Cache
{
    public function get(string $key): ?string;

    public function set(string $key, string $value, int $ttl_seconds): void;
}
```

```php
<?php
// demo-shop/plugin/includes/TransientCache.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/** Кеш поверх транзиентов WordPress. */
final class TransientCache implements Cache
{
    private const PREFIX = 'solanapaykz_';

    public function get(string $key): ?string
    {
        $value = get_transient(self::PREFIX . $key);

        return is_string($value) ? $value : null;
    }

    public function set(string $key, string $value, int $ttl_seconds): void
    {
        set_transient(self::PREFIX . $key, $value, $ttl_seconds);
    }
}
```

- [ ] **Шаг 6: Реализовать источник Binance**

```php
<?php
// demo-shop/plugin/includes/BinanceRateSource.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Основной источник курса.
 *
 * На бирже существует ровно одна пара с тенге — USDTKZT, поэтому курс токена
 * собирается из двух тикеров: USDTKZT × USDCUSDT для USDC и USDTKZT × SOLUSDT
 * для SOL. Пар KZTUSDC или KZTSOL не существует.
 */
final class BinanceRateSource implements RateSource
{
    private const ENDPOINT = 'https://api.binance.com/api/v3/ticker/price';

    public function __construct(
        private HttpClient $http,
        private int $timeout_seconds = 10
    ) {
    }

    public function get_name(): string
    {
        return 'binance';
    }

    public function get_kzt_per_token(string $token): string
    {
        $kzt_per_usdt  = $this->fetch_price('USDTKZT');
        $usdt_per_token = $this->fetch_price($token === 'USDC' ? 'USDCUSDT' : 'SOLUSDT');

        return Money::multiply_rates($kzt_per_usdt, $usdt_per_token);
    }

    private function fetch_price(string $symbol): string
    {
        $data = $this->http->get_json(self::ENDPOINT . '?symbol=' . $symbol, $this->timeout_seconds);
        $price = $data['price'] ?? null;

        // Формат проверяется тем же предикатом, что и в денежном модуле:
        // иначе непригодное значение упадёт двумя слоями выше чужой ошибкой.
        // Точность в bccomp обязательна: без неё сравниваются только целые
        // части, и любая цена меньше единицы (а USDCUSDT колеблется около неё)
        // будет принята за ноль и отвергнута. Проверено.
        if (!is_string($price) || !Money::is_valid_decimal($price)
            || bccomp($price, '0', Money::RATE_DECIMALS) <= 0
        ) {
            throw new RpcException(sprintf(
                'Binance %s: непригодная цена %s.',
                $symbol,
                var_export($price, true)
            ));
        }

        return $price;
    }
}
```

- [ ] **Шаг 7: Реализовать резервный источник**

```php
<?php
// demo-shop/plugin/includes/SyntheticRateSource.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Резервный источник: курс доллара к тенге × цена токена в долларах.
 *
 * Прямой запрос цены в тенге у CoinGecko невозможен: тенге нет в списке его
 * валют, а на такой запрос он отвечает HTTP 200 и пустым объектом. Принять
 * это за ответ — значит выставить покупателю счёт на ноль.
 *
 * Курс доллара берётся у агрегатора и обновляется раз в сутки, поэтому его
 * значение отличается от биржевого примерно на процент. Для резервного
 * варианта это приемлемо, но должно быть названо в документации.
 */
final class SyntheticRateSource implements RateSource
{
    private const FX_ENDPOINT = 'https://open.er-api.com/v6/latest/USD';
    private const PRICE_ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';

    private const IDS = ['USDC' => 'usd-coin', 'SOL' => 'solana'];

    public function __construct(
        private HttpClient $http,
        private int $timeout_seconds = 10
    ) {
    }

    public function get_name(): string
    {
        return 'synthetic';
    }

    public function get_kzt_per_token(string $token): string
    {
        return Money::multiply_rates($this->fetch_kzt_per_usd(), $this->fetch_usd_per_token($token));
    }

    private function fetch_kzt_per_usd(): string
    {
        $data = $this->http->get_json(self::FX_ENDPOINT, $this->timeout_seconds);

        if (($data['result'] ?? null) !== 'success') {
            throw new RpcException('Курс валют: ответ без признака успеха.');
        }

        $rates = $data['rates'] ?? null;

        return $this->to_rate(
            is_array($rates) ? ($rates['KZT'] ?? null) : null,
            'Курс валют: в ответе нет тенге'
        );
    }

    private function fetch_usd_per_token(string $token): string
    {
        $id = self::IDS[$token] ?? null;

        if ($id === null) {
            throw new RpcException(sprintf('Неизвестный токен %s.', $token));
        }

        $url = self::PRICE_ENDPOINT . '?ids=' . $id . '&vs_currencies=usd';
        $data = $this->http->get_json($url, $this->timeout_seconds);
        $entry = $data[$id] ?? null;

        return $this->to_rate(
            is_array($entry) ? ($entry['usd'] ?? null) : null,
            sprintf('CoinGecko: нет цены для %s', $id)
        );
    }

    /**
     * Приводит число к строке курса, отвергая всё непригодное.
     *
     * Проверяется не только исходное число, но и результат форматирования:
     * очень большое значение даёт экспоненциальную запись, очень маленькое
     * округляется до нулей — и то, и другое непригодно как курс.
     */
    private function to_rate(mixed $value, string $error_message): string
    {
        if (!is_int($value) && !is_float($value)) {
            throw new RpcException(sprintf('%s (получено %s).', $error_message, var_export($value, true)));
        }

        if (!is_finite((float) $value) || $value <= 0) {
            throw new RpcException(sprintf('%s (непригодное значение %s).', $error_message, var_export($value, true)));
        }

        $formatted = number_format((float) $value, Money::RATE_DECIMALS, '.', '');

        // Точность обязательна по той же причине, что и в источнике Binance:
        // цена USDC к доллару меньше единицы, и сравнение по целым частям
        // отвергло бы её как нулевую.
        if (!Money::is_valid_decimal($formatted) || bccomp($formatted, '0', Money::RATE_DECIMALS) <= 0) {
            throw new RpcException(sprintf('%s (после форматирования получилось %s).', $error_message, $formatted));
        }

        return $formatted;
    }
}
```

- [ ] **Шаг 8: Реализовать провайдер с фолбэком и кешем**

```php
<?php
// demo-shop/plugin/includes/RateProvider.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;

/**
 * Опрашивает источники по порядку и отдаёт первый успешный ответ.
 *
 * Устаревший курс не подставляется никогда: если все источники недоступны,
 * вызывающая сторона получает ошибку. Продавец, получивший деньги по
 * неизвестному курсу, — хуже продавца, увидевшего явный отказ.
 */
final class RateProvider
{
    /** @param list<RateSource> $sources Порядок задаёт приоритет. */
    public function __construct(
        private array $sources,
        private Cache $cache,
        private int $cache_ttl_seconds
    ) {
    }

    /** @return array{rate: string, source: string} */
    public function get_kzt_per_token(string $token): array
    {
        $key = 'rate_' . $token;
        $cached = $this->cache->get($key);

        if ($cached !== null) {
            $parts = explode('|', $cached, 2);

            if (count($parts) === 2 && Money::is_valid_decimal($parts[0])) {
                return ['rate' => $parts[0], 'source' => $parts[1]];
            }
        }

        $failures = [];

        foreach ($this->sources as $source) {
            try {
                $rate = $source->get_kzt_per_token($token);
            } catch (Throwable $error) {
                // Ловим любую ошибку, а не только свою: контракт источников
                // держится на дисциплине, и его нарушение не должно ронять заказ.
                $failures[] = $source->get_name() . ': ' . $error->getMessage();
                continue;
            }

            if ($this->cache_ttl_seconds > 0) {
                $this->cache->set($key, $rate . '|' . $source->get_name(), $this->cache_ttl_seconds);
            }

            return ['rate' => $rate, 'source' => $source->get_name()];
        }

        throw new RateUnavailableException(
            'Ни один источник курса не ответил. ' . implode('; ', $failures)
        );
    }
}
```

- [ ] **Шаг 9: Подключить в точке входа**

В `solanapaykz.php` после `Verify.php` добавить в этом порядке:

```php
require_once __DIR__ . '/includes/RateUnavailableException.php';
require_once __DIR__ . '/includes/RateSource.php';
require_once __DIR__ . '/includes/Cache.php';
require_once __DIR__ . '/includes/TransientCache.php';
require_once __DIR__ . '/includes/BinanceRateSource.php';
require_once __DIR__ . '/includes/SyntheticRateSource.php';
require_once __DIR__ . '/includes/RateProvider.php';
```

- [ ] **Шаг 10: Запустить тесты**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit`
Ожидается: PASS, 57 прежних тестов плюс новые.

- [ ] **Шаг 11: Проверить на живых биржах**

```bash
docker exec solanapaykz_shop php -r '
define("ABSPATH", "/tmp/");
$b = "/var/www/html/wp-content/plugins/solanapaykz/includes/";
foreach (["Money","RpcException","HttpClient","CurlHttpClient","RateUnavailableException","RateSource","BinanceRateSource","SyntheticRateSource"] as $c) require $b . $c . ".php";
$http = new SolanaPayKZ\CurlHttpClient();
printf("Binance USDC:   %s\n", (new SolanaPayKZ\BinanceRateSource($http))->get_kzt_per_token("USDC"));
printf("синтетика USDC: %s\n", (new SolanaPayKZ\SyntheticRateSource($http))->get_kzt_per_token("USDC"));
'
```
Ожидается: два курса около 455-460 ₸, отличающиеся примерно на процент.

- [ ] **Шаг 12: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: курс тенге к токену с резервным источником"
git push -u origin feat/wc-rates
```

---

### Задача 6: Токены и котировка

**Файлы:**
- Создать: `demo-shop/plugin/includes/Tokens.php`, `includes/Quote.php`,
  `includes/QuoteException.php`
- Изменить: `demo-shop/plugin/solanapaykz.php` (подключение)
- Тест: `demo-shop/plugin/tests/TokensTest.php`, `tests/QuoteTest.php`

**Интерфейсы:**
- Потребляет: `Money`, `RateProvider` из задачи 5.
- Отдаёт: `Tokens::resolve(string $cluster, string $token): array{mint: ?string, decimals: int}`,
  константу `Tokens::SUPPORTED`;
  класс `Quote` с публичными readonly-свойствами и методами
  `Quote::create(RateProvider $rates, string $amount_kzt, string $token, string $cluster, float $markup_percent = 0.0, int $ttl_seconds = 900): self`,
  `is_expired(?int $now = null): bool`, `to_array(): array`,
  `Quote::from_array(array $data): self`;
  исключение `QuoteException`.

Котировка хранится в метаданных заказа и возвращается оттуда при каждой
проверке платежа — то есть приходит извне, из чужой базы. Поэтому
`from_array` проверяет каждое поле заново, а не доверяет содержимому.

- [ ] **Шаг 1: Создать ветку**

```bash
cd /var/www/solanapaykz && git checkout main && git pull
git checkout -b feat/wc-quote
```

- [ ] **Шаг 2: Написать падающий тест для токенов**

```php
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
```

- [ ] **Шаг 3: Запустить и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter TokensTest`
Ожидается: FAIL — классов нет.

- [ ] **Шаг 4: Реализовать исключение и токены**

```php
<?php
// demo-shop/plugin/includes/QuoteException.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use RuntimeException;

/** Котировка непригодна: неверные данные на входе или испорченная запись заказа. */
final class QuoteException extends RuntimeException
{
}
```

```php
<?php
// demo-shop/plugin/includes/Tokens.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Адреса монет по сетям.
 *
 * Адреса проверены запросом getTokenSupply к соответствующей сети: ошибка
 * в одном символе означала бы платежи в никуда.
 */
final class Tokens
{
    public const SUPPORTED = ['USDC', 'SOL'];

    private const TABLE = [
        'mainnet' => [
            'USDC' => ['mint' => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'decimals' => 6],
            'SOL'  => ['mint' => null, 'decimals' => 9],
        ],
        'devnet' => [
            'USDC' => ['mint' => '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'decimals' => 6],
            'SOL'  => ['mint' => null, 'decimals' => 9],
        ],
    ];

    /** @return array{mint: ?string, decimals: int} */
    public static function resolve(string $cluster, string $token): array
    {
        $entry = self::TABLE[$cluster][$token] ?? null;

        if ($entry === null) {
            throw new QuoteException(sprintf(
                'Неизвестное сочетание сети и монеты: %s / %s.',
                $cluster,
                $token
            ));
        }

        return $entry;
    }
}
```

- [ ] **Шаг 5: Написать падающий тест для котировки**

```php
<?php
// demo-shop/plugin/tests/QuoteTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Cache;
use SolanaPayKZ\Quote;
use SolanaPayKZ\QuoteException;
use SolanaPayKZ\RateProvider;
use SolanaPayKZ\RateSource;

final class QuoteTest extends TestCase
{
    private function rates(string $rate = '459.60000000', string $name = 'binance'): RateProvider
    {
        $source = new class($rate, $name) implements RateSource {
            public function __construct(private string $rate, private string $name) {}
            public function get_name(): string { return $this->name; }
            public function get_kzt_per_token(string $token): string { return $this->rate; }
        };

        $cache = new class implements Cache {
            public function get(string $key): ?string { return null; }
            public function set(string $key, string $value, int $ttl_seconds): void {}
        };

        return new RateProvider([$source], $cache, 0);
    }

    public function test_считает_сумму_к_оплате(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertSame('21.758051', $quote->amount_token);
        self::assertSame('10000', $quote->amount_kzt);
        self::assertSame('10000.00', $quote->amount_kzt_charged);
        self::assertSame('459.60000000', $quote->rate);
        self::assertSame('binance', $quote->rate_source);
    }

    public function test_срок_жизни_по_умолчанию_пятнадцать_минут(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertSame(900, $quote->expires_at - $quote->created_at);
    }

    public function test_применяет_наценку_к_сумме_в_тенге(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet', 1.0);

        self::assertSame('10100.00', $quote->amount_kzt_charged);
        self::assertSame('21.975631', $quote->amount_token);
    }

    public function test_считает_sol_с_девятью_знаками(): void
    {
        $quote = Quote::create($this->rates('47758.44000000'), '10000', 'SOL', 'mainnet');

        self::assertSame('0.209387074', $quote->amount_token);
    }

    public function test_идентификатор_уникален(): void
    {
        $first = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');
        $second = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertNotSame($first->quote_id, $second->quote_id);
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $first->quote_id);
    }

    public function test_просрочена_начиная_с_момента_истечения(): void
    {
        $quote = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');

        self::assertFalse($quote->is_expired($quote->expires_at - 1));
        self::assertTrue($quote->is_expired($quote->expires_at));
        self::assertTrue($quote->is_expired($quote->expires_at + 1));
    }

    public function test_отвергает_нулевую_сумму(): void
    {
        $this->expectException(QuoteException::class);
        Quote::create($this->rates(), '0', 'USDC', 'mainnet');
    }

    public function test_отвергает_сумму_с_избыточной_точностью(): void
    {
        $this->expectException(QuoteException::class);
        Quote::create($this->rates(), '100.999', 'USDC', 'mainnet');
    }

    public function test_отвергает_неположительный_срок_жизни(): void
    {
        $this->expectException(QuoteException::class);
        Quote::create($this->rates(), '10000', 'USDC', 'mainnet', 0.0, 0);
    }

    public function test_не_обращается_к_курсу_при_неверном_вводе(): void
    {
        // Сетевой запрос ради заведомо неверной суммы — лишняя задержка
        // на кассе и лишний запрос к бирже.
        $counting = new class implements RateSource {
            public int $calls = 0;
            public function get_name(): string { return 'binance'; }
            public function get_kzt_per_token(string $token): string
            {
                $this->calls++;

                return '459.60000000';
            }
        };

        $cache = new class implements Cache {
            public function get(string $key): ?string { return null; }
            public function set(string $key, string $value, int $ttl_seconds): void {}
        };

        try {
            Quote::create(new RateProvider([$counting], $cache, 0), 'мусор', 'USDC', 'mainnet');
        } catch (QuoteException) {
            // ожидаемо
        }

        self::assertSame(0, $counting->calls);
    }

    public function test_путешествие_через_массив_сохраняет_котировку(): void
    {
        $original = Quote::create($this->rates(), '10000', 'USDC', 'mainnet');
        $restored = Quote::from_array($original->to_array());

        self::assertEquals($original, $restored);
    }

    public function test_восстановление_отвергает_испорченную_запись(): void
    {
        $valid = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();

        $broken = [
            'без суммы токена'      => ['amount_token' => null],
            'сумма токена нулевая'  => ['amount_token' => '0.000000'],
            'сумма токена мусор'    => ['amount_token' => 'не-число'],
            'нет курса'             => ['rate' => null],
            'курс нулевой'          => ['rate' => '0'],
            'неизвестная монета'    => ['token' => 'BTC'],
            'неизвестная сеть'      => ['cluster' => 'testnet'],
            'срок раньше создания'  => ['expires_at' => $valid['created_at'] - 1],
            'идентификатор пустой'  => ['quote_id' => ''],
        ];

        foreach ($broken as $label => $override) {
            try {
                Quote::from_array(array_merge($valid, $override));
                self::fail("Испорченная запись «{$label}» должна быть отвергнута.");
            } catch (QuoteException) {
                self::assertTrue(true);
            }
        }
    }

    public function test_восстановление_отвергает_отсутствующее_поле(): void
    {
        $valid = Quote::create($this->rates(), '10000', 'USDC', 'mainnet')->to_array();
        unset($valid['rate_source']);

        $this->expectException(QuoteException::class);
        Quote::from_array($valid);
    }
}
```

- [ ] **Шаг 6: Запустить и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter QuoteTest`
Ожидается: FAIL — класса `Quote` нет.

- [ ] **Шаг 7: Реализовать котировку**

```php
<?php
// demo-shop/plugin/includes/Quote.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;

/**
 * Зафиксированная цена заказа в криптовалюте.
 *
 * QR-код несёт неизменную сумму, а платит покупатель когда захочет, поэтому
 * курс замораживается на ограниченный срок: риск его сдвига несёт продавец.
 *
 * Свойства объявлены readonly: котировку хранят в заказе и потом сверяют с
 * пришедшим платежом, поэтому менять её после создания нельзя.
 */
final class Quote
{
    /** Пятнадцать минут. Обоснование срока — в спецификации, раздел 7. */
    public const DEFAULT_TTL_SECONDS = 900;

    private function __construct(
        public readonly string $quote_id,
        public readonly string $amount_kzt,
        public readonly string $amount_kzt_charged,
        public readonly string $token,
        public readonly string $cluster,
        public readonly string $amount_token,
        public readonly string $rate,
        public readonly string $rate_source,
        public readonly int $created_at,
        public readonly int $expires_at
    ) {
    }

    public static function create(
        RateProvider $rates,
        string $amount_kzt,
        string $token,
        string $cluster,
        float $markup_percent = 0.0,
        int $ttl_seconds = self::DEFAULT_TTL_SECONDS
    ): self {
        if ($ttl_seconds <= 0) {
            throw new QuoteException(
                sprintf('Срок жизни котировки должен быть положительным, получено %d.', $ttl_seconds)
            );
        }

        // Всё дешёвое и синхронное — до сетевого запроса за курсом: нет смысла
        // ходить к бирже ради заведомо неверной суммы.
        $decimals = Tokens::resolve($cluster, $token)['decimals'];

        try {
            $charged = Money::apply_markup($amount_kzt, $markup_percent);
        } catch (Throwable $error) {
            throw new QuoteException($error->getMessage(), 0, $error);
        }

        if (bccomp(Money::parse_decimal_to_units($charged, Money::KZT_DECIMALS), '0') <= 0) {
            throw new QuoteException('Сумма заказа должна быть больше нуля.');
        }

        $rate = $rates->get_kzt_per_token($token);

        try {
            $units = Money::convert_kzt_to_token_units($charged, $rate['rate'], $decimals);
        } catch (Throwable $error) {
            throw new QuoteException($error->getMessage(), 0, $error);
        }

        $now = time();

        return new self(
            bin2hex(random_bytes(16)),
            $amount_kzt,
            $charged,
            $token,
            $cluster,
            Money::format_units($units, $decimals),
            $rate['rate'],
            $rate['source'],
            $now,
            $now + $ttl_seconds
        );
    }

    /** Котировка просрочена начиная с момента истечения включительно. */
    public function is_expired(?int $now = null): bool
    {
        return ($now ?? time()) >= $this->expires_at;
    }

    /** @return array<string, string|int> */
    public function to_array(): array
    {
        return [
            'quote_id'           => $this->quote_id,
            'amount_kzt'         => $this->amount_kzt,
            'amount_kzt_charged' => $this->amount_kzt_charged,
            'token'              => $this->token,
            'cluster'            => $this->cluster,
            'amount_token'       => $this->amount_token,
            'rate'               => $this->rate,
            'rate_source'        => $this->rate_source,
            'created_at'         => $this->created_at,
            'expires_at'         => $this->expires_at,
        ];
    }

    /**
     * Восстанавливает котировку из записи заказа.
     *
     * Каждое поле проверяется заново: запись пролежала в базе магазина и
     * пришла к нам извне. Пустое поле суммы из-за неудачной миграции
     * означало бы проверку платежа на нулевую сумму, то есть подтверждение
     * любого перевода.
     *
     * @param array<string, mixed> $data
     */
    public static function from_array(array $data): self
    {
        foreach (['quote_id', 'amount_kzt', 'amount_kzt_charged', 'token', 'cluster',
                  'amount_token', 'rate', 'rate_source', 'created_at', 'expires_at'] as $field) {
            if (!array_key_exists($field, $data)) {
                throw new QuoteException(sprintf('В записи котировки нет поля «%s».', $field));
            }
        }

        $decimals = Tokens::resolve((string) $data['cluster'], (string) $data['token'])['decimals'];

        $quote_id = (string) $data['quote_id'];

        if ($quote_id === '') {
            throw new QuoteException('Идентификатор котировки пуст.');
        }

        self::require_positive_amount((string) $data['amount_token'], $decimals, 'Сумма к оплате');
        self::require_positive_amount((string) $data['rate'], Money::RATE_DECIMALS, 'Курс');

        $created_at = (int) $data['created_at'];
        $expires_at = (int) $data['expires_at'];

        if ($expires_at <= $created_at) {
            throw new QuoteException('Срок истечения котировки не позже момента её создания.');
        }

        return new self(
            $quote_id,
            (string) $data['amount_kzt'],
            (string) $data['amount_kzt_charged'],
            (string) $data['token'],
            (string) $data['cluster'],
            (string) $data['amount_token'],
            (string) $data['rate'],
            (string) $data['rate_source'],
            $created_at,
            $expires_at
        );
    }

    private static function require_positive_amount(string $value, int $decimals, string $label): void
    {
        // Точность в сравнении обязательна: без неё сверяются только целые
        // части, и любое значение меньше единицы считается нулём.
        if (!Money::is_valid_decimal($value) || bccomp($value, '0', $decimals) <= 0) {
            throw new QuoteException(sprintf(
                '%s в записи котировки непригодна: %s.',
                $label,
                var_export($value, true)
            ));
        }
    }
}
```

- [ ] **Шаг 8: Подключить в точке входа**

В `solanapaykz.php` после `RateProvider.php` добавить:

```php
require_once __DIR__ . '/includes/QuoteException.php';
require_once __DIR__ . '/includes/Tokens.php';
require_once __DIR__ . '/includes/Quote.php';
```

- [ ] **Шаг 9: Запустить весь набор**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit`
Ожидается: PASS, 81 прежний тест плюс новые.

- [ ] **Шаг 10: Проверить на живом курсе**

```bash
docker exec solanapaykz_shop php -r '
define("ABSPATH", "/tmp/");
$b = "/var/www/html/wp-content/plugins/solanapaykz/includes/";
foreach (["Money","RpcException","HttpClient","CurlHttpClient","RateUnavailableException","RateSource","Cache","BinanceRateSource","SyntheticRateSource","RateProvider","QuoteException","Tokens","Quote"] as $c) require $b . $c . ".php";
$http = new SolanaPayKZ\CurlHttpClient();
$cache = new class implements SolanaPayKZ\Cache {
    private array $i = [];
    public function get(string $k): ?string { return $this->i[$k] ?? null; }
    public function set(string $k, string $v, int $t): void { $this->i[$k] = $v; }
};
$rates = new SolanaPayKZ\RateProvider([new SolanaPayKZ\BinanceRateSource($http)], $cache, 60);
$q = SolanaPayKZ\Quote::create($rates, "25000", "USDC", "mainnet");
printf("25000 ₸ -> %s USDC (курс %s от «%s»)\n", $q->amount_token, $q->rate, $q->rate_source);
printf("действует %d минут, идентификатор %s\n", ($q->expires_at - $q->created_at) / 60, $q->quote_id);
$restored = SolanaPayKZ\Quote::from_array($q->to_array());
printf("после путешествия через массив: %s USDC\n", $restored->amount_token);
'
```
Ожидается: сумма в USDC по живому курсу, срок 15 минут, восстановленная котировка совпадает.

- [ ] **Шаг 11: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: токены и котировка со сроком жизни"
git push -u origin feat/wc-quote
```

---

### Задача 7: Метка платежа и ссылка Solana Pay

**Файлы:**
- Создать: `demo-shop/plugin/includes/Base58.php`, `includes/PaymentRequest.php`
- Изменить: `demo-shop/plugin/solanapaykz.php` (подключение)
- Тест: `demo-shop/plugin/tests/Base58Test.php`, `tests/PaymentRequestTest.php`

**Интерфейсы:**
- Потребляет: `Quote`, `Tokens`, `QuoteException`.
- Отдаёт: `Base58::encode(string $bytes): string`;
  класс `PaymentRequest` с readonly-свойствами `quote`, `reference`, `url` и
  методами `PaymentRequest::create(Quote $quote, string $recipient, array $options = []): self`,
  `PaymentRequest::generate_reference(): string`.

Ссылки, которые строит этот код, проверены на совпадение с эталонной
библиотекой `@solana/pay`: PHP-функция кодирования параметров запроса даёт
байт-в-байт тот же результат, что её JavaScript-аналог. Эталоны получены
запуском самой библиотеки и вписаны в тесты.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout main && git pull
git checkout -b feat/wc-payment-request
```

- [ ] **Шаг 2: Написать падающий тест для base58**

```php
<?php
// demo-shop/plugin/tests/Base58Test.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\Base58;

final class Base58Test extends TestCase
{
    public function test_тридцать_два_нулевых_байта_дают_известный_адрес(): void
    {
        // Это System Program — адрес, который знает любой, кто работал с Solana.
        // Совпадение с ним подтверждает, что алгоритм реализован верно.
        self::assertSame(
            '11111111111111111111111111111111',
            Base58::encode(str_repeat("\x00", 32))
        );
    }

    public function test_короткие_последовательности(): void
    {
        self::assertSame('1', Base58::encode("\x00"));
        self::assertSame('2', Base58::encode("\x01"));
        self::assertSame('11', Base58::encode("\x00\x00"));
    }

    public function test_пустой_вход_даёт_пустую_строку(): void
    {
        self::assertSame('', Base58::encode(''));
    }

    public function test_ведущие_нули_сохраняются(): void
    {
        // Ведущие нулевые байты кодируются единицами и не должны теряться:
        // адрес с ними — другой адрес.
        self::assertSame('112', Base58::encode("\x00\x00\x01"));
    }

    public function test_алфавит_без_похожих_символов(): void
    {
        // В base58 нет нуля, заглавной O, заглавной I и строчной l —
        // чтобы адрес нельзя было перепутать при чтении глазами.
        for ($i = 0; $i < 50; $i++) {
            $encoded = Base58::encode(random_bytes(32));

            self::assertSame(
                strlen($encoded),
                strspn($encoded, '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'),
                'Встретился символ вне алфавита base58: ' . $encoded
            );
        }
    }

    public function test_длина_метки_из_тридцати_двух_байт(): void
    {
        for ($i = 0; $i < 50; $i++) {
            $length = strlen(Base58::encode(random_bytes(32)));

            self::assertGreaterThanOrEqual(32, $length);
            self::assertLessThanOrEqual(44, $length);
        }
    }
}
```

- [ ] **Шаг 3: Запустить и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter Base58Test`
Ожидается: FAIL — класса нет.

- [ ] **Шаг 4: Реализовать base58**

```php
<?php
// demo-shop/plugin/includes/Base58.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Кодирование в base58 — том виде, в котором Solana записывает адреса.
 *
 * Встроенного кодировщика в PHP нет, расширения gmp на типичном хостинге
 * тоже может не быть, поэтому считаем на bcmath. Алфавит без нуля,
 * заглавной O, заглавной I и строчной l: адрес не должен читаться
 * двусмысленно.
 */
final class Base58
{
    private const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    public static function encode(string $bytes): string
    {
        if ($bytes === '') {
            return '';
        }

        $number = '0';

        for ($i = 0, $length = strlen($bytes); $i < $length; $i++) {
            $number = bcadd(bcmul($number, '256'), (string) ord($bytes[$i]));
        }

        $encoded = '';

        while (bccomp($number, '0') > 0) {
            $encoded = self::ALPHABET[(int) bcmod($number, '58')] . $encoded;
            $number = bcdiv($number, '58', 0);
        }

        // Ведущие нулевые байты кодируются единицами: без этого адрес,
        // начинающийся с нулей, превратился бы в другой адрес.
        for ($i = 0, $length = strlen($bytes); $i < $length && $bytes[$i] === "\x00"; $i++) {
            $encoded = self::ALPHABET[0] . $encoded;
        }

        return $encoded;
    }
}
```

- [ ] **Шаг 5: Написать падающий тест для платёжного запроса**

```php
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
```

- [ ] **Шаг 6: Запустить и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter PaymentRequestTest`
Ожидается: FAIL — класса нет.

- [ ] **Шаг 7: Реализовать платёжный запрос**

```php
<?php
// demo-shop/plugin/includes/PaymentRequest.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Ссылка Solana Pay, которую покупатель открывает кошельком.
 *
 * Метка платежа — 32 случайных байта в виде адреса. Пара ключей при этом
 * не создаётся и приватного ключа не существует: метка только помечает
 * транзакцию, средств не касается. Требование безопасности из технического
 * задания соблюдается буквально.
 */
final class PaymentRequest
{
    /** Адрес в base58 короче 32 символов заведомо неверен. */
    private const ADDRESS_PATTERN = '/^[1-9A-HJ-NP-Za-km-z]{32,44}$/';

    private function __construct(
        public readonly Quote $quote,
        public readonly string $reference,
        public readonly string $url
    ) {
    }

    /** Случайная метка платежа. Пара ключей не создаётся. */
    public static function generate_reference(): string
    {
        return Base58::encode(random_bytes(32));
    }

    /**
     * @param array{reference?: string, label?: string, message?: string, memo?: string} $options
     */
    public static function create(Quote $quote, string $recipient, array $options = []): self
    {
        if ($quote->is_expired()) {
            throw new QuoteException(sprintf(
                'Котировка %s просрочена, платёжную ссылку по ней выпустить нельзя.',
                $quote->quote_id
            ));
        }

        self::require_valid_address($recipient, 'Адрес получателя');

        $token = Tokens::resolve($quote->cluster, $quote->token);

        // Частая ошибка при настройке: в поле адреса продавца вписывают адрес
        // самой монеты. Владельца у такого счёта нет, и платежи туда уходят
        // безвозвратно — лучше отказать сейчас, чем потерять деньги покупателя.
        if ($token['mint'] !== null && $recipient === $token['mint']) {
            throw new QuoteException(
                'Адрес получателя совпадает с адресом монеты. Укажите адрес кошелька продавца.'
            );
        }

        $reference = $options['reference'] ?? self::generate_reference();
        self::require_valid_address($reference, 'Метка платежа');

        $params = ['amount' => self::trim_zeros($quote->amount_token)];

        if ($token['mint'] !== null) {
            $params['spl-token'] = $token['mint'];
        }

        $params['reference'] = $reference;

        foreach (['label', 'message', 'memo'] as $field) {
            $value = $options[$field] ?? '';

            if ($value !== '') {
                $params[$field] = $value;
            }
        }

        return new self(
            $quote,
            $reference,
            'solana:' . $recipient . '?' . http_build_query($params)
        );
    }

    /**
     * Убирает незначащие нули: библиотека, на которую ориентируются кошельки,
     * выводит «1», а не «1.000000». Одинаковая сумма должна давать одинаковый
     * QR-код независимо от того, чем он построен.
     */
    private static function trim_zeros(string $amount): string
    {
        if (!str_contains($amount, '.')) {
            return $amount;
        }

        return rtrim(rtrim($amount, '0'), '.');
    }

    private static function require_valid_address(string $address, string $label): void
    {
        if ($address === '') {
            throw new QuoteException(sprintf('%s не указан.', $label));
        }

        if (preg_match(self::ADDRESS_PATTERN, $address) !== 1) {
            throw new QuoteException(sprintf(
                '%s не похож на адрес Solana: %s.',
                $label,
                $address
            ));
        }
    }
}
```

- [ ] **Шаг 8: Подключить в точке входа**

В `solanapaykz.php` после `Quote.php` добавить:

```php
require_once __DIR__ . '/includes/Base58.php';
require_once __DIR__ . '/includes/PaymentRequest.php';
```

- [ ] **Шаг 9: Запустить весь набор**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit`
Ожидается: PASS, 108 прежних тестов плюс новые.

- [ ] **Шаг 10: Сверить ссылку с эталонной библиотекой вживую**

Тест выше сверяется с записанным эталоном. Этот шаг проверяет, что эталон
не устарел: тот же запрос строится обеими реализациями и сравнивается.

```bash
cd /var/www/solanapaykz
cat > /tmp/cmp.test.ts <<'TS'
import { describe, it, expect } from 'vitest';
import { encodeURL } from '@solana/pay';
import { address } from '@solana/kit';

describe('сверка с PHP', () => {
  it('ссылка совпадает', () => {
    const url = encodeURL({
      recipient: address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'),
      amount: 21.758051,
      splToken: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      reference: address('DU4LZngDuaUGmzyhWiG7QwMqjF4C3b2dbjSmsH5wB1Jh'),
      label: 'Магазин',
      message: 'Заказ №123',
    }).toString();
    console.log('JS: ' + url);
    expect(url).toContain('solana:');
  });
});
TS
cp /tmp/cmp.test.ts tests/tmp-cmp.test.ts
npx vitest run tests/tmp-cmp.test.ts 2>&1 | grep "^JS:"
rm tests/tmp-cmp.test.ts
```

Затем то же на PHP и сравнить строки глазами — они должны совпасть символ
в символ, включая порядок параметров и кодировку кириллицы.

- [ ] **Шаг 11: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: метка платежа и ссылка Solana Pay"
git push -u origin feat/wc-payment-request
```

---

### Задача 8: Настройки продавца и платёжный шлюз

**Файлы:**
- Создать: `demo-shop/plugin/includes/GatewaySettings.php`, `includes/OrderMeta.php`,
  `includes/Gateway.php`
- Изменить: `demo-shop/plugin/solanapaykz.php` (подключение и регистрация шлюза)
- Тест: `demo-shop/plugin/tests/GatewaySettingsTest.php`

**Интерфейсы:**
- Потребляет: `Tokens`, `Base58`, `QuoteException`, `Quote`, `PaymentRequest`,
  `RateProvider`, `BinanceRateSource`, `SyntheticRateSource`, `TransientCache`.
- Отдаёт: `GatewaySettings::validate(array $values): array` — список сообщений об
  ошибках, пустой массив если всё верно; `GatewaySettings::fields(): array` —
  описание полей для админки; константы `OrderMeta::QUOTE`, `OrderMeta::REFERENCE`,
  `OrderMeta::SIGNATURE`, `OrderMeta::LATE_PAYMENT` и методы чтения-записи;
  класс `Gateway extends \WC_Payment_Gateway`.

**Что здесь тестируется автоматически, а что руками.** Проверка настроек —
чистая логика без WordPress, она покрывается тестами. Сам шлюз обращается к
функциям WordPress (`wc_get_order`, `get_option`, `wp_enqueue_script`), которых
в тестовом окружении нет, поэтому он делается предельно тонким: принимает
решение, зовёт готовые классы и отдаёт результат. Его проверяем вручную на
демо-магазине, шаги в конце задачи.

- [ ] **Шаг 1: Создать ветку**

```bash
git checkout main && git pull
git checkout -b feat/wc-gateway
```

- [ ] **Шаг 2: Написать падающий тест проверки настроек**

```php
<?php
// demo-shop/plugin/tests/GatewaySettingsTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use SolanaPayKZ\GatewaySettings;

final class GatewaySettingsTest extends TestCase
{
    private const MERCHANT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    private const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
        self::assertSame([], GatewaySettings::validate($this->valid()));
    }

    public function test_требует_адрес_продавца(): void
    {
        $errors = GatewaySettings::validate($this->valid(['recipient' => '']));

        self::assertCount(1, $errors);
        self::assertStringContainsString('адрес', mb_strtolower($errors[0]));
    }

    public function test_отвергает_адрес_неверной_длины_в_байтах(): void
    {
        // Строка из допустимых символов правильной длины может не быть
        // адресом: настоящий адрес Solana — ровно 32 байта.
        $errors = GatewaySettings::validate($this->valid(['recipient' => str_repeat('z', 44)]));

        self::assertCount(1, $errors);
    }

    public function test_отвергает_адрес_монеты_вместо_кошелька(): void
    {
        // Частая ошибка настройки: платежи по такому адресу уходят безвозвратно.
        $errors = GatewaySettings::validate($this->valid(['recipient' => self::USDC_MINT]));

        self::assertCount(1, $errors);
        self::assertStringContainsString('монет', mb_strtolower($errors[0]));
    }

    public function test_адрес_монеты_другой_сети_тоже_отвергается(): void
    {
        $errors = GatewaySettings::validate($this->valid([
            'cluster' => 'devnet',
            'recipient' => '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        ]));

        self::assertCount(1, $errors);
    }

    public function test_требует_адрес_узла(): void
    {
        $errors = GatewaySettings::validate($this->valid(['rpc_url' => '']));

        self::assertCount(1, $errors);
        self::assertStringContainsString('узл', mb_strtolower($errors[0]));
    }

    public function test_отвергает_адрес_узла_не_похожий_на_ссылку(): void
    {
        foreach (['не-ссылка', 'ftp://узел', 'httpsx://a.b', '//rpc.example.com'] as $bad) {
            $errors = GatewaySettings::validate($this->valid(['rpc_url' => $bad]));

            self::assertNotSame([], $errors, "Адрес «{$bad}» должен быть отвергнут.");
        }
    }

    public function test_принимает_адрес_узла_по_http_и_https(): void
    {
        foreach (['https://rpc.example.com', 'http://127.0.0.1:8899'] as $good) {
            self::assertSame([], GatewaySettings::validate($this->valid(['rpc_url' => $good])));
        }
    }

    public function test_отвергает_неизвестную_сеть(): void
    {
        self::assertNotSame([], GatewaySettings::validate($this->valid(['cluster' => 'testnet'])));
    }

    public function test_отвергает_неизвестную_монету(): void
    {
        self::assertNotSame([], GatewaySettings::validate($this->valid(['token' => 'BTC'])));
    }

    public function test_отвергает_наценку_вне_допустимых_границ(): void
    {
        foreach (['-1', '101', 'не-число'] as $bad) {
            self::assertNotSame([], GatewaySettings::validate($this->valid(['markup_percent' => $bad])));
        }
    }

    public function test_принимает_дробную_наценку(): void
    {
        self::assertSame([], GatewaySettings::validate($this->valid(['markup_percent' => '2.5'])));
    }

    public function test_отвергает_наценку_меньше_минимального_шага(): void
    {
        // 0,004 процента после округления превращается в ноль: продавец
        // настроит наценку и не заметит, что её нет.
        self::assertNotSame([], GatewaySettings::validate($this->valid(['markup_percent' => '0.004'])));
    }

    public function test_отвергает_срок_жизни_котировки_вне_разумных_границ(): void
    {
        foreach (['0', '-60', '90000', 'не-число'] as $bad) {
            self::assertNotSame([], GatewaySettings::validate($this->valid(['quote_ttl' => $bad])));
        }
    }

    public function test_ноль_в_сроке_проверки_отменённых_допустим(): void
    {
        // Ноль означает «не проверять отменённые заказы» — осознанный выбор
        // продавца, а не ошибка.
        self::assertSame([], GatewaySettings::validate($this->valid(['late_window' => '0'])));
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
        ]);

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
```

- [ ] **Шаг 3: Запустить и убедиться, что падает**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter GatewaySettingsTest`
Ожидается: FAIL — класса нет.

- [ ] **Шаг 4: Реализовать проверку настроек**

```php
<?php
// demo-shop/plugin/includes/GatewaySettings.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;

/**
 * Настройки продавца и их проверка.
 *
 * Проверка вынесена из класса шлюза, чтобы её можно было покрыть тестами:
 * сам шлюз завязан на функции WordPress и в тестовом окружении не работает.
 *
 * Ошибки собираются списком, а не выбрасываются на первой: продавец должен
 * увидеть всё, что нужно исправить, за один заход.
 */
final class GatewaySettings
{
    /** Верхняя граница срока жизни котировки — сутки. */
    private const MAX_QUOTE_TTL = 86400;

    /** Верхняя граница окна проверки отменённых заказов — неделя. */
    private const MAX_LATE_WINDOW = 604800;

    /**
     * @param array<string, mixed> $values
     * @return list<string> Сообщения об ошибках на русском.
     */
    public static function validate(array $values): array
    {
        $errors = [];

        $cluster = (string) ($values['cluster'] ?? '');
        $token = (string) ($values['token'] ?? '');

        if (!in_array($cluster, ['mainnet', 'devnet'], true)) {
            $errors[] = 'Выберите сеть: основную или тестовую.';
        }

        if (!in_array($token, Tokens::SUPPORTED, true)) {
            $errors[] = sprintf('Монета «%s» не поддерживается.', $token);
        }

        $errors = array_merge($errors, self::check_recipient(
            (string) ($values['recipient'] ?? ''),
            $cluster,
            $token
        ));

        $errors = array_merge($errors, self::check_rpc_url((string) ($values['rpc_url'] ?? '')));
        $errors = array_merge($errors, self::check_markup((string) ($values['markup_percent'] ?? '0')));

        $errors = array_merge($errors, self::check_seconds(
            (string) ($values['quote_ttl'] ?? ''),
            'Срок жизни котировки',
            1,
            self::MAX_QUOTE_TTL
        ));

        $errors = array_merge($errors, self::check_seconds(
            (string) ($values['late_window'] ?? ''),
            'Срок проверки отменённых заказов',
            0,
            self::MAX_LATE_WINDOW
        ));

        return $errors;
    }

    /** @return list<string> */
    private static function check_recipient(string $recipient, string $cluster, string $token): array
    {
        if ($recipient === '') {
            return ['Укажите адрес кошелька Solana, на который будут приходить платежи.'];
        }

        // decode возвращает null на строке с недопустимыми символами, а не
        // бросает исключение — это его контракт из задачи 7.
        $decoded = Base58::decode($recipient);

        if ($decoded === null) {
            return ['Адрес кошелька записан не в том формате: допустимы только символы base58.'];
        }

        if (strlen($decoded) !== 32) {
            return ['Адрес кошелька неверной длины. Проверьте, что скопировали его целиком.'];
        }

        // Адрес монеты в поле кошелька — частая ошибка настройки, и платежи
        // по нему уходят безвозвратно. Проверяем обе сети: продавец мог
        // переключить сеть уже после того, как вписал адрес.
        foreach (['mainnet', 'devnet'] as $known_cluster) {
            foreach (Tokens::SUPPORTED as $known_token) {
                try {
                    $mint = Tokens::resolve($known_cluster, $known_token)['mint'];
                } catch (Throwable) {
                    continue;
                }

                if ($mint !== null && $recipient === $mint) {
                    return ['Это адрес монеты, а не кошелька. Укажите адрес своего кошелька — '
                        . 'платежи на адрес монеты вернуть невозможно.'];
                }
            }
        }

        return [];
    }

    /** @return list<string> */
    private static function check_rpc_url(string $url): array
    {
        if ($url === '') {
            return ['Укажите адрес узла Solana. Публичный узел для приёма платежей не подходит: '
                . 'он ограничивает запросы и не хранит историю, нужную для поиска платежа.'];
        }

        $parts = parse_url($url);

        if ($parts === false || !isset($parts['scheme'], $parts['host'])
            || !in_array($parts['scheme'], ['http', 'https'], true)
        ) {
            return ['Адрес узла должен начинаться с http:// или https://.'];
        }

        return [];
    }

    /** @return list<string> */
    private static function check_markup(string $value): array
    {
        if (!is_numeric($value)) {
            return ['Наценка должна быть числом.'];
        }

        $percent = (float) $value;

        if ($percent < 0 || $percent > 100) {
            return ['Наценка должна быть от 0 до 100 процентов.'];
        }

        // Меньше сотой доли процента округлится до нуля, и продавец будет
        // думать, что наценка работает.
        if ($percent > 0 && (int) round($percent * 100) === 0) {
            return ['Наценка меньше 0,01 процента не применяется. Укажите большее значение или ноль.'];
        }

        return [];
    }

    /** @return list<string> */
    private static function check_seconds(string $value, string $label, int $min, int $max): array
    {
        if (!is_numeric($value) || (string) (int) $value !== trim($value)) {
            return [sprintf('%s должен быть целым числом секунд.', $label)];
        }

        $seconds = (int) $value;

        if ($seconds < $min || $seconds > $max) {
            return [sprintf('%s должен быть от %d до %d секунд.', $label, $min, $max)];
        }

        return [];
    }

    /**
     * Описание полей для админки WooCommerce.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function fields(): array
    {
        return [
            'enabled' => [
                'title' => 'Включить',
                'type' => 'checkbox',
                'label' => 'Принимать оплату криптовалютой',
                'default' => 'no',
            ],
            'title' => [
                'title' => 'Название способа оплаты',
                'type' => 'text',
                'description' => 'Что увидит покупатель при оформлении заказа.',
                'default' => 'Оплата криптовалютой (USDC)',
                'desc_tip' => true,
            ],
            'description' => [
                'title' => 'Описание',
                'type' => 'textarea',
                'default' => 'Отсканируйте QR-код кошельком Solana. Деньги придут продавцу напрямую.',
            ],
            'recipient' => [
                'title' => 'Адрес кошелька продавца',
                'type' => 'text',
                'description' => 'Адрес Solana, на который придут платежи. Это адрес вашего кошелька, '
                    . 'а не адрес монеты.',
                'default' => '',
                'desc_tip' => true,
            ],
            'cluster' => [
                'title' => 'Сеть',
                'type' => 'select',
                'options' => [
                    'mainnet' => 'Основная сеть (настоящие деньги)',
                    'devnet' => 'Тестовая сеть (бесплатные монеты, для проверки)',
                ],
                'default' => 'devnet',
                'description' => 'Начните с тестовой сети и переключитесь на основную, '
                    . 'когда убедитесь, что всё работает.',
                'desc_tip' => true,
            ],
            'rpc_url' => [
                'title' => 'Адрес узла Solana',
                'type' => 'text',
                'description' => 'Публичный узел не подходит: он ограничивает запросы и не хранит '
                    . 'историю, нужную для поиска платежа. Нужен собственный провайдер.',
                'default' => '',
                'desc_tip' => true,
            ],
            'token' => [
                'title' => 'Монета',
                'type' => 'select',
                'options' => ['USDC' => 'USDC (стейблкоин)', 'SOL' => 'SOL'],
                'default' => 'USDC',
            ],
            'markup_percent' => [
                'title' => 'Наценка, %',
                'type' => 'text',
                'description' => 'Добавляется к сумме заказа до пересчёта в криптовалюту. '
                    . 'Страховка от движения курса, пока покупатель платит.',
                'default' => '0',
                'desc_tip' => true,
            ],
            'quote_ttl' => [
                'title' => 'Срок действия цены, секунд',
                'type' => 'text',
                'description' => 'Сколько времени действует зафиксированный курс. По умолчанию 15 минут.',
                'default' => '900',
                'desc_tip' => true,
            ],
            'late_window' => [
                'title' => 'Проверять отменённые заказы, секунд',
                'type' => 'text',
                'description' => 'Отмена заказа не отменяет QR-код: покупатель может заплатить позже. '
                    . 'В течение этого времени плагин продолжит проверять отменённые заказы и '
                    . 'предупредит вас о позднем платеже. Ноль отключает проверку.',
                'default' => '86400',
                'desc_tip' => true,
            ],
        ];
    }
}
```

- [ ] **Шаг 5: Запустить тесты настроек**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit --filter GatewaySettingsTest`
Ожидается: PASS.

- [ ] **Шаг 6: Реализовать работу с данными заказа**

```php
<?php
// demo-shop/plugin/includes/OrderMeta.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;
use WC_Order;

/**
 * Чтение и запись данных плагина в заказе.
 *
 * Своих таблиц в базе плагин не создаёт: всё живёт в метаданных заказа,
 * которые WooCommerce переносит вместе с ним при переезде магазина.
 */
final class OrderMeta
{
    public const QUOTE = '_solanapaykz_quote';
    public const REFERENCE = '_solanapaykz_reference';
    public const SIGNATURE = '_solanapaykz_signature';
    public const LATE_PAYMENT = '_solanapaykz_late_payment';

    public static function save_quote(WC_Order $order, Quote $quote, string $reference): void
    {
        $order->update_meta_data(self::QUOTE, wp_json_encode($quote->to_array()));
        $order->update_meta_data(self::REFERENCE, $reference);
        $order->save();
    }

    /**
     * Возвращает котировку заказа или null, если её нет либо запись испорчена.
     *
     * Испорченная запись — это не «платежа нет», а сломанный заказ, поэтому
     * причина пишется в журнал: иначе продавец увидит вечное «ожидаем оплату»
     * без единого следа о том, что пошло не так.
     */
    public static function read_quote(WC_Order $order): ?Quote
    {
        $raw = $order->get_meta(self::QUOTE);

        if (!is_string($raw) || $raw === '') {
            return null;
        }

        $data = json_decode($raw, true);

        if (!is_array($data)) {
            error_log(sprintf('SolanaPay-KZ: заказ %d — котировка не разбирается как JSON.', $order->get_id()));

            return null;
        }

        try {
            return Quote::from_array($data);
        } catch (Throwable $error) {
            error_log(sprintf(
                'SolanaPay-KZ: заказ %d — котировка непригодна: %s',
                $order->get_id(),
                $error->getMessage()
            ));

            return null;
        }
    }

    public static function read_reference(WC_Order $order): ?string
    {
        $reference = $order->get_meta(self::REFERENCE);

        return is_string($reference) && $reference !== '' ? $reference : null;
    }

    public static function save_signature(WC_Order $order, string $signature): void
    {
        $order->update_meta_data(self::SIGNATURE, $signature);
        $order->save();
    }

    public static function mark_late_payment(WC_Order $order, string $signature): void
    {
        $order->update_meta_data(self::LATE_PAYMENT, $signature);
        $order->save();
    }
}
```

- [ ] **Шаг 7: Реализовать платёжный шлюз**

```php
<?php
// demo-shop/plugin/includes/Gateway.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

use Throwable;
use WC_Order;
use WC_Payment_Gateway;

/**
 * Способ оплаты «криптовалютой» в WooCommerce.
 *
 * Класс намеренно тонкий: вся содержательная работа — расчёт, ссылка,
 * проверка платежа — лежит в классах, которые не зависят от WordPress и
 * покрыты тестами. Здесь только связывание с магазином.
 */
final class Gateway extends WC_Payment_Gateway
{
    public function __construct()
    {
        $this->id = 'solanapaykz';
        $this->method_title = 'SolanaPay-KZ';
        $this->method_description = 'Приём оплаты в криптовалюте на блокчейне Solana '
            . 'с автоматическим пересчётом из тенге. Деньги идут напрямую на кошелёк продавца.';
        $this->has_fields = false;
        $this->supports = ['products'];

        $this->init_form_fields();
        $this->init_settings();

        $this->title = $this->get_option('title', 'Оплата криптовалютой (USDC)');
        $this->description = $this->get_option('description', '');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
        add_action('woocommerce_thankyou_' . $this->id, [$this, 'render_payment_page']);
    }

    public function init_form_fields(): void
    {
        $this->form_fields = GatewaySettings::fields();
    }

    /**
     * Не даём сохранить заведомо нерабочие настройки: иначе продавец узнает
     * об ошибке от первого покупателя, который не смог заплатить.
     */
    public function process_admin_options(): bool
    {
        $saved = parent::process_admin_options();

        if ($this->get_option('enabled') !== 'yes') {
            return $saved;
        }

        $errors = GatewaySettings::validate([
            'recipient' => $this->get_option('recipient', ''),
            'cluster' => $this->get_option('cluster', ''),
            'rpc_url' => $this->get_option('rpc_url', ''),
            'token' => $this->get_option('token', ''),
            'markup_percent' => $this->get_option('markup_percent', '0'),
            'quote_ttl' => $this->get_option('quote_ttl', '900'),
            'late_window' => $this->get_option('late_window', '86400'),
        ]);

        foreach ($errors as $error) {
            \WC_Admin_Settings::add_error('SolanaPay-KZ: ' . $error);
        }

        if ($errors !== []) {
            $this->update_option('enabled', 'no');
            \WC_Admin_Settings::add_error(
                'SolanaPay-KZ выключен, пока настройки не исправлены.'
            );
        }

        return $saved;
    }

    /** Способ оплаты не показывается покупателю, пока настройки неверны. */
    public function is_available(): bool
    {
        if (!parent::is_available()) {
            return false;
        }

        return GatewaySettings::validate([
            'recipient' => $this->get_option('recipient', ''),
            'cluster' => $this->get_option('cluster', ''),
            'rpc_url' => $this->get_option('rpc_url', ''),
            'token' => $this->get_option('token', ''),
            'markup_percent' => $this->get_option('markup_percent', '0'),
            'quote_ttl' => $this->get_option('quote_ttl', '900'),
            'late_window' => $this->get_option('late_window', '86400'),
        ]) === [];
    }

    /**
     * @param int $order_id
     * @return array<string, string>
     */
    public function process_payment($order_id): array
    {
        $order = wc_get_order($order_id);

        if (!$order instanceof WC_Order) {
            return ['result' => 'failure'];
        }

        try {
            $quote = Quote::create(
                $this->build_rate_provider(),
                (string) $order->get_total(),
                (string) $this->get_option('token', 'USDC'),
                (string) $this->get_option('cluster', 'devnet'),
                (float) $this->get_option('markup_percent', '0'),
                (int) $this->get_option('quote_ttl', '900')
            );

            $request = PaymentRequest::create($quote, (string) $this->get_option('recipient', ''), [
                'label' => (string) get_bloginfo('name'),
                'message' => sprintf('Заказ №%s', $order->get_order_number()),
            ]);
        } catch (RateUnavailableException $error) {
            // Курс недоступен — заказ не создаём: продать по выдуманному курсу
            // хуже, чем не продать.
            error_log('SolanaPay-KZ: ' . $error->getMessage());
            wc_add_notice(
                'Оплата криптовалютой сейчас недоступна: не удалось получить курс. '
                . 'Выберите другой способ оплаты.',
                'error'
            );

            return ['result' => 'failure'];
        } catch (Throwable $error) {
            error_log('SolanaPay-KZ: ' . $error->getMessage());
            wc_add_notice('Не удалось подготовить оплату криптовалютой. Выберите другой способ.', 'error');

            return ['result' => 'failure'];
        }

        OrderMeta::save_quote($order, $quote, $request->reference);

        $order->update_status(
            'pending',
            sprintf('Ожидается оплата %s %s. Курс %s от «%s».',
                $quote->amount_token, $quote->token, $quote->rate, $quote->rate_source)
        );

        // Корзину очищаем: заказ уже создан, возвращаться к ней незачем.
        if (function_exists('WC') && WC()->cart !== null) {
            WC()->cart->empty_cart();
        }

        return [
            'result' => 'success',
            'redirect' => $this->get_return_url($order),
        ];
    }

    /** Страница «Спасибо за заказ»: сумма, QR и ожидание оплаты. */
    public function render_payment_page(int $order_id): void
    {
        $order = wc_get_order($order_id);

        if (!$order instanceof WC_Order || $order->get_payment_method() !== $this->id) {
            return;
        }

        $quote = OrderMeta::read_quote($order);
        $reference = OrderMeta::read_reference($order);

        if ($quote === null || $reference === null) {
            echo '<p>Не удалось загрузить данные оплаты. Свяжитесь с магазином.</p>';

            return;
        }

        // Разметка и опрос статуса — задача 9. Пока выводим сумму и ссылку,
        // чтобы страницу можно было проверить вручную.
        printf(
            '<section class="solanapaykz-payment"><h2>Оплата криптовалютой</h2>'
            . '<p>К оплате: <strong>%s %s</strong> (%s ₸ по курсу %s)</p>'
            . '<p><a href="%s">Открыть в кошельке</a></p></section>',
            esc_html($quote->amount_token),
            esc_html($quote->token),
            esc_html($quote->amount_kzt_charged),
            esc_html($quote->rate),
            esc_url(PaymentRequest::create($quote, (string) $this->get_option('recipient', ''), [
                'reference' => $reference,
            ])->url)
        );
    }

    private function build_rate_provider(): RateProvider
    {
        $http = new CurlHttpClient();

        return new RateProvider(
            [new BinanceRateSource($http), new SyntheticRateSource($http)],
            new TransientCache(),
            60
        );
    }
}
```

- [ ] **Шаг 8: Зарегистрировать шлюз в точке входа**

В `solanapaykz.php` добавить подключения после `PaymentRequest.php`:

```php
require_once __DIR__ . '/includes/GatewaySettings.php';
```

А внутри проверки на наличие WooCommerce, вместо комментария «Платёжный шлюз
подключается в задаче 8», добавить:

```php
    require_once __DIR__ . '/includes/OrderMeta.php';
    require_once __DIR__ . '/includes/Gateway.php';

    add_filter('woocommerce_payment_gateways', static function (array $gateways): array {
        $gateways[] = Gateway::class;

        return $gateways;
    });
```

Классы `OrderMeta` и `Gateway` подключаются только когда WooCommerce на месте:
они наследуют и принимают его типы, и без него вызовут фатальную ошибку.

- [ ] **Шаг 9: Запустить весь набор**

Запустить: `docker exec -w /var/www/html/wp-content/plugins/solanapaykz solanapaykz_shop php vendor/bin/phpunit`
Ожидается: PASS, 130 прежних тестов плюс новые.

- [ ] **Шаг 10: Проверить вручную на демо-магазине**

Юнит-тесты не покрывают связывание с WooCommerce — проверяем руками.

1. Убедиться, что плагин активен и сайт не сломан:
```bash
curl -s -o /dev/null -w "%{http_code}
" https://shop.pagafox.kz/
docker logs solanapaykz_shop 2>&1 | tail -5 | grep -i fatal || echo "фатальных ошибок нет"
```
Ожидается: 200 и отсутствие фатальных ошибок.

2. Убедиться, что способ оплаты появился в списке:
```bash
cd /var/www/solanapaykz/demo-shop && source .env
docker run --rm --network demo-shop_default --volumes-from solanapaykz_shop -u 33:33   -e WORDPRESS_DB_HOST=db -e WORDPRESS_DB_NAME=wordpress -e WORDPRESS_DB_USER=wordpress   -e WORDPRESS_DB_PASSWORD="$MARIADB_PASSWORD"   wordpress:cli wp eval 'foreach (WC()->payment_gateways()->payment_gateways() as $id => $g) { echo $id, " — ", $g->get_method_title(), PHP_EOL; }'
```
Ожидается: в списке есть `solanapaykz — SolanaPay-KZ`.

3. Настроить шлюз через WP-CLI на тестовую сеть и проверить, что при неверном
   адресе он остаётся недоступным, а при верном становится доступен:
```bash
docker run --rm --network demo-shop_default --volumes-from solanapaykz_shop -u 33:33   -e WORDPRESS_DB_HOST=db -e WORDPRESS_DB_NAME=wordpress -e WORDPRESS_DB_USER=wordpress   -e WORDPRESS_DB_PASSWORD="$MARIADB_PASSWORD"   wordpress:cli wp eval '
    update_option("woocommerce_solanapaykz_settings", [
      "enabled" => "yes", "title" => "Оплата криптовалютой (USDC)",
      "recipient" => "zzzz", "cluster" => "devnet",
      "rpc_url" => "https://api.devnet.solana.com", "token" => "USDC",
      "markup_percent" => "0", "quote_ttl" => "900", "late_window" => "86400",
    ]);
    $g = new SolanaPayKZ\Gateway();
    echo "с неверным адресом доступен: ", $g->is_available() ? "да" : "нет", PHP_EOL;'
```
Ожидается: «нет» — шлюз не показывается покупателю при неверных настройках.

4. Повторить с верным адресом (любой валидный адрес Solana, например
   `9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`) — ожидается «да».

Результаты всех четырёх проверок вписать в отчёт дословно.

- [ ] **Шаг 11: Коммит и пуш**

```bash
cd /var/www/solanapaykz
git add -A
git commit -m "feat: настройки продавца и платёжный шлюз WooCommerce"
git push -u origin feat/wc-gateway
```

---

## Задача 9

Расписывается после ревью задачи 8.

- **Задача 9. Страница оплаты и жизненный цикл заказа.** QR-код в браузере
  покупателя, опрос статуса каждые 5 секунд через AJAX, проверка по расписанию
  каждые 5 минут, отмена через срок жизни котировки, проверка отменённых
  заказов в течение настроенного окна, уведомление продавцу о позднем платеже.

## Самопроверка плана

**Покрытие спеки задачами 1-4:**

| Раздел спеки | Задача |
|---|---|
| 10. Требования к окружению | 1 |
| 3. Арифметика на bcmath | 2 |
| 6.1. Поиск транзакции | 3, 4 |
| 6.2. Проверка транзакции, все четыре пункта | 4 |
| 6.3. Статусы pending/confirmed/mismatch | 4 |
| 12. Отсутствие зависимостей | 1, 3 |

**Согласованность имён:** `Money::convert_kzt_to_token_units` объявлена в
задаче 2 и используется в 4 через `Money::is_valid_decimal`;
`Rpc::get_signatures_for_address` и `Rpc::get_transaction` объявлены в
задаче 3 и вызываются в задаче 4; `Environment::check` из задачи 1
вызывается в точке входа там же.

**Плейсхолдеров нет:** каждый шаг задач 1-4 содержит исполняемый код или
конкретную команду с ожидаемым результатом. Задачи 5-9 намеренно оставлены
описанием, а не заготовкой с заглушками.
