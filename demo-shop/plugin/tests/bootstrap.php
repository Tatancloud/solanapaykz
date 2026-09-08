<?php
/**
 * Bootstrap для PHPUnit тестов.
 *
 * Загружает composer autoloader и определяет ABSPATH фиктивным значением.
 * Тесты не поднимают WordPress, но файлы плагина обязаны иметь защиту от
 * прямого обращения (if (!defined('ABSPATH')) { exit; }), поэтому ABSPATH
 * должен быть определён перед загрузкой любого файла плагина.
 */

define('ABSPATH', true);

require_once __DIR__ . '/../vendor/autoload.php';
