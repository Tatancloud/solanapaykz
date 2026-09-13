<?php
// demo-shop/plugin/includes/BlocksPaymentMethodData.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Правила для блочного оформления заказа (Cart & Checkout blocks) — умолчание
 * для новых установок WooCommerce, где обычные шлюзы (WC_Payment_Gateway) не
 * появляются автоматически, в отличие от классического оформления.
 *
 * Логика вынесена из BlocksSupport в отдельный класс без зависимости от
 * WordPress намеренно: BlocksSupport наследует
 * Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType,
 * которого нет в тестовом окружении (WooCommerce туда не ставится), и
 * поэтому сам BlocksSupport нельзя создать в тесте. Здесь же — то, что
 * определяет видимость и содержимое способа оплаты, и это можно проверить
 * без WordPress, как и GatewaySettings рядом.
 */
final class BlocksPaymentMethodData
{
    /**
     * Должен ли способ оплаты быть виден в блочном оформлении.
     *
     * Правило то же самое, что и в классическом оформлении
     * (Gateway::is_available()): продавец включил приём оплаты, и настройки
     * проходят проверку — в том числе валюта магазина. Без повторения этой
     * проверки здесь способ оплаты появился бы в блочном оформлении при
     * магазине не в тенге, и заказ снова считался бы по чужому курсу —
     * именно та ошибка, которую GatewaySettings::validate() уже
     * предотвращает в классическом оформлении.
     *
     * @param array<string, mixed> $settings_for_validation То же самое, что
     *     принимает GatewaySettings::validate(): имена полей и значения —
     *     как в Gateway::settings_for_validation().
     */
    public static function is_active(bool $gateway_enabled, array $settings_for_validation, string $currency): bool
    {
        if (!$gateway_enabled) {
            return false;
        }

        return GatewaySettings::validate($settings_for_validation, $currency) === [];
    }

    /**
     * Данные, которые получает браузер для отрисовки способа оплаты в
     * блочном оформлении: название и описание из настроек продавца, а не
     * пустая строка — иначе покупатель увидит способ оплаты без единого
     * пояснения, что это и как им пользоваться.
     *
     * @return array{title: string, description: string, supports: list<string>}
     */
    public static function payment_method_data(string $title, string $description): array
    {
        return [
            'title' => $title,
            'description' => $description,
            // Тот же список, что Gateway::$supports: способ оплаты не
            // поддерживает подписки и повторные списания, только разовую
            // оплату товаров.
            'supports' => ['products'],
        ];
    }
}
