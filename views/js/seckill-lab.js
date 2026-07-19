(function () {
    "use strict";

    var STORAGE_KEY = "silas.cache-aside.material-id";
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
        mode: "direct",
        snapshot: null,
        previousRead: null,
        lastResponse: null,
        isRequesting: false,
        isReplaying: false,
        stream: null,
        pollTimer: null,
        routeTimers: [],
        lastTrafficReplayAt: 0,
        reducedMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    };

    var sourceDefinitions = {
        mysql: {
            state: "direct",
            label: "MYSQL DIRECT",
            title: "Client → Go API → MySQL → Response",
            redis: "NOT INVOLVED",
            mysql: "DB READ",
            tone: "direct",
            events: [
                ["MYSQL DIRECT", "Go API 选择直读路径", "本次不查询 Redis"],
                ["REDIS NOT INVOLVED", "Redis 不参与", "缓存层保持待机"],
                ["MYSQL DB READ", "读取权威材料档案", "DB Reads 增加"],
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
                ["REDIS CACHE HIT", "命中只读档案副本", "不产生 MySQL DB Read"],
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
            mysql: "DB READ",
            tone: "miss",
            events: [
                ["CACHE LOOKUP", "Go API 查询 Redis 槽位", "当前 key 没有可用副本"],
                ["CACHE MISS", "Redis 返回未命中", "请求继续回源 MySQL"],
                ["MYSQL DB READ", "读取权威材料档案", "DB Reads 增加"],
                ["CACHE FILLED", "响应体回填 Redis", "TTL 重置为 300 秒"],
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
                ["MYSQL DB READ", "读取权威材料档案", "本次不执行缓存回填"],
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

    function setMode(mode) {
        state.mode = mode === "cached" ? "cached" : "direct";
        document.body.dataset.labMode = state.mode;
        var cached = state.mode === "cached";
        byId("mode-direct").classList.toggle("is-active", !cached);
        byId("mode-cached").classList.toggle("is-active", cached);
        byId("mode-direct").setAttribute("aria-pressed", cached ? "false" : "true");
        byId("mode-cached").setAttribute("aria-pressed", cached ? "true" : "false");
        byId("query-endpoint").textContent = cached ? "via /cached" : "via /direct";
        byId("load-mode").textContent = cached ? "REDIS CACHE-ASIDE" : "MYSQL DIRECT";
        updateCommand();
        renderActiveMetrics();
    }

    function updateControlState() {
        var locked = state.isRequesting || state.isReplaying;
        byId("query-archive").disabled = locked;
        byId("mode-direct").disabled = locked;
        byId("mode-cached").disabled = locked;
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

    function renderRecord(body, source, latency) {
        var responseId = Number(body && body.id);
        var profile = profiles[responseId] || state.profile;
        state.lastResponse = { body: body, source: source, latency: latency };
        byId("record-placeholder").hidden = true;
        byId("record-result").hidden = false;
        byId("record-result").dataset.kind = profile.kind;
        byId("record-result-code").textContent = profile.code;
        byId("record-result-name").textContent = profile.name;
        byId("record-result-sigil").textContent = profile.sigil;
        byId("record-rarity").textContent = profile.rarity;
        byId("record-origin").textContent = profile.origin;
        byId("record-attribute").textContent = profile.attribute;
        byId("record-usage").textContent = profile.usage;
        byId("record-risk").textContent = profile.risk;
        byId("record-source").textContent = sourceLabel(source);
        byId("record-latency").textContent = latency.toFixed(1) + " ms";
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
        var path = state.mode === "cached" ? "cached" : "direct";
        var started = window.performance.now();

        try {
            var result = await requestJSON("/api/archives/" + state.id + "/" + path);
            var latency = window.performance.now() - started;
            var source = result.response.headers.get("X-Archive-Source") || "unknown";
            state.isRequesting = false;
            byId("request-status").textContent = "响应已接收并保存";
            byId("actual-latency").textContent = latency.toFixed(1) + " ms";
            byId("actual-source").textContent = source;
            renderRecord(result.body, source, latency);
            playRoute(source, "manual");
        } catch (error) {
            state.isRequesting = false;
            byId("request-status").textContent = "真实请求失败";
            byId("actual-latency").textContent = (window.performance.now() - started).toFixed(1) + " ms";
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
            dbReads: Number(path.dbReads || 0), p99: Number(path.p99 || 0),
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
        var path = state.mode === "cached" ? state.snapshot.cached : state.snapshot.direct;
        setMetric("active-qps", path.qps);
        setMetric("active-db-reads", path.dbReads);
        setMetric("active-p99", path.p99, " ms");
        byId("active-pool").textContent = formatNumber(path.poolPeak) + " / " + formatNumber(path.poolCapacity);
        byId("active-hit-rate").textContent = state.mode === "cached" ? formatNumber(path.cacheHitRate) + "%" : "—";
        setMetric("active-errors", path.errors);
        byId("mysql-pool-live").textContent = "POOL " + formatNumber(path.poolPeak) + " / " + formatNumber(path.poolCapacity);
        updateTrafficWindow(path.qps);
    }

    function perThousand(path) {
        return path.totalRequests ? Math.round(path.dbReads * 1000 / path.totalRequests) : null;
    }

    function renderComparison(direct, cached) {
        var directRate = perThousand(direct);
        var cachedRate = perThousand(cached);
        if (directRate === null || cachedRate === null) {
            byId("comparison-summary").textContent = "等待两条路径产生真实请求";
            return;
        }
        var reduction = directRate > 0 ? Math.max(0, Math.round((directRate - cachedRate) * 100 / directRate)) : 0;
        byId("comparison-summary").textContent = "每千次请求的 DB Reads：" +
            formatNumber(directRate) + " → " + formatNumber(cachedRate) + "，减少 " + reduction + "%";
    }

    function updateTrafficWindow(qps) {
        var active = qps > 0;
        byId("traffic-window").classList.toggle("is-active", active);
        byId("traffic-status").textContent = active ? "LIVE TRAFFIC" : "IDLE";
        byId("traffic-qps").textContent = formatNumber(qps) + " req/s";
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
            if (state.mode !== "cached") {
                setMode("cached");
            }
            var errorDelta = cached.cacheErrors - previous.cached.cacheErrors;
            var missDelta = cached.cacheMisses - previous.cached.cacheMisses;
            playRoute(errorDelta > 0 ? "redis-fallback" : (missDelta > 0 ? "redis-miss" : "redis-hit"), "sse");
        } else {
            if (state.mode !== "direct") {
                setMode("direct");
            }
            playRoute("mysql", "sse");
        }
    }

    function renderArchiveRead(chapter) {
        if (!chapter) {
            return;
        }
        var direct = pathValues(chapter.direct);
        var cached = pathValues(chapter.cached);
        state.snapshot = { direct: direct, cached: cached };
        setMetric("direct-total", direct.totalRequests);
        setMetric("cached-total", cached.totalRequests);
        setMetric("direct-db-reads", direct.dbReads);
        setMetric("cached-db-reads", cached.dbReads);
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
        inferExternalRoute(direct, cached);
    }

    function renderSnapshot(snapshot) {
        if (snapshot && snapshot.archiveRead) {
            renderArchiveRead(snapshot.archiveRead);
        }
    }

    async function fetchSnapshot() {
        try {
            var result = await requestJSON("/api/metrics/snapshot");
            renderSnapshot(result.body);
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
                renderSnapshot(JSON.parse(event.data));
                setConnection(true);
            } catch (_) {
                setConnection(false);
            }
        });
        state.stream.onerror = function () { setConnection(false); };
    }

    function updateCommand() {
        if (!state.id) {
            return;
        }
        var rate = byId("rate-range").value;
        var connections = byId("connections-range").value;
        var duration = byId("duration-select").value;
        var path = state.mode === "cached" ? "cached" : "direct";
        byId("rate-value").textContent = rate + " req/s";
        byId("connections-value").textContent = connections;
        byId("load-command").textContent = "docker compose --profile loadtest run --rm --no-deps " +
            "-e RATE=" + rate + " -e DURATION=" + duration + " -e CONNECTIONS=" + connections + " " +
            "-e TARGET_URL=http://app:5678/api/archives/" + state.id + "/" + path + " " +
            "-e SCRIPT=/opt/wrk2/scripts/read.lua wrk2";
    }

    async function copyCommand() {
        var command = byId("load-command").textContent;
        try {
            await navigator.clipboard.writeText(command);
            showToast("wrk2 命令已复制。运行后这里会通过 SSE 显示真实指标。", "success");
        } catch (_) {
            var textarea = document.createElement("textarea");
            textarea.value = command;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            textarea.remove();
            showToast("wrk2 命令已复制。", "success");
        }
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
            byId("route-title").textContent = "选择策略后发起请求";
            byId("route-events").innerHTML = "<li><span>READY</span><strong>等待真实响应头</strong><small>不会根据所选模式猜测结果</small></li>";
            byId("record-placeholder").hidden = false;
            byId("record-result").hidden = true;
            byId("request-status").textContent = "等待发起真实请求";
            byId("actual-latency").textContent = "—";
            byId("actual-source").textContent = "—";
            byId("replay-status").textContent = "尚未开始";
            renderArchiveRead(result.body && result.body.snapshot);
            showToast("Redis 档案缓存和本章指标已清空。", "success");
        } catch (error) {
            showToast(error.message, "danger");
        } finally {
            button.disabled = false;
            updateControlState();
        }
    }

    function bindEvents() {
        byId("mode-direct").addEventListener("click", function () { setMode("direct"); });
        byId("mode-cached").addEventListener("click", function () { setMode("cached"); });
        byId("query-archive").addEventListener("click", readArchive);
        byId("reset-lab").addEventListener("click", resetLab);
        byId("rate-range").addEventListener("input", updateCommand);
        byId("connections-range").addEventListener("input", updateCommand);
        byId("duration-select").addEventListener("change", updateCommand);
        byId("copy-command").addEventListener("click", copyCommand);
        byId("purchase-entry").addEventListener("click", function () {
            showToast("购买实验尚未接入；价格与真实库存会在购买请求中重新校验。", "success");
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        if (!showLabContext(incomingMaterial())) {
            return;
        }
        bindEvents();
        setMode("direct");
        resetRouteVisual();
        updateControlState();
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
    });
}());
