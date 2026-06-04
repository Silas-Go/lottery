(function () {
    var giftMap = new Map();
    var gifts = [];
    var wheel = null;
    var spinning = false;
    var simulationTimer = null;
    var toastTimer = null;

    var state = {
        baseStock: 100,
        redisStock: 100,
        dbStock: "100 / 等待异步落库",
        totalRequests: 0,
        queueSuccess: 0,
        rateLimited: 0,
        stockFailed: 0,
        mqPending: 0,
        completedOrders: 0,
        avgLatency: 0,
        maxLatency: 0,
        oversold: "否",
        simulationTotal: 0,
        simulationDone: 0,
        qps: 0,
        p95: 0,
        p99: 0,
        latencySamples: []
    };

    function el(id) {
        return document.getElementById(id);
    }

    function setText(id, value) {
        var target = el(id);
        if (target) {
            target.textContent = value;
        }
    }

    function formatNumber(value) {
        return Number(value || 0).toLocaleString("zh-CN");
    }

    function updateMetrics() {
        setText("activity-stock", formatNumber(state.baseStock));
        setText("redis-stock", formatNumber(state.redisStock));
        setText("db-stock", state.dbStock);
        setText("total-requests", formatNumber(state.totalRequests));
        setText("queue-success", formatNumber(state.queueSuccess));
        setText("rate-limited", formatNumber(state.rateLimited));
        setText("stock-failed", formatNumber(state.stockFailed));
        setText("mq-pending", formatNumber(state.mqPending));
        setText("completed-orders", formatNumber(state.completedOrders));
        setText("avg-latency", state.avgLatency + "ms");
        setText("max-latency", state.maxLatency + "ms");
        setText("oversold", state.oversold);
        setText("simulation-progress", formatNumber(state.simulationDone) + " / " + formatNumber(state.simulationTotal));
        setText("qps", formatNumber(state.qps));
        setText("p95", state.p95 + "ms");
        setText("p99", state.p99 + "ms");
    }

    function setBadge(id, text, className) {
        var badge = el(id);
        if (!badge) {
            return;
        }
        badge.textContent = text;
        badge.className = "badge" + (className ? " " + className : "");
    }

    function setOperationMessage(text) {
        setText("operation-message", text);
    }

    function pushEvent(title, detail, tone) {
        var list = el("event-log");
        if (!list) {
            return;
        }
        var item = document.createElement("li");
        var time = document.createElement("span");
        var content = document.createElement("div");
        var strong = document.createElement("strong");
        var span = document.createElement("span");

        item.className = "event-item" + (tone ? " " + tone : "");
        time.className = "event-time";
        content.className = "event-content";
        time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        strong.textContent = title;
        span.textContent = detail;

        content.appendChild(strong);
        content.appendChild(span);
        item.appendChild(time);
        item.appendChild(content);
        list.prepend(item);

        while (list.children.length > 16) {
            list.removeChild(list.lastElementChild);
        }
    }

    function showToast(text) {
        var toast = el("toast");
        if (!toast) {
            return;
        }
        toast.textContent = text;
        toast.classList.add("is-visible");
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            toast.classList.remove("is-visible");
        }, 2200);
    }

    function pulseStep(step) {
        var node = document.querySelector('[data-step="' + step + '"]');
        if (!node) {
            return;
        }
        node.classList.add("is-active");
        window.setTimeout(function () {
            node.classList.remove("is-active");
        }, 1200);
    }

    function pulseRequestFlow() {
        ["browser", "api", "redis", "mq", "mysql"].forEach(function (step, index) {
            window.setTimeout(function () {
                pulseStep(step);
            }, index * 170);
        });
    }

    function recordLatency(ms) {
        state.latencySamples.push(ms);
        if (state.latencySamples.length > 60) {
            state.latencySamples.shift();
        }
        var sum = state.latencySamples.reduce(function (acc, value) {
            return acc + value;
        }, 0);
        state.avgLatency = Math.round(sum / state.latencySamples.length);
        state.maxLatency = Math.max(state.maxLatency, ms);
    }

    function renderGiftList() {
        var list = el("gift-list");
        if (!list) {
            return;
        }
        list.innerHTML = "";
        gifts.forEach(function (gift) {
            var item = document.createElement("article");
            var img = document.createElement("img");
            var body = document.createElement("div");
            var name = document.createElement("strong");
            var price = document.createElement("span");

            item.className = "gift-item";
            img.src = gift.Picture;
            img.alt = gift.Name;
            name.textContent = gift.Name;
            price.textContent = gift.Price > 0 ? gift.Price + " 元" : "空奖项";

            body.appendChild(name);
            body.appendChild(price);
            item.appendChild(img);
            item.appendChild(body);
            list.appendChild(item);
        });
        setText("gift-count", gifts.length + " 个奖品");
    }

    function buildPrizes() {
        var colors = ["#eaf1ff", "#e8f7ef", "#fff5dd", "#edf7fb"];
        return gifts.map(function (gift, index) {
            giftMap.set(String(gift.Id), index);
            return {
                background: colors[index % colors.length],
                fonts: [{ text: gift.Name, top: "12px", fontSize: "14px", fontWeight: "700", fontColor: "#172033" }],
                imgs: [{ src: gift.Picture, top: "42px", width: "74px", height: "74px" }]
            };
        });
    }

    function initWheel() {
        var mount = el("my-lucky");
        if (!mount || !window.LuckyCanvas || gifts.length === 0) {
            return;
        }
        mount.innerHTML = "";
        var size = Math.max(320, Math.min(430, mount.clientWidth || 430));
        wheel = new LuckyCanvas.LuckyWheel("#my-lucky", {
            width: size + "px",
            height: size + "px",
            blocks: [
                { padding: "10px", background: "#2563eb" },
                { padding: "5px", background: "#ffffff" }
            ],
            prizes: buildPrizes(),
            buttons: [
                { radius: "39%", background: "#2563eb" },
                { radius: "32%", background: "#ffffff" },
                {
                    radius: "25%",
                    background: "#099268",
                    pointer: true,
                    fonts: [{ text: "开始", top: "-10px", fontColor: "#ffffff", fontSize: "18px", fontWeight: "900" }]
                }
            ],
            start: runSingleLottery,
            end: function (prize) {
                spinning = false;
                var button = el("single-lottery");
                if (button) {
                    button.disabled = false;
                }
                if (!prize || !prize.fonts || !prize.fonts[0]) {
                    return;
                }
                var prizeName = prize.fonts[0].text;
                if (prizeName === "谢谢参与") {
                    showToast("谢谢参与，本次没有创建支付订单");
                    pushEvent("抽奖结束", "命中空奖项，没有进入支付链路。", "warning");
                    return;
                }
                showToast("恭喜中奖：" + prizeName);
                pushEvent("等待支付", "临时订单已写入 Redis，RocketMQ 会在超时后触发取消。", "success");
                window.setTimeout(function () {
                    window.location.replace("/result");
                }, 900);
            }
        });
    }

    function handleLotterySuccess(giftId, latency) {
        if (giftId === "0") {
            state.stockFailed += 1;
            state.simulationDone = state.totalRequests;
            recordLatency(latency);
            updateMetrics();
            setOperationMessage("库存已抢完，本次请求被库存保护拦截。");
            setBadge("simulation-status", "库存不足", "is-warn");
            pushEvent("库存不足", "Redis 中没有可扣减库存，系统直接返回失败。", "warning");
            showToast("抽奖结束，库存不足");
            spinning = false;
            var button = el("single-lottery");
            if (button) {
                button.disabled = false;
            }
            return;
        }

        state.queueSuccess += 1;
        state.redisStock = Math.max(0, state.redisStock - 1);
        state.mqPending += 1;
        state.simulationDone = state.totalRequests;
        recordLatency(latency);
        updateMetrics();
        setBadge("simulation-status", "已进入队列", "is-ok");
        setOperationMessage("抢到资格，等待用户支付或 MQ 延迟取消。");
        pushEvent("预扣库存成功", "Redis 库存扣减成功，临时订单已创建。", "success");
        pushEvent("发送延迟消息", "RocketMQ 将在支付超时后检查并回滚库存。", "success");

        var index = giftMap.get(String(giftId));
        if (typeof index === "number" && wheel) {
            wheel.play();
            wheel.stop(index);
        } else {
            spinning = false;
            showToast("中奖编号：" + giftId);
        }
    }

    async function runSingleLottery() {
        if (spinning) {
            return;
        }
        spinning = true;
        var button = el("single-lottery");
        if (button) {
            button.disabled = true;
        }

        var startedAt = performance.now();
        state.totalRequests += 1;
        state.simulationTotal = Math.max(state.simulationTotal, state.totalRequests);
        setBadge("simulation-status", "请求中", "is-warn");
        setOperationMessage("正在请求 /lucky，观察右侧系统链路。");
        pulseRequestFlow();
        pushEvent("Browser 发起请求", "GET /lucky，进入 Gin 秒杀接口。");
        updateMetrics();

        try {
            var response = await fetch("/lucky", { method: "GET" });
            var giftId = await response.text();
            var latency = Math.max(1, Math.round(performance.now() - startedAt));

            if (!response.ok) {
                state.stockFailed += 1;
                recordLatency(latency);
                updateMetrics();
                setBadge("simulation-status", "请求失败", "is-error");
                setOperationMessage("请求失败：" + giftId);
                pushEvent("请求失败", giftId || "接口返回异常。", "danger");
                showToast("请求失败，请看右侧事件");
                spinning = false;
                if (button) {
                    button.disabled = false;
                }
                return;
            }

            handleLotterySuccess(giftId.trim(), latency);
        } catch (error) {
            var latencyOnError = Math.max(1, Math.round(performance.now() - startedAt));
            state.stockFailed += 1;
            recordLatency(latencyOnError);
            updateMetrics();
            setBadge("simulation-status", "网络异常", "is-error");
            setOperationMessage("网络异常：" + error.message);
            pushEvent("网络异常", error.message, "danger");
            showToast("网络异常，请稍后再试");
            spinning = false;
            if (button) {
                button.disabled = false;
            }
        }
    }

    function resetSimulation(total) {
        state.baseStock = 100;
        state.redisStock = 100;
        state.dbStock = "100 / 等待异步落库";
        state.totalRequests = 0;
        state.queueSuccess = 0;
        state.rateLimited = 0;
        state.stockFailed = 0;
        state.mqPending = 0;
        state.completedOrders = 0;
        state.avgLatency = 0;
        state.maxLatency = 0;
        state.oversold = "否";
        state.simulationTotal = total;
        state.simulationDone = 0;
        state.qps = 0;
        state.p95 = 0;
        state.p99 = 0;
        state.latencySamples = [];
        updateMetrics();
    }

    function easeOut(value) {
        return 1 - Math.pow(1 - value, 3);
    }

    function setActiveStressButton(activeButton) {
        document.querySelectorAll(".stress-btn").forEach(function (button) {
            button.classList.toggle("is-active", button === activeButton);
            button.disabled = Boolean(activeButton) && button !== activeButton;
        });
    }

    function finishSimulationButtons() {
        document.querySelectorAll(".stress-btn").forEach(function (button) {
            button.classList.remove("is-active");
            button.disabled = false;
        });
    }

    function startSimulation(total, concurrency, button) {
        window.clearInterval(simulationTimer);
        resetSimulation(total);
        setActiveStressButton(button);
        setBadge("simulation-status", "压测进行中", "is-warn");
        setOperationMessage("前端正在演示压测指标流，不会从浏览器发起海量请求。");
        pushEvent("启动压测模拟", "计划请求 " + formatNumber(total) + "，并发 " + formatNumber(concurrency) + "。");

        var startedAt = performance.now();
        var duration = Math.min(4800, Math.max(1600, total / 2.5));
        var successTarget = Math.min(state.baseStock, total);
        var rateLimitedTarget = total <= state.baseStock ? 0 : Math.round((total - successTarget) * (total >= 5000 ? 0.72 : 0.58));
        var stockFailedTarget = Math.max(0, total - successTarget - rateLimitedTarget);

        simulationTimer = window.setInterval(function () {
            var elapsed = performance.now() - startedAt;
            var ratio = Math.min(1, elapsed / duration);
            var eased = easeOut(ratio);
            var completed = Math.min(total, Math.round(total * eased));

            state.simulationDone = completed;
            state.totalRequests = completed;
            state.queueSuccess = Math.min(successTarget, Math.round(successTarget * Math.min(1, eased * 1.08)));
            state.rateLimited = Math.min(rateLimitedTarget, Math.round(rateLimitedTarget * eased));
            state.stockFailed = Math.max(0, completed - state.queueSuccess - state.rateLimited);
            if (ratio === 1) {
                state.stockFailed = stockFailedTarget;
            }
            state.redisStock = Math.max(0, state.baseStock - state.queueSuccess);
            state.completedOrders = Math.min(state.queueSuccess, Math.round(state.queueSuccess * Math.min(1, eased * 0.72)));
            state.mqPending = Math.max(0, state.queueSuccess - state.completedOrders);
            state.dbStock = ratio < 1 ? "100 / 等待异步落库" : (state.baseStock - state.completedOrders) + " / 已异步落库";
            state.qps = elapsed > 0 ? Math.round(completed / (elapsed / 1000)) : 0;
            state.avgLatency = Math.round(12 + concurrency / 760 + eased * 10);
            state.maxLatency = Math.round(state.avgLatency * 3.8 + Math.min(150, concurrency / 70));
            state.p95 = Math.round(state.avgLatency * 2.4 + Math.min(80, concurrency / 160));
            state.p99 = Math.round(state.avgLatency * 3.1 + Math.min(130, concurrency / 100));
            state.oversold = state.redisStock < 0 ? "是" : "否";

            if (completed > 0) {
                pulseStep("api");
            }
            if (state.queueSuccess > 0) {
                pulseStep("redis");
                pulseStep("mq");
            }
            updateMetrics();

            if (ratio === 1) {
                window.clearInterval(simulationTimer);
                simulationTimer = null;
                setBadge("simulation-status", "压测完成", "is-ok");
                setOperationMessage("压测预演完成：成功数不超过库存，超卖为否。");
                pushEvent("压测完成", "成功 " + formatNumber(successTarget) + "，限流 " + formatNumber(rateLimitedTarget) + "，库存不足 " + formatNumber(stockFailedTarget) + "，超卖：否。", "success");
                finishSimulationButtons();
            }
        }, 90);
    }

    async function loadGifts() {
        try {
            var response = await fetch("/gifts");
            if (!response.ok) {
                throw new Error(await response.text());
            }
            gifts = await response.json();
            renderGiftList();
            initWheel();
            setBadge("api-status", "接口已连接", "is-ok");
            pushEvent("奖品加载成功", "从 /gifts 读取到 " + gifts.length + " 个奖品。", "success");
        } catch (error) {
            setBadge("api-status", "接口异常", "is-error");
            setOperationMessage("奖品加载失败：" + error.message);
            pushEvent("奖品加载失败", error.message, "danger");
        }
    }

    function bindEvents() {
        var single = el("single-lottery");
        if (single) {
            single.addEventListener("click", runSingleLottery);
        }

        document.querySelectorAll(".stress-btn").forEach(function (button) {
            button.addEventListener("click", function () {
                startSimulation(Number(button.dataset.total), Number(button.dataset.concurrency), button);
            });
        });

        var clear = el("clear-events");
        if (clear) {
            clear.addEventListener("click", function () {
                var log = el("event-log");
                if (log) {
                    log.innerHTML = "";
                }
            });
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        updateMetrics();
        bindEvents();
        pushEvent("系统面板就绪", "当前指标为教学面板演示数据，真实压测接口下一步接入。");
        loadGifts();
    });
})();
