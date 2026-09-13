#!/usr/bin/env bash
set -euo pipefail

# Пересобирает шаблон переводов (.pot) из исходников PHP и JS, обновляет
# существующий русский перевод (.po) новым шаблоном через msgmerge (старые
# переводы сохраняются, новые строки попадают как непереведённые — “msgstr
# ""”, без этого пришлось бы переводить всё заново при каждой правке текста),
# собирает .mo для PHP (load_plugin_textdomain) и .json для двух скриптов
# (wp_set_script_translations — см. Gateway.php и BlocksSupport.php).
#
# Требует gettext (xgettext, msgmerge, msgfmt) и php — оба уже есть на
# хосте разработки (см. i18n-fix.md), в отличие от контейнера shop, где нет
# ни gettext, ни wp-cli.

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANG_DIR="$PLUGIN_DIR/languages"
cd "$PLUGIN_DIR"

echo "== xgettext: PHP =="
xgettext \
    --language=PHP \
    --from-code=UTF-8 \
    --keyword=__ --keyword=_e --keyword=esc_html__ --keyword=esc_attr__ \
    --keyword=esc_html_e --keyword=esc_attr_e \
    --keyword=_x:1,2c --keyword=_n:1,2 \
    --package-name=SolanaPay-KZ \
    --package-version=0.1.0 \
    --copyright-holder=SolanaPay-KZ \
    -o "$LANG_DIR/.solanapaykz-php.pot" \
    solanapaykz.php \
    includes/Environment.php includes/Gateway.php includes/GatewaySettings.php \
    includes/CustomerMessage.php includes/OrderChecker.php includes/Ajax.php \
    includes/PaymentDecision.php includes/Scheduler.php includes/BlocksSupport.php \
    includes/Verify.php

echo "== xgettext: JS =="
xgettext \
    --language=JavaScript \
    --from-code=UTF-8 \
    --keyword=__ --keyword=t \
    --package-name=SolanaPay-KZ \
    --package-version=0.1.0 \
    --copyright-holder=SolanaPay-KZ \
    -o "$LANG_DIR/.solanapaykz-js.pot" \
    assets/checkout.js assets/blocks-checkout.js

echo "== msgcat: объединение =="
msgcat --use-first "$LANG_DIR/.solanapaykz-php.pot" "$LANG_DIR/.solanapaykz-js.pot" \
    -o "$LANG_DIR/solanapaykz.pot"
rm -f "$LANG_DIR/.solanapaykz-php.pot" "$LANG_DIR/.solanapaykz-js.pot"

# Причёсываем шапку: xgettext подставляет плейсхолдеры (fuzzy-заголовок,
# YEAR, LANGUAGE и т. п.), которые не нужны в проекте без Makevars.
sed -i \
    -e 's/^# SOME DESCRIPTIVE TITLE\.$/# Translations template for SolanaPay-KZ for WooCommerce./' \
    -e 's/^# Copyright (C) YEAR SolanaPay-KZ$/# Copyright (C) 2026 SolanaPay-KZ/' \
    -e 's/^# This file is distributed under the same license as the SolanaPay-KZ package\.$/# This file is distributed under the same license as the SolanaPay-KZ plugin./' \
    -e '/^# FIRST AUTHOR <EMAIL@ADDRESS>, YEAR\.$/d' \
    -e '/^#, fuzzy$/d' \
    -e 's/^"Language: \\n"$/"Language: en_US\\n"/' \
    "$LANG_DIR/solanapaykz.pot"

if [ -f "$LANG_DIR/solanapaykz-ru_RU.po" ]; then
    echo "== msgmerge: обновление русского перевода =="
    msgmerge --update --backup=off "$LANG_DIR/solanapaykz-ru_RU.po" "$LANG_DIR/solanapaykz.pot"
else
    echo "== msginit: новый файл перевода =="
    msginit --no-translator --locale=ru_RU --input="$LANG_DIR/solanapaykz.pot" \
        --output-file="$LANG_DIR/solanapaykz-ru_RU.po"
fi

echo "== msgfmt: .mo для PHP =="
msgfmt --check --statistics -o "$LANG_DIR/solanapaykz-ru_RU.mo" "$LANG_DIR/solanapaykz-ru_RU.po"

echo "== JSON для wp_set_script_translations() =="
php "$LANG_DIR/build-js-json.php" "$LANG_DIR/solanapaykz-ru_RU.po" "$LANG_DIR"

echo "Готово."
