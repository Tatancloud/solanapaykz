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
    /**
     * Solana JSON-RPC ограничивает getSignaturesForAddress максимум 1000
     * записей за один запрос — это и есть предел, который мы просим.
     * Значение по умолчанию интерфейса (10) годится только для мгновенной
     * проверки в тестах: на практике кошелёк повторяет отправку при
     * протухшем blockhash или нехватке лампортов на комиссию, и
     * провалившаяся попытка ложится в историю раньше состоявшегося
     * платежа, а посторонний может добавлять к адресу-метке собственные
     * дешёвые транзакции, вытесняя из окна настоящий платёж.
     */
    public const SIGNATURE_LIMIT = 1000;

    public function __construct(private SolanaChain $chain)
    {
    }

    /**
     * @param ?string $mint Адрес монеты, либо null для нативного SOL —
     *     признак «монета без минта» передаётся честно, а не подменяется
     *     пустой строкой: пустая строка не встречается ни в одном токен-
     *     балансе, поэтому такая подмена превращала бы любой нативный
     *     перевод в вечный mismatch.
     * @return array{status: string, signature: ?string, reason: ?string, received_units: ?string, truncated: bool}
     *     truncated — пришло ровно SIGNATURE_LIMIT подписей: история по
     *     метке может быть длиннее того, что мы видим за один запрос.
     */
    public function check(
        string $reference,
        string $recipient,
        ?string $mint,
        string $expected_units
    ): array {
        $signatures = $this->chain->get_signatures_for_address($reference, self::SIGNATURE_LIMIT);
        $truncated = count($signatures) === self::SIGNATURE_LIMIT;

        if ($truncated) {
            error_log(sprintf(
                'SolanaPay-KZ: по метке %s пришло ровно %d подписей — это предел одного запроса,'
                . ' видна не вся история по этому адресу.',
                $reference,
                self::SIGNATURE_LIMIT
            ));
        }

        if ($signatures === []) {
            return $this->result('pending') + ['truncated' => $truncated];
        }

        // По спецификации Solana Pay метка уникальна на платёж, поэтому
        // искомая оплата — самая ранняя состоявшаяся транзакция с верной
        // суммой, а не первый попавшийся кандидат: кошелёк мог отправить
        // несколько провалившихся попыток раньше настоящего платежа. Узел
        // отдаёт подписи от новых к старым — переворачиваем, чтобы
        // перебирать кандидатов в хронологическом порядке, и не
        // останавливаемся, пока не найдём состоявшийся платёж или не
        // переберём всё.
        $earliest_mismatch = null;
        $earliest_pending_signature = null;

        foreach (array_reverse($signatures) as $entry) {
            $signature = $entry['signature'] ?? null;

            if (!is_string($signature) || $signature === '') {
                // Запись без подписи — не «платежа ещё нет», а аномальный
                // ответ узла: молча трактовать его как отсутствие оплаты
                // нельзя, иначе сбой узла замаскируется под неуплату.
                throw new RpcException('Узел блокчейна вернул запись без поля signature.');
            }

            $transaction = $this->chain->get_transaction($signature);

            if ($transaction === null) {
                // Подпись уже в истории, а тело транзакции для нужного
                // уровня подтверждения ещё не отдаётся — узел не догнал.
                // Запоминаем самую раннюю такую подпись и продолжаем: более
                // новый кандидат ещё может оказаться состоявшимся платежом.
                $earliest_pending_signature ??= $signature;

                continue;
            }

            $outcome = $this->validate($transaction, $signature, $reference, $recipient, $mint, $expected_units);

            if ($outcome['status'] === 'confirmed') {
                return $outcome + ['truncated' => $truncated];
            }

            $earliest_mismatch ??= $outcome;
        }

        if ($earliest_pending_signature !== null) {
            // Платёж мог быть отправлен и ещё не проиндексирован. Это не
            // «подписей нет вовсе» — signature непустая различает эти два
            // случая для PaymentDecision: на истёкшей котировке первое не
            // повод отменять заказ, а второе — повод.
            return $this->result('pending', $earliest_pending_signature) + ['truncated' => $truncated];
        }

        return ($earliest_mismatch ?? $this->result('pending')) + ['truncated' => $truncated];
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
        ?string $mint,
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

        // 3 и 4. Ищем поступление: для SPL-токена — по token-балансам, для
        // нативного SOL (mint === null) — по разнице системных балансов
        // на индексе получателя.
        $received = $mint === null
            ? $this->received_native_units($transaction, $meta, $recipient)
            : $this->received_units($meta, $recipient, $mint);

        if ($received === null) {
            return $this->result(
                'mismatch',
                $signature,
                $mint === null
                    ? 'В транзакции нет перевода SOL нужному получателю.'
                    : 'В транзакции нет перевода нужного токена нужному получателю.'
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
     * Сколько лампортов SOL поступило получателю.
     *
     * У нативного SOL нет token-балансов: сумма считается по разнице
     * meta.preBalances/postBalances на индексе аккаунта получателя в общем
     * списке ключей транзакции (account_keys() уже учитывает и
     * версионированные транзакции с loadedAddresses). Получателя нет
     * среди ключей, либо массивов балансов нет или они короче индекса —
     * это mismatch, а не «перевода не было»: аномальный ответ узла нельзя
     * молча принимать за отсутствие оплаты.
     *
     * @param array<string, mixed> $transaction
     * @param array<string, mixed> $meta
     */
    private function received_native_units(array $transaction, array $meta, string $recipient): ?string
    {
        $index = array_search($recipient, $this->account_keys($transaction, $meta), true);

        if ($index === false) {
            return null;
        }

        $pre = $meta['preBalances'] ?? null;
        $post = $meta['postBalances'] ?? null;

        if (!is_array($pre) || !is_array($post)
            || !array_key_exists($index, $pre) || !array_key_exists($index, $post)
        ) {
            return null;
        }

        $before = $pre[$index];
        $after = $post[$index];

        if ((!is_int($before) && !is_string($before)) || (!is_int($after) && !is_string($after))) {
            return null;
        }

        $delta = bcsub((string) $after, (string) $before);

        return bccomp($delta, '0') > 0 ? $delta : null;
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
