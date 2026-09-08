// demo-shop/plugin/assets/checkout.js
(function () {
    'use strict';

    var data = window.solanapaykzData;

    if (!data || !window.qrcode) {
        return;
    }

    var qrBox = document.getElementById('solanapaykz-qr');
    var statusBox = document.getElementById('solanapaykz-status');
    var timerBox = document.getElementById('solanapaykz-timer');
    var timer = null;
    var poller = null;
    var stopped = false;

    // До finalized проходит около 15 секунд. Покупатель, отправивший
    // платёж за несколько секунд до истечения цены, не должен увидеть
    // «срок истёк» и больше никогда не узнать, подтвердилась ли оплата —
    // опрос продолжается ещё некоторое время после истечения таймера.
    var GRACE_SECONDS = 180;

    // Уровень коррекции M: ссылка Solana Pay длинная, а код должен
    // читаться с экрана телефона под углом и при бликах.
    function drawQr() {
        var qr = window.qrcode(0, 'M');
        qr.addData(data.url);
        qr.make();
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    }

    function pad(value) {
        return value < 10 ? '0' + value : String(value);
    }

    function updateTimer() {
        var left = data.expiresAt - Math.floor(Date.now() / 1000);

        if (left > 0) {
            timerBox.textContent = 'Цена действует ещё ' + pad(Math.floor(left / 60)) + ':' + pad(left % 60);
            return;
        }

        var overtime = -left;

        if (overtime < GRACE_SECONDS) {
            // Таймер истёк, но опрос продолжается: если платёж уже
            // отправлен, ждём его подтверждения, а не молча объявляем
            // деньги потерянными.
            timerBox.textContent = 'Срок цены истёк. Если вы уже отправили платёж, '
                + 'дождитесь подтверждения — это занимает до минуты.';
            return;
        }

        timerBox.textContent = 'Срок оплаты истёк. Если вы всё же отправили платёж, свяжитесь с магазином.';
        stop();
    }

    function stop() {
        stopped = true;
        if (poller) { window.clearTimeout(poller); poller = null; }
        if (timer) { window.clearInterval(timer); timer = null; }
    }

    function show(state, message) {
        statusBox.textContent = message;
        statusBox.className = 'solanapaykz__status solanapaykz__status--' + state;
    }

    // Опрос перепланируется через setTimeout после каждого ответа, а не
    // через setInterval с фиксированным шагом: таймаут RPC на сервере — 10
    // секунд, а интервал опроса — 5, и setInterval запускал бы следующий
    // запрос, пока предыдущий ещё висит на сервере. Наложение таких
    // запросов — лишняя нагрузка на PHP-воркеры и участник гонки за
    // завершение заказа (см. OrderLock), даже если сам лок её и не даст
    // довести до дела.
    //
    // stop() гасит только запланированный setTimeout — уже отправленный
    // fetch продолжает жить в своих .then()/.catch() и без этой проверки
    // безусловно вызвал бы scheduleCheck() заново, воскрешая опрос. Флаг
    // stopped — единственное, что реально останавливает опрос навсегда.
    function scheduleCheck(delay) {
        if (stopped) {
            return;
        }

        poller = window.setTimeout(check, delay);
    }

    function check() {
        var url = data.ajaxUrl + '?action=' + encodeURIComponent(data.action)
            + '&order_id=' + encodeURIComponent(data.orderId)
            + '&key=' + encodeURIComponent(data.orderKey);

        window.fetch(url, { credentials: 'same-origin' })
            .then(function (response) { return response.json(); })
            .then(function (body) {
                if (!body || !body.success || !body.data) {
                    scheduleCheck(data.intervalMs);
                    return;
                }

                show(body.data.status, body.data.message);

                // Останавливаем опрос, только когда состояние окончательное.
                // При сбое связи продолжаем: временная ошибка сети — не ответ.
                if (['paid', 'expired', 'mismatch', 'late'].indexOf(body.data.status) !== -1) {
                    stop();

                    if (body.data.status === 'paid') {
                        window.setTimeout(function () { window.location.reload(); }, 2000);
                    }

                    return;
                }

                scheduleCheck(data.intervalMs);
            })
            .catch(function () {
                // Молчим: следующая попытка через несколько секунд.
                scheduleCheck(data.intervalMs);
            });
    }

    drawQr();
    updateTimer();
    timer = window.setInterval(updateTimer, 1000);

    if (!window.fetch) {
        // Старый браузер без fetch: QR и таймер работают, но проверить
        // оплату автоматически нечем. Покупатель должен узнать об этом
        // явно — иначе страница молча висит на «Ожидаем оплату…» вечно,
        // и не отличить рабочий опрос от сломанного.
        show('unknown', 'Автоматическая проверка оплаты недоступна в этом браузере. '
            + 'Обновите страницу вручную после оплаты.');
        return;
    }

    check();
}());
