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
