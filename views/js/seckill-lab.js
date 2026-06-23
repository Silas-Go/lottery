(function () {
    var giftMap = new Map();
    var gifts = [];
    var wheel = null;
    var spinning = false;
    var toastTimer = null;
    var metricsSource = null;
    var liveMetrics = false;

    // 两种库存模式的前端配置：抽奖入口 URL、库存模式标签、请求提示与事件文案。
    // 切换模式只改变请求走向和文案，转盘交互和 SSE 指标刷新逻辑两种模式共用。
    var MODES = {
        prededuct: {
            url: "/lucky",
            label: "Redis 预扣 + MQ 补偿",
            requestHint: "正在请求 /lucky，观察右侧系统链路。",
            requestEvent: ["Browser 发起请求", "GET /lucky，进入 Gin 预扣库存接口。"]
        },
        cacheaside: {
            url: "/lucky/cacheaside",
            label: "MySQL 权威 + 旁路缓存",
            requestHint: "正在请求 /lucky/cacheaside，观察右侧 DB 压力与熔断状态。",
            requestEvent: ["Browser 发起请求", "GET /lucky/cacheaside，进入 Cache-Aside 强一致接口。"]
        }
    };
    var currentMode = "prededuct";

    function modeConf() {
        return MODES[currentMode];
    }

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

    function applyMetricsSnapshot(snapshot) {
        if (!snapshot) {
            return;
        }
        liveMetrics = true;
        state.baseStock = snapshot.activityStock || 0;
        state.redisStock = snapshot.redisStock || 0;
        state.dbStock = snapshot.dbStock || "0 / 未初始化";
        state.totalRequests = snapshot.totalRequests || 0;
        state.queueSuccess = snapshot.queueSuccess || 0;
        state.rateLimited = snapshot.rateLimited || 0;
        state.stockFailed = snapshot.stockFailed || 0;
        state.mqPending = snapshot.mqPending || 0;
        state.completedOrders = snapshot.completedOrders || 0;
        state.avgLatency = snapshot.avgLatency || 0;
        state.maxLatency = snapshot.maxLatency || 0;
        state.oversold = snapshot.oversold ? "是" : "否";
        state.simulationTotal = snapshot.simulationTotal || state.totalRequests;
        state.simulationDone = snapshot.simulationDone || state.totalRequests;
        state.qps = snapshot.qps || 0;
        state.p95 = snapshot.p95 || 0;
        state.p99 = snapshot.p99 || 0;
        updateMetrics();
        renderServerEvents(snapshot.events || []);
        applyCacheAsideSnapshot(snapshot.cacheAside);
    }

    // applyCacheAsideSnapshot 渲染旁路缓存压力面板。
    // 这些指标只来自服务端真实埋点（snapshot.cacheAside），压测 /lucky/cacheaside 时才会变化。
    function applyCacheAsideSnapshot(ca) {
        if (!ca) {
            return;
        }
        setText("ca-qps", formatNumber(ca.qps));
        setText("ca-db-avg", (ca.dbAvgLatency || 0) + "ms");
        setText("ca-db-p95", (ca.dbP95Latency || 0) + "ms");
        setText("ca-pool", (ca.poolUsage || 0) + "% (" + (ca.poolInUse || 0) + "/" + (ca.poolCapacity || 0) + ")");
        setText("ca-hit-rate", (ca.cacheHitRate || 0) + "%");
        setText("ca-miss", formatNumber(ca.cacheMisses));
        setText("ca-rejected", formatNumber(ca.rejected));
        setText("ca-completed", formatNumber(ca.completed));
        updateCircuitLamp(ca.circuitState || "green");
    }

    // updateCircuitLamp 根据熔断状态切换信号灯颜色与面板高亮。
    // green=正常放行，yellow=压力预警/Half-Open 试探，red=熔断降级（fail-fast 拒绝新请求）。
    function updateCircuitLamp(stateText) {
        var tone = stateText === "red" ? "red" : (stateText === "yellow" ? "yellow" : "green");
        var lamp = el("circuit-lamp");
        if (lamp) {
            lamp.className = "circuit-lamp " + tone;
        }
        var label = el("circuit-state");
        if (label) {
            var textMap = { green: "熔断器：正常", yellow: "熔断器：预警", red: "熔断器：熔断降级中" };
            label.textContent = textMap[tone];
        }
        var panel = el("cacheaside-panel");
        if (panel) {
            panel.classList.toggle("is-overload", tone === "red");
        }
    }

    // setMode 切换库存模式。切换只影响后续抽奖请求走向和文案，不打断正在进行的转盘。
    function setMode(mode) {
        if (!MODES[mode] || mode === currentMode || spinning) {
            return;
        }
        currentMode = mode;
        document.querySelectorAll(".mode-btn").forEach(function (button) {
            button.classList.toggle("is-active", button.dataset.mode === mode);
        });
        setText("mode-label", MODES[mode].label);
        if (mode === "cacheaside") {
            setOperationMessage("已切换到旁路缓存模式：MySQL 行锁原子扣减、强一致不超卖，高并发时 DB 是瓶颈。");
            pushEvent("切换库存模式", "旁路缓存（Cache-Aside）：慢但稳，过载时熔断降级。", "warning");
        } else {
            setOperationMessage("已切换到预扣库存模式：Redis 原子扣减 + MQ 补偿，扛高并发写。");
            pushEvent("切换库存模式", "预扣库存：快，Redis 是权威源。", "success");
        }
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

    function appendEventItem(list, timeText, title, detail, tone) {
        var item = document.createElement("li");
        var time = document.createElement("span");
        var content = document.createElement("div");
        var strong = document.createElement("strong");
        var span = document.createElement("span");

        item.className = "event-item" + (tone ? " " + tone : "");
        time.className = "event-time";
        content.className = "event-content";
        time.textContent = timeText;
        strong.textContent = title;
        span.textContent = detail;

        content.appendChild(strong);
        content.appendChild(span);
        item.appendChild(time);
        item.appendChild(content);
        list.appendChild(item);
    }

    function pushEvent(title, detail, tone) {
        var list = el("event-log");
        if (!list) {
            return;
        }
        var temp = document.createElement("ol");
        appendEventItem(temp, new Date().toLocaleTimeString("zh-CN", { hour12: false }), title, detail, tone);
        var item = temp.firstElementChild;
        list.prepend(item);

        while (list.children.length > 16) {
            list.removeChild(list.lastElementChild);
        }
    }

    function renderServerEvents(events) {
        var list = el("event-log");
        if (!list) {
            return;
        }
        list.innerHTML = "";
        events.forEach(function (event) {
            appendEventItem(list, event.time || "--:--:--", event.title || "系统事件", event.detail || "", event.tone || "");
        });
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

        state.simulationDone = state.totalRequests;
        recordLatency(latency);
        if (currentMode === "cacheaside") {
            setBadge("simulation-status", "已落库", "is-ok");
            setOperationMessage("MySQL 行锁原子扣减成功，正式订单已强一致落库（绝不超卖）。");
            pushEvent("MySQL 扣减成功", "UPDATE cache_stock WHERE >0，行锁原子扣减，售罄时影响行数为 0。", "success");
            pushEvent("正式订单落库", "Cache-Aside 走纯 DB 强一致路径，无需临时资格和 MQ 补偿。", "success");
        } else {
            state.queueSuccess += 1;
            state.redisStock = Math.max(0, state.redisStock - 1);
            state.mqPending += 1;
            setBadge("simulation-status", "已进入队列", "is-ok");
            setOperationMessage("抢到资格，等待用户支付或 MQ 延迟取消。");
            pushEvent("预扣库存成功", "Redis 库存扣减成功，临时订单已创建。", "success");
            pushEvent("发送延迟消息", "RocketMQ 将在支付超时后检查并回滚库存。", "success");
        }
        updateMetrics();

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
        setOperationMessage(modeConf().requestHint);
        pulseRequestFlow();
        pushEvent(modeConf().requestEvent[0], modeConf().requestEvent[1]);
        updateMetrics();

        try {
            var response = await fetch(modeConf().url, { method: "GET" });
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

    function setActiveStressButton(activeButton) {
        document.querySelectorAll(".stress-btn").forEach(function (button) {
            button.classList.toggle("is-active", button === activeButton);
        });
    }

    function buildLoadtestCommand(rate, connections) {
        return "docker compose --profile loadtest run --rm -e RATE=" + rate +
            " -e CONNECTIONS=" + connections + " wrk2";
    }

    function prepareLoadtest(rate, connections, button) {
        var command = buildLoadtestCommand(rate, connections);
        setText("loadtest-command", command);
        setActiveStressButton(button);
        if (liveMetrics) {
            setBadge("simulation-status", "等待 wrk2", "is-ok");
            setOperationMessage("真实指标流已连接。在终端运行左侧命令，右侧会用后端埋点实时刷新。");
            pushEvent("准备真实压测", command, "success");
            showToast("已生成 wrk2 命令");
            return;
        }
        setBadge("simulation-status", "指标未连接", "is-warn");
        setOperationMessage("SSE 指标流暂未连接。请先确认服务运行，再执行 wrk2 命令。");
        pushEvent("指标流未连接", "不会展示前端假数据；真实结果只来自服务端埋点。", "warning");
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

    async function loadMetricsSnapshot() {
        try {
            var response = await fetch("/api/metrics/snapshot");
            if (!response.ok) {
                throw new Error(await response.text());
            }
            applyMetricsSnapshot(await response.json());
            setBadge("simulation-status", "实时指标中", "is-ok");
        } catch (error) {
            setBadge("simulation-status", "指标未连接", "is-warn");
        }
    }

    function connectMetricsStream() {
        if (!window.EventSource) {
            loadMetricsSnapshot();
            return;
        }
        if (metricsSource) {
            metricsSource.close();
        }

        metricsSource = new EventSource("/api/metrics/stream");
        metricsSource.addEventListener("metrics", function (event) {
            try {
                applyMetricsSnapshot(JSON.parse(event.data));
                setBadge("simulation-status", "实时指标中", "is-ok");
            } catch (error) {
                setBadge("simulation-status", "指标解析失败", "is-error");
            }
        });
        metricsSource.onerror = function () {
            liveMetrics = false;
            setBadge("simulation-status", "指标流重连中", "is-warn");
        };
    }

    function bindEvents() {
        var single = el("single-lottery");
        if (single) {
            single.addEventListener("click", runSingleLottery);
        }

        document.querySelectorAll(".stress-btn").forEach(function (button) {
            button.addEventListener("click", function () {
                prepareLoadtest(Number(button.dataset.rate), Number(button.dataset.connections), button);
            });
        });

        document.querySelectorAll(".mode-btn").forEach(function (button) {
            button.addEventListener("click", function () {
                setMode(button.dataset.mode);
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
        pushEvent("系统面板就绪", "正在连接服务端真实指标流。");
        loadGifts();
        connectMetricsStream();
    });
})();
