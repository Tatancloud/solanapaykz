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

## Задачи 6-9

Расписываются после ревью задачи 5 — тем же порядком и по той же причине,
что задачи 5-9 не были расписаны до ревью первых четырёх: каждая опирается на
интерфейсы предыдущей, а ревью их меняет. За четыре закрытые задачи ревью
изменило интерфейсы трижды.

Их содержание задано спекой:

- **Задача 6. Котировка.** Срок жизни 15 минут, наценка продавца, сумма и курс
  фиксируются в момент создания. Хранится в метаданных заказа и проверяется
  заново при каждом чтении: приходит из базы, то есть извне.
- **Задача 7. Платёжный запрос.** Метка платежа — 32 случайных байта,
  закодированных в base58 (встроенного кодировщика в PHP нет, пишем сами на
  bcmath; проверка алгоритма: 32 нулевых байта дают известный адрес
  `11111111111111111111111111111111`). Ссылка Solana Pay по спецификации,
  без создания пары ключей.
- **Задача 8. Платёжный шлюз.** Класс, наследующий `WC_Payment_Gateway`,
  регистрация через фильтр `woocommerce_payment_gateways`, настройки продавца,
  `process_payment`, отображение QR на странице «Спасибо за заказ».
- **Задача 9. Опрос и жизненный цикл заказа.** AJAX-эндпоинт для страницы
  оплаты, опрос из браузера каждые 5 секунд, WP-Cron каждые 5 минут, отмена
  через 15 минут, проверка отменённых ещё сутки, уведомление продавцу о
  позднем платеже.

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
