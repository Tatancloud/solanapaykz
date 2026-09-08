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
        // берём самую раннюю транзакцию — она и есть искомая оплата. Узел
        // отдаёт подписи от новых к старым, значит нужна последняя запись
        // массива; если бы мы брали первую (самую новую), злоумышленник
        // мог бы перебить чужой платёж по той же метке своей транзакцией.
        //
        // Поиск идёт с лимитом по умолчанию (get_signatures_for_address
        // без явного $limit — это 10 в интерфейсе SolanaChain), то есть
        // «самая ранняя» здесь — самая ранняя среди последних десяти
        // транзакций по метке. Для одноразового адреса-метки, на который
        // приходит ровно один платёж, этого достаточно.
        $last = $signatures[count($signatures) - 1];
        $signature = $last['signature'] ?? null;

        if (!is_string($signature) || $signature === '') {
            // Запись без подписи — не «платежа ещё нет», а аномальный
            // ответ узла: молча трактовать его как отсутствие оплаты
            // нельзя, иначе сбой узла замаскируется под неуплату.
            throw new RpcException('Узел блокчейна вернул запись без поля signature.');
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
        // У версионированных транзакций часть аккаунтов подставляется не
        // напрямую, а из заранее опубликованной таблицы адресов и
        // приходит отдельно, в meta.loadedAddresses (writable и
        // readonly), а не в message.accountKeys. Такие транзакции — не
        // редкость: в блоке mainnet 42 из 48 транзакций с USDC их
        // используют.
        if (!in_array($reference, $this->account_keys($transaction, $meta), true)) {
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
     * Считается как сумма разниц балансов до и после по всем счетам
     * получателя для данного токена — получатель может держать несколько
     * счётов одного и того же токена, и оплата может разойтись по
     * нескольким из них; суммарно достаточный платёж не должен
     * отвергаться из-за того, что на каждый счёт в отдельности пришло
     * меньше требуемого. Если записи «до» нет, значит токен-аккаунт
     * создан этой же транзакцией и прежний баланс равен нулю — иначе
     * первый в жизни платёж продавцу не засчитается.
     *
     * @param array<string, mixed> $meta
     */
    private function received_units(array $meta, string $recipient, string $mint): ?string
    {
        $before = [];

        foreach ($this->balances($meta, 'preTokenBalances', $recipient, $mint) as $index => $amount) {
            $before[$index] = $amount;
        }

        $total = null;

        foreach ($this->balances($meta, 'postTokenBalances', $recipient, $mint) as $index => $after) {
            $delta = bcsub($after, $before[$index] ?? '0');

            if (bccomp($delta, '0') > 0) {
                $total = $total === null ? $delta : bcadd($total, $delta);
            }
        }

        return $total;
    }

    /**
     * Все ключи аккаунтов транзакции: из message.accountKeys и, если
     * транзакция версионированная, из подставленной по таблице адресов
     * meta.loadedAddresses (writable и readonly).
     *
     * @param array<string, mixed> $transaction
     * @param array<string, mixed> $meta
     * @return list<mixed>
     */
    private function account_keys(array $transaction, array $meta): array
    {
        $keys = $transaction['transaction']['message']['accountKeys'] ?? [];
        $keys = is_array($keys) ? $keys : [];

        $loaded = is_array($meta['loadedAddresses'] ?? null) ? $meta['loadedAddresses'] : [];
        $writable = is_array($loaded['writable'] ?? null) ? $loaded['writable'] : [];
        $readonly = is_array($loaded['readonly'] ?? null) ? $loaded['readonly'] : [];

        return array_merge($keys, $writable, $readonly);
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
