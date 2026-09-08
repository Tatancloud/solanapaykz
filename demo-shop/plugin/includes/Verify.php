<?php
// demo-shop/plugin/includes/Verify.php

declare(strict_types=1);

namespace SolanaPayKZ;

if (!defined('ABSPATH')) {
    exit;
}

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
        //
        // Ключ err обязан присутствовать: на успешной транзакции узел
        // отдаёт err === null, но его отсутствие — не то же самое, что
        // null. Усечённый или аномальный ответ узла без ключа err не
        // содержит информации об исходе транзакции и не может считаться
        // успехом.
        if (!array_key_exists('err', $meta)) {
            return $this->result(
                'mismatch',
                $signature,
                'Ответ узла не содержит признака результата транзакции (meta.err отсутствует).'
            );
        }

        if ($meta['err'] !== null) {
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
