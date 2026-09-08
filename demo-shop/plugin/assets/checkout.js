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

        if (left <= 0) {
            timerBox.textContent = 'Срок оплаты истёк.';
            stop();
            return;
        }

        timerBox.textContent = 'Цена действует ещё ' + pad(Math.floor(left / 60)) + ':' + pad(left % 60);
    }

    function stop() {
        if (poller) { window.clearInterval(poller); poller = null; }
        if (timer) { window.clearInterval(timer); timer = null; }
    }

    function show(state, message) {
        statusBox.textContent = message;
        statusBox.className = 'solanapaykz__status solanapaykz__status--' + state;
    }

    function check() {
        var url = data.ajaxUrl + '?action=' + encodeURIComponent(data.action)
            + '&order_id=' + encodeURIComponent(data.orderId)
            + '&key=' + encodeURIComponent(data.orderKey);

        window.fetch(url, { credentials: 'same-origin' })
            .then(function (response) { return response.json(); })
            .then(function (body) {
                if (!body || !body.success || !body.data) {
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
                }
            })
            .catch(function () {
                // Молчим: следующая попытка через несколько секунд.
            });
    }

    drawQr();
    updateTimer();
    timer = window.setInterval(updateTimer, 1000);
    poller = window.setInterval(check, data.intervalMs);
    check();
}());
