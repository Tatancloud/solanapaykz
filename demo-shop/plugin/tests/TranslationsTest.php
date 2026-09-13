<?php
// demo-shop/plugin/tests/TranslationsTest.php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Проверяет, что перевод действительно подключён, а не просто лежит рядом
 * файлом, который никто не читает — этого бага не видно ни по __() в коде
 * (заглушка в bootstrap.php их не переводит вовсе, см. там же), ни по
 * существованию .po (в .mo он не скомпилирован тем же ключом).
 *
 * Тестового WordPress здесь нет (см. bootstrap.php), поэтому
 * load_plugin_textdomain() и wp_set_script_translations() по-настоящему не
 * вызвать — вместо этого читаем скомпилированные файлы теми же средствами,
 * которыми их прочитал бы WordPress: разбираем бинарный формат .mo вручную
 * (ext-gettext в контейнере не установлен, WordPress тоже не полагается на
 * него — свой парсер в wp-includes/pomo/) и проверяем структуру JSON для
 * wp_set_script_translations().
 */
final class TranslationsTest extends TestCase
{
    private const LANG_DIR = __DIR__ . '/../languages';

    public function test_шаблон_и_русский_перевод_существуют(): void
    {
        self::assertFileExists(self::LANG_DIR . '/solanapaykz.pot');
        self::assertFileExists(self::LANG_DIR . '/solanapaykz-ru_RU.po');
        self::assertFileExists(self::LANG_DIR . '/solanapaykz-ru_RU.mo');
    }

    /** @return array<string, string> msgid => msgstr */
    private function read_mo(string $path): array
    {
        $data = file_get_contents($path);
        self::assertIsString($data, "Не удалось прочитать $path");

        // Формат .mo: https://www.gnu.org/software/gettext/manual/html_node/MO-Files.html
        $magic = substr($data, 0, 4);
        self::assertContains(
            $magic,
            ["\x95\x04\x12\xde", "\xde\x12\x04\x95"],
            'Файл .mo начинается не с магического числа gettext — это не .mo файл.'
        );

        // msgfmt пишет 0x950412de как 32-битное число младшим байтом вперёд,
        // поэтому на диске это выглядит как байты DE 12 04 95 — не перепутать
        // порядок здесь просто, оба варианта выглядят как «то самое число».
        $little_endian = $magic === "\xde\x12\x04\x95";
        $unpack_uint32 = static function (string $bytes) use ($little_endian): int {
            $unpacked = unpack($little_endian ? 'V' : 'N', $bytes);

            return (int) $unpacked[1];
        };

        $count = $unpack_uint32(substr($data, 8, 4));
        $orig_table_offset = $unpack_uint32(substr($data, 12, 4));
        $trans_table_offset = $unpack_uint32(substr($data, 16, 4));

        $entries = [];

        for ($i = 0; $i < $count; $i++) {
            $orig_len = $unpack_uint32(substr($data, $orig_table_offset + $i * 8, 4));
            $orig_off = $unpack_uint32(substr($data, $orig_table_offset + $i * 8 + 4, 4));
            $trans_len = $unpack_uint32(substr($data, $trans_table_offset + $i * 8, 4));
            $trans_off = $unpack_uint32(substr($data, $trans_table_offset + $i * 8 + 4, 4));

            $msgid = substr($data, $orig_off, $orig_len);
            $msgstr = substr($data, $trans_off, $trans_len);

            $entries[$msgid] = $msgstr;
        }

        return $entries;
    }

    public function test_mo_файл_читается_и_содержит_перевод(): void
    {
        $entries = $this->read_mo(self::LANG_DIR . '/solanapaykz-ru_RU.mo');

        // Заголовочная запись (msgid "") плюс не меньше, чем реально
        // переведённых строк на момент написания теста — заниженная граница,
        // чтобы новые строки не ломали тест, а провал перевода (пустой или
        // почти пустой .mo) — ловился.
        self::assertGreaterThanOrEqual(90, count($entries));

        self::assertArrayHasKey('Order not found.', $entries);
        self::assertSame('Заказ не найден.', $entries['Order not found.']);

        self::assertArrayHasKey('Awaiting payment of %1$s %2$s. Rate %3$s from "%4$s".', $entries);
        self::assertSame(
            'Ожидается оплата %1$s %2$s. Курс %3$s от «%4$s».',
            $entries['Awaiting payment of %1$s %2$s. Rate %3$s from "%4$s".']
        );
    }

    public function test_заголовок_плагина_объявляет_домен_перевода(): void
    {
        $header = (string) file_get_contents(__DIR__ . '/../solanapaykz.php');

        self::assertStringContainsString('Text Domain: solanapaykz', $header);
        self::assertStringContainsString('Domain Path: /languages', $header);
        // load_plugin_textdomain() должен реально вызываться с нашим доменом,
        // а не просто объявляться в заголовке без подключения самого файла.
        self::assertMatchesRegularExpression(
            "/load_plugin_textdomain\\(\\s*'solanapaykz'/",
            $header
        );
    }

    /** @return array<string, array{0: string}> */
    public static function script_translation_files(): array
    {
        return [
            'checkout.js' => ['solanapaykz-ru_RU-8d1151cb85a338a839bac2a7eb9c326b.json'],
            'blocks-checkout.js' => ['solanapaykz-ru_RU-5218a0acc1caf5d57023fe5955247421.json'],
        ];
    }

    /**
     * Имя файла — не выдумка: это то же самое md5() от относительного пути
     * скрипта (assets/checkout.js, assets/blocks-checkout.js), которое
     * WordPress сам вычисляет в load_script_textdomain(). Совпадение имени
     * проверяем прямо здесь, а не только полагаемся на комментарий рядом с
     * wp_set_script_translations() в Gateway.php/BlocksSupport.php.
     */
    #[PHPUnit\Framework\Attributes\DataProvider('script_translation_files')]
    public function test_json_перевода_скрипта_называется_как_ожидает_wordpress(string $filename): void
    {
        $rel_path = str_starts_with($filename, 'solanapaykz-ru_RU-8d1151')
            ? 'assets/checkout.js'
            : 'assets/blocks-checkout.js';

        self::assertSame('solanapaykz-ru_RU-' . md5($rel_path) . '.json', $filename);
        self::assertFileExists(self::LANG_DIR . '/' . $filename);
    }

    public function test_json_переводов_скриптов_валиден_и_несёт_перевод(): void
    {
        $checkout = json_decode(
            (string) file_get_contents(self::LANG_DIR . '/solanapaykz-ru_RU-8d1151cb85a338a839bac2a7eb9c326b.json'),
            true
        );

        self::assertIsArray($checkout);
        // WordPress ждёт локаль во внутреннем ключе "messages" независимо от
        // домена плагина (см. wp.i18n.setLocaleData()) — это конвенция Jed,
        // а не наш домен, и напутать здесь легко.
        self::assertArrayHasKey('messages', $checkout['locale_data']);
        self::assertSame(
            'QR-код для оплаты через кошелёк Solana',
            $checkout['locale_data']['messages']['QR code for payment via a Solana wallet'][0]
        );

        $blocks = json_decode(
            (string) file_get_contents(
                self::LANG_DIR . '/solanapaykz-ru_RU-5218a0acc1caf5d57023fe5955247421.json'
            ),
            true
        );

        self::assertIsArray($blocks);
        self::assertSame(
            'Оплата криптовалютой (USDC)',
            $blocks['locale_data']['messages']['Pay with cryptocurrency (USDC)'][0]
        );
    }
}
