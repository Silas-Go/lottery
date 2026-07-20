(function () {
    "use strict";

    var STORAGE_KEY = "silas.cache-aside.material-id";
    var experimentState = window.SilasExperimentState;
    var experimentResults = window.SilasExperimentResults;
    var profiles = {
        1: {
            code: "ARC-001", name: "月盐", sigil: "Ⅰ", kind: "salt",
            rarity: "COMMON · 常见", origin: "霜潮盐沼", attribute: "低温稳定 · 吸热",
            usage: "炼成介质与温控缓冲", risk: "过量使用会造成局部低温脆化。"
        },
        2: {
            code: "ARC-002", name: "雾银", sigil: "Ⅱ", kind: "silver",
            rarity: "RARE · 稀有", origin: "雾海银脉", attribute: "折射 · 液态金属",
            usage: "镜面术式与感应组件", risk: "强魔力场中形态不稳定，需隔离保存。"
        },
        3: {
            code: "ARC-003", name: "龙息琥珀", sigil: "Ⅲ", kind: "amber",
            rarity: "EPIC · 史诗", origin: "赤脊火山带", attribute: "高温封存 · 持续放能",
            usage: "动力核心与耐热封装", risk: "高温或撞击可能触发能量泄漏。"
        },
        4: {
            code: "ARC-004", name: "星髓", sigil: "Ⅳ", kind: "star",
            rarity: "LEGENDARY · 传说", origin: "坠星盆地", attribute: "高密度魔力 · 星光迁移",
            usage: "高阶炼成与能量校准", risk: "高密度魔力会干扰未经屏蔽的仪器。"
        }
    };

    var state = {
        id: null,
        profile: null,
        entry: "single",
        pendingRun: null,
        crowdRun: null,
        snapshot: null,
        previousRead: null,
        lastResponse: null,
        isRequesting: false,
        isReplaying: false,
        stream: null,
        pollTimer: null,
        routeTimers: [],
        lastTrafficReplayAt: 0,
        metricsHistory: [],
        metricsLatest: null,
        metricsLoadActive: false,
        metricsTrafficSeen: false,
        metricsIdleFrames: 0,
        metricsReplaying: false,
        metricsReplayPaused: false,
        metricsReplayFrames: [],
        metricsReplayIndex: 0,
        metricsReplayTimer: null,
        reducedMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    };

    var sourceDefinitions = {
        mysql: {
            state: "direct",
            label: "MYSQL DIRECT",
            title: "Client → Go API → MySQL → Response",
            redis: "NOT INVOLVED",
            mysql: "4 SQL QUERIES",
            tone: "direct",
            events: [
                ["MYSQL DIRECT", "Go API 选择直读路径", "本次不查询 Redis"],
                ["REDIS NOT INVOLVED", "Redis 不参与", "缓存层保持待机"],
                ["MYSQL AGGREGATION", "组装材料聚合详情", "基础 JOIN、组成、交易、评分共 4 条 SQL"],
                ["RESPONSE", "只读 JSON 返回 Client", "完成本次真实路径回放"]
            ],
            frames: [
                ["node-client"], ["edge-client-api", "node-api"], ["edge-api-mysql"],
                ["node-mysql"], ["edge-mysql-response"], ["node-response"]
            ]
        },
        "redis-hit": {
            state: "hit",
            label: "CACHE HIT",
            title: "Client → Go API → Redis → Response",
            redis: "CACHE HIT",
            mysql: "STANDBY",
            tone: "hit",
            events: [
                ["CACHE LOOKUP", "Go API 查询 Redis 槽位", "按 archive ID 读取缓存副本"],
                ["REDIS CACHE HIT", "命中最终详情 DTO", "不执行 MySQL JOIN 或聚合"],
                ["MYSQL STANDBY", "MySQL 保持待机", "连接池不承接本次读取"],
                ["RESPONSE", "缓存内容返回 Client", "完成本次真实路径回放"]
            ],
            frames: [
                ["node-client"], ["edge-client-api", "node-api"], ["edge-api-redis"],
                ["node-redis"], ["edge-redis-response"], ["node-response"]
            ]
        },
        "redis-miss": {
            state: "miss",
            label: "CACHE MISS → CACHE FILLED",
            title: "Client → Go API → Redis → MySQL → Redis → Response",
            redis: "CACHE MISS",
            mysql: "4 SQL QUERIES",
            tone: "miss",
            events: [
                ["CACHE LOOKUP", "Go API 查询 Redis 槽位", "当前 key 没有可用副本"],
                ["CACHE MISS", "Redis 返回未命中", "请求继续回源 MySQL"],
                ["MYSQL AGGREGATION", "组装材料聚合详情", "执行 4 条真实 SQL"],
                ["CACHE FILLED", "最终 DTO 回填 Redis", "TTL 重置为 300 秒"],
                ["RESPONSE", "只读 JSON 返回 Client", "完成本次真实路径回放"]
            ],
            frames: [
                ["node-client"], ["edge-client-api", "node-api"], ["edge-api-redis"],
                ["node-redis"], ["edge-redis-mysql"], ["node-mysql"],
                ["edge-mysql-redis"], ["node-redis"], ["edge-redis-response"], ["node-response"]
            ]
        },
        "redis-fallback": {
            state: "fallback",
            label: "REDIS FALLBACK",
            title: "Client → Go API → Redis 异常 → MySQL → Response",
            redis: "REDIS ERROR",
            mysql: "SAFE BYPASS",
            tone: "fallback",
            events: [
                ["CACHE LOOKUP", "Go API 尝试读取 Redis", "缓存层返回异常"],
                ["REDIS FALLBACK", "启用 MySQL 安全旁路", "缓存故障不阻断正确读取"],
                ["MYSQL AGGREGATION", "安全回源并组装详情", "执行 4 条 SQL，本次不回填"],
                ["RESPONSE", "只读 JSON 返回 Client", "完成降级路径回放"]
            ],
            frames: [
                ["node-client"], ["edge-client-api", "node-api"], ["edge-api-redis"],
                ["node-redis"], ["edge-redis-mysql"], ["node-mysql"],
                ["edge-mysql-response"], ["node-response"]
            ]
        }
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function formatNumber(value) {
        return Number(value || 0).toLocaleString("zh-CN");
    }

    function normalizeMaterial(value) {
        if (value === null || value === undefined || value === "") {
            return null;
        }
        var raw = String(value).trim().toUpperCase();
        var match = raw.match(/^ARC-00([1-4])$/);
        var id = match ? Number(match[1]) : Number(raw);
        return profiles[id] ? { id: id, profile: profiles[id] } : null;
    }

    function incomingMaterial() {
        var query = new URLSearchParams(window.location.search);
        if (query.has("material")) {
            return normalizeMaterial(query.get("material"));
        }
        try {
            return normalizeMaterial(window.sessionStorage.getItem(STORAGE_KEY));
        } catch (_) {
            return null;
        }
    }

    function incomingEntry() {
        return new URLSearchParams(window.location.search).get("entry") === "crowd" ? "crowd" : "single";
    }

    function rememberMaterial(profile) {
        try {
            window.sessionStorage.setItem(STORAGE_KEY, profile.code);
        } catch (_) {
            // URL 已经携带材料编号，存储失败不影响当前实验。
        }
    }

    function showToast(message, tone) {
        var toast = byId("lab-toast");
        toast.textContent = message;
        toast.className = "lab-toast is-visible " + (tone || "");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(function () {
            toast.classList.remove("is-visible");
        }, 2600);
    }

    async function requestJSON(url, options) {
        var response = await fetch(url, options || {});
        var raw = await response.text();
        var body = null;
        if (raw) {
            try {
                body = JSON.parse(raw);
            } catch (_) {
                throw new Error("服务返回了无法解析的响应");
            }
        }
        if (!response.ok) {
            throw new Error((body && body.message) || "请求失败（" + response.status + "）");
        }
        return { response: response, body: body };
    }

    function setConnection(connected) {
        var badge = byId("connection-state");
        badge.classList.toggle("is-live", connected);
        badge.classList.toggle("is-error", !connected);
        badge.innerHTML = "<i></i>" + (connected ? "SSE 指标在线 · LIVE" : "SSE 连接中断");
    }

    function showLabContext(context) {
        if (!context) {
            byId("empty-state").hidden = false;
            byId("lab-content").hidden = true;
            byId("connection-state").innerHTML = "<i></i>等待材料上下文";
            byId("reset-lab").disabled = true;
            return false;
        }
        state.id = context.id;
        state.profile = context.profile;
        rememberMaterial(context.profile);
        document.body.dataset.materialKind = context.profile.kind;
        byId("lab-current-code").textContent = context.profile.code;
        byId("lab-current-name").textContent = context.profile.name;
        byId("empty-state").hidden = true;
        byId("lab-content").hidden = false;
        return true;
    }

    function currentExperiment() {
        return experimentState.get();
    }

    function renderExperimentState(next) {
        var cached = next.mode === "cached";
        document.body.dataset.labMode = next.mode;
        byId("mode-direct").classList.toggle("is-active", !cached);
        byId("mode-cached").classList.toggle("is-active", cached);
        byId("query-endpoint").textContent = cached ? "via /cached" : "via /direct";
        byId("lab-shared-strategy").textContent = cached ?
            "Redis Cache-Aside · " + (next.cacheTemperature === "cold" ? "冷缓存" : "热缓存") :
            "MySQL Direct";
        byId("lab-strategy-explanation").textContent = cached ?
            (next.cacheTemperature === "cold" ?
                "查询前先清空档案缓存与本章指标，首个真实响应应映射为 Cache Miss。" :
                "保留已有 Redis 副本；实际结果仍以 X-Archive-Source 的 Hit 或 Miss 为准。") :
            "Redis 不参与；每次请求都执行基础 JOIN、组成、交易和评分共 4 条 SQL。";
        renderActiveMetrics();
    }

    function updateControlState() {
        var locked = state.isRequesting || state.isReplaying;
        byId("query-archive").disabled = locked;
        byId("query-archive").querySelector("span").textContent = state.isRequesting ?
            "正在等待真实响应" : (state.lastResponse ? "再次检索材料档案" : "检索材料档案");
    }

    function clearRouteTimers() {
        state.routeTimers.forEach(function (timer) { window.clearTimeout(timer); });
        state.routeTimers = [];
    }

    function resetRouteVisual() {
        clearRouteTimers();
        Array.prototype.forEach.call(document.querySelectorAll(".route-node, .route-edge"), function (element) {
            element.classList.remove("is-active", "is-hit", "is-miss", "is-error", "is-refill", "is-idle");
        });
        byId("redis-state").textContent = "STANDBY";
        byId("mysql-state").textContent = "STANDBY";
    }

    function renderRouteEvents(definition) {
        var host = byId("route-events");
        host.innerHTML = "";
        definition.events.forEach(function (event, index) {
            var item = document.createElement("li");
            item.dataset.step = String(index);
            item.innerHTML = "<span>" + event[0] + "</span><strong>" + event[1] + "</strong><small>" + event[2] + "</small>";
            host.appendChild(item);
        });
    }

    function activateFrame(ids, tone) {
        ids.forEach(function (id) {
            var element = byId(id);
            if (!element) {
                return;
            }
            element.classList.add("is-active");
            if (tone === "hit") {
                element.classList.add("is-hit");
            } else if (tone === "miss") {
                element.classList.add(id === "edge-mysql-redis" ? "is-refill" : "is-miss");
            } else if (tone === "fallback") {
                element.classList.add("is-error");
            }
        });
    }

    function finishRouteReplay(definition) {
        state.isReplaying = false;
        byId("replay-status").textContent = "回放完成 · 不计入真实耗时";
        byId("route-title").textContent = definition.title;
        if (definition.state === "miss") {
            byId("redis-state").textContent = "CACHE FILLED";
        }
        var events = byId("route-events").children;
        Array.prototype.forEach.call(events, function (item) {
            item.classList.remove("is-current");
            item.classList.add("is-complete");
        });
        updateControlState();
    }

    function playRoute(source, origin) {
        var definition = sourceDefinitions[source];
        resetRouteVisual();
        if (!definition) {
            document.body.dataset.routeState = "unknown";
            byId("route-label").textContent = "UNKNOWN SOURCE";
            byId("route-title").textContent = "响应头无法映射到已知路径：" + (source || "空值");
            byId("replay-status").textContent = "未回放未知路径";
            state.isReplaying = false;
            updateControlState();
            return;
        }

        state.isReplaying = true;
        document.body.dataset.routeState = definition.state;
        byId("route-label").textContent = definition.label;
        byId("route-title").textContent = definition.title;
        byId("redis-state").textContent = definition.redis;
        byId("mysql-state").textContent = definition.mysql;
        byId("replay-status").textContent = origin === "sse" ? "正在回放外部真实流量" : "正在回放本次数据路径";
        renderRouteEvents(definition);
        updateControlState();

        if (definition.state === "direct") {
            byId("node-redis").classList.add("is-idle");
        } else if (definition.state === "hit") {
            byId("node-mysql").classList.add("is-idle");
        }

        if (state.reducedMotion) {
            definition.frames.forEach(function (frame) { activateFrame(frame, definition.tone); });
            finishRouteReplay(definition);
            return;
        }

        definition.frames.forEach(function (frame, index) {
            var timer = window.setTimeout(function () {
                activateFrame(frame, definition.tone);
                var eventIndex = Math.min(definition.events.length - 1,
                    Math.floor(index * definition.events.length / definition.frames.length));
                Array.prototype.forEach.call(byId("route-events").children, function (item, itemIndex) {
                    item.classList.toggle("is-current", itemIndex === eventIndex);
                    if (itemIndex < eventIndex) {
                        item.classList.add("is-complete");
                    }
                });
            }, index * 180);
            state.routeTimers.push(timer);
        });
        state.routeTimers.push(window.setTimeout(function () {
            finishRouteReplay(definition);
        }, definition.frames.length * 180 + 180));
    }

    function sourceLabel(source) {
        var definition = sourceDefinitions[source];
        return definition ? definition.label : (source || "UNKNOWN");
    }

    function resultMetric(result, key) {
        var metrics = result && result.metrics || {};
        if (key === "sqlQueries" && metrics.sqlQueries === undefined) {
            return Number(metrics.dbReads || 0);
        }
        return Number(metrics[key] || 0);
    }

    function renderFrozenCard(mode, result) {
        var card = byId(mode === "cached" ? "frozen-cached" : "frozen-direct");
        if (!result) {
            card.classList.add("is-empty");
            card.querySelector("header > span").textContent = "待测试";
            card.querySelector("[data-result-context]").textContent = mode === "cached" ?
                "完成旁路缓存测试后自动冻结" : "完成直查测试后自动冻结";
            Array.prototype.forEach.call(card.querySelectorAll("[data-result]"), function (node) {
                node.textContent = "—";
            });
            card.querySelector("[data-result-time]").textContent = "结果不会随实时指标变化";
            return;
        }
        card.classList.remove("is-empty");
        card.querySelector("header > span").textContent = "FROZEN";
        var temperature = mode === "cached" ?
            " · " + (result.cacheTemperature === "hot" ? "热缓存" : "冷缓存") : "";
        var runKind = result.entry === "crowd" ?
            "多人压测" + (result.expectedRate ? " · " + result.expectedRate + " req/s" : "") +
            (result.expectedDurationSeconds ? " · " + result.expectedDurationSeconds + "s" : "") : "单次检索";
        card.querySelector("[data-result-context]").textContent =
            (result.materialCode || "材料未标记") + " · " + (result.materialName || "") + temperature + " · " + runKind;
        Array.prototype.forEach.call(card.querySelectorAll("[data-result]"), function (node) {
            var key = node.dataset.result;
            var value = resultMetric(result, key);
            if (key === "p99") {
                node.textContent = value + " ms";
            } else if (key === "pool") {
                node.textContent = resultMetric(result, "poolPeak") + " / " + resultMetric(result, "poolCapacity");
            } else if (key === "hitRate") {
                node.textContent = result.metrics.hitRate === null ? "—" : value + "%";
            } else {
                node.textContent = formatNumber(value);
            }
        });
        card.querySelector("[data-result-time]").textContent = "冻结于 " +
            new Date(result.frozenAt).toLocaleTimeString("zh-CN", { hour12: false });
    }

    function setComparisonRow(name, directText, cachedText, directValue, cachedValue, preference, comparable, tieTolerance) {
        var row = byId("compare-" + name + "-row");
        byId("compare-" + name + "-direct").textContent = directText;
        byId("compare-" + name + "-cached").textContent = cachedText;
        row.classList.remove("winner-direct", "winner-cached", "is-tie");
        if (!comparable) {
            byId("compare-" + name + "-winner").textContent = "条件不同";
            return null;
        }
        if (Math.abs(directValue - cachedValue) <= Number(tieTolerance || 0)) {
            row.classList.add("is-tie");
            byId("compare-" + name + "-winner").textContent = "持平";
            return "tie";
        }
        var cachedWins = preference === "higher" ? cachedValue > directValue : cachedValue < directValue;
        row.classList.add(cachedWins ? "winner-cached" : "winner-direct");
        byId("compare-" + name + "-winner").textContent = cachedWins ? "Cache-Aside 胜出" : "Direct 胜出";
        return cachedWins ? "cached" : "direct";
    }

    function comparisonIsFair(direct, cached) {
        if (direct.entry !== "crowd" || cached.entry !== "crowd") {
            return false;
        }
        if (direct.materialCode !== cached.materialCode) {
            return false;
        }
        return Number(direct.expectedRate || 0) === Number(cached.expectedRate || 0) &&
            Number(direct.expectedDurationSeconds || 20) === Number(cached.expectedDurationSeconds || 20);
    }

    function resetFrozenComparison() {
        ["db", "qps", "p99", "pool", "error"].forEach(function (name) {
            var row = byId("compare-" + name + "-row");
            row.classList.remove("winner-direct", "winner-cached", "is-tie");
            byId("compare-" + name + "-direct").textContent = "—";
            byId("compare-" + name + "-cached").textContent = "—";
            byId("compare-" + name + "-winner").textContent = "等待";
        });
        byId("compare-hit-row").classList.remove("winner-direct", "winner-cached", "is-tie");
        byId("compare-hit-cached").textContent = "—";
        byId("compare-hit-assessment").textContent = "Redis 专属指标";
    }

    function renderFrozenComparison(direct, cached) {
        var panel = byId("frozen-comparison");
        if (!direct || !cached) {
            panel.classList.add("is-waiting");
            resetFrozenComparison();
            byId("frozen-comparison-title").textContent = "还需要两种路径各完成一轮测试";
            byId("frozen-overall-winner").textContent = "WAITING";
            return;
        }

        panel.classList.remove("is-waiting");
        var fair = comparisonIsFair(direct, cached);
        var directRequests = Math.max(1, resultMetric(direct, "requests"));
        var cachedRequests = Math.max(1, resultMetric(cached, "requests"));
        var directDBRate = resultMetric(direct, "sqlQueries") * 1000 / directRequests;
        var cachedDBRate = resultMetric(cached, "sqlQueries") * 1000 / cachedRequests;
        var directErrorRate = resultMetric(direct, "errors") * 1000 / directRequests;
        var cachedErrorRate = resultMetric(cached, "errors") * 1000 / cachedRequests;
        var directPoolUsage = resultMetric(direct, "poolCapacity") ?
            resultMetric(direct, "poolPeak") * 100 / resultMetric(direct, "poolCapacity") : 0;
        var cachedPoolUsage = resultMetric(cached, "poolCapacity") ?
            resultMetric(cached, "poolPeak") * 100 / resultMetric(cached, "poolCapacity") : 0;
        var qpsTieTolerance = Math.max(resultMetric(direct, "qps"), resultMetric(cached, "qps")) * .02;
        var winners = [
            setComparisonRow("db", directDBRate.toFixed(1), cachedDBRate.toFixed(1), directDBRate, cachedDBRate, "lower", fair),
            setComparisonRow("qps", formatNumber(resultMetric(direct, "qps")), formatNumber(resultMetric(cached, "qps")), resultMetric(direct, "qps"), resultMetric(cached, "qps"), "higher", fair, qpsTieTolerance),
            setComparisonRow("p99", resultMetric(direct, "p99") + " ms", resultMetric(cached, "p99") + " ms", resultMetric(direct, "p99"), resultMetric(cached, "p99"), "lower", fair),
            setComparisonRow("pool", directPoolUsage.toFixed(1) + "%", cachedPoolUsage.toFixed(1) + "%", directPoolUsage, cachedPoolUsage, "lower", fair),
            setComparisonRow("error", directErrorRate.toFixed(1), cachedErrorRate.toFixed(1), directErrorRate, cachedErrorRate, "lower", fair)
        ];
        var hitRate = cached.metrics.hitRate;
        byId("compare-hit-cached").textContent = hitRate === null ? "—" : hitRate + "%";
        byId("compare-hit-assessment").textContent = hitRate === null ? "无缓存命中样本" :
            (hitRate >= 95 ? "命中率优秀" : (hitRate >= 80 ? "命中率健康" : "MISS 偏多"));

        if (!fair) {
            var onlyPathChecks = direct.entry === "single" && cached.entry === "single";
            byId("frozen-comparison-title").textContent = onlyPathChecks ?
                "单次检索只验证路径；请各完成一轮同速率压测后再判胜负" :
                "两轮材料、目标速率或时长不同，仅展示结果，不判总胜负";
            byId("frozen-overall-winner").textContent = onlyPathChecks ? "PATH CHECK ONLY" : "NOT COMPARABLE";
            return;
        }
        var directWins = winners.filter(function (winner) { return winner === "direct"; }).length;
        var cachedWins = winners.filter(function (winner) { return winner === "cached"; }).length;
        byId("frozen-comparison-title").textContent = direct.materialCode + " · 同条件结果已冻结";
        if (directWins === cachedWins) {
            byId("frozen-overall-winner").textContent = "总体持平 " + directWins + " : " + cachedWins;
        } else if (cachedWins > directWins) {
            byId("frozen-overall-winner").textContent = "Cache-Aside " + cachedWins + " : " + directWins + " 胜出";
        } else {
            byId("frozen-overall-winner").textContent = "Direct " + directWins + " : " + cachedWins + " 胜出";
        }
    }

    function renderFrozenResults() {
        var direct = experimentResults.latest("direct");
        var cached = experimentResults.latest("cached");
        renderFrozenCard("direct", direct);
        renderFrozenCard("cached", cached);
        renderFrozenComparison(direct, cached);
    }

    function completeResult(result) {
        experimentResults.complete(result);
        experimentResults.clearPending();
        state.pendingRun = null;
        state.crowdRun = null;
        renderFrozenResults();
        byId("freeze-status").textContent = (result.mode === "cached" ? "Cache-Aside" : "MySQL Direct") + " 本轮结果已冻结";
        showToast("本轮实验结果已冻结，可用于下一轮对比。", "success");
    }

    function freezeSingleResult(source, latency, sqlQueries) {
        var experiment = currentExperiment();
        var cached = experiment.mode === "cached";
        var hitRate = cached ? (source === "redis-hit" ? 100 : (source === "redis-miss" ? 0 : null)) : null;
        var currentPath = state.snapshot && (cached ? state.snapshot.cached : state.snapshot.direct);
        completeResult({
            entry: "single",
            materialCode: state.profile.code,
            materialName: state.profile.name,
            mode: experiment.mode,
            cacheTemperature: experiment.cacheTemperature,
            metrics: {
                requests: 1,
                qps: 1,
                sqlQueries: Number(sqlQueries || 0),
                p99: Math.max(1, Math.round(latency)),
                poolPeak: Number(currentPath && currentPath.poolPeak || 0),
                poolCapacity: Number(currentPath && currentPath.poolCapacity || 0),
                hitRate: hitRate,
                errors: 0
            }
        });
    }

    function runCounterDelta(current, baseline, key) {
        function value(source) {
            source = source || {};
            if (key === "sqlQueries" && source.sqlQueries === undefined) {
                return Number(source.dbReads || 0);
            }
            return Number(source[key] || 0);
        }
        return Math.max(0, value(current) - value(baseline));
    }

    function trackCrowdRun(direct, cached, at) {
        if (state.entry !== "crowd" || !state.pendingRun) {
            return;
        }
        var mode = state.pendingRun.mode === "cached" ? "cached" : "direct";
        var path = mode === "cached" ? cached : direct;
        var baseline = state.pendingRun.baseline || null;
        if (mode === "cached" && state.pendingRun.cacheTemperature === "cold") {
            baseline = {};
        } else if (baseline && path.totalRequests < Number(baseline.totalRequests || 0)) {
            baseline = {};
        }
        if (!state.crowdRun) {
            if (!baseline) {
                baseline = Object.assign({}, path);
            }
            var initialRequests = runCounterDelta(path, baseline, "totalRequests");
            if (path.qps <= 0 && initialRequests <= 0) {
                return;
            }
            state.crowdRun = {
                baseline: baseline,
                latest: path,
                peakPool: path.poolPeak,
                poolCapacity: path.poolCapacity,
                startedAt: at || new Date().toISOString()
            };
            if (state.metricsLoadActive) {
                byId("freeze-status").textContent = "压测进行中 · 结果尚未冻结";
                return;
            }
        } else {
            state.crowdRun.latest = path;
            state.crowdRun.peakPool = Math.max(state.crowdRun.peakPool, path.poolPeak);
            state.crowdRun.poolCapacity = Math.max(state.crowdRun.poolCapacity, path.poolCapacity);
        }
        if (state.metricsLoadActive) {
            return;
        }

        var run = state.crowdRun;
        var requests = runCounterDelta(run.latest, run.baseline, "totalRequests");
        var hits = runCounterDelta(run.latest, run.baseline, "cacheHits");
        var misses = runCounterDelta(run.latest, run.baseline, "cacheMisses");
        var durationSeconds = Math.max(1, Number(state.pendingRun.expectedDurationSeconds || 20));
        if (requests <= 0) {
            return;
        }
        completeResult({
            entry: "crowd",
            materialCode: state.pendingRun.materialCode || state.profile.code,
            materialName: state.pendingRun.materialName || state.profile.name,
            mode: mode,
            cacheTemperature: state.pendingRun.cacheTemperature,
            expectedRate: state.pendingRun.expectedRate,
            expectedDurationSeconds: durationSeconds,
            startedAt: run.startedAt,
            metrics: {
                requests: requests,
                qps: Math.round(requests / durationSeconds),
                sqlQueries: runCounterDelta(run.latest, run.baseline, "sqlQueries"),
                p99: run.latest.p99,
                poolPeak: run.peakPool,
                poolCapacity: run.poolCapacity,
                hitRate: mode === "cached" && hits + misses > 0 ? Math.round(hits * 100 / (hits + misses)) : null,
                errors: runCounterDelta(run.latest, run.baseline, "errors")
            }
        });
    }

    function renderRecord(body, source, latency) {
        var responseId = Number(body && body.id);
        var profile = profiles[responseId] || state.profile;
        state.lastResponse = { body: body, source: source, latency: latency };
        byId("record-placeholder").hidden = true;
        byId("record-result").hidden = false;
        byId("record-result").dataset.kind = profile.kind;
        byId("record-result-code").textContent = body.code || profile.code;
        byId("record-result-name").textContent = body.name || profile.name;
        byId("record-result-sigil").textContent = body.sigil || profile.sigil;
        byId("record-rarity").textContent = body.rarity && body.rarity.label || profile.rarity;
        byId("record-origin").textContent = body.source ? body.source.name + " · " + body.source.region : profile.origin;
        byId("record-attribute").textContent = body.attribute || profile.attribute;
        byId("record-usage").textContent = body.usage || profile.usage;
        byId("record-risk").textContent = body.risk || profile.risk;
        byId("record-price").textContent = formatNumber(body.price) + " 金币";
        byId("record-stock").textContent = formatNumber(body.stock) + " 份";
        byId("record-components").textContent = (body.components || []).map(function (component) {
            return component.name + " × " + component.quantity + component.unit;
        }).join("、") || "—";
        byId("record-trades").textContent = body.tradeStats ?
            formatNumber(body.tradeStats.transactions24h) + " 笔 · " + formatNumber(body.tradeStats.volume24h) + " 份" : "—";
        byId("record-rating").textContent = body.rating ?
            Number(body.rating.score || 0).toFixed(2) + " / 5 · " + formatNumber(body.rating.count) + " 条" : "—";
        byId("record-source").textContent = sourceLabel(source);
        byId("record-latency").textContent = latency.toFixed(1) + " ms";
    }

    async function prepareColdCache() {
        var result = await requestJSON("/api/chapters/cache-aside/reset", { method: "POST" });
        state.previousRead = null;
        resetMetricsHistory();
        if (result.body && result.body.snapshot) {
            acceptMetricsSnapshot({ archiveRead: result.body.snapshot });
        }
    }

    async function readArchive() {
        if (!state.id || state.isRequesting || state.isReplaying) {
            return;
        }
        state.isRequesting = true;
        updateControlState();
        resetRouteVisual();
        byId("request-status").textContent = "真实 HTTP 请求已发送";
        byId("actual-latency").textContent = "等待响应";
        byId("actual-source").textContent = "等待响应头";
        byId("replay-status").textContent = "响应到达后开始";
        var experiment = currentExperiment();
        var path = experiment.mode === "cached" ? "cached" : "direct";
        var started = null;

        try {
            if (experiment.mode === "cached" && experiment.cacheTemperature === "cold") {
                byId("request-status").textContent = "正在准备冷缓存：清除档案缓存与本章指标";
                byId("actual-latency").textContent = "尚未发起材料请求";
                await prepareColdCache();
                byId("request-status").textContent = "冷缓存已准备，真实 HTTP 请求已发送";
                byId("actual-latency").textContent = "等待响应";
            }
            started = window.performance.now();
            var result = await requestJSON("/api/archives/" + state.id + "/" + path);
            var latency = window.performance.now() - started;
            var source = result.response.headers.get("X-Archive-Source") || "unknown";
            var sqlQueries = Number(result.response.headers.get("X-SQL-Queries") || 0);
            state.isRequesting = false;
            byId("request-status").textContent = "响应已接收并保存";
            byId("actual-latency").textContent = latency.toFixed(1) + " ms";
            byId("actual-source").textContent = source;
            renderRecord(result.body, source, latency);
            if (state.entry === "single") {
                freezeSingleResult(source, latency, sqlQueries);
            }
            playRoute(source, "manual");
        } catch (error) {
            state.isRequesting = false;
            byId("request-status").textContent = started ? "真实请求失败" : "冷缓存准备失败，材料请求未发出";
            byId("actual-latency").textContent = started ?
                (window.performance.now() - started).toFixed(1) + " ms" : "—";
            byId("actual-source").textContent = "ERROR";
            byId("replay-status").textContent = "没有成功路径可回放";
            showToast(error.message, "danger");
            updateControlState();
        }
    }

    function pathValues(path) {
        path = path || {};
        return {
            totalRequests: Number(path.totalRequests || 0), qps: Number(path.qps || 0),
            sqlQueries: Number(path.sqlQueries === undefined ? path.dbReads || 0 : path.sqlQueries), p99: Number(path.p99 || 0),
            poolPeak: Number(path.poolPeak || 0), poolCapacity: Number(path.poolCapacity || 0),
            cacheHits: Number(path.cacheHits || 0), cacheMisses: Number(path.cacheMisses || 0),
            cacheErrors: Number(path.cacheErrors || 0), cacheHitRate: Number(path.cacheHitRate || 0),
            errors: Number(path.errors || 0)
        };
    }

    function setMetric(id, value, suffix) {
        byId(id).textContent = formatNumber(value) + (suffix || "");
    }

    function renderActiveMetrics() {
        if (!state.snapshot) {
            return;
        }
        var cached = currentExperiment().mode === "cached";
        var path = cached ? state.snapshot.cached : state.snapshot.direct;
        setMetric("active-qps", path.qps);
        setMetric("active-db-reads", path.sqlQueries);
        setMetric("active-p99", path.p99, " ms");
        byId("active-pool").textContent = formatNumber(path.poolPeak) + " / " + formatNumber(path.poolCapacity);
        byId("active-hit-rate").textContent = cached ? formatNumber(path.cacheHitRate) + "%" : "—";
        setMetric("active-errors", path.errors);
        byId("mysql-pool-live").textContent = "POOL " + formatNumber(path.poolPeak) + " / " + formatNumber(path.poolCapacity);
    }

    function perThousand(path) {
        return path.totalRequests ? Math.round(path.sqlQueries * 1000 / path.totalRequests) : null;
    }

    function renderComparison(direct, cached) {
        var directRate = perThousand(direct);
        var cachedRate = perThousand(cached);
        if (directRate === null || cachedRate === null) {
            byId("comparison-summary").textContent = "等待两条路径产生真实请求";
            return;
        }
        var reduction = directRate > 0 ? Math.max(0, Math.round((directRate - cachedRate) * 100 / directRate)) : 0;
        byId("comparison-summary").textContent = "每千次请求的 SQL Queries：" +
            formatNumber(directRate) + " → " + formatNumber(cachedRate) + "，减少 " + reduction + "%";
    }

    function inferExternalRoute(direct, cached) {
        var previous = state.previousRead;
        state.previousRead = { direct: direct, cached: cached };
        if (!previous || state.isRequesting || state.isReplaying) {
            return;
        }
        var directDelta = direct.totalRequests - previous.direct.totalRequests;
        var cachedDelta = cached.totalRequests - previous.cached.totalRequests;
        if (directDelta <= 0 && cachedDelta <= 0) {
            return;
        }
        var now = Date.now();
        if (now - state.lastTrafficReplayAt < 1500) {
            return;
        }
        state.lastTrafficReplayAt = now;
        if (cachedDelta > directDelta) {
            var errorDelta = cached.cacheErrors - previous.cached.cacheErrors;
            var missDelta = cached.cacheMisses - previous.cached.cacheMisses;
            playRoute(errorDelta > 0 ? "redis-fallback" : (missDelta > 0 ? "redis-miss" : "redis-hit"), "sse");
        } else {
            playRoute("mysql", "sse");
        }
    }

    function renderArchiveRead(chapter, skipRouteInference) {
        if (!chapter) {
            return;
        }
        var direct = pathValues(chapter.direct);
        var cached = pathValues(chapter.cached);
        state.snapshot = { direct: direct, cached: cached };
        setMetric("direct-total", direct.totalRequests);
        setMetric("cached-total", cached.totalRequests);
        setMetric("direct-db-reads", direct.sqlQueries);
        setMetric("cached-db-reads", cached.sqlQueries);
        setMetric("direct-p99", direct.p99, " ms");
        setMetric("cached-p99", cached.p99, " ms");
        byId("direct-pool").textContent = formatNumber(direct.poolPeak) + " / " + formatNumber(direct.poolCapacity);
        byId("cached-pool").textContent = formatNumber(cached.poolPeak) + " / " + formatNumber(cached.poolCapacity);
        setMetric("cached-hit-rate", cached.cacheHitRate, "%");
        setMetric("direct-errors", direct.errors);
        setMetric("cached-errors", cached.errors);
        byId("redis-ttl").textContent = "TTL " + formatNumber(chapter.cacheTTLSeconds || 300) + "s";
        byId("metrics-timestamp").textContent = chapter.at ? new Date(chapter.at).toLocaleTimeString("zh-CN", { hour12: false }) : "LIVE";
        renderComparison(direct, cached);
        renderActiveMetrics();
        if (!skipRouteInference) {
            trackCrowdRun(direct, cached, chapter.at);
            inferExternalRoute(direct, cached);
        }
    }

    function renderSnapshot(snapshot, skipRouteInference) {
        if (snapshot && snapshot.archiveRead) {
            renderArchiveRead(snapshot.archiveRead, skipRouteInference);
        }
    }

    function metricsFrameValues(snapshot) {
        var chapter = snapshot && snapshot.archiveRead;
        return chapter ? { direct: pathValues(chapter.direct), cached: pathValues(chapter.cached) } : null;
    }

    function metricsFrameIsActive(snapshot) {
        var values = metricsFrameValues(snapshot);
        return Boolean(values && (values.direct.qps > 0 || values.cached.qps > 0));
    }

    function replayMetricsWindow() {
        return state.metricsHistory.slice(-60);
    }

    function hasReplayableMetrics() {
        var frames = replayMetricsWindow();
        return frames.length > 1 && frames.some(metricsFrameIsActive);
    }

    function updateMetricsPlaybackControls() {
        var replayButton = byId("replay-metrics");
        var pauseButton = byId("pause-metrics-replay");
        var status = byId("metrics-playback-state");

        replayButton.disabled = !state.metricsReplaying && (state.metricsLoadActive || !hasReplayableMetrics());
        replayButton.textContent = state.metricsReplaying ? "退出重放" : "重放指标";
        pauseButton.disabled = !state.metricsReplaying;
        pauseButton.textContent = state.metricsReplayPaused ? "继续重放" : "暂停重放";
        pauseButton.setAttribute("aria-pressed", state.metricsReplayPaused ? "true" : "false");

        if (state.metricsLoadActive) {
            status.textContent = "压测进行中 · 实时指标不可暂停";
        } else if (state.metricsReplaying) {
            status.textContent = (state.metricsReplayPaused ? "重放已暂停 · " : "正在重放 · ") +
                state.metricsReplayIndex + " / " + state.metricsReplayFrames.length;
        } else if (hasReplayableMetrics()) {
            status.textContent = "压测已结束 · 可重放最近 " + replayMetricsWindow().length + " 帧";
        } else {
            status.textContent = "实时采集中 · 等待压测数据";
        }
    }

    function clearMetricsReplayTimer() {
        if (state.metricsReplayTimer) {
            window.clearTimeout(state.metricsReplayTimer);
            state.metricsReplayTimer = null;
        }
    }

    function finishMetricsReplay(skipRouteInference, skipRestore) {
        clearMetricsReplayTimer();
        state.metricsReplaying = false;
        state.metricsReplayPaused = false;
        state.metricsReplayFrames = [];
        state.metricsReplayIndex = 0;
        if (state.metricsLatest && !skipRestore) {
            renderSnapshot(state.metricsLatest, skipRouteInference);
        }
        updateMetricsPlaybackControls();
    }

    function playNextMetricsFrame() {
        if (!state.metricsReplaying || state.metricsReplayPaused) {
            return;
        }
        if (state.metricsReplayIndex >= state.metricsReplayFrames.length) {
            finishMetricsReplay(true, false);
            return;
        }
        renderSnapshot(state.metricsReplayFrames[state.metricsReplayIndex], true);
        state.metricsReplayIndex += 1;
        updateMetricsPlaybackControls();
        state.metricsReplayTimer = window.setTimeout(playNextMetricsFrame, state.reducedMotion ? 120 : 500);
    }

    function startMetricsReplay() {
        if (state.metricsReplaying) {
            finishMetricsReplay(true, false);
            return;
        }
        if (state.metricsLoadActive) {
            showToast("压测进行中，指标必须保持实时。", "danger");
            return;
        }
        if (!hasReplayableMetrics()) {
            showToast("还没有可重放的压测指标。", "danger");
            return;
        }
        var frames = replayMetricsWindow();
        var firstActive = frames.findIndex(metricsFrameIsActive);
        state.metricsReplayFrames = frames.slice(Math.max(0, firstActive - 2));
        state.metricsReplayIndex = 0;
        state.metricsReplaying = true;
        state.metricsReplayPaused = false;
        playNextMetricsFrame();
    }

    function toggleMetricsReplayPause() {
        if (!state.metricsReplaying) {
            return;
        }
        state.metricsReplayPaused = !state.metricsReplayPaused;
        clearMetricsReplayTimer();
        updateMetricsPlaybackControls();
        if (!state.metricsReplayPaused) {
            playNextMetricsFrame();
        }
    }

    function resetMetricsHistory() {
        clearMetricsReplayTimer();
        state.metricsHistory = [];
        state.metricsLatest = null;
        state.metricsLoadActive = false;
        state.metricsTrafficSeen = false;
        state.metricsIdleFrames = 0;
        state.metricsReplaying = false;
        state.metricsReplayPaused = false;
        state.metricsReplayFrames = [];
        state.metricsReplayIndex = 0;
        updateMetricsPlaybackControls();
    }

    function acceptMetricsSnapshot(snapshot) {
        if (!snapshot || !snapshot.archiveRead) {
            return;
        }
        var previousLatest = state.metricsLatest;
        state.metricsLatest = snapshot;
        state.metricsHistory.push(snapshot);
        if (state.metricsHistory.length > 90) {
            state.metricsHistory.shift();
        }

        var loadActive = false;
        if (state.entry === "crowd") {
            var currentValues = metricsFrameValues(snapshot);
            var previousValues = metricsFrameValues(previousLatest);
            var currentTotal = currentValues ? currentValues.direct.totalRequests + currentValues.cached.totalRequests : 0;
            var previousTotal = previousValues ? previousValues.direct.totalRequests + previousValues.cached.totalRequests : currentTotal;
            if (currentTotal !== previousTotal || (!state.metricsTrafficSeen && metricsFrameIsActive(snapshot))) {
                state.metricsTrafficSeen = true;
                state.metricsIdleFrames = 0;
            } else if (state.metricsTrafficSeen) {
                state.metricsIdleFrames += 1;
            }
            loadActive = state.metricsTrafficSeen && state.metricsIdleFrames < 3;
        }
        if (loadActive && state.metricsReplaying) {
            state.metricsLoadActive = true;
            finishMetricsReplay(true, true);
            showToast("检测到新的实时流量，已退出重放。", "success");
        } else {
            state.metricsLoadActive = loadActive;
        }

        if (!state.metricsReplaying) {
            renderSnapshot(snapshot);
        }
        updateMetricsPlaybackControls();
    }

    async function fetchSnapshot() {
        try {
            var result = await requestJSON("/api/metrics/snapshot");
            acceptMetricsSnapshot(result.body);
            setConnection(true);
        } catch (_) {
            setConnection(false);
        }
    }

    function connectMetrics() {
        if (!window.EventSource) {
            state.pollTimer = window.setInterval(fetchSnapshot, 1500);
            return;
        }
        state.stream = new EventSource("/api/metrics/stream");
        state.stream.addEventListener("metrics", function (event) {
            try {
                acceptMetricsSnapshot(JSON.parse(event.data));
                setConnection(true);
            } catch (_) {
                setConnection(false);
            }
        });
        state.stream.onerror = function () { setConnection(false); };
    }

    async function resetLab() {
        var button = byId("reset-lab");
        button.disabled = true;
        try {
            var result = await requestJSON("/api/chapters/cache-aside/reset", { method: "POST" });
            state.previousRead = null;
            state.lastResponse = null;
            state.isRequesting = false;
            state.isReplaying = false;
            resetRouteVisual();
            document.body.dataset.routeState = "idle";
            byId("route-label").textContent = "WAITING";
            byId("route-title").textContent = "按室外配置发起请求";
            byId("route-events").innerHTML = "<li><span>READY</span><strong>等待真实响应头</strong><small>不会根据所选模式猜测结果</small></li>";
            byId("record-placeholder").hidden = false;
            byId("record-result").hidden = true;
            byId("request-status").textContent = "等待发起真实请求";
            byId("actual-latency").textContent = "—";
            byId("actual-source").textContent = "—";
            byId("replay-status").textContent = "尚未开始";
            resetMetricsHistory();
            if (result.body && result.body.snapshot) {
                acceptMetricsSnapshot({ archiveRead: result.body.snapshot });
            }
            showToast("Redis 档案缓存和本章指标已清空。", "success");
        } catch (error) {
            showToast(error.message, "danger");
        } finally {
            button.disabled = false;
            updateControlState();
        }
    }

    async function clearComparison() {
        var button = byId("clear-comparison");
        button.disabled = true;
        experimentResults.clear();
        state.pendingRun = null;
        state.crowdRun = null;
        state.previousRead = null;
        resetMetricsHistory();
        renderFrozenResults();
        byId("freeze-status").textContent = "对比已清空 · 等待新一轮测试";
        try {
            var result = await requestJSON("/api/chapters/cache-aside/reset", { method: "POST" });
            if (result.body && result.body.snapshot) {
                acceptMetricsSnapshot({ archiveRead: result.body.snapshot });
            }
            showToast("对比结果、待运行状态、Redis 档案缓存和本章指标已清空。", "success");
        } catch (error) {
            showToast("本地对比已清空；服务端缓存与指标重置失败：" + error.message, "danger");
        } finally {
            button.disabled = false;
            updateControlState();
        }
    }

    function bindEvents() {
        byId("query-archive").addEventListener("click", readArchive);
        byId("reset-lab").addEventListener("click", resetLab);
        byId("clear-comparison").addEventListener("click", clearComparison);
        byId("replay-metrics").addEventListener("click", startMetricsReplay);
        byId("pause-metrics-replay").addEventListener("click", toggleMetricsReplayPause);
        byId("purchase-entry").addEventListener("click", function () {
            if (!state.lastResponse || !state.profile) {
                showToast("请先完成一次真实材料查询。", "danger");
                return;
            }
            window.location.href = "/purchase-lab?material=" + encodeURIComponent(state.profile.code);
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        if (!showLabContext(incomingMaterial())) {
            return;
        }
        bindEvents();
        var entry = incomingEntry();
        state.entry = entry;
        state.pendingRun = entry === "crowd" ? experimentResults.pending() : null;
        document.body.dataset.entryMode = entry;
        renderExperimentState(currentExperiment());
        experimentState.subscribe(renderExperimentState);
        experimentResults.subscribe(renderFrozenResults);
        renderFrozenResults();
        resetRouteVisual();
        updateControlState();
        updateMetricsPlaybackControls();
        if (entry === "crowd") {
            byId("request-status").textContent = "已从室外跟随压测请求进入";
            byId("replay-status").textContent = "等待 SSE 捕获后续请求";
        }
        fetchSnapshot();
        connectMetrics();
    });

    window.addEventListener("beforeunload", function () {
        clearRouteTimers();
        if (state.stream) {
            state.stream.close();
        }
        if (state.pollTimer) {
            window.clearInterval(state.pollTimer);
        }
        clearMetricsReplayTimer();
    });
}());
