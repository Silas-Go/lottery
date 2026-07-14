(function () {
    var giftMap = new Map();
    var gifts = [];
    var wheel = null;
    var spinning = false;
    var toastTimer = null;
    var metricsSource = null;
    var liveMetrics = false;
    var latestSnapshot = null;
    var replayFrames = [];
    var replayMode = false;
    var replayPlaying = false;
    var replayIndex = -1;
    var replayTimer = null;
    var lastReplayKey = "";
    var maxReplayFrames = 240;

    // 两种库存模式的前端配置：抽奖入口 URL、库存模式标签、请求提示与事件文案。
    // 切换模式只改变请求走向和文案，转盘交互和 SSE 指标刷新逻辑两种模式共用。
    var MODES = {
        prededuct: {
            url: "/lucky",
            label: "Redis 准入 + MQ 异步落单",
            requestHint: "正在请求 /lucky，观察右侧系统链路。",
            requestEvent: ["Browser 发起请求", "GET /lucky，进入 Gin 预扣库存接口。"]
        },
        cacheaside: {
            url: "/lucky/cacheaside",
            label: "MySQL 权威同步准入",
            requestHint: "正在请求 /lucky/cacheaside，观察右侧 DB 压力与熔断状态。",
            requestEvent: ["Browser 发起请求", "GET /lucky/cacheaside，进入 MySQL 权威库存同步准入接口。"]
        }
    };
    var currentMode = "prededuct";
    var selectedLoadtest = {
        rate: null,
        connections: null,
        duration: null,
        button: null
    };

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

    function formatElapsed(ms) {
        if (!Number.isFinite(ms) || ms < 0) {
            return "+0s";
        }
        return "+" + Math.round(ms / 1000) + "s";
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

    function cloneSnapshot(snapshot) {
        return JSON.parse(JSON.stringify(snapshot));
    }

    function snapshotActivityKey(snapshot, mode) {
        if (mode === "cacheaside") {
            var ca = snapshot.cacheAside || {};
            return [
                mode,
                ca.totalRequests || 0,
                ca.qps || 0,
                ca.cacheHits || 0,
                ca.cacheMisses || 0,
                ca.dbReads || 0,
                ca.dbWrites || 0,
                ca.rejected || 0,
                ca.completed || 0,
                ca.circuitState || "green"
            ].join("|");
        }
        var db = snapshot.preDeductMySQL || {};
        return [
            mode,
            snapshot.totalRequests || 0,
            snapshot.qps || 0,
            snapshot.queueSuccess || 0,
            snapshot.rateLimited || 0,
            snapshot.stockFailed || 0,
            snapshot.mqPending || 0,
            db.totalRequests || 0
        ].join("|");
    }

    function captureReplayFrame(snapshot, mode) {
        if (!snapshot) {
            return;
        }
        var frameMode = mode || currentMode;
        var key = snapshotActivityKey(snapshot, frameMode);
        if (key === lastReplayKey && replayFrames.length > 0) {
            return;
        }
        lastReplayKey = key;
        replayFrames.push({
            mode: frameMode,
            timeMs: Date.now(),
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            snapshot: cloneSnapshot(snapshot)
        });
        if (replayFrames.length > maxReplayFrames) {
            replayFrames.shift();
        }
        if (!replayMode) {
            replayIndex = replayFrames.length - 1;
        }
        renderReplayControls();
    }

    function renderReplayControls() {
        var total = replayFrames.length;
        var index = replayIndex >= 0 ? Math.min(replayIndex, Math.max(0, total - 1)) : 0;
        var frame = total > 0 ? replayFrames[index] : null;
        var firstFrame = total > 0 ? replayFrames[0] : null;
        var lastFrame = total > 0 ? replayFrames[total - 1] : null;
        var spanText = total > 1 ? formatElapsed(lastFrame.timeMs - firstFrame.timeMs) : "+0s";
        var scrubber = el("replay-scrubber");
        if (scrubber) {
            scrubber.max = String(Math.max(0, total - 1));
            scrubber.value = String(total > 0 ? index : 0);
            scrubber.disabled = total < 2;
            var progress = total > 1 ? (index / (total - 1)) * 100 : 0;
            scrubber.style.setProperty("--replay-progress", progress + "%");
        }
        setText("replay-frame-label", total > 0 ? (index + 1) + " / " + total : "0 / 0");
        setText("replay-time-label", frame ? frame.time + " " + formatElapsed(frame.timeMs - firstFrame.timeMs) : "--:--:--");
        setText("replay-toggle", replayPlaying ? "暂停" : "播放");
        var status = "等待记录";
        if (total > 0) {
            status = replayMode ? ("回放 " + (index + 1) + "/" + total + " · " + spanText) : ("已记录 " + total + " 帧 · " + spanText);
        }
        setText("replay-status", status);
    }

    function stopReplayTimer() {
        if (replayTimer) {
            window.clearInterval(replayTimer);
            replayTimer = null;
        }
        replayPlaying = false;
        renderReplayControls();
    }

    function applyReplayFrame(index) {
        if (replayFrames.length === 0) {
            return;
        }
        replayMode = true;
        replayIndex = Math.max(0, Math.min(index, replayFrames.length - 1));
        var frame = replayFrames[replayIndex];
        applyMetricsSnapshot(frame.snapshot, frame.mode, { replay: true, skipReplayCapture: true });
        setBadge("simulation-status", "回放中", "is-warn");
        renderReplayControls();
    }

    function toggleReplay() {
        if (replayFrames.length === 0) {
            showToast("还没有可回放的压测数据");
            return;
        }
        if (replayPlaying) {
            stopReplayTimer();
            return;
        }
        replayMode = true;
        if (replayIndex < 0 || replayIndex >= replayFrames.length - 1) {
            replayIndex = 0;
            applyReplayFrame(replayIndex);
        }
        replayPlaying = true;
        replayTimer = window.setInterval(function () {
            if (replayIndex >= replayFrames.length - 1) {
                stopReplayTimer();
                return;
            }
            applyReplayFrame(replayIndex + 1);
        }, 850);
        renderReplayControls();
    }

    function exitReplayMode() {
        stopReplayTimer();
        replayMode = false;
        if (latestSnapshot) {
            applyMetricsSnapshot(latestSnapshot, currentMode, { skipReplayCapture: true });
        }
        setBadge("simulation-status", "实时指标中", "is-ok");
        renderReplayControls();
    }

    function clearReplayFrames() {
        stopReplayTimer();
        replayMode = false;
        replayFrames = [];
        replayIndex = -1;
        lastReplayKey = "";
        renderReplayControls();
    }

    function applyMetricsSnapshot(snapshot, renderMode, options) {
        if (!snapshot) {
            return;
        }
        options = options || {};
        if (!options.replay) {
            latestSnapshot = snapshot;
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
        renderMySQLPressure(snapshot, renderMode || currentMode);
        if (!options.skipReplayCapture) {
            captureReplayFrame(snapshot, renderMode || currentMode);
        }
    }

    function setMySQLPressureLabels(mode) {
        var cacheAside = mode === "cacheaside";
        setText("mysql-qps-label", "当前模式 QPS");
        setText("mysql-total-label", cacheAside ? "MySQL 同步总请求" : "Redis 准入总请求");
        setText("mysql-p95-label", "入口 P95 响应");
        setText("mysql-p99-label", "入口 P99 响应");
        setText("mysql-db-avg-label", cacheAside ? "DB 响应(含排队)" : "MySQL 平均响应");
        setText("mysql-db-p95-label", "MySQL P95 响应");
        setText("mysql-db-p99-label", "MySQL P99 响应");
        setText("mysql-cache-label", cacheAside ? "库存缓存命中率" : "Redis 库存角色");
        setText("mysql-db-ops-label", cacheAside ? "库存回源查询" : "MySQL 查询次数");
        setText("mysql-rejected-label", "熔断降级拒绝");
        setText("mysql-success-label", cacheAside ? "待支付订单 / 扣减写" : "成功进入异步队列");
    }

    function renderMySQLPressure(snapshot, mode) {
        if (!snapshot) {
            return;
        }
        var renderMode = mode || currentMode;
        setMySQLPressureLabels(renderMode);
        if (renderMode === "cacheaside") {
            renderCacheAsidePressure(snapshot.cacheAside || {});
            return;
        }
        renderPreDeductPressure(snapshot);
    }

    function renderCacheAsidePressure(ca) {
        setText("mysql-pressure-help", "当前展示旁路缓存链路的 MySQL 库存压力：库存回源查询=缓存未命中后的 SELECT，扣减写=MySQL 行锁 UPDATE；连接池打满后触发熔断保护。");
        var cacheReads = (ca.cacheHits || 0) + (ca.cacheMisses || 0);
        var dbWrites = ca.dbWrites == null ? ca.completed : ca.dbWrites;
        setText("ca-qps", formatNumber(ca.qps));
        setText("ca-total", formatNumber(ca.totalRequests));
        setText("ca-p95", (ca.p95 || 0) + "ms");
        setText("ca-p99", (ca.p99 || 0) + "ms");
        setText("ca-db-avg", (ca.dbAvgLatency || 0) + "ms");
        setText("ca-db-p95", (ca.dbP95Latency || 0) + "ms");
        setText("ca-db-p99", (ca.dbP99Latency || 0) + "ms");
        setText("ca-pool", (ca.poolUsage || 0) + "% (" + (ca.poolInUse || 0) + "/" + (ca.poolCapacity || 0) + ")");
        setText("ca-hit-rate", (ca.cacheHitRate || 0) + "% (" + formatNumber(ca.cacheHits) + "/" + formatNumber(cacheReads) + ")");
        setText("ca-miss", formatNumber(ca.dbReads == null ? ca.cacheMisses : ca.dbReads));
        setText("ca-rejected", formatNumber(ca.rejected));
        setText("ca-completed", formatNumber(ca.completed) + " / " + formatNumber(dbWrites));
        updateCircuitLamp(ca.circuitState || "green", true);
    }

    function renderPreDeductPressure(snapshot) {
        var db = snapshot.preDeductMySQL || {};
        setText("mysql-pressure-help", "当前展示预扣库存链路的 MySQL 轻量读压力：防重复查询和奖品详情查询会访问 MySQL；Redis 在这里是库存权威源，不是 MySQL 的缓存副本。");
        setText("ca-qps", formatNumber(snapshot.qps));
        setText("ca-total", formatNumber(snapshot.totalRequests));
        setText("ca-p95", (snapshot.p95 || 0) + "ms");
        setText("ca-p99", (snapshot.p99 || 0) + "ms");
        setText("ca-db-avg", (db.dbAvgLatency || 0) + "ms");
        setText("ca-db-p95", (db.dbP95Latency || 0) + "ms");
        setText("ca-db-p99", (db.dbP99Latency || 0) + "ms");
        setText("ca-pool", (db.poolUsage || 0) + "% (" + (db.poolInUse || 0) + "/" + (db.poolCapacity || 0) + ")");
        setText("ca-hit-rate", "权威源");
        setText("ca-miss", formatNumber(db.totalRequests));
        setText("ca-rejected", "0");
        setText("ca-completed", formatNumber(snapshot.queueSuccess));
        updateCircuitLamp("green", false);
    }

    // updateCircuitLamp 根据熔断状态切换信号灯颜色与面板高亮。
    // green=正常放行，yellow=压力预警/Half-Open 试探，red=熔断降级（fail-fast 拒绝新请求）。
    function updateCircuitLamp(stateText, breakerEnabled) {
        var tone = breakerEnabled && stateText === "red" ? "red" : (breakerEnabled && stateText === "yellow" ? "yellow" : "green");
        var lamp = el("circuit-lamp");
        if (lamp) {
            lamp.className = "circuit-lamp " + tone;
        }
        var label = el("circuit-state");
        if (label) {
            var textMap = breakerEnabled ?
                { green: "熔断器：正常", yellow: "熔断器：预警", red: "熔断器：熔断降级中" } :
                { green: "预扣链路：正常" };
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
            pushEvent("切换库存模式", "MySQL 同步准入：库存与待支付订单同事务，过载时熔断降级。", "warning");
        } else {
            setOperationMessage("已切换到预扣库存模式：Redis 原子扣减 + MQ 补偿，扛高并发写。");
            pushEvent("切换库存模式", "预扣库存：快，Redis 是权威源。", "success");
        }
        renderLoadtestCommand();
        renderMySQLPressure(latestSnapshot, currentMode);
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
                pushEvent("统一订单状态", "库存已获取；订单进入 pending_payment 后可支付，超时则进入 cancelled。", "success");
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
            setBadge("simulation-status", "待支付", "is-ok");
            setOperationMessage("MySQL 已原子完成库存扣减与 pending_payment 订单创建。");
            pushEvent("MySQL 扣减成功", "UPDATE cache_stock WHERE >0，行锁原子扣减，售罄时影响行数为 0。", "success");
            pushEvent("订单待支付", "库存和待支付订单处于同一数据库事务，超时取消会回补库存。", "success");
        } else {
            state.queueSuccess += 1;
            state.redisStock = Math.max(0, state.redisStock - 1);
            state.mqPending += 1;
            setBadge("simulation-status", "已进入队列", "is-ok");
            setOperationMessage("Redis 已进入 stock_acquired，MQ 正在异步建立待支付订单。");
            pushEvent("Redis 准入成功", "库存已扣减，业务状态进入 stock_acquired。", "success");
            pushEvent("异步落单", "普通 MQ 削平 MySQL 写峰值；延迟消息只负责支付超时。", "success");
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

    function buildLoadtestCommand(rate, connections, duration) {
        var targetUrl = "http://app:5678" + modeConf().url;
        var command = "docker compose --profile loadtest run --rm -e TARGET_URL=" + targetUrl;
        if (rate && connections) {
            command += " -e RATE=" + rate;
            if (duration) {
                command += " -e DURATION=" + duration;
            }
            command += " -e CONNECTIONS=" + connections;
        }
        return command + " wrk2";
    }

    function renderLoadtestCommand() {
        var command = buildLoadtestCommand(selectedLoadtest.rate, selectedLoadtest.connections, selectedLoadtest.duration);
        setText("loadtest-command", command);
        return command;
    }

    function fallbackCopyText(text) {
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            return document.execCommand("copy");
        } finally {
            document.body.removeChild(textarea);
        }
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise(function (resolve, reject) {
            if (fallbackCopyText(text)) {
                resolve();
                return;
            }
            reject(new Error("copy command failed"));
        });
    }

    function markCommandCopied() {
        var button = el("copy-loadtest-command");
        if (!button) {
            return;
        }
        button.textContent = "已复制";
        window.setTimeout(function () {
            button.textContent = "复制";
        }, 1200);
    }

    function copyLoadtestCommand() {
        var commandBox = el("loadtest-command");
        var command = commandBox ? commandBox.textContent.trim() : renderLoadtestCommand();
        if (!command) {
            showToast("没有可复制的命令");
            return;
        }
        copyText(command).then(function () {
            markCommandCopied();
            showToast("已复制压测命令");
        }).catch(function () {
            showToast("复制失败，请手动选择命令");
        });
    }

    function prepareLoadtest(rate, connections, duration, button) {
        selectedLoadtest.rate = rate;
        selectedLoadtest.connections = connections;
        selectedLoadtest.duration = duration;
        selectedLoadtest.button = button;
        var command = renderLoadtestCommand();
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

    async function resetLabData() {
        var confirmed = window.confirm("会清空订单、Redis 临时资格和两套指标。正在压测时请先 Ctrl+C 停掉 wrk2。确定要真重置吗？");
        if (!confirmed) {
            return;
        }

        var button = el("reset-lab");
        if (button) {
            button.disabled = true;
            button.textContent = "重置中";
        }
        try {
            var response = await fetch("/api/lab/reset", { method: "POST" });
            if (!response.ok) {
                throw new Error(await response.text());
            }
            var payload = await response.json();
            state.latencySamples = [];
            clearReplayFrames();
            if (payload.snapshot) {
                applyMetricsSnapshot(payload.snapshot);
            } else {
                await loadMetricsSnapshot();
            }
            setBadge("simulation-status", "已重置", "is-ok");
            setOperationMessage("实验数据已真重置：订单、Redis 临时资格、库存和指标都回到初始基线。");
            showToast("实验数据已重置");
        } catch (error) {
            setBadge("simulation-status", "重置失败", "is-error");
            setOperationMessage("重置失败：" + error.message);
            pushEvent("重置失败", error.message, "danger");
            showToast("重置失败，请看后端日志");
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = "真重置";
            }
        }
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
                var snapshot = JSON.parse(event.data);
                if (replayMode) {
                    latestSnapshot = snapshot;
                    liveMetrics = true;
                    captureReplayFrame(snapshot, currentMode);
                } else {
                    applyMetricsSnapshot(snapshot);
                    setBadge("simulation-status", "实时指标中", "is-ok");
                }
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
                prepareLoadtest(Number(button.dataset.rate), Number(button.dataset.connections), button.dataset.duration, button);
            });
        });

        document.querySelectorAll(".mode-btn").forEach(function (button) {
            button.addEventListener("click", function () {
                setMode(button.dataset.mode);
            });
        });

        var copy = el("copy-loadtest-command");
        if (copy) {
            copy.addEventListener("click", copyLoadtestCommand);
        }

        var reset = el("reset-lab");
        if (reset) {
            reset.addEventListener("click", resetLabData);
        }

        var replayLive = el("replay-live");
        if (replayLive) {
            replayLive.addEventListener("click", exitReplayMode);
        }

        var replayToggle = el("replay-toggle");
        if (replayToggle) {
            replayToggle.addEventListener("click", toggleReplay);
        }

        var replayScrubber = el("replay-scrubber");
        if (replayScrubber) {
            var seekReplay = function () {
                stopReplayTimer();
                applyReplayFrame(Number(replayScrubber.value));
            };
            var seekReplayAt = function (clientX) {
                if (replayFrames.length < 2) {
                    return;
                }
                var rect = replayScrubber.getBoundingClientRect();
                var ratio = (clientX - rect.left) / Math.max(1, rect.width);
                var index = Math.round(Math.max(0, Math.min(1, ratio)) * (replayFrames.length - 1));
                replayScrubber.value = String(index);
                stopReplayTimer();
                applyReplayFrame(index);
            };
            replayScrubber.addEventListener("input", seekReplay);
            replayScrubber.addEventListener("change", seekReplay);
            replayScrubber.addEventListener("pointerdown", function (event) {
                seekReplayAt(event.clientX);
                replayScrubber.setPointerCapture(event.pointerId);
            });
            replayScrubber.addEventListener("pointermove", function (event) {
                if (event.buttons !== 1) {
                    return;
                }
                seekReplayAt(event.clientX);
            });
        }

        var replayClear = el("replay-clear");
        if (replayClear) {
            replayClear.addEventListener("click", function () {
                clearReplayFrames();
                showToast("回放记录已清空");
            });
        }

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
        renderLoadtestCommand();
        bindEvents();
        pushEvent("系统面板就绪", "正在连接服务端真实指标流。");
        loadGifts();
        connectMetricsStream();
    });
})();
