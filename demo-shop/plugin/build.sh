#!/usr/bin/env bash
set -euo pipefail

# Собирает архив плагина для поставки: копирует то, что нужно в бою,
# без vendor/, tests/, файлов composer и прочих следов разработки —
# см. .distignore. Нужно, потому что каталог плагина одновременно
# боевой (демо-магазин монтирует его как есть в docker-compose) и
# рабочая копия разработчика: без сборки продавец, заархивировавший
# папку руками, поставил бы себе в webroot PHPUnit и полный перечень
# composer-зависимостей (см. B5).

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLUG="solanapaykz"

VERSION="$(sed -n "s/^const VERSION = '\([^']*\)';/\1/p" "$PLUGIN_DIR/solanapaykz.php" | head -n1)"
if [ -z "$VERSION" ]; then
    echo "Не удалось прочитать версию из solanapaykz.php (константа VERSION)." >&2
    exit 1
fi

BUILD_DIR="$PLUGIN_DIR/build"
STAGE_DIR="$BUILD_DIR/$SLUG"
ARCHIVE_NAME="${SLUG}-${VERSION}.zip"
ARCHIVE_PATH="$BUILD_DIR/$ARCHIVE_NAME"

rm -rf "$STAGE_DIR" "$ARCHIVE_PATH"
mkdir -p "$STAGE_DIR"

# --exclude-from читает .distignore; build/ исключаем отдельно, чтобы
# сборка не пыталась скопировать сама себя при повторном запуске.
rsync -a \
    --exclude-from="$PLUGIN_DIR/.distignore" \
    --exclude="/build" \
    "$PLUGIN_DIR"/ "$STAGE_DIR"/

cd "$BUILD_DIR"

if command -v zip >/dev/null 2>&1; then
    zip -r -q "$ARCHIVE_NAME" "$SLUG"
elif command -v php >/dev/null 2>&1 && php -m | grep -qi '^zip$'; then
    php -r '
        $dir = $argv[1];
        $archive = $argv[2];
        $zip = new ZipArchive();
        if ($zip->open($archive, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            fwrite(STDERR, "Не удалось создать архив: $archive\n");
            exit(1);
        }
        $base = dirname($dir) . "/";
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($iterator as $path) {
            $local = substr($path->getPathname(), strlen($base));
            if ($path->isDir()) {
                $zip->addEmptyDir($local);
            } else {
                $zip->addFile($path->getPathname(), $local);
            }
        }
        $zip->close();
    ' "$SLUG" "$ARCHIVE_NAME"
else
    echo "Ни бинарник zip, ни расширение PHP zip не найдены — архив не собран." >&2
    echo "Собранные файлы остались в: $STAGE_DIR" >&2
    echo "Заархивируйте эту папку в ${SLUG}.zip вручную на машине, где zip есть." >&2
    exit 1
fi

echo "Собрано: $ARCHIVE_PATH"
