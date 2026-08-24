(function () {
    "use strict";

    var ACTIVE_TASK_KEY = "silas.cache-aside.active-loadtest.v1";
    var experimentState = window.SilasExperimentState;
    var experimentResults = window.SilasExperimentResults;
    var profiles = {
        4: {
            name: "星髓", sigil: "Ⅳ", kind: "star",
            rarity: "LEGENDARY · 传说", origin: "坠星盆地", attribute: "高密度魔力 · 星光迁移",
            usage: "高阶炼成与能量校准", risk: "高密度魔力会干扰未经屏蔽的仪器。"
        }
    };

    var state = {
        id: null,
        profile: null,
        entry: "single",
        scenario: "steady",
        protection: "none",
        pendingRun: null,
        crowdRun: null,
        loadtestTaskId: null,
        loadtestTask: null,
        loadtestStream: null,
        loadtestPollTimer: null,
        loadtestResultSaved: false,
        loadtestLastActiveStatus: "starting",
        loadtestRecordLoaded: false,
        loadtestStartRequested: false,
        loadtestCreateInFlight: false,
        labSceneReady: false,
        metricsObservationReady: false,
        metricsSnapshotRecoveryAt: 0,
        crowdHandoff: null,
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
        connectionPlan: null,
        connectionPlanError: "",
        connectionPlanRequest: 0,
        tideTrace: {
            taskId: "",
            eventHighWater: 0,
            seenMilestones: {},
            lastStep: null,
            sequence: 0,
            requestHighWater: 0,
            hitHighWater: 0,
            fallbackHighWater: 0,
            cacheErrorHighWater: 0,
            coalescedHighWater: 0,
            negativeHighWater: 0,
            refillHitFloor: 0,
            refillPending: false,
            refillEvidence: false,
            responseBaseline: 0,
            responseResetObserved: false,
            responseEvidence: false,
            queue: [],
            active: null,
            animations: [],
            timer: null,
            lastStartedAt: 0
        },
        reducedMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    };
    var metricAnimations = new WeakMap();
    // 查询潮汐是目标 QPS，魔法通路是 wrk2 保持的 HTTP 持久连接；二者都不是用户人数。
    // 运行前通过 Runner 的同源预估接口显示 -c；创建任务后必须用 CreateResponse/Task 的最终值覆盖，
    // 避免前端复制自动算法，也避免把配置连接数误称为成功建立的 socket 数。
    var crowdTiers = Object.freeze({
        qps_100: Object.freeze({ label: "涓流", rate: 100, duration: 30 }),
        qps_300: Object.freeze({ label: "涟漪", rate: 300, duration: 30 }),
        qps_800: Object.freeze({ label: "浪潮", rate: 800, duration: 30 }),
        qps_1500: Object.freeze({ label: "满潮", rate: 1500, duration: 30 })
    });
    var allowedConnections = Object.freeze([70, 140, 300, 500]);
    var crowdTierID = "qps_1500";
    var connectionMode = "auto";
    var manualConnections = 300;

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

    function formatMetricValue(value, suffix, precision) {
        var number = Number(value || 0);
        return (precision > 0 ? number.toFixed(precision) : formatNumber(Math.round(number))) + (suffix || "");
    }

    function setQueryMetric(id, value, suffix, precision) {
        var element = byId(id);
        var target = Number(value);
        if (!element || !Number.isFinite(target)) {
            if (element) {
                element.textContent = String(value);
                delete element.dataset.metricValue;
            }
            return;
        }
        var previous = Number(element.dataset.metricValue);
        if (!Number.isFinite(previous)) {
            previous = Number.parseFloat(element.textContent.replace(/,/g, ""));
        }
        if (!Number.isFinite(previous)) {
            previous = 0;
        }
        if (state.reducedMotion || previous === target) {
            element.textContent = formatMetricValue(target, suffix, precision);
            element.dataset.metricValue = String(target);
            return;
        }
        var running = metricAnimations.get(element);
        if (running) {
            window.cancelAnimationFrame(running);
        }
        var startedAt = window.performance.now();
        var duration = 460;
        element.classList.remove("is-ticking");
        void element.offsetWidth;
        element.classList.add("is-ticking");

        function tick(now) {
            var progress = Math.min(1, (now - startedAt) / duration);
            var eased = 1 - Math.pow(1 - progress, 3);
            var current = previous + (target - previous) * eased;
            element.textContent = formatMetricValue(current, suffix, precision);
            if (progress < 1) {
                metricAnimations.set(element, window.requestAnimationFrame(tick));
                return;
            }
            element.dataset.metricValue = String(target);
            element.classList.remove("is-ticking");
            metricAnimations.delete(element);
        }

        metricAnimations.set(element, window.requestAnimationFrame(tick));
    }

    function setRouteProgress(current, total) {
        var progress = byId("route-step-progress");
        progress.textContent = formatNumber(current) + " / " + formatNumber(total);
        progress.classList.remove("is-ticking");
        void progress.offsetWidth;
        progress.classList.add("is-ticking");
    }

    function queryVerdict(source, latency) {
        var hasLatency = latency !== null && latency !== undefined && latency !== "" &&
            Number.isFinite(Number(latency));
        var latencyText = hasLatency ? "，真实响应 " + Number(latency).toFixed(1) + " ms" : "";
        if (source === "mysql") {
            return "掌柜点评：这次直奔账房，路径最坦白" + latencyText + "；每次查询都要让 MySQL 亲自翻档案。";
        }
        if (source === "redis-hit") {
            return "掌柜点评：缓存窗口直接递出了完整档案" + latencyText + "，账房这次可以继续休息。";
        }
        if (source === "redis-miss") {
            return "掌柜点评：先在缓存扑空，再去账房取回档案并补上副本" + latencyText + "。";
        }
        if (source === "redis-fallback") {
            return "掌柜点评：缓存出了岔子，但安全旁路仍从 MySQL 取回了正确档案" + latencyText + "。";
        }
        return "掌柜点评：响应来源无法识别，先保留证据，不替服务器猜路线。";
    }

    function setQueryVerdict(copy) {
        byId("query-verdict-line").textContent = copy;
    }

    function incomingMaterial() {
        return { id: 4, profile: profiles[4] };
    }

    function incomingEntry() {
        var entry = new URLSearchParams(window.location.search).get("entry");
        return entry === "crowd" ? "crowd" : (entry === "crowd-setup" ? "crowd-setup" : "single");
    }

    function incomingLoadtestTaskID() {
        return new URLSearchParams(window.location.search).get("task") || "";
    }

    function incomingCrowdMode() {
        var mode = new URLSearchParams(window.location.search).get("mode");
        return mode === "cached" ? "cached" : (mode === "direct" ? "direct" : "");
    }

    function incomingCacheScenario() {
        var scenario = new URLSearchParams(window.location.search).get("scenario");
        return scenario === "breakdown" || scenario === "penetration" ? scenario : "steady";
    }

    function incomingProtection() {
        return new URLSearchParams(window.location.search).get("protection") === "negative-cache" ?
            "negative-cache" : "none";
    }

    function incomingLaunchWhenObserved() {
        return new URLSearchParams(window.location.search).get("launch") === "when-observed";
    }

    function crowdTierForRate(rate) {
        var matched = Object.keys(crowdTiers).find(function (key) {
            return crowdTiers[key].rate === Number(rate);
        });
        return matched || "";
    }

    function incomingCrowdConfig() {
        var query = new URLSearchParams(window.location.search);
        var tierID = crowdTierForRate(query.get("rate"));
        if (!tierID) {
            // 旧书签只用于恢复页面，不再把旧挡位名称带回新参数模型。
            var legacyRates = { visitors: 100, tide_eve: 300, crowd: 1500, boiling_city: 1500 };
            tierID = crowdTierForRate(legacyRates[query.get("tier")]) || "qps_1500";
        }
        var requestedMode = query.get("connectionMode");
        var mode = requestedMode === "manual" ? "manual" : "auto";
        var requestedConnections = Number(query.get("connections") || 0);
        if (allowedConnections.indexOf(requestedConnections) < 0) {
            requestedConnections = 300;
        }
        return {
            tierID: tierID,
            connectionMode: mode,
            connections: requestedConnections
        };
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
            var requestError = new Error((body && body.message) || "请求失败（" + response.status + "）");
            requestError.status = response.status;
            requestError.code = body && body.code || "";
            throw requestError;
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
        document.body.dataset.materialKind = context.profile.kind;
        byId("lab-current-name").textContent = context.profile.name;
        byId("rare-query-brief").hidden = context.profile.kind !== "star";
        byId("empty-state").hidden = true;
        byId("lab-content").hidden = false;
        return true;
    }

    function currentExperiment() {
        return experimentState.get();
    }

    function selectedLoadtestExperiment() {
        if (state.scenario === "breakdown") {
            return "cache-breakdown";
        }
        if (state.scenario === "penetration") {
            return "cache-penetration";
        }
        return "cache-aside-read";
    }

    function taskScenario(task) {
        if (task && task.experiment === "cache-breakdown") {
            return "breakdown";
        }
        if (task && task.experiment === "cache-penetration") {
            return "penetration";
        }
        return "steady";
    }

    function selectedConnectionMode() {
        return state.scenario === "steady" ? connectionMode : "auto";
    }

    function selectedProtection() {
        return state.scenario === "penetration" ? state.protection : "";
    }

    function taskMatchesSelection(task) {
        return Boolean(task && taskScenario(task) === state.scenario &&
            task.mode === currentExperiment().mode &&
            (state.scenario !== "penetration" || task.protection === state.protection));
    }

    function isCrowdEntry() {
        return state.entry === "crowd" || state.entry === "crowd-setup";
    }

    function renderCrowdSetup() {
        var panel = byId("lab-crowd-settings");
        var stage = byId("query-tide-stage");
        var taskBoard = byId("lab-loadtest");
        panel.hidden = !isCrowdEntry();
        stage.hidden = !isCrowdEntry();
        taskBoard.hidden = !isCrowdEntry();
        if (!isCrowdEntry()) {
            return;
        }
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        var taskMatchesMode = taskMatchesSelection(state.loadtestTask);
        var pendingPlanMatchesMode = Boolean(!state.loadtestTask &&
            state.pendingRun && (state.pendingRun.sharedConditions ||
                state.pendingRun.mode === currentExperiment().mode) &&
            (state.pendingRun.experiment || "cache-aside-read") === selectedLoadtestExperiment() &&
            (state.scenario !== "penetration" || state.pendingRun.protection === state.protection));
        var recoveringTask = Boolean(!state.loadtestTask && state.loadtestTaskId);
        var pendingMatchesMode = pendingPlanMatchesMode || recoveringTask;
        var pending = state.pendingRun || {};
        var pendingTask = pendingMatchesMode ? {
            taskId: state.loadtestTaskId,
            status: state.loadtestTaskId && state.pendingRun ? "starting" : "waiting",
            experiment: pending.experiment || "cache-aside-read",
            protection: pending.protection || "",
            mode: pending.sharedConditions ? currentExperiment().mode :
                (pending.mode || currentExperiment().mode),
            connectionMode: pending.connectionMode || connectionMode,
            connectionReason: pending.connectionReason || "",
            plannedConnections: Number(pending.plannedConnections || 0),
            tier: {
                rate: Number(pending.expectedRate || tier.rate),
                durationSeconds: Number(pending.expectedDurationSeconds || tier.duration),
                connections: state.loadtestTaskId ?
                    Number(pending.connections || 0) : 0
            }
        } : null;
        // 共同条件计划还不是任务，保留“先选路径、再开始”的配置视角；
        // 只有真实任务或恢复中的 task id 才切换到任务观测布局。
        var taskAttached = taskMatchesMode || recoveringTask;
        document.body.dataset.taskAttached = taskAttached ? "true" : "false";
        byId("query-title").textContent = taskAttached ?
            "观察本轮查询压测任务" : "选择本轮读取路径并开始";
        var taskTier = taskMatchesMode && state.loadtestTask.tier ||
            pendingTask && pendingTask.tier || null;
        var taskMode = taskMatchesMode && state.loadtestTask.connectionMode ||
            pendingTask && pendingTask.connectionMode || "";
        var displayRate = Number(taskTier && taskTier.rate || tier.rate);
        var displayDuration = Number(taskTier && taskTier.durationSeconds || tier.duration);
        var plan = matchingLabConnectionPlan();
        var handoffConnections = Number(pendingMatchesMode &&
            (!pending.sharedConditions || pending.connectionMode === "manual") &&
            pending.plannedConnections || 0);
        var effectiveConnectionMode = selectedConnectionMode();
        var plannedConnections = effectiveConnectionMode === "manual" ? manualConnections :
            Number(plan && plan.connections || handoffConnections || 0);
        var resolvedConnections = Number(taskTier && taskTier.connections || 0);
        var connectionCopy = taskTier && !taskMode ?
            ("旧任务 · -c " + resolvedConnections.toLocaleString("zh-CN")) :
            (resolvedConnections > 0 ?
                (taskMode === "manual" ? "手动" : "自动") + " · -c " +
                    resolvedConnections.toLocaleString("zh-CN") + " · 已锁定" :
                (effectiveConnectionMode === "manual" ?
                    "手动 · -c " + manualConnections.toLocaleString("zh-CN") + " · 计划" :
                    (plannedConnections > 0 ?
                        "自动 · -c " + plannedConnections.toLocaleString("zh-CN") + " · 计划" :
                        "自动 · 计划计算中")));
        var cached = currentExperiment().mode === "cached";
        var pathLabel = cached ? "Redis 旁路缓存" : "MySQL 直接查询";
        if (state.scenario === "breakdown") {
            pathLabel = "热点失效 · 旁路缓存";
        } else if (state.scenario === "penetration") {
            pathLabel = "不存在 ID · " + (state.protection === "negative-cache" ? "负缓存" : "无保护");
        }
        byId("lab-crowd-summary").textContent =
            "目标 " + displayRate.toLocaleString("zh-CN") + " req/s · " + connectionCopy;
        byId("query-endpoint").textContent = cached ? "via /cached" : "via /direct";
        byId("tide-target-rate").textContent = displayRate.toLocaleString("zh-CN") + " req/s";
        byId("tide-conduit-count").textContent = resolvedConnections > 0 ?
            "-c " + resolvedConnections.toLocaleString("zh-CN") + " · 已锁定" :
            (plannedConnections > 0 ? "-c " + plannedConnections.toLocaleString("zh-CN") + " · 计划" : "计划计算中");
        renderLabConnectionPlan(taskMatchesMode ? state.loadtestTask :
            (state.loadtestTaskId ? pendingTask : null));
        byId("query-tide-stage").dataset.backendMode = cached ? "cached" : "direct";
        byId("tide-kitchen-title").textContent = cached ? "Redis 优先 · MISS 回源" : "MySQL";

        if (!taskMatchesMode) {
            var waitingForObservation = Boolean(pendingTask && !state.loadtestTaskId);
            var waitingStatus = pendingTask ? pendingTask.status : "draft";
            taskBoard.dataset.status = waitingStatus;
            byId("lab-loadtest-title").textContent = waitingForObservation ?
                (state.loadtestCreateInFlight ? "正在创建 Runner 任务" :
                    (!state.labSceneReady ? "实验现场正在就绪" :
                        (!state.metricsObservationReady ? "正在建立指标观测" : "观测已经就绪"))) :
                (pendingTask ? "正在恢复任务状态" : "任务尚未创建");
            byId("lab-loadtest-copy").textContent = waitingForObservation ?
                (state.loadtestCreateInFlight ?
                    "页面和指标观测均已就绪，正在锁定最终 Runner 配置。" :
                    (state.labSceneReady && state.metricsObservationReady ?
                        (pending.sharedConditions ?
                            "共同 QPS、连接策略与时长已载入；选择直接查询或旁路缓存，再点击开始创建任务。" :
                            "观测已经就绪；点击开始按钮后才会创建 Runner 任务并发送真实请求。") :
                        "Runner 尚未创建，当前没有连接启用，也没有真实请求发送。")) :
                (pendingTask ? "正在通过任务快照恢复 Runner 状态；此时不会播放请求动画。" :
                "创建后，Runner " + (plannedConnections > 0 ?
                    "按 -c " + plannedConnections.toLocaleString("zh-CN") + " 启用连接配置" :
                    "按最终 -c 启用连接配置") + "，再发送请求。");
            byId("lab-loadtest-clock").textContent =
                "00:00 / " + formatLoadtestClock(displayDuration);
            byId("lab-stop-loadtest").hidden = true;
            byId("lab-load-path").textContent = pathLabel;
            byId("lab-load-target").textContent = displayRate.toLocaleString("zh-CN") + " req/s";
            byId("lab-load-connections").textContent = connectionCopy;
            byId("lab-load-runner-state").textContent =
                state.loadtestTaskId ? "状态同步中" : "尚未创建";
            byId("lab-load-qps").textContent = "—";
            byId("lab-load-completion").textContent = "—";
            byId("lab-load-timeouts").textContent =
                state.loadtestTaskId ? "结算后可见" : "—";
            byId("lab-load-requests").textContent = "—";
            byId("lab-load-request-p50").textContent = "—";
            byId("lab-load-request-p95").textContent = "—";
            byId("lab-load-p50").textContent = "—";
            byId("lab-load-p95").textContent = "—";
            byId("lab-load-errors").textContent = "—";
            byId("lab-load-hits").textContent = "—";
            byId("lab-load-fallbacks").textContent = "—";
            renderLoadtestStages({ status: waitingStatus });
            renderLoadtestLogs([]);
            renderQueryTideStage(pendingTask);
        }
    }

    function renderExperimentState(next) {
        var cached = next.mode === "cached";
        document.body.dataset.labMode = next.mode;
        var tideStage = byId("query-tide-stage");
        if (tideStage && !loadtestIsActive(state.loadtestTask)) {
            tideStage.dataset.backendMode = cached ? "cached" : "direct";
            resetTideCacheBridge();
        }
        byId("mode-direct").classList.toggle("is-active", !cached);
        byId("mode-cached").classList.toggle("is-active", cached);
        byId("mode-direct").setAttribute("aria-pressed", cached ? "false" : "true");
        byId("mode-cached").setAttribute("aria-pressed", cached ? "true" : "false");
        byId("lab-cache-settings").hidden = !cached || isCrowdEntry();
        Array.prototype.forEach.call(document.querySelectorAll("[name='lab-cache-temperature']"), function (radio) {
            radio.checked = radio.value === next.cacheTemperature;
        });
        byId("query-endpoint").textContent = cached ? "via /cached" : "via /direct";
        byId("lab-shared-strategy").textContent = cached ?
            "Redis 旁路缓存 · " + (next.cacheTemperature === "cold" ? "冷缓存" : "热缓存") :
            "MySQL 直接查询";
        byId("lab-strategy-explanation").textContent = isCrowdEntry() ?
            (cached ?
                "查询潮汐固定从冷缓存起跑；Runner 会先清空缓存与指标，再持续发送旁路缓存查询请求。" :
                "查询潮汐会持续发送 MySQL 直接查询请求；Runner 启动前会清空本章指标。") :
            (cached ?
            (next.cacheTemperature === "cold" ?
                "查询前先清空档案缓存与本章指标，首个真实响应应映射为 Cache Miss。" :
                "保留已有 Redis 副本；实际结果仍以 X-Archive-Source 的 Hit 或 Miss 为准。") :
            "Redis 不参与；每次请求都执行基础 JOIN、组成、交易和评分共 4 条 SQL。");
        if (!state.lastResponse) {
            setQueryVerdict(cached ?
                "掌柜点评：这轮先问缓存，MISS 才去账房；最后仍由响应头裁定真实路线。" :
                "掌柜点评：这轮绕过缓存，直接让 MySQL 组装完整材料档案。");
        }
        renderActiveMetrics();
        renderCrowdSetup();
        renderScenarioControls(state.loadtestTask);
        updateControlState();
    }

    function scenarioPhaseLabel(phase) {
        return ({
            stable: "稳定命中",
            evicted: "热点 Key 已消失",
            recovering: "缓存已重建 · 观察恢复",
            recovered: "命中率恢复稳定",
            unprotected: "无保护穿透",
            protected: "负缓存保护"
        })[phase] || "等待真实状态";
    }

    function formatScenarioDuration(value) {
        return Number(value || 0) > 0 ? Number(value).toLocaleString("zh-CN") + " ms" : "—";
    }

    function formatScenarioRate(value, sampled) {
        return sampled ? Number(value || 0).toLocaleString("zh-CN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }) + "%" : "—";
    }

    function renderBreakdownWindow(prefix, windowMetrics) {
        windowMetrics = windowMetrics || {};
        var sampled = Number(windowMetrics.requests || 0) > 0;
        byId("breakdown-" + prefix + "-rate").textContent =
            formatScenarioRate(windowMetrics.hitRate, sampled);
        byId("breakdown-" + prefix + "-hit-miss").textContent = sampled ?
            formatNumber(windowMetrics.positiveCacheHits) + " / " + formatNumber(windowMetrics.redisMisses) : "—";
        byId("breakdown-" + prefix + "-fallbacks").textContent = sampled ?
            formatNumber(windowMetrics.mysqlFallbacks) : "—";
        byId("breakdown-" + prefix + "-latency").textContent = sampled ?
            formatScenarioDuration(windowMetrics.p95Ms) + " / " +
                formatScenarioDuration(windowMetrics.maxLatencyMs) : "—";
    }

    function renderBreakdownComparison() {
        var result = experimentResults.scenario("breakdown");
        var metrics = result && result.metrics || {};
        var comparison = metrics.scenarioComparison || {};
        renderBreakdownWindow("stable", comparison.stable);
        renderBreakdownWindow("impact", comparison.impact);
        renderBreakdownWindow("recovered", comparison.recovered);
        if (!result || !comparison.stable || !comparison.impact || !comparison.recovered) {
            byId("breakdown-result-status").textContent = "等待完整任务";
            byId("breakdown-verdict").textContent =
                "完成一轮热点击穿任务后，这里固定对比真实稳态、失效后 1 秒与恢复窗口。";
            return;
        }
        byId("breakdown-result-status").textContent = "FROZEN · " +
            formatResultQPS(result.expectedRate) + " · " + result.expectedDurationSeconds + "s";
        var stable = comparison.stable;
        var impact = comparison.impact;
        var recovered = comparison.recovered;
        var coalesced = Number(metrics.coalescedAfterMiss || impact.coalescedAfterMiss || 0);
        var fallback = Number(impact.mysqlFallbacks || 0);
        var verdict = "真实失效后 1 秒出现 " + formatNumber(impact.redisMisses) +
            " 次 MISS、" + formatNumber(fallback) + " 次 MySQL 回源，命中率 " +
            formatScenarioRate(stable.hitRate, true) + " → " +
            formatScenarioRate(impact.hitRate, true) + " → " +
            formatScenarioRate(recovered.hitRate, true) + "。";
        if (fallback === 1) {
            verdict += Number(impact.redisMisses || 0) > 1 ?
                "其中 " + formatNumber(coalesced) +
                    " 个请求等待后复用重建结果，现有按 Key 互斥没有让并发 MISS 全部打到 MySQL。" :
                "本轮只有 1 次真实回源和 1 次重建，未观察到并发回源放大。";
        } else if (fallback > 1) {
            verdict += "本轮观察到多个并发回源，需要继续评估互斥重建是否失效。";
        }
        verdict += " 整轮命中率 " + formatScenarioRate(metrics.cacheHitRate, true) +
            "，失效到稳定 " + formatScenarioDuration(metrics.recoveryDurationMs) + "。";
        byId("breakdown-verdict").textContent = verdict;
    }

    function scenarioComparisonIsFair(left, right) {
        return Boolean(left && right &&
            Number(left.probeArchiveId || 0) === Number(right.probeArchiveId || 0) &&
            Number(left.expectedRate || 0) === Number(right.expectedRate || 0) &&
            Number(left.expectedDurationSeconds || 0) === Number(right.expectedDurationSeconds || 0) &&
            left.connectionMode === right.connectionMode &&
            Number(left.connections || 0) === Number(right.connections || 0));
    }

    function renderPenetrationColumn(name, result) {
        var metrics = result && result.metrics || {};
        var requests = Number(metrics.nonexistentRequests || 0);
        var sampled = requests > 0;
        var invalidRate = sampled ? Number(metrics.invalidMySQLQueries || 0) * 100 / requests : 0;
        byId("penetration-" + name + "-requests").textContent = sampled ? formatNumber(requests) : "—";
        byId("penetration-" + name + "-misses").textContent = sampled ?
            formatNumber(metrics.redisMisses) : "—";
        byId("penetration-" + name + "-negative-hits").textContent = sampled ?
            formatNumber(metrics.negativeCacheHits) : "—";
        byId("penetration-" + name + "-invalid").textContent = sampled ?
            formatNumber(metrics.invalidMySQLQueries) : "—";
        byId("penetration-" + name + "-invalid-rate").textContent =
            formatScenarioRate(invalidRate, sampled);
        byId("penetration-" + name + "-p95").textContent = sampled ?
            formatScenarioDuration(metrics.requestP95Ms) : "—";
        byId("penetration-" + name + "-errors").textContent = sampled ?
            formatScenarioRate(metrics.errorRate, true) : "—";
    }

    function renderPenetrationComparison() {
        var none = experimentResults.scenario("penetration:none");
        var negative = experimentResults.scenario("penetration:negative-cache");
        renderPenetrationColumn("none", none);
        renderPenetrationColumn("negative", negative);
        if (!none || !negative) {
            byId("penetration-result-status").textContent = none ? "无保护已冻结 · 等待负缓存" :
                (negative ? "负缓存已冻结 · 等待无保护" : "等待两轮任务");
            byId("penetration-verdict").textContent =
                "用相同速率、连接数和时长各运行一轮，页面才会给出保护效果结论。";
            return;
        }
        if (!scenarioComparisonIsFair(none, negative)) {
            byId("penetration-result-status").textContent = "NOT COMPARABLE";
            byId("penetration-verdict").textContent =
                "两轮的不存在 ID、目标速率、连接数或时长不同，只能并列查看，不能裁定保护效果。";
            return;
        }
        byId("penetration-result-status").textContent = "FROZEN · 同条件";
        var base = none.metrics || {};
        var protectedMetrics = negative.metrics || {};
        var baseInvalid = Number(base.invalidMySQLQueries || 0);
        var protectedInvalid = Number(protectedMetrics.invalidMySQLQueries || 0);
        var reduction = baseInvalid > 0 ? Math.max(0, (baseInvalid - protectedInvalid) * 100 / baseInvalid) : 0;
        var protectedRequests = Math.max(1, Number(protectedMetrics.nonexistentRequests || 0));
        var interception = Number(protectedMetrics.negativeCacheHits || 0) * 100 / protectedRequests;
        byId("penetration-verdict").textContent =
            "无保护把 " + formatNumber(baseInvalid) + " 次不存在请求打到 MySQL；负缓存后只剩 " +
            formatNumber(protectedInvalid) + " 次，无效查询减少 " + formatScenarioRate(reduction, true) +
            "，负缓存拦截 " + formatScenarioRate(interception, true) + "。正常 DTO Redis MISS 仍单列，" +
            "不冒充缓存命中；P95 " + formatScenarioDuration(base.requestP95Ms) + " → " +
            formatScenarioDuration(protectedMetrics.requestP95Ms) + "。";
    }

    function renderScenarioComparison(scenario) {
        byId("breakdown-comparison").hidden = scenario !== "breakdown";
        byId("penetration-comparison").hidden = scenario !== "penetration";
        if (scenario === "breakdown") {
            renderBreakdownComparison();
        } else if (scenario === "penetration") {
            renderPenetrationComparison();
        }
    }

    function renderScenarioObservation(task) {
        var relevantTask = taskMatchesSelection(task) && taskScenario(task) !== "steady" ? task : null;
        var scenario = relevantTask ? taskScenario(relevantTask) : state.scenario;
        var panel = byId("cache-scenario-observation");
        panel.hidden = scenario === "steady";
        if (panel.hidden) {
            return;
        }
        var metrics = relevantTask && relevantTask.metrics || {};
        var sampled = Number(metrics.actualRequests || 0) > 0;
        var phase = metrics.scenarioPhase || "";
        panel.dataset.phase = phase || "waiting";
        byId("scenario-phase").textContent = scenarioPhaseLabel(phase);
        byId("cache-scenario-title").textContent = scenario === "breakdown" ?
            "ARC-004 热点失效与恢复" :
            "不存在材料 900004 · " +
                ((relevantTask && relevantTask.protection || state.protection) === "negative-cache" ? "负缓存" : "无保护");
        byId("scenario-current-hit-rate").textContent = sampled ?
            Number(metrics.currentHitRate || 0).toFixed(1) + "%" : "—";
        byId("scenario-current-hit-miss").textContent = sampled ?
            formatNumber(metrics.currentPositiveHits) + " / " + formatNumber(metrics.currentRedisMisses) : "—";
        byId("scenario-current-fallbacks").textContent = sampled ?
            formatNumber(metrics.currentMySQLFallbacks) + " /s" : "—";
        byId("scenario-current-latency").textContent = sampled ?
            formatScenarioDuration(metrics.currentP95Ms) + " / " +
                formatScenarioDuration(metrics.currentMaxLatencyMs) : "—";
        byId("scenario-round-hit-rate").textContent = sampled ?
            Number(metrics.cacheHitRate || 0).toFixed(1) + "%" : "—";
        byId("scenario-round-fallbacks").textContent = sampled ? formatNumber(metrics.mysqlFallbacks) : "—";
        byId("scenario-round-max-latency").textContent = sampled ?
            formatScenarioDuration(metrics.runMaxLatencyMs) : "—";
        if (scenario === "breakdown") {
            var keyState = metrics.keyPresent ? "存在" : (metrics.evictedAt ? "不存在" : "等待检查");
            if (metrics.keyPresent && Number(metrics.keyPttlMillis || 0) > 0) {
                keyState += " · TTL " + Math.ceil(Number(metrics.keyPttlMillis) / 1000) + "s";
            }
            byId("scenario-key-state").textContent = keyState;
            byId("scenario-coalesced").textContent = sampled ? formatNumber(metrics.coalescedAfterMiss) : "—";
            byId("scenario-rebuilds").textContent = sampled ? formatNumber(metrics.cacheRebuilds) : "—";
            byId("scenario-rebuild-time").textContent = formatScenarioDuration(metrics.rebuildDurationMs);
            byId("scenario-recovery-time").textContent = formatScenarioDuration(metrics.recoveryDurationMs);
            byId("scenario-proof-copy").textContent =
                "Key 状态、回源、重建与恢复窗口均由真实 Redis DEL 和请求指标推进。";
        } else {
            byId("scenario-key-state").textContent = "正常 DTO MISS · ID 900004";
            byId("scenario-nonexistent").textContent = sampled ? formatNumber(metrics.nonexistentRequests) : "—";
            byId("scenario-negative-hits").textContent = sampled ? formatNumber(metrics.negativeCacheHits) : "—";
            byId("scenario-negative-writes").textContent = sampled ? formatNumber(metrics.negativeCacheWrites) : "—";
            byId("scenario-invalid-queries").textContent = sampled ? formatNumber(metrics.invalidMySQLQueries) : "—";
            byId("scenario-proof-copy").textContent =
                "正常缓存 MISS 与负缓存命中分别计数；预期 404 不记作系统错误。";
        }
        byId("breakdown-evidence").hidden = scenario !== "breakdown";
        byId("penetration-evidence").hidden = scenario !== "penetration";
        renderScenarioComparison(scenario);
    }

    function renderScenarioControls(task) {
        document.body.dataset.cacheScenario = state.scenario;
        ["steady", "breakdown", "penetration"].forEach(function (scenario) {
            var button = byId("scenario-" + scenario);
            var active = scenario === state.scenario;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
        var penetration = state.scenario === "penetration";
        byId("penetration-protection").hidden = !penetration;
        byId("protection-none").classList.toggle("is-active", state.protection === "none");
        byId("protection-negative").classList.toggle("is-active", state.protection === "negative-cache");
        byId("protection-none").setAttribute("aria-pressed", state.protection === "none" ? "true" : "false");
        byId("protection-negative").setAttribute("aria-pressed", state.protection === "negative-cache" ? "true" : "false");
        if (state.scenario === "steady") {
            byId("query-route-label").textContent = "GET /api/archives/:id/{direct|cached}";
        } else if (state.scenario === "breakdown") {
            byId("query-route-label").textContent = "ARC-004 · TASK-SCOPED REAL EVICTION";
            byId("query-endpoint").textContent = "stable → DEL → rebuild → recovered";
            byId("lab-shared-strategy").textContent = "热点 Key 真实失效";
            byId("lab-strategy-explanation").textContent =
                "Runner 先观察稳定命中，再真实删除 ARC-004 Key；现有按 Key 互斥负责合并并发回源。";
        } else {
            byId("query-route-label").textContent = "MISSING MATERIAL 900004 · TASK-SCOPED";
            byId("query-endpoint").textContent = state.protection === "negative-cache" ?
                "positive MISS → negative HIT" : "positive MISS → MySQL 404";
            byId("lab-shared-strategy").textContent = state.protection === "negative-cache" ?
                "穿透保护 · 负缓存" : "穿透基线 · 无保护";
            byId("lab-strategy-explanation").textContent = state.protection === "negative-cache" ?
                "首次真实查询确认材料不存在并写入短 TTL 负缓存；后续请求单独记录负缓存命中。" :
                "固定不存在 ID 持续 MISS，并在每次请求中真实回源 MySQL；预期 404 不冒充系统错误。";
        }
        renderScenarioObservation(task);
    }

    function updateControlState() {
        var loadtestLocked = loadtestIsActive(state.loadtestTask);
        var pendingConfiguredPlan = Boolean(state.entry === "crowd" && state.pendingRun &&
            !state.loadtestTaskId);
        var pendingSharedPlan = Boolean(pendingConfiguredPlan && state.pendingRun.sharedConditions);
        var observationPending = Boolean(isCrowdEntry() && !state.loadtestTaskId &&
            (!state.labSceneReady || !state.metricsObservationReady));
        var pathReadinessLocked = state.loadtestStartRequested || state.loadtestCreateInFlight ||
            (pendingConfiguredPlan && !pendingSharedPlan);
        var scenarioReadinessLocked = state.loadtestStartRequested || state.loadtestCreateInFlight ||
            pendingConfiguredPlan;
        var legacyTask = Boolean(state.loadtestTask && state.loadtestTask.tier &&
            !crowdTierForRate(state.loadtestTask.tier.rate));
        var locked = state.isRequesting || state.isReplaying || loadtestLocked ||
            state.loadtestCreateInFlight;
        byId("query-archive").disabled = locked || observationPending;
        ["mode-direct", "mode-cached"].forEach(function (id) {
            byId(id).disabled = locked || pathReadinessLocked || state.scenario !== "steady";
        });
        ["steady", "breakdown", "penetration"].forEach(function (scenario) {
            byId("scenario-" + scenario).disabled = locked || scenarioReadinessLocked;
        });
        ["protection-none", "protection-negative"].forEach(function (id) {
            byId(id).disabled = locked || scenarioReadinessLocked;
        });
        Array.prototype.forEach.call(document.querySelectorAll("[name='lab-cache-temperature']"), function (radio) {
            radio.disabled = locked;
        });
        var queryButtonCopy = "启动读取实验";
        if (!isCrowdEntry()) {
            queryButtonCopy = state.isRequesting ? "正在等待真实响应" :
                (state.lastResponse ? "再次启动读取实验" : "启动读取实验");
        } else if (state.loadtestCreateInFlight) {
            queryButtonCopy = "正在创建 Runner 任务";
        } else if (observationPending) {
            queryButtonCopy = "正在准备观测环境";
        } else if (loadtestLocked) {
            queryButtonCopy = "查询潮汐进行中";
        } else if (legacyTask) {
            queryButtonCopy = "返回门口配置新查询潮汐";
        } else {
            queryButtonCopy = state.loadtestTask ? "再次启动查询潮汐" :
                (currentExperiment().mode === "cached" ?
                    "开始 Redis 旁路缓存压测" : "开始 MySQL 直接查询压测");
            if (state.scenario === "breakdown") {
                queryButtonCopy = state.loadtestTask ? "再次验证热点击穿" : "启动热点击穿实验";
            } else if (state.scenario === "penetration") {
                queryButtonCopy = state.loadtestTask ? "再次验证缓存穿透" : "启动缓存穿透实验";
            }
        }
        byId("query-archive").querySelector("span").textContent = queryButtonCopy;
        byId("reset-lab").disabled = loadtestLocked;
        Array.prototype.forEach.call(document.querySelectorAll("[data-clear-comparison]"), function (button) {
            button.disabled = loadtestLocked;
        });
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

    function finishRouteReplay(definition, source, origin) {
        state.isReplaying = false;
        byId("replay-status").textContent = "回放完成 · 不计入真实耗时";
        byId("route-title").textContent = definition.title;
        setRouteProgress(definition.frames.length, definition.frames.length);
        if (definition.state === "miss") {
            byId("redis-state").textContent = "CACHE FILLED";
        }
        var events = byId("route-events").children;
        Array.prototype.forEach.call(events, function (item) {
            item.classList.remove("is-current");
            item.classList.add("is-complete");
        });
        var latency = state.lastResponse ? state.lastResponse.latency : null;
        setQueryVerdict(queryVerdict(source, latency));
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
            setRouteProgress(0, 0);
            setQueryVerdict(queryVerdict(source, null));
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
        setRouteProgress(0, definition.frames.length);
        setQueryVerdict("掌柜点评：服务器已经给出真实来源，现在只把这条路径逐格走给你看。");
        renderRouteEvents(definition);
        updateControlState();

        if (definition.state === "direct") {
            byId("node-redis").classList.add("is-idle");
        } else if (definition.state === "hit") {
            byId("node-mysql").classList.add("is-idle");
        }

        if (state.reducedMotion) {
            definition.frames.forEach(function (frame) { activateFrame(frame, definition.tone); });
            finishRouteReplay(definition, source, origin);
            return;
        }

        definition.frames.forEach(function (frame, index) {
            var timer = window.setTimeout(function () {
                activateFrame(frame, definition.tone);
                setRouteProgress(index + 1, definition.frames.length);
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
            finishRouteReplay(definition, source, origin);
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

    function matchingLabConnectionPlan() {
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        var mode = currentExperiment().mode;
        var effectiveConnectionMode = selectedConnectionMode();
        var plan = state.connectionPlan;
        if (!plan || plan.rate !== tier.rate || plan.requestMode !== mode ||
            plan.requestExperiment !== selectedLoadtestExperiment() ||
            plan.requestProtection !== selectedProtection() ||
            plan.connectionMode !== effectiveConnectionMode) {
            return null;
        }
        if (effectiveConnectionMode === "manual" && plan.connections !== manualConnections) {
            return null;
        }
        return plan;
    }

    function renderLabConnectionPlan(task) {
        var taskMatchesMode = taskMatchesSelection(task);
        var previousConnections = Number(taskMatchesMode && task.tier && task.tier.connections || 0);
        var resolvedConnections = taskMatchesMode ? previousConnections : 0;
        if (resolvedConnections > 0) {
            var resolvedMode = task.connectionMode === "manual" ? "手动指定" :
                (task.connectionMode === "auto" ? "自动选择" : "旧固定配置");
            byId("lab-connection-plan-value").textContent =
                "已锁定 · wrk2 -c " + resolvedConnections.toLocaleString("zh-CN");
            byId("lab-connection-plan-copy").textContent =
                resolvedMode + (task.connectionReason ? " · " + task.connectionReason : "");
            return;
        }
        var plan = matchingLabConnectionPlan();
        var effectiveConnectionMode = selectedConnectionMode();
        var plannedConnections = effectiveConnectionMode === "manual" ? manualConnections :
            Number(plan && plan.connections || 0);
        byId("lab-connection-plan-value").textContent = plannedConnections > 0 ?
            (effectiveConnectionMode === "manual" ? "计划 · wrk2 -c " : "自动计划 · wrk2 -c ") +
                plannedConnections.toLocaleString("zh-CN") :
            "自动计划计算中";
        byId("lab-connection-plan-copy").textContent = state.connectionPlanError ?
            "计划暂不可用；任务创建时由 Runner 返回最终配置。" :
            "任务尚未创建" + (plan && plan.reason ? " · " + plan.reason : "");
    }

    async function refreshLabConnectionPlan() {
        if (!isCrowdEntry() || loadtestIsActive(state.loadtestTask) || !state.id) {
            return;
        }
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        var mode = currentExperiment().mode;
        var experiment = selectedLoadtestExperiment();
        var effectiveConnectionMode = selectedConnectionMode();
        var requestID = ++state.connectionPlanRequest;
        state.connectionPlan = null;
        state.connectionPlanError = "";
        renderCrowdSetup();
        try {
            var result = await requestJSON("/api/loadtests/connection-plan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    experiment: experiment,
                    archiveId: state.id,
                    mode: mode,
                    rate: tier.rate,
                    connectionMode: effectiveConnectionMode,
                    connections: effectiveConnectionMode === "manual" ? manualConnections : 0,
                    protection: selectedProtection()
                })
            });
            if (requestID !== state.connectionPlanRequest) {
                return;
            }
            state.connectionPlan = Object.assign({}, result.body, {
                requestMode: mode,
                requestExperiment: experiment,
                requestProtection: selectedProtection()
            });
            renderCrowdSetup();
        } catch (error) {
            if (requestID !== state.connectionPlanRequest) {
                return;
            }
            state.connectionPlanError = error.message;
            renderCrowdSetup();
        }
    }

    function hasResultMetric(result, key) {
        return Boolean(result && result.metrics &&
            Object.prototype.hasOwnProperty.call(result.metrics, key));
    }

    function formatResultLatency(value) {
        value = Number(value || 0);
        return value > 0 ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " ms" : "—";
    }

    function formatResultQPS(value) {
        value = Number(value || 0);
        return value > 0 ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " QPS" : "—";
    }

    function formatResultDuration(value) {
        value = Number(value || 0);
        return value > 0 ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " s" : "—";
    }

    function wrk2ErrorRate(result) {
        var metrics = result && result.metrics || {};
        if (metrics.errorRate !== undefined) {
            return Number(metrics.errorRate || 0);
        }
        var requests = Number(metrics.requests || 0);
        return requests > 0 ? Number(metrics.errors || 0) * 100 / requests : 0;
    }

    function resultTargetRate(result) {
        return Number(result && result.expectedRate || 0);
    }

    function resultConnections(result) {
        return Number(result && result.connections || 0);
    }

    function formatConnectionConfig(result) {
        var connections = resultConnections(result);
        if (connections <= 0) {
            return "—";
        }
        var mode = result && result.connectionMode;
        var modeCopy = mode === "auto" ? "自动" : (mode === "manual" ? "手动" : "旧配置");
        return "-c " + formatNumber(connections) + " · " + modeCopy;
    }

    function resultCompletionRate(result) {
        var metrics = result && result.metrics || {};
        if (metrics.completionRate !== undefined) {
            return Number(metrics.completionRate || 0);
        }
        var target = resultTargetRate(result);
        var duration = Number(metrics.durationSeconds || result && result.expectedDurationSeconds || 0);
        var requests = Number(metrics.requests || 0);
        if (target > 0 && duration > 0 && requests > 0) {
            return Math.min(100, requests * 100 / (target * duration));
        }
        return target > 0 ? Math.min(100, Number(metrics.qps || 0) * 100 / target) : 0;
    }

    function formatCompletionRate(value) {
        value = Number(value || 0);
        return value > 0 ? value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + "%" : "0%";
    }

    function latestWrk2Result(mode) {
        var results = experimentResults.list();
        for (var index = results.length - 1; index >= 0; index -= 1) {
            if (results[index].mode === mode && results[index].entry === "crowd" &&
                state.profile && results[index].materialName === state.profile.name) {
                return results[index];
            }
        }
        return null;
    }

    function renderFinalTaskMetrics(mode, result) {
        var isCrowdResult = Boolean(result && result.entry === "crowd");
        byId(mode + "-target-qps").textContent = isCrowdResult ?
            formatResultQPS(resultTargetRate(result)) : "—";
        byId(mode + "-total").textContent = isCrowdResult ?
            formatNumber(resultMetric(result, "requests")) : "—";
        byId(mode + "-actual-qps").textContent = isCrowdResult ?
            formatResultQPS(resultMetric(result, "qps")) : "—";
        byId(mode + "-completion-rate").textContent = isCrowdResult ?
            formatCompletionRate(resultCompletionRate(result)) : "—";
        byId(mode + "-connections").textContent = isCrowdResult ?
            formatConnectionConfig(result) : "—";
        byId(mode + "-duration").textContent = isCrowdResult ?
            formatResultDuration(resultMetric(result, "durationSeconds")) : "—";
        byId(mode + "-request-p50").textContent = isCrowdResult ?
            formatResultLatency(resultMetric(result, "requestP50")) : "—";
        byId(mode + "-request-p95").textContent = isCrowdResult ?
            formatResultLatency(resultMetric(result, "requestP95")) : "—";
        byId(mode + "-request-p99").textContent = isCrowdResult ?
            formatResultLatency(resultMetric(result, "requestP99")) : "—";
        byId(mode + "-p50").textContent = isCrowdResult ?
            formatResultLatency(resultMetric(result, "p50")) : "—";
        byId(mode + "-p95").textContent = isCrowdResult ?
            formatResultLatency(resultMetric(result, "p95")) : "—";
        byId(mode + "-p99").textContent = isCrowdResult ?
            formatResultLatency(resultMetric(result, "p99")) : "—";
        byId(mode + "-timeouts").textContent = isCrowdResult ?
            (hasResultMetric(result, "socketErrors") ?
                formatNumber(resultMetric(result, "socketErrors")) : "本轮未采集") : "—";
        byId(mode + "-error-rate").textContent = isCrowdResult ?
            wrk2ErrorRate(result).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + "%" : "—";
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
            "查询潮汐" + (result.expectedRate ? " · " + result.expectedRate + " req/s" : "") +
            (result.expectedDurationSeconds ? " · " + result.expectedDurationSeconds + "s" : "") : "单次检索";
        card.querySelector("[data-result-context]").textContent =
            (result.materialName || "星髓") + temperature + " · " + runKind;
        Array.prototype.forEach.call(card.querySelectorAll("[data-result]"), function (node) {
            var key = node.dataset.result;
            var value = resultMetric(result, key);
            if (["p50", "p95", "requestP50", "requestP95"].indexOf(key) >= 0) {
                node.textContent = formatResultLatency(value);
            } else if (key === "ratePair") {
                node.textContent = formatResultQPS(resultTargetRate(result)) + " / " +
                    formatResultQPS(resultMetric(result, "qps"));
            } else if (key === "completionRate") {
                node.textContent = formatCompletionRate(resultCompletionRate(result));
            } else if (key === "connections") {
                node.textContent = formatConnectionConfig(result);
            } else if (key === "socketErrors" && !hasResultMetric(result, key)) {
                node.textContent = "本轮未采集";
            } else if (key === "errorRate") {
                node.textContent = wrk2ErrorRate(result).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + "%";
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
        byId("compare-" + name + "-winner").textContent = cachedWins ? "旁路缓存胜出" : "直接查询胜出";
        return cachedWins ? "cached" : "direct";
    }

    function setLatencyComparisonRow(rowName, metricName, direct, cached, fair) {
        var directValue = resultMetric(direct, metricName);
        var cachedValue = resultMetric(cached, metricName);
        if (fair && (directValue <= 0 || cachedValue <= 0)) {
            var row = byId("compare-" + rowName + "-row");
            row.classList.remove("winner-direct", "winner-cached", "is-tie");
            byId("compare-" + rowName + "-direct").textContent = formatResultLatency(directValue);
            byId("compare-" + rowName + "-cached").textContent = formatResultLatency(cachedValue);
            byId("compare-" + rowName + "-winner").textContent = "本轮未采集";
            return null;
        }
        return setComparisonRow(rowName, formatResultLatency(directValue), formatResultLatency(cachedValue),
            directValue, cachedValue, "lower", fair);
    }

    function setContextComparisonRow(name, directText, cachedText, fair, assessment) {
        var row = byId("compare-" + name + "-row");
        row.classList.remove("winner-direct", "winner-cached", "is-tie");
        byId("compare-" + name + "-direct").textContent = directText;
        byId("compare-" + name + "-cached").textContent = cachedText;
        byId("compare-" + name + "-winner").textContent = fair ? assessment : "条件不同";
    }

    function comparisonIsFair(direct, cached) {
        if (direct.entry !== "crowd" || cached.entry !== "crowd") {
            return false;
        }
        if (direct.materialName !== cached.materialName) {
            return false;
        }
        if (Number(direct.expectedRate || 0) !== Number(cached.expectedRate || 0) ||
            Number(direct.expectedDurationSeconds || 30) !== Number(cached.expectedDurationSeconds || 30)) {
            return false;
        }
        var directMode = direct.connectionMode || "";
        var cachedMode = cached.connectionMode || "";
        var directConnections = resultConnections(direct);
        var cachedConnections = resultConnections(cached);
        if (directMode !== cachedMode || (directMode !== "auto" && directMode !== "manual") ||
            directConnections <= 0 || directConnections !== cachedConnections) {
            return false;
        }
        if (directMode === "manual") {
            return Number(direct.requestedConnections || directConnections) ===
                Number(cached.requestedConnections || cachedConnections);
        }
        return true;
    }

    function resetFrozenComparison() {
        ["target", "qps", "completion", "connections", "request-p50", "request-p95",
            "p50", "p95", "timeout", "error"].forEach(function (name) {
            var row = byId("compare-" + name + "-row");
            row.classList.remove("winner-direct", "winner-cached", "is-tie");
            byId("compare-" + name + "-direct").textContent = "—";
            byId("compare-" + name + "-cached").textContent = "—";
            byId("compare-" + name + "-winner").textContent = "等待";
        });
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
        var hasSocketErrors = hasResultMetric(direct, "socketErrors") &&
            hasResultMetric(cached, "socketErrors");
        var directSocketErrors = resultMetric(direct, "socketErrors");
        var cachedSocketErrors = resultMetric(cached, "socketErrors");
        var directSocketRate = directSocketErrors * 1000 / directRequests;
        var cachedSocketRate = cachedSocketErrors * 1000 / cachedRequests;
        var directErrorRate = wrk2ErrorRate(direct);
        var cachedErrorRate = wrk2ErrorRate(cached);
        var qpsTieTolerance = Math.max(resultMetric(direct, "qps"), resultMetric(cached, "qps")) * .02;
        setContextComparisonRow("target", formatResultQPS(resultTargetRate(direct)),
            formatResultQPS(resultTargetRate(cached)), fair, "同条件");
        setContextComparisonRow("connections", formatConnectionConfig(direct),
            formatConnectionConfig(cached), fair, "同条件");
        setComparisonRow("qps", formatResultQPS(resultMetric(direct, "qps")),
            formatResultQPS(resultMetric(cached, "qps")), resultMetric(direct, "qps"),
            resultMetric(cached, "qps"), "higher", fair, qpsTieTolerance);
        setComparisonRow("completion", formatCompletionRate(resultCompletionRate(direct)),
            formatCompletionRate(resultCompletionRate(cached)), resultCompletionRate(direct),
            resultCompletionRate(cached), "higher", fair, 0.5);
        setLatencyComparisonRow("request-p50", "requestP50", direct, cached, fair);
        setLatencyComparisonRow("request-p95", "requestP95", direct, cached, fair);
        setLatencyComparisonRow("p50", "p50", direct, cached, fair);
        setLatencyComparisonRow("p95", "p95", direct, cached, fair);
        if (hasSocketErrors) {
            setComparisonRow("timeout",
                formatNumber(directSocketErrors) + "（" + directSocketRate.toFixed(2) + "/1k）",
                formatNumber(cachedSocketErrors) + "（" + cachedSocketRate.toFixed(2) + "/1k）",
                directSocketRate, cachedSocketRate, "lower", fair);
        } else {
            setContextComparisonRow("timeout",
                hasResultMetric(direct, "socketErrors") ? formatNumber(directSocketErrors) : "本轮未采集",
                hasResultMetric(cached, "socketErrors") ? formatNumber(cachedSocketErrors) : "本轮未采集",
                false, "");
            byId("compare-timeout-winner").textContent = "本轮未采集";
        }
        setComparisonRow("error", directErrorRate.toFixed(2) + "%", cachedErrorRate.toFixed(2) + "%",
            directErrorRate, cachedErrorRate, "lower", fair);

        if (!fair) {
            byId("frozen-comparison-title").textContent =
                "材料、目标速率、wrk2 -c 配置或时长不同，仅并列展示";
            byId("frozen-overall-winner").textContent = "NOT COMPARABLE";
            byId("wrk2-summary").textContent =
                "两轮配置不同，页面不会据此裁定路径差异；请使用相同潮汐和相同 wrk2 -c 配置重新实验。";
            return;
        }
        byId("frozen-comparison-title").textContent = (direct.materialName || "星髓") + " · 同条件结果已冻结";
        byId("frozen-overall-winner").textContent = "分维度观察";
        var directCompletion = resultCompletionRate(direct);
        var cachedCompletion = resultCompletionRate(cached);
        if (directCompletion < 90 || cachedCompletion < 90) {
            byId("wrk2-summary").textContent =
                "完成率不足表示查询卷轴没有按目标潮汐完成投递与响应。需求侧延迟包含这部分容量欠账，不能当作单次 HTTP 请求的真实等待时间。";
        } else {
            byId("wrk2-summary").textContent =
                "两轮都基本跟上目标潮汐；请同时观察实际请求延迟、需求侧延迟与 Socket Errors，不把 QPS、请求数或通路数解释成用户人数。";
        }
    }

    function renderFrozenResults() {
        var direct = latestWrk2Result("direct");
        var cached = latestWrk2Result("cached");
        renderFinalTaskMetrics("direct", direct);
        renderFinalTaskMetrics("cached", cached);
        renderFrozenCard("direct", direct);
        renderFrozenCard("cached", cached);
        renderFrozenComparison(direct, cached);
        byId("wrk2-final-status").textContent = direct && cached ? "两条 wrk2 结果已冻结" :
            (direct ? "直接查询已冻结 · 等待旁路缓存" :
                (cached ? "旁路缓存已冻结 · 等待直接查询" : "等待 wrk2 完成"));
    }

    function completeResult(result) {
        experimentResults.complete(result);
        experimentResults.clearPending();
        state.pendingRun = null;
        state.crowdRun = null;
        renderFrozenResults();
        byId("freeze-status").textContent = (result.mode === "cached" ? "旁路缓存" : "MySQL 直接查询") + " 本轮结果已冻结";
        showToast("本轮实验结果已冻结，可用于下一轮对比。", "success");
    }

    function loadtestIsActive(task) {
        return Boolean(task && ["starting", "resetting", "running", "collecting"].indexOf(task.status) >= 0);
    }

    var loadtestStatusRank = Object.freeze({
        waiting: 0,
        starting: 1,
        resetting: 2,
        running: 3,
        collecting: 4,
        completed: 5,
        failed: 5,
        stopped: 5
    });
    var loadtestScenarioPhaseRank = Object.freeze({
        stable: 0,
        evicted: 1,
        recovering: 2,
        recovered: 3
    });

    // GET、轮询和 SSE 会并行返回。这里按同一任务的单调状态、elapsedSeconds
    // 与热点实验阶段合并，避免旧快照把 running/completed 或 DEL 后证据倒退。
    // SSE 增量没有 tier/mode 等完整字段，因此必须保留已有锁定配置。
    function mergeLoadtestTask(current, incoming) {
        if (!incoming) {
            return current;
        }
        if (!current || current.taskId !== incoming.taskId) {
            return Object.assign({}, incoming, {
                tier: Object.assign({}, incoming.tier || {}),
                metrics: Object.assign({}, incoming.metrics || {}),
                logs: Array.isArray(incoming.logs) ? incoming.logs.slice() : []
            });
        }
        var merged = Object.assign({}, current, incoming, {
            tier: Object.assign({}, current.tier || {}, incoming.tier || {}),
            metrics: Object.assign({}, current.metrics || {}, incoming.metrics || {}),
            logs: Array.isArray(incoming.logs) ? incoming.logs.slice() :
                (Array.isArray(current.logs) ? current.logs.slice() : [])
        });
        var currentRank = loadtestStatusRank[current.status] || 0;
        var incomingRank = loadtestStatusRank[incoming.status] || 0;
        var currentElapsed = Number(current.elapsedSeconds || 0);
        var incomingElapsed = Number(incoming.elapsedSeconds || 0);
        var currentRequests = Number(current.metrics && current.metrics.actualRequests || 0);
        var incomingRequests = Number(incoming.metrics && incoming.metrics.actualRequests || 0);
        var currentScenarioPhase = current.metrics && current.metrics.scenarioPhase || "";
        var incomingScenarioPhase = incoming.metrics && incoming.metrics.scenarioPhase || "";
        var currentScenarioKnown = Object.prototype.hasOwnProperty.call(
            loadtestScenarioPhaseRank, currentScenarioPhase);
        var incomingScenarioKnown = Object.prototype.hasOwnProperty.call(
            loadtestScenarioPhaseRank, incomingScenarioPhase);
        var scenarioRegressed = currentScenarioKnown &&
            (!incomingScenarioKnown || loadtestScenarioPhaseRank[incomingScenarioPhase] <
                loadtestScenarioPhaseRank[currentScenarioPhase]);
        var currentTerminal = ["completed", "failed", "stopped"].indexOf(current.status) >= 0;
        var incomingTerminal = ["completed", "failed", "stopped"].indexOf(incoming.status) >= 0;
        var stale = (currentTerminal &&
                (!incomingTerminal || incoming.status !== current.status)) ||
            incomingRank < currentRank || scenarioRegressed ||
            (incomingRank === currentRank &&
                (incomingElapsed < currentElapsed ||
                    (incomingElapsed === currentElapsed && incomingRequests < currentRequests)));
        if (stale) {
            merged.status = current.status;
            merged.elapsedSeconds = current.elapsedSeconds;
            merged.remainingSeconds = current.remainingSeconds;
            merged.metrics = Object.assign({}, current.metrics || {});
            merged.startedAt = current.startedAt;
            merged.endedAt = current.endedAt;
            merged.errorCode = current.errorCode;
            merged.errorMessage = current.errorMessage;
        }
        ["evictedAt", "rebuiltAt", "stableAt"].forEach(function (field) {
            if (current.metrics && current.metrics[field] && !merged.metrics[field]) {
                merged.metrics[field] = current.metrics[field];
            }
        });
        return merged;
    }

    function formatLoadtestClock(value) {
        var seconds = Math.max(0, Math.floor(Number(value || 0)));
        return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" +
            String(seconds % 60).padStart(2, "0");
    }

    function formatLoadtestLatency(value) {
        var latency = Number(value || 0);
        return latency > 0 ? latency.toFixed(latency >= 10 ? 1 : 2) + " ms" : "—";
    }

    function loadtestStatusCopy(status) {
        var copies = {
            starting: ["任务已创建", "Runner 已接单，准备本轮运行环境。"],
            resetting: ["正在重置运行环境", "Runner 正在清空缓存与本章指标；wrk2 尚未启动。"],
            running: ["请求发送与系统处理进行中", "实际速率与完成率由 Runner 持续回传。"],
            collecting: ["正在输出结果", "请求已停止发送，Runner 正在解析最终指标。"],
            completed: ["实验结果", "本轮配置与实测结果已经冻结。"],
            failed: ["任务执行失败", "查看 Runner 事件定位失败阶段。"],
            stopped: ["任务已停止", "本轮没有形成完整结算。"]
        };
        return copies[status] || ["正在连接任务", "正在恢复 Runner 的任务状态。"];
    }

    function inferLoadtestFailureStatus(task) {
        var messages = (Array.isArray(task && task.logs) ? task.logs : [])
            .map(function (entry) { return entry.message || ""; })
            .concat(task && task.errorMessage || "")
            .join("\n");
        if (/收集|指标解析|指标收集|wrk2 结束|结果/.test(messages)) {
            return "collecting";
        }
        if (Number(task && task.metrics && task.metrics.actualRequests || 0) > 0 ||
            Number(task && task.elapsedSeconds || 0) > 0 ||
            /wrk2 已启动|wrk2 异常退出|子进程/.test(messages)) {
            return "running";
        }
        if (/数据重置完成|wrk2 启动失败|启动阶段/.test(messages)) {
            return "launching";
        }
        if (/重置/.test(messages)) {
            return "resetting";
        }
        return state.loadtestLastActiveStatus || "starting";
    }

    function renderLoadtestStages(task) {
        var status = task && task.status || "draft";
        var failed = status === "failed" || status === "stopped";
        var effectiveStatus = failed ? inferLoadtestFailureStatus(task) : status;
        var completed = [];
        var current = [];
        if (effectiveStatus === "draft") {
            current = ["intent"];
        } else if (effectiveStatus === "waiting") {
            completed = ["intent"];
            current = ["task"];
        } else if (effectiveStatus === "starting") {
            completed = ["intent"];
            current = ["task"];
        } else if (effectiveStatus === "resetting") {
            completed = ["intent"];
            current = ["task"];
        } else if (effectiveStatus === "launching") {
            completed = ["intent", "task"];
            current = ["connections"];
        } else if (effectiveStatus === "running") {
            completed = ["intent", "task"];
            current = ["connections", "delivery", "backend"];
        } else if (effectiveStatus === "collecting") {
            completed = ["intent", "task", "connections", "delivery", "backend"];
            current = ["result"];
        } else if (effectiveStatus === "completed") {
            completed = ["intent", "task", "connections", "delivery", "backend", "result"];
        }
        Array.prototype.forEach.call(byId("lab-loadtest-stages").children, function (item) {
            var phase = item.dataset.loadStage;
            item.classList.toggle("is-complete", completed.indexOf(phase) >= 0);
            item.classList.toggle("is-current", current.indexOf(phase) >= 0);
            item.classList.toggle("is-failed", failed && current.indexOf(phase) >= 0);
        });
    }

    function renderLoadtestLogs(logs) {
        var host = byId("lab-loadtest-log");
        host.innerHTML = "";
        var entries = Array.isArray(logs) ? logs.slice(-8) : [];
        if (!entries.length) {
            var waiting = document.createElement("li");
            waiting.textContent = "等待 Runner 关键事件";
            host.appendChild(waiting);
            return;
        }
        entries.forEach(function (entry) {
            var item = document.createElement("li");
            item.className = entry.level === "error" ? "is-error" : "";
            var at = entry.at ? new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--";
            var time = document.createElement("time");
            var message = document.createElement("span");
            time.textContent = at;
            message.textContent = entry.message || "任务状态已更新";
            item.appendChild(time);
            item.appendChild(message);
            host.appendChild(item);
        });
    }

    function freezeScenarioResult(task) {
        var scenario = taskScenario(task);
        if (state.loadtestResultSaved || task.status !== "completed" || scenario === "steady") {
            return;
        }
        var key = scenario === "breakdown" ? "breakdown" :
            "penetration:" + (task.protection === "negative-cache" ? "negative-cache" : "none");
        var existing = experimentResults.scenario(key);
        if (existing && existing.taskId === task.taskId) {
            state.loadtestResultSaved = true;
            renderScenarioComparison(scenario);
            return;
        }
        var metrics = task.metrics || {};
        var tier = task.tier || {};
        experimentResults.saveScenario({
            key: key,
            taskId: task.taskId,
            scenario: scenario,
            protection: task.protection || "none",
            archiveId: Number(task.archiveId || 0),
            probeArchiveId: Number(task.probeArchiveId || 0),
            expectedRate: Number(tier.rate || 0),
            expectedDurationSeconds: Number(tier.durationSeconds || 0),
            connectionMode: task.connectionMode || "",
            connections: Number(tier.connections || 0),
            metrics: {
                actualRequests: Number(metrics.actualRequests || 0),
                redisHits: Number(metrics.redisHits || 0),
                redisMisses: Number(metrics.redisMisses || 0),
                mysqlFallbacks: Number(metrics.mysqlFallbacks || 0),
                cacheHitRate: Number(metrics.cacheHitRate || 0),
                coalescedAfterMiss: Number(metrics.coalescedAfterMiss || 0),
                cacheRebuilds: Number(metrics.cacheRebuilds || 0),
                negativeCacheHits: Number(metrics.negativeCacheHits || 0),
                negativeCacheWrites: Number(metrics.negativeCacheWrites || 0),
                nonexistentRequests: Number(metrics.nonexistentRequests || 0),
                invalidMySQLQueries: Number(metrics.invalidMySQLQueries || 0),
                requestP95Ms: Number(metrics.requestP95Ms || 0),
                runMaxLatencyMs: Number(metrics.runMaxLatencyMs || 0),
                errorRate: Number(metrics.errorRate || 0),
                rebuildDurationMs: Number(metrics.rebuildDurationMs || 0),
                recoveryDurationMs: Number(metrics.recoveryDurationMs || 0),
                scenarioComparison: metrics.scenarioComparison || null
            }
        });
        state.loadtestResultSaved = true;
        experimentResults.clearPending();
        state.pendingRun = null;
        renderScenarioComparison(scenario);
        byId("freeze-status").textContent = scenario === "breakdown" ?
            "热点击穿三个阶段已冻结" : "缓存穿透本轮结果已冻结";
        showToast("场景真实结果已冻结，可继续完成对比。", "success");
    }

    function freezeLoadtestResult(task) {
        if (state.loadtestResultSaved || task.status !== "completed" ||
            taskScenario(task) !== "steady") {
            return;
        }
        var existing = experimentResults.latest(task.mode);
        if (existing && existing.taskId === task.taskId) {
            state.loadtestResultSaved = true;
            renderFrozenResults();
            return;
        }
        state.loadtestResultSaved = true;
        var metrics = task.metrics || {};
        var tier = task.tier || {};
        var pending = state.pendingRun || {};
        var requestCount = Number(metrics.actualRequests || 0);
        var targetRate = Number(tier.rate || pending.expectedRate || 0);
        var duration = Number(metrics.durationSeconds || task.elapsedSeconds ||
            tier.durationSeconds || pending.expectedDurationSeconds || 30);
        var completionRate = metrics.targetCompletionRate !== undefined ?
            Number(metrics.targetCompletionRate || 0) :
            (targetRate > 0 ? Math.min(100, Number(metrics.actualQps || 0) * 100 / targetRate) : 0);
        var newProtocol = task.connectionMode === "auto" || task.connectionMode === "manual";
        var frozenMetrics = {
            requests: requestCount,
            qps: Number(metrics.actualQps || 0),
            durationSeconds: duration,
            completionRate: completionRate,
            sqlQueries: Number(metrics.sqlQueries || 0),
            p50: Number(metrics.p50Ms || 0),
            p90: Number(metrics.p90Ms || 0),
            p95: Number(metrics.p95Ms || 0),
            p99: Number(metrics.p99Ms || 0),
            requestP50: newProtocol ? Number(metrics.requestP50Ms || 0) : 0,
            requestP90: newProtocol ? Number(metrics.requestP90Ms || 0) : 0,
            requestP95: newProtocol ? Number(metrics.requestP95Ms || 0) : 0,
            requestP99: newProtocol ? Number(metrics.requestP99Ms || 0) : 0,
            poolPeak: Number(metrics.poolPeak || 0),
            poolCapacity: Number(metrics.poolCapacity || 0),
            hitRate: task.mode === "cached" ? Math.round(Number(metrics.cacheHitRate || 0)) : null,
            cacheHits: Number(metrics.redisHits || 0),
            mysqlFallbacks: Number(metrics.mysqlFallbacks || 0),
            timeouts: Number(metrics.timeouts || 0),
            errorRate: Number(metrics.errorRate || 0),
            errors: Math.round(requestCount * Number(metrics.errorRate || 0) / 100)
        };
        if (newProtocol) {
            frozenMetrics.socketErrors = Number(metrics.socketErrors || 0);
        }
        completeResult({
            taskId: task.taskId,
            entry: "crowd",
            materialName: pending.materialName || state.profile.name,
            mode: task.mode === "cached" ? "cached" : "direct",
            cacheTemperature: pending.cacheTemperature || "cold",
            expectedRate: targetRate,
            expectedDurationSeconds: Number(tier.durationSeconds || pending.expectedDurationSeconds || 30),
            connectionMode: newProtocol ? task.connectionMode : "legacy",
            requestedConnections: Number(task.requestedConnections || pending.requestedConnections || 0),
            connections: Number(tier.connections || 0),
            metricsVersion: newProtocol ? 3 : 2,
            startedAt: task.startedAt || task.createdAt,
            metrics: frozenMetrics
        });
    }

    function stopLoadtestConnections() {
        if (state.loadtestStream) {
            state.loadtestStream.close();
            state.loadtestStream = null;
        }
        if (state.loadtestPollTimer) {
            window.clearInterval(state.loadtestPollTimer);
            state.loadtestPollTimer = null;
        }
    }

    function taskTargetRate(task) {
        return Number(task && task.tier && task.tier.rate ||
            state.pendingRun && state.pendingRun.expectedRate ||
            crowdTiers[crowdTierID].rate);
    }

    function taskCompletionRate(task) {
        var metrics = task && task.metrics || {};
        if (metrics.targetCompletionRate !== undefined) {
            return Number(metrics.targetCompletionRate || 0);
        }
        var target = taskTargetRate(task);
        return target > 0 ? Math.min(100, Number(metrics.actualQps || 0) * 100 / target) : 0;
    }

    // 查询潮汐没有逐请求 trace。动画只消费任务 SSE 的有序事件及其指标快照；
    // 全局 metrics SSE 和任务 GET 只负责静态渲染，不能据累计差值补画“代表性请求”。
    function tideTraceRawPath(task) {
        if (task && taskScenario(task) !== "steady") {
            var taskMetrics = task.metrics || {};
            return {
                totalRequests: Number(taskMetrics.actualRequests || 0),
                cacheHits: Number(taskMetrics.redisHits || 0),
                cacheMisses: Number(taskMetrics.redisMisses || 0),
                coalesced: Number(taskMetrics.coalescedAfterMiss || 0),
                negativeCacheHits: Number(taskMetrics.negativeCacheHits || 0),
                p99: Number(taskMetrics.runMaxLatencyMs || taskMetrics.currentMaxLatencyMs || 0),
                errors: Number(taskMetrics.errorRate || 0) > 0 ? 1 : 0
            };
        }
        var chapter = state.metricsLatest && state.metricsLatest.archiveRead;
        if (!chapter) {
            return null;
        }
        return task && task.mode === "cached" ? chapter.cached : chapter.direct;
    }

    function clearTideTraceTimer() {
        if (state.tideTrace.timer) {
            window.clearTimeout(state.tideTrace.timer);
            state.tideTrace.timer = null;
        }
    }

    function stopTideTraceMotion() {
        var sampler = state.tideTrace;
        clearTideTraceTimer();
        sampler.animations.forEach(function (animation) {
            try {
                animation.cancel();
            } catch (_) {
                // 已经结束的视觉动画无需额外恢复。
            }
        });
        sampler.animations = [];
        sampler.queue = [];
        sampler.active = null;
        ["tide-trace-request", "tide-trace-response", "tide-trace-refill"].forEach(function (id) {
            var token = byId(id);
            if (!token) {
                return;
            }
            token.style.opacity = "0";
            token.style.transform = "translate3d(-80px, -80px, 0)";
        });
        var stage = byId("query-tide-stage");
        if (stage) {
            stage.removeAttribute("data-trace-route");
            stage.removeAttribute("data-trace-phase");
        }
        resetTideCacheBridge();
    }

    function resetTideCacheBridge() {
        var bridge = document.querySelector(".tide-cache-bridge");
        if (!bridge) {
            return;
        }
        bridge.dataset.gateMode = "bypass";
        bridge.dataset.gateSubtitle = "HIT BYPASS · MISS 才进入";
        var miss = bridge.querySelector(".tide-cache-miss");
        var refill = bridge.querySelector(".tide-cache-refill");
        if (miss) {
            miss.textContent = "KEY MUTEX";
        }
        if (refill) {
            refill.textContent = "DOUBLE CHECK";
        }
    }

    function renderTideCacheGate(step) {
        var bridge = document.querySelector(".tide-cache-bridge");
        if (!bridge) {
            return;
        }
        resetTideCacheBridge();
        if (!step) {
            return;
        }
        if (!step.gatePhase) {
            var routeStates = {
                "cache-miss": ["dto", "DTO KEY · 首查 MISS"],
                "cache-rebuild": ["dto", "DTO KEY · 首查 MISS"],
                "negative-build": ["neg", "NEG KEY 900004 · MISS"],
                "cache-error": ["bypass", "REDIS ERROR · 阶段未知"],
                "dto-miss": ["bypass", "DTO KEY 900004 · BYPASS"],
                "mysql-404": ["bypass", "无保护 · BYPASS"],
                "negative-hit": ["bypass", "NEG KEY 900004 · HIT BYPASS"],
                "cache-evicted": ["idle", "DEL 完成 · 等待首查"]
            };
            var routeState = routeStates[step.route];
            if (routeState) {
                bridge.dataset.gateMode = routeState[0];
                bridge.dataset.gateSubtitle = routeState[1];
            }
            return;
        }
        var subtitles = {
            wave: "DTO KEY · MISS 进入互斥",
            leader: "DTO KEY · 二检 MISS",
            set: "DTO KEY · SET 后解锁",
            followers: "DTO KEY · 二检 HIT"
        };
        bridge.dataset.gateMode = step.gatePhase;
        bridge.dataset.gateSubtitle = subtitles[step.gatePhase] || "按 Key 合并回源";
        bridge.querySelector(".tide-cache-miss").textContent = "KEY MUTEX";
        bridge.querySelector(".tide-cache-refill").textContent = "DOUBLE CHECK";
    }

    function clearTideScenarioMotion() {
        stopTideTraceMotion();
        state.tideTrace.taskId = "";
        state.tideTrace.eventHighWater = 0;
        state.tideTrace.seenMilestones = {};
        state.tideTrace.lastStep = null;
        var stage = byId("query-tide-stage");
        if (stage) {
            stage.removeAttribute("data-causal-step");
            stage.removeAttribute("data-cache-kind");
            stage.removeAttribute("data-gate-phase");
        }
        resetTideCacheBridge();
    }

    function resetTideTraceSampler(task) {
        var sampler = state.tideTrace;
        var rawPath = tideTraceRawPath(task) || {};
        stopTideTraceMotion();
        sampler.taskId = task && task.taskId || "";
        sampler.eventHighWater = 0;
        sampler.seenMilestones = {};
        sampler.lastStep = null;
        sampler.sequence = 0;
        sampler.requestHighWater = 0;
        sampler.hitHighWater = 0;
        sampler.fallbackHighWater = 0;
        sampler.cacheErrorHighWater = Number(rawPath.cacheErrors || 0);
        sampler.coalescedHighWater = Number(rawPath.coalesced || 0);
        sampler.negativeHighWater = Number(rawPath.negativeCacheHits || 0);
        sampler.refillHitFloor = 0;
        sampler.refillPending = false;
        sampler.refillEvidence = false;
        sampler.responseBaseline = Number(rawPath.totalRequests || 0);
        sampler.responseResetObserved = sampler.responseBaseline === 0;
        sampler.responseEvidence = false;
        sampler.lastStartedAt = 0;
        var stage = byId("query-tide-stage");
        if (stage) {
            stage.dataset.hasResponse = "false";
            stage.dataset.cacheRefillObserved = "false";
            stage.removeAttribute("data-causal-step");
            stage.removeAttribute("data-cache-kind");
            stage.removeAttribute("data-gate-phase");
        }
        resetTideCacheBridge();
    }

    function updateTideResponseEvidence(task) {
        var sampler = state.tideTrace;
        var rawPath = tideTraceRawPath(task);
        if (!rawPath) {
            return;
        }
        var total = Number(rawPath.totalRequests || 0);
        if (total === 0 || total < sampler.responseBaseline) {
            sampler.responseBaseline = 0;
            sampler.responseResetObserved = true;
        }
        var hasNewRunSample = sampler.responseResetObserved ?
            total > 0 : total > sampler.responseBaseline;
        // P99 只有 RecordArchiveLatency 已经收到完成样本后才会大于零。
        // errors 为零时可确认本轮至少已有一次成功处理完成，再允许紫色响应出现。
        if (task && task.status === "running" && hasNewRunSample &&
            Number(rawPath.p99 || 0) > 0 && Number(rawPath.errors || 0) === 0) {
            sampler.responseEvidence = true;
        }
        byId("query-tide-stage").dataset.hasResponse =
            sampler.responseEvidence ? "true" : "false";
    }

    function tideTracePoint(layer, anchor, token) {
        var layerBounds = layer.getBoundingClientRect();
        var anchorBounds = anchor.getBoundingClientRect();
        return {
            x: anchorBounds.left - layerBounds.left +
                (anchorBounds.width - token.offsetWidth) / 2,
            y: anchorBounds.top - layerBounds.top +
                (anchorBounds.height - token.offsetHeight) / 2
        };
    }

    function animateTideToken(token, anchors, duration, fadeAtEnd) {
        var layer = document.querySelector(".tide-trace-layer");
        if (!layer || !token || !token.animate) {
            return { animation: null, finished: Promise.resolve(false) };
        }
        var points = anchors.filter(Boolean).map(function (anchor) {
            return tideTracePoint(layer, anchor, token);
        });
        if (points.length < 2) {
            return { animation: null, finished: Promise.resolve(false) };
        }
        var travelEnd = fadeAtEnd ? .9 : 1;
        var frames = points.map(function (point, index) {
            return {
                offset: points.length === 1 ? 0 :
                    index * travelEnd / (points.length - 1),
                opacity: 1,
                transform: "translate3d(" + point.x + "px, " + point.y + "px, 0)"
            };
        });
        if (fadeAtEnd) {
            var last = points[points.length - 1];
            frames.push({
                offset: 1,
                opacity: 0,
                transform: "translate3d(" + last.x + "px, " + last.y + "px, 0) scale(.82)"
            });
        }
        token.style.opacity = "1";
        var animation = token.animate(frames, {
            duration: duration,
            easing: "linear",
            fill: "forwards"
        });
        state.tideTrace.animations.push(animation);
        return {
            animation: animation,
            finished: animation.finished.then(function () {
                return true;
            }, function () {
                return false;
            })
        };
    }

    function tideTraceTempo(task, route) {
        var qps = Number(task && task.metrics && task.metrics.actualQps || 0);
        var fast = qps >= 700;
        var medium = qps >= 250;
        return {
            request: (fast ? 1450 : (medium ? 1700 : 2000)) +
                (["cache-miss", "cache-rebuild", "cache-rebuild-wave",
                    "cache-rebuild-leader", "negative-build", "cache-error"].indexOf(route) >= 0 ? 420 : 0),
            response: fast ? 1350 : (medium ? 1550 : 1800),
            pause: fast ? 240 : (medium ? 420 : 700)
        };
    }

    function tideTraceRequestAnchors(route) {
        if (route === "cache-evicted") {
            return [
                document.querySelector(".tide-service-icon"),
                byId("tide-redis-device")
            ];
        }
        if (route === "dto-miss") {
            return [
                document.querySelector(".tide-scroll-maker"),
                document.querySelector(".tide-conduit-bank"),
                document.querySelector(".tide-service-icon"),
                byId("tide-redis-device")
            ];
        }
        if (route === "mysql-404") {
            return [
                byId("tide-redis-device"),
                document.querySelector(".tide-service-icon"),
                byId("tide-mysql-device")
            ];
        }
        if (route === "cache-rebuild-wave") {
            return [
                document.querySelector(".tide-service-icon"),
                byId("tide-redis-device"),
                document.querySelector(".tide-cache-bridge")
            ];
        }
        if (route === "cache-rebuild-leader") {
            return [
                document.querySelector(".tide-cache-bridge"),
                byId("tide-redis-device"),
                document.querySelector(".tide-cache-bridge"),
                byId("tide-mysql-device")
            ];
        }
        if (route === "cache-rebuild-followers") {
            return [
                document.querySelector(".tide-service-icon"),
                document.querySelector(".tide-cache-bridge"),
                byId("tide-redis-device")
            ];
        }
        if (route === "negative-build") {
            return [
                document.querySelector(".tide-service-icon"),
                byId("tide-redis-device"),
                document.querySelector(".tide-cache-bridge"),
                byId("tide-redis-device"),
                document.querySelector(".tide-cache-bridge"),
                byId("tide-mysql-device")
            ];
        }
        if (route === "negative-hit") {
            return [
                byId("tide-redis-device"),
                document.querySelector(".tide-service-icon"),
                byId("tide-redis-device")
            ];
        }
        var anchors = [
            document.querySelector(".tide-scroll-maker"),
            document.querySelector(".tide-backlog-scrolls"),
            document.querySelector(".tide-conduit-bank"),
            document.querySelector(".tide-service-icon")
        ];
        if (route === "direct") {
            anchors.push(byId("tide-mysql-device"));
        } else {
            anchors.push(byId("tide-redis-device"));
            if (["cache-miss", "cache-rebuild"].indexOf(route) >= 0) {
                anchors.push(document.querySelector(".tide-cache-bridge"));
                anchors.push(byId("tide-redis-device"));
                anchors.push(document.querySelector(".tide-cache-bridge"));
                anchors.push(byId("tide-mysql-device"));
            } else if (route === "cache-error") {
                // cacheErrors 同时覆盖首查、锁内二检和 SET 失败；这里只画“Redis 异常后降级”，
                // 不把常驻 Gate 当作已被经过的逐请求证据。
                anchors.push(document.querySelector(".tide-service-icon"));
                anchors.push(byId("tide-mysql-device"));
            }
        }
        return anchors;
    }

    function tideTraceResponseAnchors(route) {
        return [
            ["direct", "cache-miss", "cache-rebuild", "cache-error", "mysql-404", "negative-build"].indexOf(route) >= 0 ?
                byId("tide-mysql-device") : byId("tide-redis-device"),
            document.querySelector(".tide-service-icon"),
            document.querySelector(".tide-conduit-bank"),
            document.querySelector(".tide-scroll-maker"),
            byId("tide-response-archive")
        ];
    }

    function tideTraceRefillAnchors() {
        return [
            byId("tide-mysql-device"),
            document.querySelector(".tide-cache-bridge"),
            byId("tide-redis-device")
        ];
    }

    function tideCausalEvidenceID(step) {
        return step && step.eventID ? "SSE #" + step.eventID : "任务指标快照";
    }

    function tideCausalStepCopy(step) {
        var metrics = step.metrics || {};
        var evidence = tideCausalEvidenceID(step);
        var gateMisses = Number(metrics.redisMisses || 0);
        var gateLeaders = Number(metrics.mysqlFallbacks || 0);
        var gateFollowers = Number(metrics.coalescedAfterMiss || 0);
        var gateConserved = gateMisses === gateLeaders + gateFollowers;
        var gateFrame = evidence + " " +
            (step.kind === "breakdown-rebuild-followers" ? "cache_recovered" : "cache_rebuilt") +
            " 冻结指标帧（语义拆解，不是逐请求 trace）：";
        var gateEquation = "redisMisses " + formatNumber(gateMisses) + " = mysqlFallbacks " +
            formatNumber(gateLeaders) + " + coalescedAfterMiss " + formatNumber(gateFollowers) +
            (gateConserved ? "，守恒成立" : "，当前帧未守恒，不补猜缺口");
        var copies = {
            "breakdown-stable": {
                badge: "因果 1/4 · 热点稳定",
                kitchen: "DTO Key HIT · MySQL 待机",
                why: "热点 DTO 已预热，连续任务指标先形成稳定命中基线",
                handling: "请求直接从 Redis 返回，MySQL 不参与这段稳态窗口",
                evidence: evidence + "：正缓存命中 " + formatNumber(metrics.redisHits) +
                    "，当前命中率 " + Number(metrics.currentHitRate || metrics.cacheHitRate || 0).toFixed(1) + "%"
            },
            "breakdown-evicted": {
                badge: "因果 2/4 · 真实 DEL",
                kitchen: "DTO Key 已删除 · 等待 MISS",
                why: "稳定命中基线成立后，Runner 才注入热点 Key 失效",
                handling: "服务端真实执行 Redis DEL；后续请求不能继续命中旧 DTO",
                evidence: evidence + " cache_evicted · " + (step.at || "事件时间已记录")
            },
            "breakdown-rebuild-wave": {
                badge: "因果 3A/3D · 已观察 MISS 进入闸门",
                kitchen: "已观察 DTO MISS → Go FILL GATE",
                why: "真实 DEL 后，截至 cache_rebuilt 帧已观察到同一热点 Key 的 Redis MISS",
                handling: "这些已观察 MISS 回到 Go API 的按 Key 回源闸门；此帧不冒充最终完整波规模",
                evidence: gateFrame + "截至该帧已观察 MISS " + formatNumber(gateMisses) + " 次"
            },
            "breakdown-rebuild-leader": {
                badge: "因果 3B/3D · leader 回源",
                kitchen: "leader 二检 MISS → MySQL",
                why: "闸门只允许 leader 持有该 Key 的重建资格，followers 留在闸门等待",
                handling: "leader 在锁内二次检查仍 MISS，才去 MySQL；followers 此时不访问 MySQL",
                evidence: gateFrame + "leader = mysqlFallbacks " + formatNumber(gateLeaders) +
                    "；followers 数量等待 cache_recovered 恢复点闭合"
            },
            "breakdown-rebuild-set": {
                badge: "因果 3C/3D · leader SET DTO",
                kitchen: "MySQL → leader SET DTO → Redis",
                why: "leader 已从 MySQL 取得权威 DTO，闸门内的 followers 仍在等待同一个结果",
                handling: "leader 把 DTO 写回 Redis 后释放按 Key 闸门，重建只记一次",
                evidence: gateFrame + "cacheRebuilds " + formatNumber(metrics.cacheRebuilds) +
                    "，SQL " + formatNumber(metrics.sqlQueries)
            },
            "breakdown-rebuild-followers": {
                badge: "因果 3D/3D · followers 二检 HIT",
                kitchen: "followers 醒来 → 二检 HIT · SKIP MySQL",
                why: "cache_recovered 恢复点表明 leader 已完成 SET DTO，等待者已经继续执行",
                handling: "followers 逐个在锁内二次检查命中新 DTO，直接返回并跳过 MySQL",
                evidence: gateFrame + "恢复点闭合 followers；" + gateEquation
            },
            "breakdown-recovered": {
                badge: "因果 4/4 · 恢复稳定",
                kitchen: "DTO Key HIT · 重建生效",
                why: gateFollowers > 0 ?
                    "DTO 已重建且 followers 已二检命中，后续请求重新具备可命中的副本" :
                    "DTO 已由 leader 重建；恢复帧中未观察到 follower 合并返回",
                handling: gateFollowers > 0 ?
                    "连续恢复窗口继续读取 Redis，并确认 followers 跳过 MySQL" :
                    "连续恢复窗口继续读取 Redis；不补演 FOLLOW×0 路径",
                evidence: evidence + " cache_recovered：当前命中率 " +
                    Number(metrics.currentHitRate || metrics.cacheHitRate || 0).toFixed(1) +
                    "% ，恢复耗时 " + formatScenarioDuration(metrics.recoveryDurationMs) +
                    (gateFollowers > 0 ? "，followers " + formatNumber(gateFollowers) :
                        "，未观察到 follower（coalescedAfterMiss=0）")
            },
            "penetration-dto-miss": {
                badge: "因果 1/" + (step.protection === "negative-cache" ? "3" : "2") + " · DTO MISS",
                kitchen: "DTO Key MISS · 不是缓存 HIT",
                why: "材料 900004 不存在，因此正常 DTO Key 没有可返回的详情副本",
                handling: "Go API 先读取正常 DTO Key，并得到真实 Redis MISS",
                evidence: evidence + " metric：正常 DTO MISS " + formatNumber(metrics.redisMisses)
            },
            "penetration-mysql-404": {
                badge: "因果 2/2 · MySQL 404",
                kitchen: "DTO MISS → MySQL NOT FOUND",
                why: "无保护模式没有负缓存拦截正常 DTO MISS",
                handling: "每次请求继续回源 MySQL 确认不存在，再返回预期 404",
                evidence: evidence + " metric：无效 MySQL 查询 " + formatNumber(metrics.invalidMySQLQueries) +
                    "，预期 404 " + formatNumber(metrics.expectedNotFound)
            },
            "penetration-negative-build": {
                badge: "因果 2/3 · 首次建立负缓存",
                kitchen: "DTO MISS → NEG MISS×2 → MySQL → SET NEG",
                why: "本轮开始时正常 DTO Key 与负缓存 Key 都尚未命中",
                handling: "负缓存首查 MISS 后进入按 Key 互斥；leader 二查仍 MISS 才回源，确认不存在后只写短 TTL 负缓存，不写 DTO",
                evidence: evidence + " metric：负缓存写入 " + formatNumber(metrics.negativeCacheWrites) +
                    "，无效 MySQL 查询 " + formatNumber(metrics.invalidMySQLQueries) +
                    "，互斥后二查命中 " + formatNumber(metrics.coalescedAfterMiss)
            },
            "penetration-negative-hit": {
                badge: "因果 3/3 · 负缓存命中",
                kitchen: "DTO MISS → NEG HIT(首查/二查) → 404",
                why: "正常 DTO 仍然 MISS，但前一步已经建立 not-found 负缓存",
                handling: "后续请求要么首查命中负缓存，要么在按 Key 互斥后二查命中；两条路径都直接返回预期 404 并跳过 MySQL",
                evidence: evidence + " metric：负缓存命中 " + formatNumber(metrics.negativeCacheHits) +
                    "，其中二查命中 " + formatNumber(metrics.coalescedAfterMiss) +
                    "、锁外快命中 " + formatNumber(Math.max(0,
                        Number(metrics.negativeCacheHits || 0) - Number(metrics.coalescedAfterMiss || 0))) +
                    "；正常 DTO 命中仍为 " + formatNumber(metrics.redisHits)
            },
            "breakdown-completed": {
                badge: "因果闭环 · 证据冻结",
                kitchen: "DEL → MISS → 重建 → 恢复",
                why: "热点失效实验已经收到任务终态",
                handling: "Runner 停止发流并冻结稳态、冲击、恢复三个真实窗口",
                evidence: evidence + " completed：重建 " + formatNumber(metrics.cacheRebuilds) +
                    "，MySQL 回源 " + formatNumber(metrics.mysqlFallbacks) +
                    "，恢复耗时 " + formatScenarioDuration(metrics.recoveryDurationMs) +
                    "；终态 " + gateEquation +
                    (gateFollowers > 0 ? "" : "；未观察到 follower")
            },
            "penetration-completed": {
                badge: "因果闭环 · 证据冻结",
                kitchen: step.protection === "negative-cache" ?
                    "DTO MISS → 负缓存 HIT → 404" : "DTO MISS → MySQL → 404",
                why: "缓存穿透实验已经收到任务终态",
                handling: step.protection === "negative-cache" ?
                    "冻结首次 MySQL 确认、一次负缓存写入及后续拦截" :
                    "冻结每次 DTO MISS 后继续回源 MySQL 的无保护基线",
                evidence: evidence + " completed：不存在请求 " + formatNumber(metrics.nonexistentRequests) +
                    "，无效 MySQL 查询 " + formatNumber(metrics.invalidMySQLQueries) +
                    "，负缓存命中 " + formatNumber(metrics.negativeCacheHits) +
                    "，预期 404 " + formatNumber(metrics.expectedNotFound)
            }
        };
        return copies[step.kind] || null;
    }

    function renderTideCausalStep(step) {
        var copy = tideCausalStepCopy(step);
        var stage = byId("query-tide-stage");
        if (!copy || !stage) {
            return;
        }
        stage.dataset.causalStep = step.kind;
        stage.dataset.cacheKind = step.kind.indexOf("negative") >= 0 ? "negative" : "dto";
        if (step.gatePhase) {
            stage.dataset.gatePhase = step.gatePhase;
        } else {
            stage.removeAttribute("data-gate-phase");
        }
        renderTideCacheGate(step);
        byId("query-tide-badge").textContent = copy.badge;
        byId("tide-kitchen-title").textContent = copy.kitchen;
        byId("query-tide-explanation").textContent =
            "为什么发生：" + copy.why + " → 系统怎么处理：" + copy.handling +
            " → 最终证据：" + copy.evidence + "。";
        byId("tide-response-copy").textContent = step.semanticDecomposition ?
            tideCausalEvidenceID(step) + " 同一冻结指标帧 · 语义拆解，非逐请求 trace" :
            "动画由 " + tideCausalEvidenceID(step) + " 推进";
    }

    function finishTideTraceSample(sample) {
        var sampler = state.tideTrace;
        if (sampler.active !== sample) {
            return;
        }
        sampler.animations.forEach(function (animation) {
            try {
                animation.cancel();
            } catch (_) {
                // 完成态动画已经自然释放。
            }
        });
        sampler.animations = [];
        byId("tide-trace-request").style.opacity = "0";
        byId("tide-trace-response").style.opacity = "0";
        byId("tide-trace-refill").style.opacity = "0";
        sampler.active = null;
        var stage = byId("query-tide-stage");
        stage.removeAttribute("data-trace-route");
        stage.removeAttribute("data-trace-phase");
        if (!sample.eventDriven) {
            resetTideCacheBridge();
        }
        if (!state.loadtestTask || sampler.queue.length === 0) {
            return;
        }
        var nextEventDriven = typeof sampler.queue[0] !== "string";
        if (!nextEventDriven && state.loadtestTask.status !== "running") {
            return;
        }
        clearTideTraceTimer();
        sampler.timer = window.setTimeout(function () {
            sampler.timer = null;
            pumpTideTrace();
        }, sample.tempo.pause);
    }

    function releaseTideTraceResponse(sample) {
        var sampler = state.tideTrace;
        if (sampler.active !== sample || sample.phase !== "waiting" ||
            !sample.responseProven || !state.loadtestTask ||
            (!sample.eventDriven && state.loadtestTask.status !== "running")) {
            return;
        }
        sample.phase = "response";
        byId("query-tide-stage").dataset.tracePhase = "response";
        if (sample.requestMotion && sample.requestMotion.animation) {
            sample.requestMotion.animation.cancel();
        }
        if (sample.refillMotion && sample.refillMotion.animation) {
            sample.refillMotion.animation.cancel();
        }
        byId("tide-trace-request").style.opacity = "0";
        byId("tide-trace-refill").style.opacity = "0";
        var response = byId("tide-trace-response");
        response.style.opacity = "1";
        sample.responseMotion = animateTideToken(
            response,
            tideTraceResponseAnchors(sample.route),
            sample.tempo.response,
            true
        );
        sample.responseMotion.finished.then(function (completed) {
            if (completed) {
                finishTideTraceSample(sample);
            }
        });
    }

    function startTideCacheRefill(sample) {
        var sampler = state.tideTrace;
        if (sampler.active !== sample || sample.phase !== "waiting-refill" ||
            !sample.refillProven || !state.loadtestTask ||
            (!sample.eventDriven && state.loadtestTask.status !== "running")) {
            return false;
        }
        sample.phase = "refill";
        var stage = byId("query-tide-stage");
        stage.dataset.tracePhase = "refill";
        stage.dataset.cacheRefillObserved = "true";
        if (sample.requestMotion && sample.requestMotion.animation) {
            sample.requestMotion.animation.cancel();
        }
        byId("tide-trace-request").style.opacity = "0";
        var refill = byId("tide-trace-refill");
        refill.querySelector("b").textContent = sample.id;
        refill.querySelector("em").textContent = sample.negativeRefill ? "负缓存 SET ↑" : "DTO SET ↑";
        refill.dataset.pairId = sample.id;
        refill.style.opacity = "1";
        sample.refillMotion = animateTideToken(
            refill,
            tideTraceRefillAnchors(sample.route),
            760,
            true
        );
        sample.refillMotion.finished.then(function (completed) {
            if (!completed || sampler.active !== sample ||
                !state.loadtestTask ||
                (!sample.eventDriven && state.loadtestTask.status !== "running")) {
                return;
            }
            refill.style.opacity = "0";
            if (sample.noResponse) {
                finishTideTraceSample(sample);
            } else {
                sample.phase = "waiting";
                stage.dataset.tracePhase = "processing";
                releaseTideTraceResponse(sample);
            }
        });
        return true;
    }

    function advanceTideTraceSample(sample) {
        var sampler = state.tideTrace;
        if (sampler.active !== sample) {
            return;
        }
        if (sample.phase === "waiting-refill") {
            if (startTideCacheRefill(sample)) {
                return;
            }
            if (!sample.eventDriven) {
                sample.refillChecks += 1;
                if (sample.refillChecks > 1 && sampler.responseEvidence) {
                    sample.phase = "waiting";
                    sample.responseProven = true;
                    releaseTideTraceResponse(sample);
                }
            }
            return;
        }
        if (sample.phase === "waiting") {
            releaseTideTraceResponse(sample);
        }
    }

    function startTideTraceSample(step) {
        var sampler = state.tideTrace;
        var task = state.loadtestTask;
        var eventDriven = typeof step !== "string";
        if (!task || (!eventDriven && task.status !== "running")) {
            return;
        }
        if (!eventDriven) {
            step = {
                route: step,
                responseProven: sampler.responseEvidence,
                refillProven: ["cache-miss", "cache-rebuild"].indexOf(step) >= 0 &&
                    sampler.refillEvidence
            };
        }
        if (step.displayOnly) {
            sampler.lastStep = step;
            renderTideCausalStep(step);
            return;
        }
        var route = step.route;
        sampler.sequence = sampler.sequence % 99 + 1;
        var pairID = step.eventID ? "#" + step.eventID :
            (eventDriven ? "E" : "S") + String(sampler.sequence).padStart(2, "0");
        var request = byId("tide-trace-request");
        var response = byId("tide-trace-response");
        request.querySelector("b").textContent = pairID;
        response.querySelector("b").textContent = pairID;
        request.dataset.pairId = pairID;
        response.dataset.pairId = pairID;
        request.querySelector("em").textContent = step.requestLabel || "REQ →";
        response.querySelector("em").textContent = step.responseLabel || "← RES";
        response.style.opacity = "0";
        var sample = {
            id: pairID,
            route: route,
            kind: step.kind,
            phase: "request",
            tempo: tideTraceTempo(task, route),
            requestMotion: null,
            refillMotion: null,
            responseMotion: null,
            eventDriven: eventDriven,
            refillChecks: 0,
            noResponse: Boolean(step.noResponse),
            refillProven: Boolean(step.refillProven),
            negativeRefill: Boolean(step.negativeRefill),
            responseProven: step.responseProven !== false
        };
        sampler.active = sample;
        if (step.kind) {
            sampler.lastStep = step;
        }
        sampler.lastStartedAt = Date.now();
        var stage = byId("query-tide-stage");
        stage.dataset.traceRoute = route;
        stage.dataset.tracePhase = "request";
        if (step.kind) {
            renderTideCausalStep(step);
        } else {
            renderTideCacheGate(step);
        }
        if (step.refillOnly) {
            sample.phase = "waiting-refill";
            stage.dataset.tracePhase = "processing";
            startTideCacheRefill(sample);
            return;
        }
        sample.requestMotion = animateTideToken(
            request,
            tideTraceRequestAnchors(route),
            sample.tempo.request,
            false
        );
        sample.requestMotion.finished.then(function (completed) {
            if (!completed || sampler.active !== sample ||
                !state.loadtestTask ||
                (!sample.eventDriven && state.loadtestTask.status !== "running")) {
                return;
            }
            if (sample.noResponse) {
                finishTideTraceSample(sample);
                return;
            }
            sample.phase = sample.refillProven ? "waiting-refill" : "waiting";
            stage.dataset.tracePhase = "processing";
            advanceTideTraceSample(sample);
        });
    }

    function pumpTideTrace() {
        var sampler = state.tideTrace;
        if (sampler.active || sampler.queue.length === 0 || !state.loadtestTask) {
            return;
        }
        var nextEventDriven = typeof sampler.queue[0] !== "string";
        if (!nextEventDriven && state.loadtestTask.status !== "running") {
            return;
        }
        startTideTraceSample(sampler.queue.shift());
    }

    function observeTideTrace(task) {
        if (!task || state.entry !== "crowd") {
            stopTideTraceMotion();
            return;
        }
        var sampler = state.tideTrace;
        var taskID = task.taskId || "";
        if (sampler.taskId !== taskID) {
            resetTideTraceSampler(task);
        }
        // 受控场景的已接收事件队列独立于 Runner live 状态；终态只停止 SSE，
        // 不能清掉断线回放时已经收到、但尚未演完的真实因果步骤。
        if (taskScenario(task) !== "steady") {
            return;
        }
        if (task.status !== "running") {
            stopTideTraceMotion();
            return;
        }
        updateTideResponseEvidence(task);

        var metrics = task.metrics || {};
        var requests = Math.max(sampler.requestHighWater,
            Number(metrics.actualRequests || 0));
        var hits = Math.max(sampler.hitHighWater,
            Number(metrics.redisHits || 0));
        var fallbacks = Math.max(sampler.fallbackHighWater,
            Number(metrics.mysqlFallbacks || 0));
        var rawPath = tideTraceRawPath(task) || {};
        var cacheErrors = Math.max(sampler.cacheErrorHighWater,
            Number(rawPath.cacheErrors || 0));
        var coalesced = Math.max(sampler.coalescedHighWater,
            Number(rawPath.coalesced || 0));
        var requestDelta = requests - sampler.requestHighWater;
        var hitDelta = hits - sampler.hitHighWater;
        var fallbackDelta = fallbacks - sampler.fallbackHighWater;
        var cacheErrorDelta = cacheErrors - sampler.cacheErrorHighWater;
        // cacheErrors 没有携带失败阶段，出现错误的采样帧无法证明本次回源是否进过 Gate。
        // 宁可少画该帧，也不把锁内二检/SET 失败伪装成首查错误 BYPASS。
        var missFallbackDelta = cacheErrorDelta > 0 ? 0 : fallbackDelta;
        var coalescedDelta = coalesced - sampler.coalescedHighWater;
        if (task.mode === "cached" && missFallbackDelta > 0) {
            sampler.refillPending = true;
            sampler.refillHitFloor = sampler.hitHighWater;
        }
        sampler.requestHighWater = requests;
        sampler.hitHighWater = hits;
        sampler.fallbackHighWater = fallbacks;
        sampler.cacheErrorHighWater = cacheErrors;
        sampler.coalescedHighWater = coalesced;
        if (task.mode === "cached" && sampler.refillPending &&
            (coalescedDelta > 0 || hits > sampler.refillHitFloor)) {
            sampler.refillPending = false;
            sampler.refillEvidence = true;
            byId("query-tide-stage").dataset.cacheRefillObserved = "true";
        }
        if (state.reducedMotion) {
            return;
        }
        var observedQPS = Number(metrics.actualQps || 0);
        var sampleLimit = observedQPS >= 700 ? 2 : 1;
        var routes = [];
        if (task.mode === "cached") {
            if (missFallbackDelta > 0) {
                routes.push("cache-miss");
            }
            if (hitDelta > 0) {
                routes.push("cache-hit");
            }
            if (routes.length === 1 && sampleLimit > 1 && hitDelta + fallbackDelta > 1) {
                routes.push(routes[0]);
            }
        } else if (requestDelta > 0) {
            routes.push("direct");
            if (sampleLimit > 1 && requestDelta > 1) {
                routes.push("direct");
            }
        }
        routes.slice(0, sampleLimit).forEach(function (route) {
            if (sampler.queue.length < 2) {
                sampler.queue.push(route);
            }
        });
        if (sampler.active && !sampler.active.eventDriven) {
            sampler.active.responseProven = sampler.responseEvidence;
            sampler.active.refillProven = sampler.refillEvidence;
            if (sampler.active.phase === "waiting" || sampler.active.phase === "waiting-refill") {
                advanceTideTraceSample(sampler.active);
            }
        }
        pumpTideTrace();
    }

    function enqueueTideCausalMilestone(key, step) {
        var sampler = state.tideTrace;
        if (sampler.seenMilestones[key]) {
            return;
        }
        sampler.seenMilestones[key] = true;
        if (state.reducedMotion) {
            sampler.lastStep = step;
            renderTideCausalStep(step);
            return;
        }
        sampler.queue.push(step);
        pumpTideTrace();
    }

    // 只有任务 SSE 处理器可以调用这里。event.id 是 Runner 的单调序号，既用于断线回放，
    // 也用于前端去重；GET 快照和全局 metrics SSE 不得进入这条动画队列。
    function ingestTideCausalEvent(eventName, update, task) {
        if (!task || state.entry !== "crowd" || taskScenario(task) === "steady") {
            return;
        }
        var sampler = state.tideTrace;
        if (sampler.taskId !== (task.taskId || "")) {
            resetTideTraceSampler(task);
        }
        var eventID = Number(update && update.id || 0);
        if (eventID > 0 && eventID <= sampler.eventHighWater) {
            return;
        }
        if (eventID > 0) {
            sampler.eventHighWater = eventID;
        }
        var scenario = taskScenario(task);
        var metrics = Object.assign({}, task.metrics || {}, update && update.metrics || {});
        var base = {
            eventID: eventID,
            at: update && update.at ? new Date(update.at).toLocaleTimeString("zh-CN", { hour12: false }) : "",
            metrics: metrics,
            protection: task.protection || "none",
            responseProven: true
        };
        if (scenario === "breakdown") {
            if (eventName === "metric" && metrics.scenarioPhase === "stable" &&
                Number(metrics.currentPositiveHits || metrics.redisHits || 0) > 0) {
                enqueueTideCausalMilestone("breakdown-stable", Object.assign({}, base, {
                    kind: "breakdown-stable", route: "cache-hit",
                    requestLabel: "DTO GET →", responseLabel: "← DTO HIT"
                }));
            } else if (eventName === "cache_evicted") {
                enqueueTideCausalMilestone("breakdown-evicted", Object.assign({}, base, {
                    kind: "breakdown-evicted", route: "cache-evicted",
                    requestLabel: "DEL →", noResponse: true
                }));
            } else if (eventName === "cache_rebuilt") {
                // 3A～3C 共享 cache_rebuilt 的冻结指标副本；followers 尚可能在返回途中，3D 留给恢复点闭合。
                var rebuildMetrics = update && update.metrics ?
                    Object.assign({}, update.metrics) : metrics;
                var rebuildBase = Object.assign({}, base, { metrics: rebuildMetrics });
                var leaderCount = Number(rebuildMetrics.mysqlFallbacks || 0);
                enqueueTideCausalMilestone("breakdown-rebuild-wave", Object.assign({}, rebuildBase, {
                    kind: "breakdown-rebuild-wave", route: "cache-rebuild-wave",
                    gatePhase: "wave",
                    semanticDecomposition: true,
                    requestLabel: "MISS×" + formatNumber(rebuildMetrics.redisMisses) + " →", noResponse: true
                }));
                enqueueTideCausalMilestone("breakdown-rebuild-leader", Object.assign({}, rebuildBase, {
                    kind: "breakdown-rebuild-leader", route: "cache-rebuild-leader",
                    gatePhase: "leader", semanticDecomposition: true,
                    requestLabel: "LEADER×" + formatNumber(leaderCount) + " →", noResponse: true
                }));
                enqueueTideCausalMilestone("breakdown-rebuild-set", Object.assign({}, rebuildBase, {
                    kind: "breakdown-rebuild-set", route: "cache-rebuild-set",
                    gatePhase: "set", semanticDecomposition: true,
                    refillOnly: true, refillProven: true, noResponse: true
                }));
            } else if (eventName === "cache_recovered") {
                // followers 要等 leader SET 后才可能二检 HIT；只用恢复点的冻结帧闭合，普通 metric 不授权 3D。
                var recoveredMetrics = update && update.metrics ?
                    Object.assign({}, update.metrics) : metrics;
                var recoveredBase = Object.assign({}, base, { metrics: recoveredMetrics });
                var recoveredFollowers = Number(recoveredMetrics.coalescedAfterMiss || 0);
                if (recoveredFollowers > 0) {
                    enqueueTideCausalMilestone("breakdown-rebuild-followers", Object.assign({}, recoveredBase, {
                        kind: "breakdown-rebuild-followers", route: "cache-rebuild-followers",
                        gatePhase: "followers",
                        semanticDecomposition: true,
                        requestLabel: "FOLLOW×" + formatNumber(recoveredFollowers) + " →",
                        responseLabel: "← DTO HIT"
                    }));
                }
                enqueueTideCausalMilestone("breakdown-recovered", Object.assign({}, recoveredBase, {
                    kind: "breakdown-recovered", route: "cache-hit",
                    requestLabel: "DTO GET →", responseLabel: "← DTO HIT"
                }));
            }
        } else if (eventName === "metric") {
            if (Number(metrics.redisMisses || 0) > 0) {
                enqueueTideCausalMilestone("penetration-dto-miss", Object.assign({}, base, {
                    kind: "penetration-dto-miss", route: "dto-miss",
                    requestLabel: "DTO GET →", noResponse: true
                }));
            }
            if (task.protection === "negative-cache") {
                if (Number(metrics.negativeCacheWrites || 0) > 0 &&
                    Number(metrics.invalidMySQLQueries || 0) > 0) {
                    enqueueTideCausalMilestone("penetration-negative-build", Object.assign({}, base, {
                        kind: "penetration-negative-build", route: "negative-build",
                        requestLabel: "首次 MISS →", responseLabel: "← 404",
                        refillProven: true, negativeRefill: true
                    }));
                }
                if (Number(metrics.negativeCacheHits || 0) > 0) {
                    enqueueTideCausalMilestone("penetration-negative-hit", Object.assign({}, base, {
                        kind: "penetration-negative-hit", route: "negative-hit",
                        requestLabel: "NEG GET →", responseLabel: "← 404"
                    }));
                }
            } else if (Number(metrics.invalidMySQLQueries || 0) > 0 &&
                Number(metrics.expectedNotFound || 0) > 0) {
                enqueueTideCausalMilestone("penetration-mysql-404", Object.assign({}, base, {
                    kind: "penetration-mysql-404", route: "mysql-404",
                    requestLabel: "SQL →", responseLabel: "← 404"
                }));
            }
        }
        if (eventName === "completed") {
            var completedStep = Object.assign({}, base, {
                kind: scenario + "-completed",
                route: "",
                protection: task.protection || "none",
                displayOnly: true
            });
            enqueueTideCausalMilestone(completedStep.kind, completedStep);
        }
    }

    function restoreTideCausalStep(task) {
        var step = state.tideTrace.lastStep;
        if (step && task && taskScenario(task) !== "steady") {
            renderTideCausalStep(step);
        }
    }

    function tideLaunchPhase(task, actualRequests) {
        if (state.loadtestTaskId && !state.loadtestTask) {
            return "recovering";
        }
        if (state.loadtestCreateInFlight) {
            return "creating";
        }
        if (state.loadtestStartRequested && !state.loadtestTaskId) {
            if (!state.labSceneReady) {
                return "arriving";
            }
            if (!state.metricsObservationReady) {
                return "observing";
            }
            return "creating";
        }
        var status = task && task.status || "draft";
        if (status === "starting" || status === "resetting") {
            return "locked";
        }
        if (status === "running") {
            return Number(actualRequests || 0) > 0 ? "running" : "armed";
        }
        if (status === "collecting") {
            return "collecting";
        }
        if (status === "completed") {
            return "completed";
        }
        if (status === "failed" || status === "stopped") {
            return "stopped";
        }
        return "planned";
    }

    function renderQueryTideStage(task) {
        var stage = byId("query-tide-stage");
        if (!isCrowdEntry()) {
            stage.hidden = true;
            return;
        }
        stage.hidden = false;
        var metrics = task && task.metrics || {};
        var status = task && task.status || "draft";
        var isRunning = status === "running";
        var actualRequests = Number(metrics.actualRequests || 0);
        var hasObservedRequests = actualRequests > 0;
        stage.dataset.launchPhase = tideLaunchPhase(task, actualRequests);
        var completion = taskCompletionRate(task);
        var elapsed = Number(task && task.elapsedSeconds || 0);
        var overloaded = (status === "completed" || (isRunning && elapsed >= 3)) &&
            completion < 90;
        var failed = status === "failed" || status === "stopped";
        var flowState = failed ? "failed" :
            (overloaded ? "backlogged" :
                (status === "completed" ? "completed" :
                    (isRunning ? (hasObservedRequests ? "flowing" : "armed") :
                        (status === "collecting" ? "collecting" :
                            (status === "starting" || status === "resetting" ? "starting" : "waiting")))));
        stage.dataset.flowState = flowState;
        var newProtocol = task &&
            (task.connectionMode === "auto" || task.connectionMode === "manual");
        var socketErrorsAvailable = Boolean(newProtocol && status === "completed");
        var socketErrors = Number(metrics.socketErrors || 0);
        stage.dataset.faultLayer = socketErrorsAvailable && socketErrors > 0 ? "connections" :
            (status === "completed" && Number(metrics.errorRate || 0) > 0 ? "response" : "none");
        byId("tide-backlog-node").classList.toggle("is-backlogged", overloaded);
        byId("tide-target-rate").textContent =
            taskTargetRate(task).toLocaleString("zh-CN") + " req/s";
        var resolvedConnections = Number(task && task.tier && task.tier.connections || 0);
        var plan = matchingLabConnectionPlan();
        var plannedConnections = selectedConnectionMode() === "manual" ? manualConnections :
            Number(task && task.plannedConnections ||
                plan && plan.connections ||
                state.pendingRun && state.pendingRun.plannedConnections || 0);
        var plannedConduitCount = plannedConnections > 0 ?
            Math.max(1, Math.ceil(Math.min(500, plannedConnections) / 500 * 8)) : 0;
        var resolvedConduitCount = resolvedConnections > 0 ?
            Math.max(1, Math.ceil(Math.min(500, resolvedConnections) / 500 * 8)) : 0;
        Array.prototype.forEach.call(
            document.querySelectorAll(".tide-conduit-bank i"),
            function (conduit, index) {
                conduit.classList.toggle("is-planned", index < plannedConduitCount);
                conduit.classList.toggle("is-configured", index < resolvedConduitCount);
            });
        stage.dataset.conduitLevel = String(resolvedConduitCount || plannedConduitCount);
        stage.dataset.resolvedConduitLevel = String(resolvedConduitCount);
        byId("tide-conduit-count").textContent = resolvedConnections > 0 ?
            "-c " + resolvedConnections.toLocaleString("zh-CN") + " · 已锁定" :
            (plannedConnections > 0 ?
                "-c " + plannedConnections.toLocaleString("zh-CN") + " · 计划" : "计划计算中");
        var cached = task ? task.mode === "cached" : currentExperiment().mode === "cached";
        var planConnections = resolvedConnections || plannedConnections;
        byId("tide-plan-token-copy").textContent =
            taskTargetRate(task).toLocaleString("zh-CN") + " req/s · " +
            (planConnections > 0 ?
                "-c " + planConnections.toLocaleString("zh-CN") :
                "自动 -c 待锁定") + " · " + (cached ? "CACHE" : "DIRECT");
        stage.dataset.backendMode = cached ? "cached" : "direct";
        var cacheBridge = document.querySelector(".tide-cache-bridge");
        if (cached && cacheBridge && !cacheBridge.hasAttribute("data-gate-mode")) {
            resetTideCacheBridge();
        }
        stage.dataset.cacheFallbackObserved =
            cached && Number(metrics.mysqlFallbacks || 0) > 0 ? "true" : "false";
        byId("tide-kitchen-title").textContent = taskScenario(task) === "penetration" ?
            (task && task.protection === "negative-cache" ?
                "正常 Key MISS · 负缓存拦截" : "正常 Key MISS · MySQL 确认不存在") :
            (cached ? "Redis 命中返回 · MISS 下探 MySQL" : "MySQL 直读");
        var requestP95 = Number(metrics.requestP95Ms || 0);
        byId("tide-occupancy-copy").textContent = requestP95 > 0 ?
            "请求 P95 · " + formatLoadtestLatency(requestP95) :
            "连接占用时间等待实测";
        var actualQPS = Number(metrics.actualQps || 0);
        observeTideTrace(task);
        var responseObserved = state.tideTrace.responseEvidence;
        byId("tide-response-rate").textContent = status === "completed" ?
            actualQPS.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + " req/s · 最终" :
            (status === "collecting" ? "正在结算" :
                (responseObserved ? "完成样本已观察" : "等待完成样本"));
        byId("tide-response-copy").textContent = status === "completed" ?
            "本轮完成速率已经冻结" :
            (responseObserved ? "紫色卷轴沿原连接回流" :
                (isRunning ? "处理完成后沿原连接返回" : "通路尚未承载请求"));

        if (failed) {
            byId("query-tide-badge").textContent = status === "stopped" ? "已停止" : "执行失败";
            byId("tide-backlog-title").textContent = "通路入口";
            byId("tide-backlog-copy").textContent = "通路已经停止";
            byId("query-tide-explanation").textContent =
                "本轮任务没有形成有效结算；入口动画已停止，请从关键事件查看原因。";
            return;
        }
        if (overloaded) {
            byId("query-tide-badge").textContent = "目标未跟上";
            byId("tide-backlog-title").textContent = "通路入口";
            byId("tide-backlog-copy").textContent =
                "投递欠账 · 完成率 " + formatCompletionRate(completion);
            byId("query-tide-explanation").textContent =
                "查询卷轴产生速度超过当前通路的周转能力，部分卷轴未能按计划及时投递。";
            restoreTideCausalStep(task);
            return;
        }
        byId("tide-backlog-title").textContent = "待发卷轴";
        byId("tide-backlog-copy").textContent = isRunning ?
            (hasObservedRequests ? "卷轴正在通过连接通路" : "卷轴就绪 · 等待首个样本") :
            (status === "completed" ? "本轮投递已经完成" : "等待卷轴投递");
        if (status === "collecting") {
            byId("query-tide-badge").textContent = "正在结算";
            byId("tide-backlog-copy").textContent = "已停止产生新请求";
            byId("query-tide-explanation").textContent =
                "Runner 已停止发送请求，正在整理实际速率、延迟与连接错误。";
            restoreTideCausalStep(task);
            return;
        }
        if (status === "completed") {
            byId("query-tide-badge").textContent = "结算完成";
            if (taskScenario(task) === "breakdown") {
                byId("query-tide-explanation").textContent =
                    "热点 Key 的删除、回源、重建与稳定恢复已经由任务指标闭合。";
            } else if (taskScenario(task) === "penetration") {
                byId("query-tide-explanation").textContent =
                    "不存在请求、负缓存命中与无效 MySQL 查询已经分别结算。";
            } else {
                byId("query-tide-explanation").textContent = cached ?
                    "缓存命中缩短了通路占用时间，相同数量的魔法通路能够完成更多查询。" :
                    "本轮请求已经完成，目标速率与实际完成速率可直接对照。";
            }
        } else if (isRunning && !hasObservedRequests) {
            byId("query-tide-badge").textContent = "通路已启用";
            byId("query-tide-explanation").textContent =
                "wrk2 已按锁定配置启动；等待应用入口观察到首个真实请求样本。";
        } else if (isRunning) {
            byId("query-tide-badge").textContent = "请求已进入系统";
            byId("query-tide-explanation").textContent =
                "蓝色请求经连接进入 Go API 与后端；紫色响应沿同一连接返回 Runner。";
        } else if (status === "starting" || status === "resetting") {
            byId("query-tide-badge").textContent =
                status === "starting" ? "连接配置已锁定" : "正在重置数据";
            byId("tide-backlog-copy").textContent =
                status === "starting" ? "最终 -c 已确认 · 通路待启用" : "wrk2 尚未启动";
            byId("query-tide-explanation").textContent = status === "starting" ?
                "门阵列按 Runner 返回的最终 -c 标出运行配置；此时仍没有 HTTP 请求。" :
                "Runner 正在清空缓存与指标；门阵列只是锁定配置，尚未发送 HTTP 请求。";
        } else if (status === "waiting") {
            byId("query-tide-badge").textContent = "观测准备中";
            byId("tide-backlog-copy").textContent = "Runner 尚未创建";
            byId("query-tide-explanation").textContent =
                "店内正在建立指标观测；准备完成前不会启用连接，也不会发送真实请求。";
        } else {
            byId("query-tide-badge").textContent = "尚未启动";
            byId("query-tide-explanation").textContent =
                "创建任务后，Runner 会按锁定的 -c 启动连接配置，再按目标速率发送请求。";
        }
        restoreTideCausalStep(task);
    }

    function renderLoadtestTask(task) {
        if (!task) {
            return;
        }
        var previousStatus = state.loadtestTask && state.loadtestTask.status;
        task = mergeLoadtestTask(state.loadtestTask, task);
        state.loadtestTask = task;
        state.scenario = taskScenario(task);
        if (state.scenario === "penetration") {
            state.protection = task.protection === "negative-cache" ? "negative-cache" : "none";
        }
        if (task.tier && task.tier.rate) {
            crowdTierID = crowdTierForRate(task.tier.rate) || crowdTierID;
        }
        if (task.connectionMode === "manual") {
            connectionMode = "manual";
            manualConnections = Number(task.requestedConnections || task.tier && task.tier.connections ||
                manualConnections);
        } else if (task.connectionMode === "auto") {
            connectionMode = "auto";
        }
        renderCrowdSetup();
        renderScenarioControls(task);
        if (loadtestIsActive(task)) {
            state.loadtestLastActiveStatus = task.status;
            try {
                window.localStorage.setItem(ACTIVE_TASK_KEY, task.taskId);
            } catch (_) {
                // URL、pending run 与任务 GET 仍可恢复当前页面。
            }
        } else if (["completed", "failed", "stopped"].indexOf(task.status) >= 0) {
            try {
                if (window.localStorage.getItem(ACTIVE_TASK_KEY) === task.taskId) {
                    window.localStorage.removeItem(ACTIVE_TASK_KEY);
                }
            } catch (_) {
                // 本地键仅用于跨页面发现，不影响 Runner 权威状态。
            }
        }
        var panel = byId("lab-loadtest");
        var copy = loadtestStatusCopy(task.status);
        var metrics = task.metrics || {};
        var duration = Number(task.tier && task.tier.durationSeconds || 30);
        panel.hidden = false;
        panel.dataset.status = task.status || "starting";
        byId("lab-loadtest-title").textContent = copy[0];
        var resolvedConnections = Number(task.tier && task.tier.connections || 0);
        byId("lab-loadtest-copy").textContent = task.errorMessage || copy[1];
        byId("request-status").textContent = copy[0];
        var replayStatus = "SSE 正在接收任务状态";
        if (task.status === "running") {
            replayStatus = "SSE 正在接收真实请求";
        } else if (task.status === "collecting") {
            replayStatus = "卷轴投递已停止，正在结算";
        } else if (task.status === "completed") {
            replayStatus = "查询潮汐结算完成";
        } else if (task.status === "failed" || task.status === "stopped") {
            replayStatus = "查询潮汐已结束";
        }
        byId("replay-status").textContent = replayStatus;
        byId("lab-loadtest-clock").textContent = formatLoadtestClock(task.elapsedSeconds) + " / " + formatLoadtestClock(duration);
        byId("lab-stop-loadtest").hidden = !loadtestIsActive(task);
        byId("lab-stop-loadtest").disabled = false;
        byId("lab-stop-loadtest").textContent = "停止实验";
        var hasObservedRequests = Number(metrics.actualRequests || 0) > 0;
        var hasObservedSample = hasObservedRequests || task.status === "completed" ||
            (Number(task.elapsedSeconds || 0) > 0 &&
                ["running", "collecting", "failed", "stopped"].indexOf(task.status) >= 0);
        byId("lab-load-path").textContent = taskScenario(task) === "breakdown" ?
            "热点失效 · 旁路缓存" :
            (taskScenario(task) === "penetration" ?
                "不存在 ID · " + (task.protection === "negative-cache" ? "负缓存" : "无保护") :
                (task.mode === "cached" ? "Redis 旁路缓存" : "MySQL 直接查询"));
        byId("lab-load-target").textContent = taskTargetRate(task).toLocaleString("zh-CN") + " req/s";
        byId("lab-load-requests").textContent = hasObservedSample ?
            formatNumber(metrics.actualRequests) : "—";
        byId("lab-load-qps").textContent = hasObservedSample ?
            Number(metrics.actualQps || 0).toLocaleString("zh-CN",
                { maximumFractionDigits: 1 }) + " req/s" : "等待首个采样";
        byId("lab-load-completion").textContent = hasObservedSample ?
            formatCompletionRate(taskCompletionRate(task)) : "等待首个采样";
        byId("lab-load-connections").textContent = resolvedConnections > 0 ?
            "-c " + formatNumber(resolvedConnections) +
                (task.connectionMode === "manual" ? " · 手动 · 已锁定" :
                    (task.connectionMode === "auto" ? " · 自动 · 已锁定" : " · 旧配置")) :
            "Runner 决定中";
        var runnerStates = {
            starting: "任务已创建",
            resetting: "正在重置数据",
            running: "运行中",
            collecting: "正在结算",
            completed: "已完成",
            failed: "执行失败",
            stopped: "已停止"
        };
        byId("lab-load-runner-state").textContent =
            runnerStates[task.status] || "状态同步中";
        byId("lab-load-request-p50").textContent = formatLoadtestLatency(metrics.requestP50Ms);
        byId("lab-load-request-p95").textContent = formatLoadtestLatency(metrics.requestP95Ms);
        byId("lab-load-p50").textContent = formatLoadtestLatency(metrics.p50Ms);
        byId("lab-load-p95").textContent = formatLoadtestLatency(metrics.p95Ms);
        byId("lab-load-errors").textContent = hasObservedSample ?
            Number(metrics.errorRate || 0).toFixed(2) + "%" : "—";
        var socketMetricsSupported =
            task.connectionMode === "auto" || task.connectionMode === "manual";
        byId("lab-load-timeouts").textContent = task.status === "completed" ?
            (socketMetricsSupported ? formatNumber(metrics.socketErrors) : "本轮未采集") :
            ((task.status === "failed" || task.status === "stopped") ?
                "未形成完整结算" :
                (task.status === "collecting" ? "正在结算" : "结算后可见"));
        byId("lab-load-hits").textContent = hasObservedSample ?
            formatNumber(metrics.redisHits) : "—";
        byId("lab-load-fallbacks").textContent = hasObservedSample ?
            formatNumber(metrics.mysqlFallbacks) : "—";
        renderLoadtestStages(task);
        renderLoadtestLogs(task.logs);
        renderQueryTideStage(task);
        renderScenarioObservation(task);

        var selected = currentExperiment();
        if (selected.mode !== task.mode || selected.cacheTemperature !== "cold") {
            experimentState.set({ mode: task.mode, cacheTemperature: "cold" });
        }
        updateControlState();

        if (task.status === "completed") {
            // SSE 的 completed 事件只带增量字段；必须等 GET 返回完整 Task 后再冻结结果。
            if (task.endedAt && task.tier) {
                if (taskScenario(task) === "steady") {
                    freezeLoadtestResult(task);
                    renderCrowdConversion(task);
                    loadCrowdMaterialRecord(task);
                } else {
                    freezeScenarioResult(task);
                }
                stopLoadtestConnections();
            }
            if (previousStatus !== task.status) {
                refreshLabConnectionPlan();
            }
        } else if (task.status === "failed" || task.status === "stopped") {
            experimentResults.clearPending();
            state.pendingRun = null;
            byId("freeze-status").textContent = task.status === "failed" ? "本轮压测失败 · 未冻结结果" : "本轮压测已停止 · 未冻结结果";
            if (previousStatus !== task.status) {
                showToast(task.errorMessage || (task.status === "failed" ? "压测执行失败。" : "压测已停止。"), task.status === "failed" ? "danger" : "");
                refreshLabConnectionPlan();
            }
            stopLoadtestConnections();
        }
    }

    async function fetchLoadtestTask() {
        if (!state.loadtestTaskId) {
            return;
        }
        try {
            var result = await requestJSON("/api/loadtests/" + encodeURIComponent(state.loadtestTaskId));
            renderLoadtestTask(result.body);
        } catch (error) {
            if (error.status === 404) {
                var missingTaskID = state.loadtestTaskId;
                stopLoadtestConnections();
                state.loadtestTaskId = "";
                state.loadtestTask = null;
                if (state.pendingRun && state.pendingRun.taskId === missingTaskID) {
                    experimentResults.clearPending();
                    state.pendingRun = null;
                }
                try {
                    if (window.localStorage.getItem(ACTIVE_TASK_KEY) === missingTaskID) {
                        window.localStorage.removeItem(ACTIVE_TASK_KEY);
                    }
                } catch (_) {
                    // 清理发现键失败不影响页面重新创建任务。
                }
                byId("lab-loadtest").hidden = false;
                byId("lab-loadtest-title").textContent = "任务已不存在";
                byId("lab-loadtest-copy").textContent = "Runner 未找到该任务，请返回店外重新配置。";
                byId("lab-load-runner-state").textContent = "任务不存在";
                renderLoadtestStages({ status: "draft" });
                renderQueryTideStage({ status: "waiting", metrics: {} });
                updateControlState();
                return;
            }
            byId("lab-loadtest").hidden = false;
            byId("lab-loadtest-title").textContent = "正在恢复实验连接";
            byId("lab-loadtest-copy").textContent = error.message;
        }
    }

    function loadtestTaskSeed(taskID) {
        var pending = state.pendingRun || {};
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        return {
            taskId: taskID,
            status: "starting",
            experiment: pending.experiment || selectedLoadtestExperiment(),
            protection: pending.protection || selectedProtection(),
            mode: pending.mode || currentExperiment().mode,
            connectionMode: pending.connectionMode || selectedConnectionMode(),
            connectionReason: pending.connectionReason || "",
            requestedConnections: Number(pending.requestedConnections || 0),
            elapsedSeconds: 0,
            remainingSeconds: Number(pending.expectedDurationSeconds || tier.duration),
            metrics: {},
            logs: [],
            tier: {
                id: pending.tier || crowdTierID,
                label: tier.label,
                rate: Number(pending.expectedRate || tier.rate),
                connections: Number(pending.connections || 0),
                durationSeconds: Number(pending.expectedDurationSeconds || tier.duration)
            }
        };
    }

    async function connectLoadtestTask(taskID) {
        stopLoadtestConnections();
        state.loadtestTaskId = taskID;
        byId("lab-loadtest").hidden = false;
        renderCrowdSetup();
        await fetchLoadtestTask();
        if (state.loadtestTaskId !== taskID) {
            return;
        }
        if (state.loadtestTask &&
            ["completed", "failed", "stopped"].indexOf(state.loadtestTask.status) >= 0) {
            return;
        }
        state.loadtestPollTimer = window.setInterval(fetchLoadtestTask, 1500);
        if (!window.EventSource) {
            return;
        }
        state.loadtestStream = new EventSource("/api/loadtests/" + encodeURIComponent(taskID) + "/events");
        ["task_started", "reset_completed", "loadtest_started", "progress", "metric", "log",
            "cache_evicted", "cache_rebuilt", "cache_recovered",
            "completed", "failed", "stopped"].forEach(function (eventName) {
            state.loadtestStream.addEventListener(eventName, function (event) {
                try {
                    var update = JSON.parse(event.data);
                    var current = state.loadtestTask || loadtestTaskSeed(taskID);
                    // 必须先消费终态因果事件；renderLoadtestTask 可能关闭已经终态的 SSE。
                    ingestTideCausalEvent(eventName, update, current);
                    renderLoadtestTask(Object.assign({}, current, {
                        status: update.status || current.status,
                        elapsedSeconds: update.elapsedSeconds,
                        remainingSeconds: update.remainingSeconds,
                        metrics: update.metrics || current.metrics
                    }));
                    if (["log", "reset_completed", "loadtest_started", "cache_evicted", "cache_rebuilt",
                        "cache_recovered", "completed", "failed", "stopped"].indexOf(eventName) >= 0) {
                        fetchLoadtestTask();
                    }
                } catch (_) {
                    fetchLoadtestTask();
                }
            });
        });
        state.loadtestStream.onerror = function () {
            fetchLoadtestTask();
        };
    }

    function renderLoadtestReadiness() {
        if (isCrowdEntry() && !state.loadtestTaskId) {
            renderCrowdSetup();
            updateControlState();
        }
    }

    function maybeStartCrowdTest() {
        if (!state.loadtestStartRequested || state.loadtestCreateInFlight ||
            state.loadtestTaskId || loadtestIsActive(state.loadtestTask) ||
            !state.labSceneReady || !state.metricsObservationReady ||
            document.visibilityState !== "visible") {
            renderLoadtestReadiness();
            return;
        }
        startCrowdTest();
    }

    function requestCrowdTestStart() {
        if (!state.labSceneReady || !state.metricsObservationReady) {
            renderLoadtestReadiness();
            return;
        }
        if (state.loadtestTask &&
            ["completed", "failed", "stopped"].indexOf(state.loadtestTask.status) >= 0) {
            stopLoadtestConnections();
            state.loadtestTaskId = "";
            state.loadtestTask = null;
            state.loadtestLastActiveStatus = "starting";
        }
        state.loadtestStartRequested = true;
        renderLoadtestReadiness();
        maybeStartCrowdTest();
    }

    function markLabSceneReady() {
        if (document.visibilityState !== "visible") {
            return;
        }
        if (state.labSceneReady) {
            renderLoadtestReadiness();
            return;
        }
        // requestAnimationFrame 只确认当前 DOM 已获得一次可见绘制机会，不参与压测计时。
        window.requestAnimationFrame(function () {
            if (document.visibilityState !== "visible") {
                return;
            }
            state.labSceneReady = true;
            renderLoadtestReadiness();
        });
    }

    function markMetricsObservationReady() {
        if (!state.metricsObservationReady) {
            state.metricsObservationReady = true;
            renderLoadtestReadiness();
        }
    }

    async function startCrowdTest() {
        if (!state.loadtestStartRequested || state.loadtestCreateInFlight ||
            state.loadtestTaskId || loadtestIsActive(state.loadtestTask) ||
            !state.labSceneReady || !state.metricsObservationReady ||
            document.visibilityState !== "visible") {
            renderLoadtestReadiness();
            return;
        }
        if (state.loadtestTask && state.loadtestTask.tier &&
            !crowdTierForRate(state.loadtestTask.tier.rate)) {
            window.location.href = "/material-shop";
            return;
        }
        var experiment = currentExperiment();
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        var loadtestExperiment = selectedLoadtestExperiment();
        var effectiveConnectionMode = selectedConnectionMode();
        var button = byId("query-archive");
        state.loadtestCreateInFlight = true;
        renderLoadtestReadiness();
        button.disabled = true;
        button.querySelector("span").textContent = "正在创建 Runner 任务";
        try {
            if (experiment.cacheTemperature !== "cold") {
                experiment = experimentState.set({ cacheTemperature: "cold" });
            }
            var result = await requestJSON("/api/loadtests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    experiment: loadtestExperiment,
                    archiveId: state.id,
                    mode: experiment.mode,
                    rate: tier.rate,
                    connectionMode: effectiveConnectionMode,
                    connections: effectiveConnectionMode === "manual" ? manualConnections : 0,
                    protection: selectedProtection()
                })
            });
            var created = result.body;
            var finalConnectionMode = created.connectionMode || effectiveConnectionMode;
            var finalConnections = Number(created.connections || 0);
            var finalConnectionReason = created.connectionReason || "";
            var pending = {
                taskId: created.taskId,
                entry: "crowd",
                launchWhenObserved: false,
                materialName: state.profile.name,
                experiment: loadtestExperiment,
                protection: selectedProtection(),
                mode: experiment.mode,
                cacheTemperature: "cold",
                tier: crowdTierID,
                expectedRate: tier.rate,
                expectedDurationSeconds: tier.duration,
                connectionMode: finalConnectionMode,
                connectionReason: finalConnectionReason,
                plannedConnections: Number(state.pendingRun &&
                    state.pendingRun.plannedConnections || finalConnections),
                connections: finalConnections,
                requestedConnections: effectiveConnectionMode === "manual" ? manualConnections : 0,
                armedAt: new Date().toISOString()
            };
            experimentResults.arm(pending);
            state.pendingRun = pending;
            state.entry = "crowd";
            state.loadtestTaskId = created.taskId;
            state.loadtestStartRequested = false;
            state.loadtestResultSaved = false;
            state.loadtestRecordLoaded = false;
            document.body.dataset.entryMode = "crowd";
            var nextURL = new URL(window.location.href);
            nextURL.searchParams.set("entry", "crowd");
            nextURL.searchParams.set("task", created.taskId);
            nextURL.searchParams.set("rate", String(tier.rate));
            nextURL.searchParams.set("connectionMode", effectiveConnectionMode);
            if (state.scenario !== "steady") {
                nextURL.searchParams.set("scenario", state.scenario);
            }
            if (state.scenario === "penetration") {
                nextURL.searchParams.set("protection", state.protection);
            }
            if (effectiveConnectionMode === "manual") {
                nextURL.searchParams.set("connections", String(manualConnections));
            } else {
                nextURL.searchParams.delete("connections");
            }
            window.history.replaceState(null, "", nextURL.toString());
            state.loadtestTask = null;
            renderLoadtestTask({
                taskId: created.taskId,
                status: created.status || "starting",
                experiment: loadtestExperiment,
                protection: selectedProtection(),
                mode: experiment.mode,
                connectionMode: finalConnectionMode,
                connectionReason: finalConnectionReason,
                requestedConnections: effectiveConnectionMode === "manual" ? manualConnections : 0,
                elapsedSeconds: 0,
                metrics: {},
                logs: [{ level: "info", message: "准备实验" }],
                tier: {
                    id: crowdTierID,
                    label: tier.label,
                    rate: tier.rate,
                    connections: finalConnections,
                    durationSeconds: tier.duration
                }
            });
            connectLoadtestTask(created.taskId);
            showToast("Runner 任务已创建，最终 -c 已锁定，正在准备运行。", "success");
        } catch (error) {
            state.loadtestStartRequested = false;
            showToast(error.message, "danger");
            updateControlState();
        } finally {
            state.loadtestCreateInFlight = false;
            renderLoadtestReadiness();
        }
    }

    async function stopLoadtest() {
        if (!loadtestIsActive(state.loadtestTask) || !state.loadtestTaskId) {
            return;
        }
        var button = byId("lab-stop-loadtest");
        button.disabled = true;
        button.textContent = "正在停止";
        try {
            var result = await requestJSON("/api/loadtests/" + encodeURIComponent(state.loadtestTaskId) + "/stop", { method: "POST" });
            renderLoadtestTask(result.body);
        } catch (error) {
            button.disabled = false;
            button.textContent = "停止实验";
            showToast(error.message, "danger");
        }
    }

    function freezeSingleResult(source, latency, sqlQueries) {
        var experiment = currentExperiment();
        var cached = experiment.mode === "cached";
        var hitRate = cached ? (source === "redis-hit" ? 100 : (source === "redis-miss" ? 0 : null)) : null;
        var currentPath = state.snapshot && (cached ? state.snapshot.cached : state.snapshot.direct);
        completeResult({
            entry: "single",
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
        // 新版 Runner 任务使用任务自身的权威指标冻结结果，不能再与全局 SSE 差值重复计数。
        if (state.loadtestTaskId || state.entry !== "crowd" || !state.pendingRun) {
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
        var durationSeconds = Math.max(1, Number(state.pendingRun.expectedDurationSeconds || 30));
        if (requests <= 0) {
            return;
        }
        completeResult({
            entry: "crowd",
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
            formatNumber(body.tradeStats.transactions24h) + " 笔 · 7d 均价 " + formatNumber(body.tradeStats.averagePrice7d) +
            " · 最高 " + formatNumber(body.tradeStats.maxPrice7d) : "—";
        byId("record-rating").textContent = body.rating ?
            Number(body.rating.score || 0).toFixed(2) + " / 5 · " + formatNumber(body.rating.count) + " 条" : "—";
        byId("record-source").textContent = sourceLabel(source);
        byId("record-latency").textContent = latency.toFixed(1) + " ms";
    }

    function renderCrowdConversion(task) {
        var completedRequests = Number(task && task.metrics && task.metrics.actualRequests || 0);
        if (!completedRequests) {
            return;
        }
        state.crowdHandoff = {
            taskId: task.taskId
        };
        byId("crowd-conversion").hidden = false;
        byId("crowd-spread-title").textContent = state.profile.name + "的查询卷轴已经完成归档。";
        byId("crowd-scroll-count").textContent = formatNumber(completedRequests);
        byId("crowd-actual-rate").textContent =
            Number(task.metrics.actualQps || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " QPS";
        byId("purchase-entry").textContent = "查看购买实验详情";
        byId("purchase-entry-note").textContent =
            "先回到详情页了解两条失效路径，再进入实验室选择本轮方案；购买实验固定发出 150 个唯一请求。";
    }

    async function loadCrowdMaterialRecord(task) {
        if (state.loadtestRecordLoaded || !task || task.status !== "completed") {
            return;
        }
        state.loadtestRecordLoaded = true;
        var path = task.mode === "cached" ? "cached" : "direct";
        var started = window.performance.now();
        try {
            var result = await requestJSON("/api/archives/" + state.id + "/" + path);
            var latency = window.performance.now() - started;
            var source = result.response.headers.get("X-Archive-Source") || "unknown";
            renderRecord(result.body, source, latency);
            byId("request-status").textContent = "查询潮汐完成，材料资料已归档";
            setQueryMetric("actual-latency", latency, " ms", 1);
            setQueryMetric("actual-source", source);
            setQueryVerdict(queryVerdict(source, latency));
        } catch (error) {
            state.loadtestRecordLoaded = false;
            byId("request-status").textContent = "压测完成，但材料资料回填失败";
            setQueryVerdict("掌柜点评：查询潮汐完成了，但材料档案没有成功回填，先保留这次错误证据。");
            showToast(error.message, "danger");
        }
    }

    function enterPurchaseLab() {
        if (!state.lastResponse || !state.profile) {
            showToast("请先完成一次真实材料查询。", "danger");
            return;
        }
        window.location.href = "/material-shop?experiment=purchase";
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
        setQueryMetric("actual-latency", "等待响应");
        setQueryMetric("actual-source", "等待响应头");
        byId("replay-status").textContent = "响应到达后开始";
        setRouteProgress(0, 0);
        setQueryVerdict("掌柜点评：请求已经出发，先等真实响应头回来，再决定该点亮哪条路。");
        var experiment = currentExperiment();
        var path = experiment.mode === "cached" ? "cached" : "direct";
        var started = null;

        try {
            if (experiment.mode === "cached" && experiment.cacheTemperature === "cold") {
                byId("request-status").textContent = "正在准备冷缓存：清除档案缓存与本章指标";
                setQueryMetric("actual-latency", "尚未发起");
                setQueryVerdict("掌柜点评：先把缓存窗口清空，这样第一份档案会诚实暴露一次 MISS。");
                await prepareColdCache();
                byId("request-status").textContent = "冷缓存已准备，真实 HTTP 请求已发送";
                setQueryMetric("actual-latency", "等待响应");
            }
            started = window.performance.now();
            var result = await requestJSON("/api/archives/" + state.id + "/" + path);
            var latency = window.performance.now() - started;
            var source = result.response.headers.get("X-Archive-Source") || "unknown";
            var sqlQueries = Number(result.response.headers.get("X-SQL-Queries") || 0);
            state.isRequesting = false;
            byId("request-status").textContent = "响应已接收并保存";
            setQueryMetric("actual-latency", latency, " ms", 1);
            setQueryMetric("actual-source", source);
            setQueryVerdict("掌柜点评：真实响应已经到手，正在按 " + source + " 把路径逐格结算。");
            renderRecord(result.body, source, latency);
            if (state.entry === "single") {
                freezeSingleResult(source, latency, sqlQueries);
            }
            playRoute(source, "manual");
        } catch (error) {
            state.isRequesting = false;
            byId("request-status").textContent = started ? "真实请求失败" : "冷缓存准备失败，材料请求未发出";
            if (started) {
                setQueryMetric("actual-latency", window.performance.now() - started, " ms", 1);
            } else {
                setQueryMetric("actual-latency", "—");
            }
            setQueryMetric("actual-source", "ERROR");
            byId("replay-status").textContent = "没有成功路径可回放";
            setRouteProgress(0, 0);
            setQueryVerdict("掌柜点评：这次查询没有成功返回，舞台停在错误证据上，不伪造后续路径。");
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
        setQueryMetric(id, value, suffix || "", 0);
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
        if (cached) {
            setQueryMetric("active-hit-rate", path.cacheHitRate, "%", 0);
        } else {
            setQueryMetric("active-hit-rate", "—");
        }
        setMetric("active-errors", path.errors);
        byId("mysql-pool-live").textContent = "POOL " + formatNumber(path.poolPeak) + " / " + formatNumber(path.poolCapacity);
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
        byId("redis-ttl").textContent = "TTL " + formatNumber(chapter.cacheTTLSeconds || 300) + "s";
        byId("metrics-timestamp").textContent = chapter.at ? new Date(chapter.at).toLocaleTimeString("zh-CN", { hour12: false }) : "LIVE";
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
        if (state.loadtestTask) {
            observeTideTrace(state.loadtestTask);
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
            if (!window.EventSource) {
                // 不支持 SSE 时，以成功快照加持续轮询作为观测就绪事实。
                setConnection(true);
                markMetricsObservationReady();
            }
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
                // 服务端在 SSE 建立后立即发送权威快照；收到它才说明持续观测链路可用。
                markMetricsObservationReady();
            } catch (_) {
                setConnection(false);
            }
        });
        state.stream.onerror = function () {
            setConnection(false);
            var now = Date.now();
            if (now - state.metricsSnapshotRecoveryAt >= 1000) {
                state.metricsSnapshotRecoveryAt = now;
                fetchSnapshot();
            }
        };
    }

    async function resetLab() {
        if (loadtestIsActive(state.loadtestTask)) {
            showToast("查询潮汐实验进行中，不能单独重置店内数据。", "danger");
            return;
        }
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
            byId("route-title").textContent = "等待读取器启动";
            byId("route-events").innerHTML = "<li><span>READY</span><strong>等待真实响应头</strong><small>不会根据所选模式猜测结果</small></li>";
            byId("record-placeholder").hidden = false;
            byId("record-result").hidden = true;
            byId("crowd-conversion").hidden = true;
            state.crowdHandoff = null;
            state.loadtestRecordLoaded = false;
            byId("request-status").textContent = "等待发起真实请求";
            setQueryMetric("actual-latency", "—");
            setQueryMetric("actual-source", "—");
            byId("replay-status").textContent = "尚未开始";
            setRouteProgress(0, 0);
            setQueryVerdict("掌柜点评：缓存与指标已经归零，下一次查询会从干净的实验起点出发。");
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
        if (loadtestIsActive(state.loadtestTask)) {
            showToast("查询潮汐实验进行中，结束或停止后再清空对比。", "danger");
            return;
        }
        Array.prototype.forEach.call(document.querySelectorAll("[data-clear-comparison]"), function (button) {
            button.disabled = true;
        });
        experimentResults.clear();
        state.pendingRun = null;
        state.crowdRun = null;
        state.previousRead = null;
        resetMetricsHistory();
        renderFrozenResults();
        renderScenarioComparison(state.scenario);
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
            updateControlState();
        }
    }

    function showDataComposition() {
        var dialog = byId("data-composition-dialog");
        if (typeof dialog.showModal === "function") {
            if (!dialog.open) {
                dialog.showModal();
            }
            return;
        }
        dialog.setAttribute("open", "");
    }

    function closeDataComposition() {
        var dialog = byId("data-composition-dialog");
        if (typeof dialog.close === "function") {
            dialog.close();
            return;
        }
        dialog.removeAttribute("open");
    }

    function updateScenarioURL() {
        var url = new URL(window.location.href);
        if (state.scenario === "steady") {
            url.searchParams.delete("scenario");
            url.searchParams.delete("protection");
        } else {
            url.searchParams.set("entry", "crowd-setup");
            url.searchParams.set("mode", "cached");
            url.searchParams.set("scenario", state.scenario);
            if (state.scenario === "penetration") {
                url.searchParams.set("protection", state.protection);
            } else {
                url.searchParams.delete("protection");
            }
            url.searchParams.delete("task");
            url.searchParams.delete("launch");
        }
        window.history.replaceState(null, "", url.toString());
    }

    function selectCacheScenario(scenario) {
        if (["steady", "breakdown", "penetration"].indexOf(scenario) < 0 ||
            loadtestIsActive(state.loadtestTask)) {
            return;
        }
        if (state.scenario !== scenario) {
            clearTideScenarioMotion();
        }
        state.scenario = scenario;
        state.loadtestStartRequested = false;
        if (scenario !== "steady") {
            state.entry = "crowd-setup";
            document.body.dataset.entryMode = "crowd-setup";
            connectionMode = "auto";
            if (currentExperiment().mode !== "cached" || currentExperiment().cacheTemperature !== "cold") {
                experimentState.set({ mode: "cached", cacheTemperature: "cold" });
            }
            experimentResults.clearPending();
            state.pendingRun = null;
        }
        updateScenarioURL();
        renderScenarioControls(state.loadtestTask);
        renderCrowdSetup();
        updateControlState();
        refreshLabConnectionPlan();
    }

    function selectPenetrationProtection(protection) {
        if (state.scenario !== "penetration" || loadtestIsActive(state.loadtestTask) ||
            (protection !== "none" && protection !== "negative-cache")) {
            return;
        }
        clearTideScenarioMotion();
        state.protection = protection;
        updateScenarioURL();
        renderScenarioControls(state.loadtestTask);
        renderCrowdSetup();
        refreshLabConnectionPlan();
    }

    function bindEvents() {
        byId("scenario-steady").addEventListener("click", function () { selectCacheScenario("steady"); });
        byId("scenario-breakdown").addEventListener("click", function () { selectCacheScenario("breakdown"); });
        byId("scenario-penetration").addEventListener("click", function () { selectCacheScenario("penetration"); });
        byId("protection-none").addEventListener("click", function () { selectPenetrationProtection("none"); });
        byId("protection-negative").addEventListener("click", function () { selectPenetrationProtection("negative-cache"); });
        byId("mode-direct").addEventListener("click", function () {
            experimentState.set({ mode: "direct" });
            var nextURL = new URL(window.location.href);
            nextURL.searchParams.set("mode", "direct");
            window.history.replaceState(null, "", nextURL.toString());
            refreshLabConnectionPlan();
        });
        byId("mode-cached").addEventListener("click", function () {
            experimentState.set({ mode: "cached" });
            var nextURL = new URL(window.location.href);
            nextURL.searchParams.set("mode", "cached");
            window.history.replaceState(null, "", nextURL.toString());
            refreshLabConnectionPlan();
        });
        Array.prototype.forEach.call(document.querySelectorAll("[name='lab-cache-temperature']"), function (radio) {
            radio.addEventListener("change", function () {
                if (radio.checked) {
                    experimentState.set({ cacheTemperature: radio.value });
                }
            });
        });
        byId("query-archive").addEventListener("click", function () {
            if (isCrowdEntry()) {
                requestCrowdTestStart();
            } else {
                readArchive();
            }
        });
        byId("reset-lab").addEventListener("click", resetLab);
        Array.prototype.forEach.call(document.querySelectorAll("[data-clear-comparison]"), function (button) {
            button.addEventListener("click", clearComparison);
        });
        byId("lab-stop-loadtest").addEventListener("click", stopLoadtest);
        byId("show-data-composition").addEventListener("click", showDataComposition);
        byId("close-data-composition").addEventListener("click", closeDataComposition);
        byId("data-composition-dialog").addEventListener("click", function (event) {
            var dialog = event.currentTarget;
            var bounds = dialog.getBoundingClientRect();
            var outside = event.clientX < bounds.left || event.clientX > bounds.right ||
                event.clientY < bounds.top || event.clientY > bounds.bottom;
            if (outside) {
                closeDataComposition();
            }
        });
        byId("replay-metrics").addEventListener("click", startMetricsReplay);
        byId("pause-metrics-replay").addEventListener("click", toggleMetricsReplayPause);
        byId("purchase-entry").addEventListener("click", enterPurchaseLab);
    }

    document.addEventListener("DOMContentLoaded", function () {
        if (!showLabContext(incomingMaterial())) {
            return;
        }
        bindEvents();
        var entry = incomingEntry();
        state.entry = entry;
        state.scenario = incomingCacheScenario();
        state.protection = incomingProtection();
        if (state.scenario !== "steady" && state.entry === "single") {
            state.entry = "crowd-setup";
        }
        var incomingConfig = incomingCrowdConfig();
        crowdTierID = incomingConfig.tierID;
        connectionMode = state.scenario === "steady" ? incomingConfig.connectionMode : "auto";
        manualConnections = incomingConfig.connections;
        var incomingMode = incomingCrowdMode();
        if (state.scenario !== "steady" && currentExperiment().mode !== "cached") {
            experimentState.set({ mode: "cached" });
        } else if (isCrowdEntry() && incomingMode &&
            currentExperiment().mode !== incomingMode) {
            experimentState.set({ mode: incomingMode });
        }
        if (isCrowdEntry() && currentExperiment().cacheTemperature !== "cold") {
            experimentState.set({ cacheTemperature: "cold" });
        }
        var pendingRun = entry === "crowd" ? experimentResults.pending() : null;
        if (!pendingRun && entry === "crowd" && incomingLaunchWhenObserved()) {
            var incomingTier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
            pendingRun = {
                taskId: "",
                entry: "crowd",
                launchWhenObserved: false,
                materialName: state.profile.name,
                mode: incomingMode || currentExperiment().mode,
                cacheTemperature: "cold",
                tier: crowdTierID,
                expectedRate: incomingTier.rate,
                expectedDurationSeconds: incomingTier.duration,
                connectionMode: connectionMode,
                plannedConnections: connectionMode === "manual" ? manualConnections : 0,
                requestedConnections: connectionMode === "manual" ? manualConnections : 0,
                armedAt: new Date().toISOString()
            };
            experimentResults.arm(pendingRun);
        }
        state.pendingRun = pendingRun && pendingRun.materialName === state.profile.name ? pendingRun : null;
        if (state.pendingRun && Number(state.pendingRun.plannedConnections || 0) > 0) {
            state.connectionPlan = {
                rate: Number(state.pendingRun.expectedRate || 0),
                connectionMode: state.pendingRun.connectionMode || connectionMode,
                connections: Number(state.pendingRun.plannedConnections || 0),
                reason: state.pendingRun.connectionReason || "",
                // 详情页的自动值只是共同条件预估；进入实验室后必须按所选路径重算。
                requestMode: state.pendingRun.sharedConditions ? "shared-preview" : state.pendingRun.mode,
                requestExperiment: state.pendingRun.experiment || "cache-aside-read",
                requestProtection: state.pendingRun.protection || ""
            };
        }
        state.loadtestTaskId = entry === "crowd" ? (incomingLoadtestTaskID() ||
            (state.pendingRun && state.pendingRun.taskId) || "") : "";
        // 详情页只把共同条件带入实验室；即使旧链接仍含 launch=when-observed，
        // 也必须等待用户在实验室明确点击开始按钮，不能自动创建 Runner 任务。
        state.loadtestStartRequested = false;
        document.body.dataset.entryMode = state.entry;
        renderExperimentState(currentExperiment());
        experimentState.subscribe(renderExperimentState);
        experimentResults.subscribe(function () {
            renderFrozenResults();
            renderScenarioComparison(state.scenario);
        });
        renderFrozenResults();
        renderScenarioComparison(state.scenario);
        resetRouteVisual();
        updateControlState();
        updateMetricsPlaybackControls();
        if (state.entry === "crowd") {
            byId("request-status").textContent = "正在连接查询潮汐实验";
            byId("replay-status").textContent = state.loadtestTaskId ?
                "正在恢复任务观测" : "正在建立店内指标观测 · 就绪后等待手动开始";
            if (state.loadtestTaskId) {
                connectLoadtestTask(state.loadtestTaskId);
            } else {
                renderLoadtestReadiness();
                if (!matchingLabConnectionPlan()) {
                    refreshLabConnectionPlan();
                }
            }
        } else if (state.entry === "crowd-setup") {
            byId("request-status").textContent = "查询潮汐与通路模式已锁定，选择读取路径";
            byId("replay-status").textContent = "等待启动实验";
            refreshLabConnectionPlan();
        }
        connectMetrics();
        fetchSnapshot();
        markLabSceneReady();
        document.addEventListener("visibilitychange", markLabSceneReady);
    });

    window.addEventListener("beforeunload", function () {
        clearRouteTimers();
        stopTideTraceMotion();
        if (state.stream) {
            state.stream.close();
        }
        if (state.pollTimer) {
            window.clearInterval(state.pollTimer);
        }
        stopLoadtestConnections();
        clearMetricsReplayTimer();
    });
}());
