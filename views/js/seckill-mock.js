(function (global) {
    "use strict";

    // 这里的状态只驱动室外预览。它不读取库存、不请求 /lucky，也不代表真实订单状态。
    var LabState = Object.freeze({
        IDLE: "idle",
        COUNTDOWN: "countdown",
        RUNNING: "running",
        SOLD_OUT: "sold_out"
    });

    // 请求卡状态对应一张视觉凭证的完整旅程，避免用多个 boolean 拼出互相矛盾的动画。
    var CardState = Object.freeze({
        CREATED: "created",
        MOVING_TO_SLOT: "moving_to_slot",
        PROCESSING: "processing",
        SUCCESS: "success",
        RATE_LIMITED: "rate_limited",
        DUPLICATE: "duplicate",
        SOLD_OUT: "sold_out"
    });

    var labTransitions = Object.freeze({
        idle: [LabState.COUNTDOWN],
        countdown: [LabState.RUNNING, LabState.IDLE],
        running: [LabState.SOLD_OUT, LabState.IDLE],
        sold_out: [LabState.COUNTDOWN, LabState.IDLE]
    });

    var cardTransitions = Object.freeze({
        created: [CardState.MOVING_TO_SLOT],
        moving_to_slot: [CardState.PROCESSING],
        processing: [CardState.SUCCESS, CardState.RATE_LIMITED, CardState.DUPLICATE, CardState.SOLD_OUT],
        success: [],
        rate_limited: [],
        duplicate: [],
        sold_out: []
    });

    // 接入真实接口时保留状态与 UI，只需用服务端事件替换 create() 内的计时调度。
    var DEFAULT_CONFIG = Object.freeze({
        countdownSeconds: 3,
        countdownStepMs: 820,
        runningDurationMs: 6800,
        spawnMinMs: 260,
        spawnMaxMs: 520,
        requestMinMs: 640,
        requestMaxMs: 1080,
        processingMinMs: 230,
        processingMaxMs: 520,
        outcomeSequence: [
            CardState.SUCCESS,
            CardState.RATE_LIMITED,
            CardState.SUCCESS,
            CardState.DUPLICATE,
            CardState.SUCCESS,
            CardState.RATE_LIMITED,
            CardState.SUCCESS
        ]
    });

    function create(overrides) {
        var config = Object.assign({}, DEFAULT_CONFIG, overrides || {});
        var state = LabState.IDLE;
        var stateDetail = { remaining: 0 };
        var stateListeners = [];
        var cardListeners = [];
        var timers = new Set();
        var cards = new Map();
        var requestSequence = 0;
        var outcomeSequence = 0;
        var runningUntil = 0;

        function later(callback, delay) {
            var timer = global.setTimeout(function () {
                timers.delete(timer);
                callback();
            }, Math.max(0, delay));
            timers.add(timer);
            return timer;
        }

        function clearTimers() {
            timers.forEach(function (timer) { global.clearTimeout(timer); });
            timers.clear();
        }

        function stateSnapshot() {
            return Object.freeze({
                state: state,
                remaining: Number(stateDetail.remaining || 0),
                activeCards: cards.size
            });
        }

        function cardSnapshot(card) {
            return Object.freeze({
                id: card.id,
                state: card.state,
                duration: card.duration,
                processingDuration: card.processingDuration,
                originIndex: card.originIndex
            });
        }

        function emitState() {
            var snapshot = stateSnapshot();
            stateListeners.slice().forEach(function (listener) { listener(snapshot); });
        }

        function emitCard(type, card) {
            var event = Object.freeze({
                type: type,
                card: card ? cardSnapshot(card) : null
            });
            cardListeners.slice().forEach(function (listener) { listener(event); });
        }

        function transitionLab(next, detail, force) {
            if (!force && labTransitions[state].indexOf(next) === -1) {
                throw new Error("invalid mock lab transition: " + state + " -> " + next);
            }
            state = next;
            stateDetail = Object.assign({ remaining: 0 }, detail || {});
            emitState();
        }

        function transitionCard(card, next) {
            if (!card || cardTransitions[card.state].indexOf(next) === -1) {
                return;
            }
            card.state = next;
            emitCard("transition", card);
        }

        function ranged(minimum, maximum, seed) {
            var span = Math.max(0, maximum - minimum);
            return Math.round(minimum + ((seed * 47) % 101) / 100 * span);
        }

        function createRequest(forcedOutcome) {
            if (state !== LabState.RUNNING && !forcedOutcome) {
                return;
            }

            requestSequence += 1;
            var card = {
                id: requestSequence,
                state: CardState.CREATED,
                duration: ranged(config.requestMinMs, config.requestMaxMs, requestSequence),
                processingDuration: ranged(config.processingMinMs, config.processingMaxMs, requestSequence + 9),
                originIndex: (requestSequence - 1) % 8,
                outcome: forcedOutcome || config.outcomeSequence[outcomeSequence % config.outcomeSequence.length]
            };
            outcomeSequence += 1;
            cards.set(card.id, card);
            emitCard("created", card);

            var movementDelay = Math.min(24, Math.max(1, Math.round(card.duration * .05)));
            later(function () {
                transitionCard(card, CardState.MOVING_TO_SLOT);
            }, movementDelay);
            later(function () {
                transitionCard(card, CardState.PROCESSING);
            }, movementDelay + card.duration);
            later(function () {
                transitionCard(card, card.outcome);
                later(function () {
                    cards.delete(card.id);
                    emitState();
                }, 1050);
            }, movementDelay + card.duration + card.processingDuration);
        }

        function scheduleRequest() {
            if (state !== LabState.RUNNING || Date.now() >= runningUntil) {
                return;
            }
            createRequest();
            var delay = ranged(config.spawnMinMs, config.spawnMaxMs, requestSequence + 3);
            later(scheduleRequest, delay);
        }

        function beginRunning() {
            transitionLab(LabState.RUNNING);
            runningUntil = Date.now() + config.runningDurationMs;
            scheduleRequest();
            later(function () {
                if (state !== LabState.RUNNING) {
                    return;
                }
                createRequest(CardState.SOLD_OUT);
                transitionLab(LabState.SOLD_OUT);
            }, config.runningDurationMs);
        }

        function beginCountdown() {
            var remaining = Math.max(1, Number(config.countdownSeconds) || 3);
            transitionLab(LabState.COUNTDOWN, { remaining: remaining });

            function tick() {
                remaining -= 1;
                if (remaining <= 0) {
                    beginRunning();
                    return;
                }
                stateDetail = { remaining: remaining };
                emitState();
                later(tick, config.countdownStepMs);
            }

            later(tick, config.countdownStepMs);
        }

        function start() {
            if (state === LabState.COUNTDOWN || state === LabState.RUNNING) {
                return stateSnapshot();
            }
            clearTimers();
            cards.clear();
            emitCard("reset", null);
            beginCountdown();
            return stateSnapshot();
        }

        function reset() {
            clearTimers();
            cards.clear();
            emitCard("reset", null);
            transitionLab(LabState.IDLE, { remaining: 0 }, true);
            return stateSnapshot();
        }

        function subscribe(listener) {
            stateListeners.push(listener);
            return function () {
                stateListeners = stateListeners.filter(function (candidate) { return candidate !== listener; });
            };
        }

        function subscribeCards(listener) {
            cardListeners.push(listener);
            return function () {
                cardListeners = cardListeners.filter(function (candidate) { return candidate !== listener; });
            };
        }

        return Object.freeze({
            start: start,
            reset: reset,
            getSnapshot: stateSnapshot,
            subscribe: subscribe,
            subscribeCards: subscribeCards
        });
    }

    global.SilasSeckillMock = Object.freeze({
        LabState: LabState,
        CardState: CardState,
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        create: create
    });
}(window));
