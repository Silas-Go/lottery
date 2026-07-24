(function () {
    "use strict";

    var MATERIAL_STORAGE_KEY = "silas.cache-aside.material-id";
    var REPLAY_POSITION_KEY = "silas.cache-aside.purchase-replay-position.v2";
    var PURCHASE_COUNT = 150;
    var PROBE_RATE = 20;
    var PROBE_INTERVAL_MS = 1000 / PROBE_RATE;
    var REPLAY_STEP_MS = 1800;
    var ACTIVE_STATUSES = ["running", "waiting_outbox", "waiting_consumer"];
    var resultStore = window.SilasPurchaseLabResults;
    var profiles = {
        1: { code: "ARC-001", name: "月盐" },
        2: { code: "ARC-002", name: "雾银" },
        3: { code: "ARC-003", name: "龙息琥珀" },
        4: { code: "ARC-004", name: "星髓" }
    };
    var strategyNames = {
        "sync-invalidate": "同步缓存失效",
        "outbox-mq-invalidate": "Outbox + MQ 异步失效"
    };
    var stageNames = [
        "购买请求进入",
        "MySQL 事务提交",
        "购买响应返回",
        "缓存失效执行",
        "查询探针验证",
        "实验完成"
    ];
    // executionMode 表示“真实执行 / 回放 / 暂停 / 结果”边界；replay 只保存前端游标和速度。
    // 只有 startExperiment 会进入购买与重置接口，任何回放控制都不能复用该入口。
    var state = {
        materialId: null,
        profile: null,
        strategy: null,
        stock: null,
        liveRun: null,
        record: null,
        executionMode: "idle",
        executionDetail: "",
        probe: createProbeState(),
        replay: {
            index: 0,
            furthest: -1,
            speed: 1,
            playing: false,
            timer: null
        }
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function createProbeState() {
        return {
            timer: null,
            active: false,
            inFlight: 0,
            issued: 0,
            completed: 0,
            oldReads: 0,
            hits: 0,
            misses: 0,
            fallbacks: 0,
            errors: 0,
            staleOpenedAt: null,
            maxStaleWindowMs: 0,
            latest: null,
            samples: [],
            startedAt: null
        };
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
            return normalizeMaterial(window.sessionStorage.getItem(MATERIAL_STORAGE_KEY));
        } catch (_) {
            return null;
        }
    }

    function rememberMaterial(profile) {
        try {
            window.sessionStorage.setItem(MATERIAL_STORAGE_KEY, profile.code);
        } catch (_) {
            // URL 仍保留材料上下文；存储失败只影响刷新后的便捷恢复。
        }
    }

    function readReplayPosition() {
        try {
            return JSON.parse(window.sessionStorage.getItem(REPLAY_POSITION_KEY) || "null");
        } catch (_) {
            return null;
        }
    }

    function persistReplayPosition() {
        if (!state.record || !state.record.run) {
            return;
        }
        try {
            window.sessionStorage.setItem(REPLAY_POSITION_KEY, JSON.stringify({
                materialId: state.materialId,
                strategy: state.strategy,
                requestId: state.record.run.requestId,
                index: state.replay.index,
                furthest: state.replay.furthest,
                speed: state.replay.speed
            }));
        } catch (_) {
            // 当前页面仍持有完整 trace；禁用存储只影响刷新恢复。
        }
    }

    function formatNumber(value) {
        return Number(value || 0).toLocaleString("zh-CN");
    }

    function formatMS(value) {
        var numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
            return "—";
        }
        if (numeric >= 1000) {
            return (numeric / 1000).toFixed(numeric >= 10000 ? 1 : 2) + " s";
        }
        return numeric.toFixed(numeric >= 100 ? 1 : 2) + " ms";
    }

    function stockText(value) {
        return value === null || value === undefined ? "MISS" : formatNumber(value);
    }

    function showToast(message, tone) {
        var toast = byId("lab-toast");
        toast.textContent = message;
        toast.className = "lab-toast is-visible " + (tone || "success");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(function () {
            toast.classList.remove("is-visible");
        }, 2800);
    }

    async function requestJSON(url, options) {
        var response = await window.fetch(url, Object.assign({
            cache: "no-store",
            headers: { "Content-Type": "application/json" }
        }, options || {}));
        var payload = {};
        try {
            payload = await response.json();
        } catch (_) {
            payload = {};
        }
        if (!response.ok) {
            throw new Error(payload.message || payload.error || ("HTTP " + response.status));
        }
        return payload;
    }

    function runningStatus(run) {
        return run && ACTIVE_STATUSES.indexOf(run.status) >= 0;
    }

    function traceStep(run, actions) {
        if (!run || !Array.isArray(run.trace)) {
            return null;
        }
        for (var index = run.trace.length - 1; index >= 0; index -= 1) {
            if (actions.indexOf(run.trace[index].action) >= 0) {
                return run.trace[index];
            }
        }
        return null;
    }

    function outboxSummary(run) {
        var events = run && Array.isArray(run.outbox) ? run.outbox : [];
        var summary = { total: events.length, pending: 0, published: 0, completed: 0, retry: 0, failed: 0 };
        events.forEach(function (event) {
            if (event.status === "completed") {
                summary.completed += 1;
            } else if (event.status === "published") {
                summary.published += 1;
            } else if (event.status === "retry") {
                summary.retry += 1;
            } else {
                summary.pending += 1;
            }
            if (event.lastError) {
                summary.failed += 1;
            }
        });
        return summary;
    }

    function currentConsistency(run) {
        if (!run || run.finalRedisStock === null || run.finalRedisStock === undefined) {
            return null;
        }
        return Number(run.finalRedisStock) === Number(run.finalMySQLStock);
    }

    function setRole(id, roleState, message) {
        var role = byId(id);
        if (!role) {
            return;
        }
        role.dataset.state = roleState;
        var status = role.querySelector("[data-role-status]");
        if (status) {
            status.textContent = message;
        }
    }

    function setNode(id, nodeState, status, time, io) {
        var node = byId(id);
        if (!node) {
            return;
        }
        node.dataset.state = nodeState;
        var statusElement = node.querySelector("[data-node-status]");
        var timeElement = node.querySelector("[data-node-time]");
        var ioElement = node.querySelector("[data-node-io]");
        if (statusElement) {
            statusElement.textContent = status;
        }
        if (timeElement) {
            timeElement.textContent = time;
        }
        if (ioElement) {
            ioElement.textContent = io;
        }
    }

    function clearReplayTimer() {
        if (state.replay.timer) {
            window.clearTimeout(state.replay.timer);
            state.replay.timer = null;
        }
    }

    function setExecutionMode(mode, detail) {
        state.executionMode = mode;
        state.executionDetail = detail || "";
        renderHeaderAndControls();
        renderTimeline();
    }

    function modeLabel() {
        var labels = {
            idle: "准备实验",
            executing: "正在真实执行",
            replaying: "正在回放实验过程",
            paused: "回放已暂停",
            result: "实验结果",
            error: "真实执行失败"
        };
        return labels[state.executionMode] || labels.idle;
    }

    function renderHeaderAndControls() {
        var busy = state.executionMode === "executing";
        var ready = !!(state.record && state.record.run);
        var label = modeLabel();
        byId("header-strategy").textContent = strategyNames[state.strategy] || "请选择方案";
        byId("header-status").textContent = label;
        byId("running-phase").textContent = label;
        byId("running-material").textContent = state.profile ? state.profile.name : "—";
        byId("running-strategy").textContent = strategyNames[state.strategy] || "—";
        byId("execution-boundary-copy").textContent = state.executionDetail ||
            (busy ? "后端正在真实扣减库存并完成失效链路；此时尚未播放任何阶段。" :
                "真实执行与回放相互分离；上一步、下一步和重新播放都只读取本轮 trace。");
        byId("replay-position").textContent = ready ? ((state.replay.index + 1) + " / 6") : "— / 6";
        byId("timeline-mode").textContent = label;
        byId("start-purchase-run").disabled = busy || !state.strategy;
        byId("start-purchase-run").textContent = busy ? "后端正在真实执行…" : "开始 150 人购买实验";
        byId("prepare-action-hint").textContent = state.strategy ?
            ("本轮将真实执行“" + strategyNames[state.strategy] + "”；完成后自动按 trace 回放。") :
            "请先选择一种缓存失效方案。";
        byId("replay-previous").disabled = !ready || busy || state.replay.index <= 0;
        byId("replay-next").disabled = !ready || busy || state.replay.index >= stageNames.length - 1;
        byId("replay-toggle").disabled = !ready || busy;
        byId("replay-toggle").textContent = state.replay.playing ? "暂停" : "播放";
        byId("replay-toggle").setAttribute("aria-label", state.replay.playing ? "暂停回放" : "播放回放");
        byId("replay-toggle").setAttribute("aria-pressed", String(state.replay.playing));
        byId("replay-restart").disabled = !ready || busy;
        byId("replay-result").disabled = !ready || busy;
        document.querySelectorAll("[data-replay-speed]").forEach(function (button) {
            button.disabled = !ready || busy;
            button.classList.toggle("is-active", Number(button.dataset.replaySpeed) === state.replay.speed);
            button.setAttribute("aria-pressed", String(Number(button.dataset.replaySpeed) === state.replay.speed));
        });
        document.querySelectorAll(".purchase-strategy-card").forEach(function (button) {
            button.disabled = busy;
        });
        byId("view-full-process").disabled = !ready || busy;
        byId("run-other-strategy").disabled = !ready || busy;
        byId("rerun-current-strategy").disabled = busy || !ready;
        byId("open-technical-details").disabled = !ready;
        document.body.dataset.purchaseStrategy = state.strategy || "unselected";
        document.body.dataset.purchaseStatus = state.executionMode;
    }

    function renderTimeline() {
        var ready = !!(state.record && state.record.run);
        var failed = ready && state.record.run.status === "failed";
        var invalidationFailed = ready && !!traceStep(
            state.record.run,
            ["cache_invalidation_failed", "delete_cache_failed"]
        );
        document.querySelectorAll("[data-replay-step]").forEach(function (button) {
            var index = Number(button.dataset.replayStep);
            var status = "waiting";
            if (ready && index <= state.replay.furthest) {
                status = index === state.replay.index && state.replay.playing ? "running" : "completed";
            }
            if (ready && index === state.replay.index && index > state.replay.furthest) {
                status = "running";
            }
            if (failed && index === stageNames.length - 1 && index <= state.replay.furthest) {
                status = "failed";
            }
            if (invalidationFailed && index === 3 && index <= state.replay.furthest) {
                status = "failed";
            }
            button.dataset.status = status;
            button.classList.toggle("is-current", ready && index === state.replay.index);
            button.disabled = !ready || state.executionMode === "executing" || index > state.replay.furthest;
            button.querySelector("[data-step-status]").textContent = status;
        });
    }

    function setSelectedStrategy(strategy) {
        state.strategy = strategy;
        document.querySelectorAll(".purchase-strategy-card").forEach(function (button) {
            var active = button.dataset.strategy === strategy;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-checked", String(active));
        });
        document.body.dataset.purchaseStrategy = strategy || "unselected";
    }

    function renderSceneBaseline(record) {
        var run = record && record.run;
        var initialMySQL = run ? run.initialStock : (state.stock && state.stock.mysqlStock);
        var initialRedis = record && record.baseline ? record.baseline.redisStock :
            (state.stock && state.stock.redisStock);
        byId("allegory-status").textContent = record ? "等待回放" : "等待开门";
        byId("topology-status").textContent = record ? "TRACE READY" : "IDLE";
        byId("story-redis-stock").textContent = stockText(initialRedis);
        setRole("story-buyers", "idle", "正在店外等待");
        setRole("story-service", "idle", "等待购买请求");
        setRole("story-mysql", "idle", "账本库存 " + stockText(initialMySQL));
        setRole("story-redis", "idle", initialRedis === null ? "库存牌尚未回填" : "库存牌显示 " + stockText(initialRedis));
        setRole("story-outbox", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不使用" : "等待事务创建凭证");
        setRole("story-mq", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不使用" : "等待凭证");
        setRole("story-consumer", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不使用" : "等待消息");
        setNode("node-buyers", "idle", "150 个唯一用户", "—", "150 × 1");
        setNode("node-service", "idle", "等待请求", "—", "—");
        setNode("node-mysql", "idle", "等待事务", "—", stockText(initialMySQL) + " → —");
        setNode("node-response", "idle", "顾客等待中", "—", "—");
        setNode("node-sync-redis", "idle", "等待事务提交", "—", "—");
        setNode("node-outbox", "idle", "等待事务", "同事务", "—");
        setNode("node-worker", "idle", "等待凭证", "0", "—");
        setNode("node-mq", "idle", "等待发布", "0", "—");
        setNode("node-consumer", "idle", "等待消息", "0 / 150", "—");
        setNode("node-probe", "idle", "固定 20 QPS", "0", "0");
        setNode("node-probe-redis", "idle", "HIT / MISS", "0", "0");
        byId("purchase-fault-banner").hidden = true;
    }

    function stageEvidence(record, index) {
        var run = record.run;
        var probe = record.probe;
        var outbox = outboxSummary(run);
        var request = traceStep(run, ["transaction_started"]);
        var transaction = traceStep(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        var response = traceStep(run, ["purchase_responded"]);
        var invalidation = traceStep(run, ["cache_invalidated", "delete_cache", "cache_invalidation_failed", "delete_cache_failed"]);
        var evidence = {
            kicker: "STEP " + String(index + 1).padStart(2, "0") + " / 06",
            title: stageNames[index],
            summary: "",
            mysql: run.initialStock,
            redis: record.baseline ? record.baseline.redisStock : null,
            message: state.strategy === "sync-invalidate" ? "未使用" : "等待 Outbox",
            duration: "—"
        };
        if (index === 0) {
            evidence.summary = request ? request.detail : "150 个唯一 request_id 已进入购买服务。";
            evidence.mysql = request ? request.mysqlStock : run.initialStock;
            evidence.redis = request ? request.redisStock : evidence.redis;
            evidence.duration = formatMS(request && request.durationMs);
        } else if (index === 1) {
            evidence.summary = transaction ? transaction.detail : "订单与库存条件扣减已经提交。";
            evidence.mysql = transaction ? transaction.mysqlStock : run.finalMySQLStock;
            evidence.redis = transaction ? transaction.redisStock : evidence.redis;
            evidence.message = state.strategy === "sync-invalidate" ? "未使用" : (outbox.total + " 条事件同事务写入");
            evidence.duration = formatMS(transaction && transaction.durationMs);
        } else if (index === 2) {
            evidence.summary = response ? response.detail : "购买响应已全部收集。";
            evidence.mysql = response ? response.mysqlStock : run.finalMySQLStock;
            evidence.redis = response ? response.redisStock : run.finalRedisStock;
            evidence.message = state.strategy === "sync-invalidate" ? "响应等待 Redis DEL" : "响应不等待 Consumer";
            evidence.duration = formatMS(run.purchaseP99Ms);
        } else if (index === 3) {
            evidence.summary = state.strategy === "sync-invalidate" ?
                (invalidation ? invalidation.detail : "同步 Redis DEL 已执行。") :
                ("Outbox " + outbox.completed + " / " + outbox.total + " 已完成，MQ " + (run.mqStatus || "—") + "。");
            evidence.mysql = run.finalMySQLStock;
            evidence.redis = invalidation ? invalidation.redisStock : null;
            evidence.message = state.strategy === "sync-invalidate" ?
                (invalidation && /failed/i.test(invalidation.action) ? "Redis DEL 失败" : "同步 DEL 完成") :
                ("Outbox " + (run.outboxStatus || "—") + " / MQ " + (run.mqStatus || "—"));
            evidence.duration = formatMS(run.cacheInvalidationLatencyMs);
        } else if (index === 4) {
            evidence.summary = "真实 Cached 探针完成 " + probe.completed + " 次，观察到 " + probe.oldReads + " 次旧库存读取。";
            evidence.mysql = run.finalMySQLStock;
            evidence.redis = run.finalRedisStock;
            evidence.message = state.strategy === "sync-invalidate" ? "未使用" : ("重试 " + Number(run.retryCount || 0) + " 次");
            evidence.duration = probe.maxStaleWindowMs > 0 ? formatMS(probe.maxStaleWindowMs) : "0 ms";
        } else {
            evidence.kicker = run.status === "failed" ? "FAILED TRACE" : "RESULT TRACE";
            evidence.summary = run.status === "failed" ?
                (run.errorMessage || "后端返回失败状态，已保留本轮证据。") :
                ("成功购买 " + run.purchaseSucceeded + "，最终 MySQL 与 Redis " +
                    (currentConsistency(run) ? "一致。" : "仍不一致。"));
            evidence.mysql = run.finalMySQLStock;
            evidence.redis = run.finalRedisStock;
            evidence.message = state.strategy === "sync-invalidate" ? "同步链路结束" :
                ("Outbox " + (run.outboxStatus || "—") + " / MQ " + (run.mqStatus || "—"));
            evidence.duration = formatMS(run.purchaseP99Ms);
        }
        return evidence;
    }

    function renderStageReadout(record, index) {
        var evidence = stageEvidence(record, index);
        byId("stage-kicker").textContent = evidence.kicker;
        byId("stage-title").textContent = evidence.title;
        byId("stage-summary").textContent = evidence.summary;
        byId("stage-mysql-stock").textContent = stockText(evidence.mysql);
        byId("stage-redis-stock").textContent = stockText(evidence.redis);
        byId("stage-message-state").textContent = evidence.message;
        byId("stage-duration").textContent = evidence.duration;
        byId("purchase-stock-summary").textContent =
            "回放快照 · MySQL " + stockText(evidence.mysql) + " · Redis " + stockText(evidence.redis);
        byId("control-status").textContent = evidence.summary;
    }

    function applyRequestFrame(record) {
        var run = record.run;
        var request = traceStep(run, ["transaction_started"]);
        byId("allegory-status").textContent = "购买请求进入";
        byId("topology-status").textContent = "REQUEST RECEIVED";
        setRole("story-buyers", "running", "150 个唯一购买请求已经发出");
        setRole("story-service", "running", "掌柜正在接收购买请求");
        setRole("story-mysql", "waiting", "账房等待事务");
        setRole("story-redis", "waiting", "库存牌保持实验起点快照");
        setNode("node-buyers", "success", "150 个唯一请求已发出", formatMS(request && request.atMs), "150 × 1");
        setNode("node-service", "running", "购买 API 已接收", "—", "150 requests");
        setNode("node-mysql", "waiting", "等待事务提交", "—", run.initialStock + " → ?");
    }

    function applyTransactionFrame(record) {
        var run = record.run;
        var transaction = traceStep(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        var outbox = outboxSummary(run);
        setRole("story-mysql", "success", "账房已盖章，库存 " + run.initialStock + " → " + run.finalMySQLStock);
        setNode("node-mysql", "success", "事务已提交", formatMS(transaction && transaction.durationMs),
            run.initialStock + " → " + run.finalMySQLStock);
        if (state.strategy === "outbox-mq-invalidate") {
            setRole("story-outbox", "success", "订单与 " + outbox.total + " 张凭证同事务提交");
            setNode("node-outbox", "success", "订单与事件同事务提交", "同事务", outbox.total + " events");
        }
    }

    function applyResponseFrame(record) {
        var run = record.run;
        setRole("story-buyers", "success", "收到 " +
            formatNumber(Number(run.purchaseSucceeded || 0) + Number(run.soldOutRequests || 0) +
                Number(run.duplicateRequests || 0)) + " 份购买结果");
        setRole("story-service", "success", "顾客已收到购买结果");
        setNode("node-service", "success", "响应已收集", formatMS(run.purchaseLatencyMs),
            run.purchaseSucceeded + " success");
        setNode("node-response", run.status === "failed" ? "failed" : "success", "购买响应已返回",
            formatMS(run.purchaseP99Ms), run.purchaseSucceeded + " / " + PURCHASE_COUNT);
    }

    function applyInvalidationFrame(record) {
        var run = record.run;
        var outbox = outboxSummary(run);
        var failedStep = traceStep(run, ["cache_invalidation_failed", "delete_cache_failed"]);
        if (state.strategy === "sync-invalidate") {
            var invalidated = traceStep(run, ["cache_invalidated", "delete_cache"]);
            setRole("story-redis", failedStep ? "failed" : "success",
                failedStep ? "Redis DEL 重试耗尽" : "旧库存牌已被同步撤下");
            setNode("node-sync-redis", failedStep ? "failed" : "success",
                failedStep ? "DEL 重试耗尽" : "Redis DEL 已完成",
                formatMS(run.cacheInvalidationLatencyMs), invalidated ? "cache deleted" : "—");
        } else {
            setRole("story-outbox", outbox.retry ? "retry" : "success",
                outbox.retry ? "凭证等待重试" : (outbox.completed + " 张凭证已经完成"));
            setRole("story-mq", outbox.retry ? "retry" : "success",
                outbox.retry ? "信使投递失败，等待重试" : "失效通知已经投递");
            setRole("story-consumer", outbox.completed ? "success" : "waiting",
                "伙计已处理 " + outbox.completed + " 次幂等失效");
            setRole("story-redis", outbox.completed ? "success" : "waiting",
                outbox.completed ? "旧库存牌已由 Consumer 撤下" : "等待 Consumer");
            setNode("node-worker", outbox.retry ? "retry" : "success",
                outbox.retry ? "发布失败，等待重试" : "凭证已认领发布",
                String(run.retryCount || 0), run.outboxStatus || "—");
            setNode("node-mq", outbox.retry ? "retry" : "success",
                outbox.retry ? "发布正在重试" : "消息已消费",
                String(outbox.pending + outbox.published + outbox.retry), run.mqStatus || "—");
            setNode("node-consumer", outbox.completed === outbox.total && outbox.total ? "success" : "waiting",
                outbox.completed ? "幂等删除缓存" : "等待消息",
                outbox.completed + " / " + (outbox.total || PURCHASE_COUNT),
                outbox.completed ? "Redis DEL" : "—");
        }
        byId("story-redis-stock").textContent = "MISS";
    }

    function applyProbeFrame(record) {
        var run = record.run;
        var probe = record.probe;
        var latest = probe.latest;
        setNode("node-probe", "success", "20 QPS 真实查询已保存",
            String(probe.completed), String(probe.oldReads));
        setNode("node-probe-redis", probe.oldReads ? "retry" : "success",
            latest ? (String(latest.source).toUpperCase() + (latest.old ? " · OLD" : "")) : "PROBE COMPLETE",
            String(probe.hits), String(probe.misses + probe.fallbacks));
        setRole("story-redis", currentConsistency(run) ? "success" : "failed",
            currentConsistency(run) ? "库存牌已经与账本一致" : "库存牌仍与账本不同");
        byId("story-redis-stock").textContent = stockText(run.finalRedisStock);
    }

    function applyCompleteFrame(record) {
        var run = record.run;
        byId("allegory-status").textContent = run.status === "failed" ? "实验失败" : "实验结果";
        byId("topology-status").textContent = String(run.status || "completed").toUpperCase();
        if (run.status === "failed") {
            byId("purchase-fault-banner").hidden = false;
            byId("purchase-fault-title").textContent = "真实链路返回失败状态";
            byId("purchase-fault-copy").textContent = run.errorMessage || "请查看本轮保存的 trace。";
        }
    }

    function stageEvents(record, index) {
        var actionsByStage = [
            ["transaction_started"],
            ["transaction_committed", "update_mysql", "idempotent_order", "sold_out", "outbox_created", "write_outbox"],
            ["purchase_responded"],
            ["cache_invalidated", "delete_cache", "cache_invalidation_failed", "delete_cache_failed"],
            ["query_material"],
            []
        ];
        var events = [];
        (record.run.trace || []).forEach(function (step) {
            if (actionsByStage[index].indexOf(step.action) >= 0) {
                events.push({
                    clock: "+" + (formatMS(step.atMs) === "—" ? "0 ms" : formatMS(step.atMs)),
                    label: step.label || step.action,
                    detail: step.detail || "",
                    failed: /failed/i.test(step.action)
                });
            }
        });
        if (index === 3 && state.strategy === "outbox-mq-invalidate") {
            var published = (record.run.outbox || []).filter(function (event) { return event.publishedAt; }).length;
            var invalidated = (record.run.outbox || []).filter(function (event) { return event.invalidatedAt; }).length;
            var retries = (record.run.outbox || []).reduce(function (total, event) {
                return total + Number(event.retryCount || 0);
            }, 0);
            events.push({
                clock: "TRACE",
                label: "OUTBOX / MQ EVIDENCE",
                detail: published + " 条已发布，" + invalidated + " 条已失效，真实重试 " + retries + " 次。",
                failed: retries > 0
            });
        }
        if (index === 4) {
            var probe = record.probe;
            events.push({
                clock: "PROBE",
                label: "QUERY PROBE SUMMARY",
                detail: probe.completed + " 个真实样本 · HIT " + probe.hits + " · MISS/FALLBACK " +
                    (probe.misses + probe.fallbacks) + " · OLD " + probe.oldReads + "。",
                failed: probe.errors > 0
            });
            var stale = (probe.samples || []).find(function (sample) { return sample.old; });
            var latest = probe.latest;
            if (stale) {
                events.push({
                    clock: "+" + formatMS(stale.observedAtMs),
                    label: "OLD STOCK OBSERVED",
                    detail: stale.source + " 返回 " + stale.stock + "，当时 MySQL 为 " + stale.authoritativeStock + "。",
                    failed: true
                });
            }
            if (latest) {
                events.push({
                    clock: "+" + formatMS(latest.observedAtMs),
                    label: "LATEST PROBE",
                    detail: latest.source + " 返回 " + latest.stock + "，MySQL 为 " + latest.authoritativeStock + "。",
                    failed: false
                });
            }
        }
        if (index === 5) {
            events.push({
                clock: "RESULT",
                label: record.run.status === "failed" ? "EXPERIMENT FAILED" : "EXPERIMENT COMPLETED",
                detail: record.run.status === "failed" ?
                    (record.run.errorMessage || "后端返回 failed。") :
                    ("P99 " + formatMS(record.run.purchaseP99Ms) + " · 旧读 " + record.probe.oldReads +
                        " · 最终" + (currentConsistency(record.run) ? "一致" : "未一致") + "。"),
                failed: record.run.status === "failed"
            });
        }
        return events;
    }

    function renderEventLog(record, index) {
        var list = byId("story-event-log");
        var events = stageEvents(record, index);
        list.replaceChildren();
        if (!events.length) {
            var empty = document.createElement("li");
            var emptyTime = document.createElement("time");
            var emptyBody = document.createElement("span");
            emptyTime.textContent = "TRACE";
            emptyBody.textContent = "本阶段没有额外事件；页面不会补造动画或日志。";
            empty.appendChild(emptyTime);
            empty.appendChild(emptyBody);
            list.appendChild(empty);
            return;
        }
        events.slice(-6).forEach(function (event) {
            var item = document.createElement("li");
            item.className = event.failed ? "is-failed" : "";
            var time = document.createElement("time");
            var body = document.createElement("span");
            var strong = document.createElement("strong");
            time.textContent = event.clock;
            strong.textContent = event.label;
            body.appendChild(strong);
            body.appendChild(document.createTextNode(" · " + event.detail));
            item.appendChild(time);
            item.appendChild(body);
            list.appendChild(item);
        });
    }

    function renderResults(record) {
        var run = record.run;
        var probe = record.probe;
        var consistent = currentConsistency(run);
        byId("result-p99").textContent = formatMS(run.purchaseP99Ms);
        byId("result-old-reads").textContent = formatNumber(probe.oldReads);
        byId("result-stale-window").textContent = probe.maxStaleWindowMs > 0 ?
            formatMS(probe.maxStaleWindowMs) : "0 ms";
        byId("result-consistency").textContent = consistent === null ? "待回填" : (consistent ? "一致" : "不一致");
        byId("result-consistency").className = consistent === true ? "is-good" : (consistent === false ? "is-bad" : "");
        byId("result-stock-pair").textContent = "MySQL " + stockText(run.finalMySQLStock) +
            " / Redis " + stockText(run.finalRedisStock);
        byId("result-status").textContent = run.status === "failed" ? "真实运行失败" : "真实结果已保存";
        if (run.status === "failed") {
            byId("purchase-conclusion").textContent = "本次实验失败：" +
                (run.errorMessage || "请查看完整技术证据。");
        } else {
            byId("purchase-conclusion").textContent =
                strategyNames[record.strategy] + "本次购买 P99 为 " + formatMS(run.purchaseP99Ms) +
                "，探针观察到 " + probe.oldReads + " 次旧库存读取；最终 MySQL 与 Redis " +
                (consistent ? "一致。" : "仍未一致。");
        }
        renderTechnicalDetails(record);
    }

    function renderTechnicalDetails(record) {
        var run = record.run;
        var probe = record.probe;
        var outbox = outboxSummary(run);
        var tx = traceStep(run, ["transaction_committed", "update_mysql"]);
        byId("detail-success").textContent = formatNumber(run.purchaseSucceeded);
        byId("detail-soldout").textContent = formatNumber(run.soldOutRequests);
        byId("detail-duplicates").textContent = formatNumber(run.duplicateRequests);
        byId("detail-purchase-average").textContent = formatMS(run.purchaseLatencyMs);
        byId("detail-mysql-time").textContent = formatMS(tx && tx.durationMs);
        byId("detail-invalidation-time").textContent = formatMS(run.cacheInvalidationLatencyMs);
        byId("detail-outbox-backlog").textContent = String(outbox.pending + outbox.published + outbox.retry);
        byId("detail-retries").textContent = String(run.retryCount || 0) + " / 未单独计数";
        byId("detail-hit-miss").textContent = probe.hits + " / " + (probe.misses + probe.fallbacks);
        byId("detail-probe-samples").textContent = probe.completed + "（错误 " + probe.errors + "）";
        var trace = byId("technical-trace");
        trace.replaceChildren();
        var events = [];
        for (var index = 0; index < stageNames.length; index += 1) {
            events = events.concat(stageEvents(record, index));
        }
        events.forEach(function (event) {
            var item = document.createElement("li");
            item.textContent = event.clock + " · " + event.label + " · " + event.detail;
            trace.appendChild(item);
        });
    }

    function renderPlaybackFrame(index, options) {
        if (!state.record || !state.record.run) {
            return;
        }
        options = options || {};
        state.replay.index = Math.max(0, Math.min(stageNames.length - 1, Number(index)));
        if (options.advance !== false) {
            state.replay.furthest = Math.max(state.replay.furthest, state.replay.index);
        }
        renderSceneBaseline(state.record);
        applyRequestFrame(state.record);
        if (state.replay.index >= 1) {
            applyTransactionFrame(state.record);
        }
        if (state.replay.index >= 2) {
            applyResponseFrame(state.record);
        }
        if (state.replay.index >= 3) {
            applyInvalidationFrame(state.record);
        }
        if (state.replay.index >= 4) {
            applyProbeFrame(state.record);
        }
        if (state.replay.index >= 5) {
            applyCompleteFrame(state.record);
        }
        renderStageReadout(state.record, state.replay.index);
        renderEventLog(state.record, state.replay.index);
        renderResults(state.record);
        renderTimeline();
        renderHeaderAndControls();
        persistReplayPosition();
    }

    function finishPlaybackAtResult() {
        clearReplayTimer();
        state.replay.playing = false;
        state.replay.furthest = stageNames.length - 1;
        setExecutionMode("result",
            "实验结果来自已经完成的真实执行；可点击任意已完成步骤回看，不会再次请求购买接口。");
        renderPlaybackFrame(stageNames.length - 1, { advance: true });
    }

    function scheduleReplayAdvance() {
        clearReplayTimer();
        if (!state.replay.playing || !state.record) {
            return;
        }
        if (state.replay.index >= stageNames.length - 1) {
            finishPlaybackAtResult();
            return;
        }
        state.replay.timer = window.setTimeout(function () {
            if (!state.replay.playing) {
                return;
            }
            var next = state.replay.index + 1;
            renderPlaybackFrame(next, { advance: true });
            if (next >= stageNames.length - 1) {
                finishPlaybackAtResult();
                return;
            }
            scheduleReplayAdvance();
        }, REPLAY_STEP_MS / state.replay.speed);
    }

    function pauseReplay(detail) {
        if (!state.record) {
            return;
        }
        clearReplayTimer();
        state.replay.playing = false;
        setExecutionMode("paused", detail ||
            "回放已暂停；后续不会自动继续。所有控制只读取本轮保存的 trace。");
        renderPlaybackFrame(state.replay.index, { advance: false });
    }

    function playReplay() {
        if (!state.record) {
            return;
        }
        if (state.replay.playing) {
            pauseReplay();
            return;
        }
        if (state.replay.index >= stageNames.length - 1) {
            state.replay.index = 0;
        }
        state.replay.playing = true;
        setExecutionMode("replaying",
            "正在按本轮已保存 trace 回放；默认 1x 时每个关键步骤停留 1.8 秒。");
        renderPlaybackFrame(state.replay.index, { advance: true });
        scheduleReplayAdvance();
    }

    function stepReplay(delta) {
        if (!state.record) {
            return;
        }
        pauseReplay("已按单步方式查看；页面不会自动继续，也不会重新修改库存。");
        var next = Math.max(0, Math.min(stageNames.length - 1, state.replay.index + delta));
        state.replay.furthest = Math.max(state.replay.furthest, next);
        renderPlaybackFrame(next, { advance: true });
    }

    function restartReplay() {
        if (!state.record) {
            return;
        }
        clearReplayTimer();
        state.replay.index = 0;
        state.replay.playing = true;
        setExecutionMode("replaying",
            "已从第一步重新播放保存的 trace；没有调用重置或购买接口。");
        renderPlaybackFrame(0, { advance: true });
        scheduleReplayAdvance();
    }

    function jumpToResult() {
        if (!state.record) {
            return;
        }
        pauseReplay("已跳到实验结果；这是保存结果的回看，不会再次执行购买。");
        state.replay.furthest = stageNames.length - 1;
        renderPlaybackFrame(stageNames.length - 1, { advance: true });
        setExecutionMode("result",
            "实验结果来自已经完成的真实执行；可点击任意已完成步骤继续回看。");
    }

    function chooseTimelineStep(index) {
        if (!state.record || index > state.replay.furthest) {
            return;
        }
        pauseReplay("正在回看“" + stageNames[index] + "”；此操作只读取本轮 trace。");
        renderPlaybackFrame(index, { advance: false });
    }

    function setReplaySpeed(speed) {
        if ([0.5, 1, 2].indexOf(speed) < 0) {
            return;
        }
        state.replay.speed = speed;
        renderHeaderAndControls();
        persistReplayPosition();
        if (state.replay.playing) {
            scheduleReplayAdvance();
        }
    }

    function resetIdleVisuals() {
        state.record = null;
        state.liveRun = null;
        clearReplayTimer();
        state.replay.index = 0;
        state.replay.furthest = -1;
        state.replay.playing = false;
        renderSceneBaseline(null);
        byId("stage-kicker").textContent = "NOT STARTED";
        byId("stage-title").textContent = "选择方案并开始真实实验";
        byId("stage-summary").textContent =
            "页面会先等待后端完整执行；拿到本轮 trace 后，六个阶段才按保存证据逐步回放。";
        byId("stage-mysql-stock").textContent = stockText(state.stock && state.stock.mysqlStock);
        byId("stage-redis-stock").textContent = stockText(state.stock && state.stock.redisStock);
        byId("stage-message-state").textContent = "—";
        byId("stage-duration").textContent = "—";
        byId("story-event-log").replaceChildren();
        var item = document.createElement("li");
        var time = document.createElement("time");
        var body = document.createElement("span");
        time.textContent = "READY";
        body.textContent = "等待后端完整返回真实 trace；这里不会用定时器伪造业务进度。";
        item.appendChild(time);
        item.appendChild(body);
        byId("story-event-log").appendChild(item);
        byId("control-status").textContent = "等待真实执行";
        byId("result-p99").textContent = "—";
        byId("result-old-reads").textContent = "—";
        byId("result-stale-window").textContent = "—";
        byId("result-consistency").textContent = "—";
        byId("result-consistency").className = "";
        byId("result-stock-pair").textContent = "MySQL — / Redis —";
        byId("result-status").textContent = "等待实验";
        byId("purchase-conclusion").textContent =
            "运行两种方案后，页面会依据真实购买 P99、旧读与最终状态说明取舍，不预设胜者。";
        setExecutionMode("idle");
    }

    function probeWindowMS() {
        if (state.probe.staleOpenedAt === null) {
            return state.probe.maxStaleWindowMs;
        }
        return Math.max(state.probe.maxStaleWindowMs, performance.now() - state.probe.staleOpenedAt);
    }

    function snapshotProbe() {
        return {
            issued: state.probe.issued,
            completed: state.probe.completed,
            oldReads: state.probe.oldReads,
            hits: state.probe.hits,
            misses: state.probe.misses,
            fallbacks: state.probe.fallbacks,
            errors: state.probe.errors,
            maxStaleWindowMs: probeWindowMS(),
            latest: state.probe.latest ? clone(state.probe.latest) : null,
            samples: clone(state.probe.samples)
        };
    }

    function stopProbe() {
        if (state.probe.timer) {
            window.clearInterval(state.probe.timer);
            state.probe.timer = null;
        }
        if (state.probe.staleOpenedAt !== null) {
            state.probe.maxStaleWindowMs = Math.max(
                state.probe.maxStaleWindowMs,
                performance.now() - state.probe.staleOpenedAt
            );
            state.probe.staleOpenedAt = null;
        }
        state.probe.active = false;
    }

    function stopProbeScheduling() {
        if (state.probe.timer) {
            window.clearInterval(state.probe.timer);
            state.probe.timer = null;
        }
    }

    function startProbe() {
        stopProbe();
        state.probe = createProbeState();
        state.probe.active = true;
        state.probe.startedAt = performance.now();
        runProbeRequest();
        state.probe.timer = window.setInterval(runProbeRequest, PROBE_INTERVAL_MS);
    }

    async function waitForProbeDrain() {
        var deadline = Date.now() + 6000;
        while (state.probe.inFlight > 0 && Date.now() < deadline) {
            await new Promise(function (resolve) { window.setTimeout(resolve, 25); });
        }
    }

    async function runProbeRequest() {
        var probe = state.probe;
        if (!probe.active || probe.inFlight >= 40 || !state.materialId) {
            return;
        }
        probe.issued += 1;
        probe.inFlight += 1;
        try {
            var payload = await requestJSON("/api/purchase-lab/" + state.materialId + "/query", {
                method: "POST",
                body: JSON.stringify({ count: 1 })
            });
            var sample = payload.samples && payload.samples[0];
            if (!sample) {
                throw new Error("库存探针没有返回样本");
            }
            sample = Object.assign({}, sample, {
                observedAtMs: Math.max(0, performance.now() - probe.startedAt)
            });
            probe.completed += 1;
            probe.latest = sample;
            if (probe.samples.length < 1000) {
                probe.samples.push(sample);
            }
            if (sample.source === "redis-hit") {
                probe.hits += 1;
            } else if (sample.source === "redis-miss") {
                probe.misses += 1;
            } else {
                probe.fallbacks += 1;
            }
            if (sample.old) {
                probe.oldReads += 1;
                if (probe.staleOpenedAt === null) {
                    probe.staleOpenedAt = performance.now();
                }
            } else if (probe.staleOpenedAt !== null) {
                probe.maxStaleWindowMs = Math.max(
                    probe.maxStaleWindowMs,
                    performance.now() - probe.staleOpenedAt
                );
                probe.staleOpenedAt = null;
            }
        } catch (_) {
            probe.errors += 1;
        } finally {
            probe.inFlight -= 1;
        }
    }

    async function fetchStockState() {
        state.stock = await requestJSON("/api/purchase-lab/" + state.materialId + "/state");
        if (!state.record) {
            byId("purchase-stock-summary").textContent =
                "MySQL " + stockText(state.stock.mysqlStock) + " · Redis " + stockText(state.stock.redisStock);
        }
        return state.stock;
    }

    async function resetExperiment() {
        var payload = await requestJSON("/api/purchase-lab/" + state.materialId + "/reset", {
            method: "POST",
            body: "{}"
        });
        state.stock = payload.state;
        return payload.state;
    }

    function requestID() {
        return "purchase-web-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 10);
    }

    async function pollRun(id) {
        var deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            var run = await requestJSON("/api/purchase-lab/runs/" + encodeURIComponent(id));
            state.liveRun = run;
            setExecutionMode("executing",
                run.status === "waiting_consumer" ?
                    "后端真实购买已响应，正在等待 Consumer 完成失效；回放尚未开始。" :
                    "后端正在等待 Outbox / MQ 完成真实失效；回放尚未开始。");
            if (!runningStatus(run)) {
                return run;
            }
            await new Promise(function (resolve) { window.setTimeout(resolve, 250); });
        }
        throw new Error("等待 Outbox / Consumer 完成超时");
    }

    async function ensureFinalCacheView(run) {
        if (!run || run.status !== "completed") {
            return run;
        }
        // 停止发新样本并等待在途查询排空，再以真实 Cached 查询回填最终 DTO；
        // 这仍属于本轮真实实验收尾，后续回放不会再进入该函数。
        stopProbeScheduling();
        await waitForProbeDrain();
        await runProbeRequest();
        await waitForProbeDrain();
        var latestState = await fetchStockState();
        run.finalMySQLStock = latestState.mysqlStock;
        run.finalRedisStock = latestState.redisStock;
        return run;
    }

    function buildRecord(run, baseline) {
        var probe = snapshotProbe();
        return {
            playbackVersion: 2,
            strategy: state.strategy,
            materialId: state.materialId,
            materialName: state.profile.name,
            frozenAt: new Date().toISOString(),
            baseline: clone(baseline || {}),
            run: clone(run),
            probe: probe,
            purchaseP99Ms: Number(run.purchaseP99Ms || 0),
            purchaseLatencyMs: Number(run.purchaseLatencyMs || 0),
            invalidationLatencyMs: Number(run.cacheInvalidationLatencyMs || 0),
            oldReadCount: probe.oldReads,
            maxStaleWindowMs: probe.maxStaleWindowMs,
            finalMySQLStock: run.finalMySQLStock,
            finalRedisStock: run.finalRedisStock,
            consistent: currentConsistency(run) === true,
            probeSamples: probe.completed,
            redisHits: probe.hits,
            redisMisses: probe.misses + probe.fallbacks,
            retryCount: Number(run.retryCount || 0)
        };
    }

    function saveRecord(record) {
        if (!resultStore || !record || !record.run || record.run.status !== "completed") {
            return record;
        }
        return resultStore.save(record);
    }

    function loadReplayRecord(record, options) {
        options = options || {};
        clearReplayTimer();
        state.record = clone(record);
        state.liveRun = clone(record.run);
        setSelectedStrategy(record.strategy);
        state.replay.index = Math.max(0, Math.min(5, Number(options.index || 0)));
        state.replay.furthest = options.furthest === undefined ?
            (options.autoplay ? 0 : 5) : Math.max(0, Math.min(5, Number(options.furthest)));
        state.replay.speed = [0.5, 1, 2].indexOf(Number(options.speed)) >= 0 ? Number(options.speed) : 1;
        state.replay.playing = !!options.autoplay;
        setExecutionMode(options.autoplay ? "replaying" : (state.replay.index === 5 ? "result" : "paused"),
            options.autoplay ?
                "真实执行已完整结束；现在只按保存 trace 回放，每个 1x 步骤停留 1.8 秒。" :
                "正在读取已保存 trace；回看不会调用购买接口或修改库存。");
        renderPlaybackFrame(state.replay.index, { advance: true });
        if (options.autoplay) {
            scheduleReplayAdvance();
        }
    }

    async function startExperiment() {
        if (state.executionMode === "executing" || !state.materialId || !state.strategy) {
            if (!state.strategy) {
                showToast("请先选择同步失效或 Outbox + MQ 异步失效。", "error");
            }
            return;
        }
        clearReplayTimer();
        resetIdleVisuals();
        setExecutionMode("executing",
            "正在真实重置实验库存并执行 150 个购买请求；此阶段没有回放动画。");
        byId("allegory-status").textContent = "正在真实执行";
        byId("topology-status").textContent = "REAL EXECUTION";
        byId("stage-kicker").textContent = "REAL EXECUTION";
        byId("stage-title").textContent = "正在真实执行，尚未开始回放";
        byId("stage-summary").textContent =
            "页面正在等待购买、缓存失效和查询探针全部结束；取得完整 trace 前不会切换时间线画面。";
        byId("control-status").textContent = "真实执行进行中；回放控制暂不可用。";
        byId("result-status").textContent = "正在真实执行";
        try {
            var baseline = await resetExperiment();
            startProbe();
            var id = requestID();
            var run = await requestJSON("/api/purchase-lab/" + state.materialId + "/run", {
                method: "POST",
                body: JSON.stringify({
                    requestId: id,
                    strategy: state.strategy,
                    purchaseCount: PURCHASE_COUNT,
                    queryCount: 0
                })
            });
            state.liveRun = run;
            if (runningStatus(run)) {
                run = await pollRun(id);
            }
            run = await ensureFinalCacheView(run);
            stopProbe();
            var record = buildRecord(run, baseline);
            var saved = saveRecord(record);
            renderSavedResults();
            loadReplayRecord(saved || record, { autoplay: true, index: 0, furthest: 0, speed: 1 });
            showToast(run.status === "completed" ?
                "真实执行已完成，正在按本轮 trace 回放。" :
                "真实执行返回失败状态，正在回放已取得的证据。",
            run.status === "completed" ? "success" : "error");
        } catch (error) {
            stopProbe();
            clearReplayTimer();
            state.replay.playing = false;
            setExecutionMode("error",
                "真实执行未能返回完整 trace：" + error.message + "。页面没有启动回放。");
            var first = document.querySelector("[data-replay-step='0']");
            first.dataset.status = "failed";
            first.classList.add("is-current");
            first.querySelector("[data-step-status]").textContent = "failed";
            byId("stage-kicker").textContent = "REAL EXECUTION FAILED";
            byId("stage-title").textContent = "后端真实执行失败";
            byId("stage-summary").textContent = error.message;
            byId("purchase-fault-banner").hidden = false;
            byId("purchase-fault-title").textContent = "真实执行失败";
            byId("purchase-fault-copy").textContent = error.message;
            showToast(error.message, "error");
        } finally {
            renderHeaderAndControls();
        }
    }

    function chooseStrategy(strategy) {
        if (state.executionMode === "executing") {
            return;
        }
        setSelectedStrategy(strategy);
        resetIdleVisuals();
    }

    function createSavedCard(record) {
        var card = document.createElement("button");
        card.type = "button";
        card.className = "purchase-saved-card";
        var name = document.createElement("small");
        var title = document.createElement("strong");
        var details = document.createElement("span");
        name.textContent = strategyNames[record.strategy] || record.strategy;
        title.textContent = "查看" + (record.strategy === "sync-invalidate" ? "同步失效" : "异步失效") + "过程";
        details.textContent = "P99 " + formatMS(record.purchaseP99Ms) + " · 旧读 " +
            record.oldReadCount + " · 窗口 " + formatMS(record.maxStaleWindowMs);
        card.disabled = !(record.run && record.probe);
        if (card.disabled) {
            details.textContent += " · 旧版本未保存 trace";
        }
        card.addEventListener("click", function () {
            loadSavedStrategy(record.strategy);
        });
        card.appendChild(name);
        card.appendChild(title);
        card.appendChild(details);
        return card;
    }

    function renderSavedResults() {
        var saved = resultStore ? resultStore.list() : {};
        var sync = saved["sync-invalidate"];
        var asyncRecord = saved["outbox-mq-invalidate"];
        if (sync && Number(sync.materialId) !== state.materialId) {
            sync = null;
        }
        if (asyncRecord && Number(asyncRecord.materialId) !== state.materialId) {
            asyncRecord = null;
        }
        var completed = [sync, asyncRecord].filter(Boolean);
        var section = byId("purchase-saved-results");
        var grid = byId("purchase-saved-grid");
        section.hidden = completed.length === 0;
        grid.replaceChildren();
        completed.forEach(function (record) {
            grid.appendChild(createSavedCard(record));
        });
        byId("purchase-side-by-side").hidden = !(sync && asyncRecord);
        if (sync && asyncRecord) {
            byId("compare-sync-p99").textContent = formatMS(sync.purchaseP99Ms);
            byId("compare-async-p99").textContent = formatMS(asyncRecord.purchaseP99Ms);
            byId("compare-sync-old").textContent = String(sync.oldReadCount);
            byId("compare-async-old").textContent = String(asyncRecord.oldReadCount);
            byId("compare-sync-window").textContent = formatMS(sync.maxStaleWindowMs);
            byId("compare-async-window").textContent = formatMS(asyncRecord.maxStaleWindowMs);
            byId("compare-sync-consistency").textContent = sync.consistent ? "一致" : "未一致";
            byId("compare-async-consistency").textContent = asyncRecord.consistent ? "一致" : "未一致";
        }
    }

    function loadSavedStrategy(strategy) {
        var saved = resultStore ? resultStore.list() : {};
        var record = saved[strategy];
        if (!record || Number(record.materialId) !== state.materialId || !record.run || !record.probe) {
            showToast("这条旧结果没有保存完整 trace，无法回看过程。", "error");
            return;
        }
        loadReplayRecord(record, { autoplay: false, index: 0, furthest: 5, speed: 1 });
        showToast("已载入保存的实验过程；没有调用购买接口。");
    }

    function runOtherStrategy() {
        var next = state.strategy === "sync-invalidate" ?
            "outbox-mq-invalidate" : "sync-invalidate";
        setSelectedStrategy(next);
        resetIdleVisuals();
        startExperiment();
    }

    function viewFullProcess() {
        if (!state.record) {
            return;
        }
        pauseReplay("已回到完整过程的第一步；可点击时间线或使用前后步继续回看。");
        state.replay.furthest = 5;
        renderPlaybackFrame(0, { advance: false });
    }

    function openTechnicalDetails() {
        var dialog = byId("technical-details-dialog");
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
    }

    function bindEvents() {
        document.querySelectorAll(".purchase-strategy-card").forEach(function (button) {
            button.addEventListener("click", function () {
                chooseStrategy(button.dataset.strategy);
            });
        });
        document.querySelectorAll("[data-replay-step]").forEach(function (button) {
            button.addEventListener("click", function () {
                chooseTimelineStep(Number(button.dataset.replayStep));
            });
        });
        document.querySelectorAll("[data-replay-speed]").forEach(function (button) {
            button.addEventListener("click", function () {
                setReplaySpeed(Number(button.dataset.replaySpeed));
            });
        });
        byId("start-purchase-run").addEventListener("click", startExperiment);
        byId("replay-previous").addEventListener("click", function () { stepReplay(-1); });
        byId("replay-toggle").addEventListener("click", playReplay);
        byId("replay-next").addEventListener("click", function () { stepReplay(1); });
        byId("replay-restart").addEventListener("click", restartReplay);
        byId("replay-result").addEventListener("click", jumpToResult);
        byId("view-full-process").addEventListener("click", viewFullProcess);
        byId("run-other-strategy").addEventListener("click", runOtherStrategy);
        byId("rerun-current-strategy").addEventListener("click", startExperiment);
        byId("open-technical-details").addEventListener("click", openTechnicalDetails);
        window.addEventListener("beforeunload", function () {
            stopProbe();
            clearReplayTimer();
            persistReplayPosition();
        });
    }

    function showContext(material) {
        if (!material) {
            byId("purchase-empty").hidden = false;
            byId("purchase-content").hidden = true;
            return false;
        }
        state.materialId = material.id;
        state.profile = material.profile;
        rememberMaterial(material.profile);
        byId("purchase-current-code").textContent = material.profile.code;
        byId("purchase-current-name").textContent = material.profile.name;
        byId("story-material-name").textContent = material.profile.name;
        byId("purchase-query-link").href = "/lab?material=" + encodeURIComponent(material.profile.code);
        byId("back-to-query").href = "/lab?material=" + encodeURIComponent(material.profile.code);
        byId("purchase-empty").hidden = true;
        byId("purchase-content").hidden = false;
        return true;
    }

    function restoreSavedReplay() {
        var cursor = readReplayPosition();
        var saved = resultStore ? resultStore.list() : {};
        if (!cursor || Number(cursor.materialId) !== state.materialId) {
            return false;
        }
        var record = saved[cursor.strategy];
        if (!record || !record.run || !record.probe || record.run.requestId !== cursor.requestId) {
            return false;
        }
        loadReplayRecord(record, {
            autoplay: false,
            index: cursor.index,
            furthest: Math.max(Number(cursor.furthest || 0), Number(cursor.index || 0)),
            speed: cursor.speed
        });
        setExecutionMode(cursor.index === 5 ? "result" : "paused",
            "已从本页会话恢复上次回放位置；没有调用购买接口。");
        return true;
    }

    async function init() {
        if (!showContext(incomingMaterial())) {
            return;
        }
        bindEvents();
        renderSavedResults();
        try {
            await fetchStockState();
        } catch (error) {
            byId("purchase-stock-summary").textContent = "库存读取失败";
            showToast(error.message, "error");
        }
        if (!restoreSavedReplay()) {
            resetIdleVisuals();
        }
    }

    init();
}());
