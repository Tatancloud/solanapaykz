// tilda-server/public/checkout.js
//
// Отсчёт времени и опрос состояния заказа на странице оплаты. QR уже
// нарисован сервером в разметку (см. src/http/routes-page.ts) — рисовать
// здесь нечего, поэтому никакая библиотека QR не подключается.
(function () {
    'use strict';

    var data = window.solanapaykzData;

    if (!data) {
        return;
    }

    var timerBox = document.getElementById('solanapaykz-timer');
    var statusBox = document.getElementById('solanapaykz-status');
    var timer = null;
    var poller = null;
    var stopped = false;

    // До finalized проходит около 15 секунд. Покупатель, отправивший
    // платёж за несколько секунд до конца отсчёта, не должен увидеть
    // «срок истёк» и больше никогда не узнать, подтвердилась ли оплата —
    // опрос продолжается ещё некоторое время после истечения таймера.
    var GRACE_SECONDS = 180;

    // Сервер присылает не момент истечения, а сколько секунд оставалось на
    // момент рендера страницы — дальше отсчитываем сами, от момента загрузки
    // этой же страницы. Если бы таймер сравнивал абсолютное время истечения
    // с Date.now() на каждом тике, сбитые часы покупателя (частый случай на
    // телефоне: часовой пояс, севшая батарейка) сразу показали бы «срок
    // истёк» на ещё живой котировке или наоборот. Разница между двумя
    // Date.now() на одном и том же устройстве от абсолютного показания часов
    // не зависит — важен только ход часов, а не их выставленное значение.
    var loadedAtMs = Date.now();
    var secondsLeftAtLoad = data.secondsLeft;

    function remainingSeconds() {
        var elapsedSeconds = Math.floor((Date.now() - loadedAtMs) / 1000);
        return secondsLeftAtLoad - elapsedSeconds;
    }

    function pad(value) {
        return value < 10 ? '0' + value : String(value);
    }

    function stop() {
        stopped = true;
        if (poller) { window.clearTimeout(poller); poller = null; }
        if (timer) { window.clearInterval(timer); timer = null; }
    }

    function updateTimer() {
        if (!timerBox) return;

        var left = remainingSeconds();

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

    // Соответствие состояния заказа CSS-модификатору — то же деление, что
    // и в src/http/html.ts (классСостояния): само состояние может содержать
    // пробел («не сошлось»), а класс должен быть одним словом.
    var STATE_CLASS = {
        'ожидает': 'pending',
        'оплачен': 'paid',
        'уведомлён': 'paid',
        'не сошлось': 'mismatch',
        'поздний': 'late',
        'просрочен': 'expired'
    };

    function show(state, message) {
        if (!statusBox) return;
        statusBox.textContent = message;
        statusBox.className = 'solanapaykz__status solanapaykz__status--' + (STATE_CLASS[state] || 'unknown');
    }

    // Опрос перепланируется через setTimeout ПОСЛЕ каждого ответа, а не
    // через setInterval с фиксированным шагом: при медленном узле или
    // перегруженной сети предыдущий запрос ещё не вернулся, а новый уже
    // ушёл бы — наложение запросов, лишняя нагрузка и лишний повод для
    // гонки на сервере.
    //
    // stop() гасит только запланированный setTimeout — уже отправленный
    // fetch продолжает жить в своих .then()/.catch() и без проверки флага
    // stopped внутри них безусловно вызвал бы scheduleCheck() заново,
    // воскрешая опрос после остановки. Флаг stopped проверяется здесь,
    // ДО планирования следующего опроса — это единственное, что реально
    // останавливает его навсегда.
    function scheduleCheck(delay) {
        if (stopped) {
            return;
        }
        poller = window.setTimeout(check, delay);
    }

    function check() {
        window.fetch(data.statusUrl, { credentials: 'same-origin' })
            .then(function (response) { return response.json(); })
            .then(function (body) {
                if (!body || typeof body.state !== 'string') {
                    scheduleCheck(data.intervalMs);
                    return;
                }

                show(body.state, body.message || '');

                if (body.state !== 'ожидает') {
                    // Состояние окончательное — сервер этот заказ больше
                    // менять не будет (см. decision.ts): опрашивать дальше
                    // незачем, открытая вкладка иначе слала бы запросы
                    // раз в 5 секунд вечно.
                    stop();

                    if (body.state === 'оплачен' || body.state === 'уведомлён') {
                        // Страница оплаты для завершённого заказа больше не
                        // показывает QR (см. routes-page.ts) — обновляем её,
                        // чтобы покупатель увидел итог, а не устаревшую цену.
                        window.setTimeout(function () { window.location.reload(); }, 2000);
                    }

                    return;
                }

                scheduleCheck(data.intervalMs);
            })
            .catch(function () {
                // Сбой сети — не ответ сервера: молчим и пробуем снова.
                scheduleCheck(data.intervalMs);
            });
    }

    updateTimer();
    timer = window.setInterval(updateTimer, 1000);

    if (!window.fetch) {
        // Старый браузер без fetch: таймер работает, а проверить оплату
        // автоматически нечем. Явно говорим об этом и указываем на прямую
        // ссылку «Открыть в кошельке», которая уже есть на странице —
        // иначе блок статуса молча висит на «Ожидаем оплату…» вечно, и
        // не отличить рабочий опрос от сломанного.
        show('ожидает', 'Автоматическая проверка оплаты недоступна в этом браузере. '
            + 'Оплатите по ссылке «Открыть в кошельке» ниже и обновите страницу вручную позже.');
        return;
    }

    check();
}());
