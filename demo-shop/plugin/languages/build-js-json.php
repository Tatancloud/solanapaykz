<?php
// demo-shop/plugin/languages/build-js-json.php
//
// Строит JSON-файлы перевода для wp_set_script_translations() из общего
// .po — отдельного .po для JS нет, чтобы не держать две параллельные копии
// одних и тех же строк.
//
// Список строк для каждого скрипта задан здесь явно (см. $scripts ниже), а
// не вычисляется из комментариев-ссылок (#:) в .po: msgcat --use-first,
// которым solanapaykz.pot собирается из PHP- и JS-шаблонов (см.
// build-translations.sh), схлопывает совпадающие msgid из разных файлов в
// одну запись с одним списком ссылок — например, "Pay with cryptocurrency
// (USDC)" встречается и в PHP (умолчание настройки), и в
// assets/blocks-checkout.js (запасное значение), и после такого слияния
// ссылка на JS-файл в комментарии терялась бы. Явный список не зависит от
// этой особенности msgcat.
//
// Имя выходного файла — то, что ищет WordPress через
// load_script_textdomain(): "<domain>-<locale>-" . md5(<относительный путь
// к скрипту>) . ".json" (см. wp-includes/l10n.php, load_script_textdomain).
// Здесь домен не 'default', поэтому file_base — "solanapaykz-ru_RU", а не
// просто локаль.

declare(strict_types=1);

if ($argc !== 3) {
    fwrite(STDERR, "Использование: php build-js-json.php <path-to.po> <output-dir>\n");
    exit(1);
}

[, $po_path, $output_dir] = $argv;

$locale = 'ru_RU';
$domain = 'solanapaykz';

/** Какие строки (msgid) видит каждый JS-файл — держим в одном месте вручную. */
$scripts = [
    'assets/checkout.js' => [
        'QR code for payment via a Solana wallet',
        'Price valid for another ',
        'The price has expired. If you already sent the payment, please wait for confirmation — this can take up to a minute.',
        'The payment window has expired. If you did send the payment, please contact the store.',
        'Automatic payment verification is not available in this browser. Please refresh the page manually after paying.',
    ],
    'assets/blocks-checkout.js' => [
        'Pay with cryptocurrency (USDC)',
    ],
];

/**
 * Разбирает многострочное значение msgid/msgstr, начиная со строки со
 * значением в кавычках, и продолжающееся, пока следующие строки тоже в
 * кавычках (перенос длинных строк в .po).
 *
 * @param list<string> $lines
 */
function read_po_string(array $lines, int &$i): string
{
    $value = '';

    while ($i < count($lines)) {
        $line = trim($lines[$i]);

        if ($line === '' || $line[0] !== '"') {
            break;
        }

        $inner = substr($line, 1, -1);
        $value .= str_replace(['\\n', '\\"', '\\\\'], ["\n", '"', '\\'], $inner);
        $i++;
    }

    return $value;
}

/** @return array<string, string> msgid => msgstr, только непустые переводы. */
function parse_po_translations(string $po_path): array
{
    $lines = file($po_path, FILE_IGNORE_NEW_LINES);

    if ($lines === false) {
        fwrite(STDERR, "Не удалось прочитать $po_path\n");
        exit(1);
    }

    $translations = [];
    $i = 0;
    $count = count($lines);

    while ($i < $count) {
        $line = ltrim($lines[$i]);

        if (!str_starts_with($line, 'msgid ')) {
            $i++;

            continue;
        }

        $lines[$i] = substr($line, strlen('msgid '));
        $msgid = read_po_string($lines, $i);

        $msgstr = '';

        if ($i < $count && str_starts_with(ltrim($lines[$i]), 'msgstr ')) {
            $lines[$i] = substr(ltrim($lines[$i]), strlen('msgstr '));
            $msgstr = read_po_string($lines, $i);
        }

        if ($msgid !== '' && $msgstr !== '') {
            $translations[$msgid] = $msgstr;
        }
    }

    return $translations;
}

$translations = parse_po_translations($po_path);
$plural_forms = 'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<12 || n%100>14) ? 1 : 2);';

foreach ($scripts as $rel_path => $msgids) {
    $messages = [
        '' => [
            'domain' => 'messages',
            'lang' => $locale,
            'plural-forms' => $plural_forms,
        ],
    ];

    foreach ($msgids as $msgid) {
        if (!isset($translations[$msgid])) {
            fwrite(STDERR, "Нет перевода для \"$msgid\" ($rel_path) в $po_path\n");

            continue;
        }

        $messages[$msgid] = [$translations[$msgid]];
    }

    $hash = md5($rel_path);
    $filename = sprintf('%s-%s-%s.json', $domain, $locale, $hash);
    $path = rtrim($output_dir, '/') . '/' . $filename;

    $data = [
        'translation-revision-date' => gmdate('Y-m-d H:iO'),
        'generator' => 'build-js-json.php',
        'source' => $rel_path,
        'domain' => 'messages',
        'locale_data' => ['messages' => $messages],
    ];

    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    if ($json === false) {
        fwrite(STDERR, "Не удалось закодировать JSON для $rel_path: " . json_last_error_msg() . "\n");
        exit(1);
    }

    file_put_contents($path, $json . "\n");
    printf("%s -> %s (%d строк)\n", $rel_path, $filename, count($messages) - 1);
}
