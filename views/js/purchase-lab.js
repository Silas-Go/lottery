(function () {
    "use strict";

    var REPLAY_POSITION_KEY = "silas.cache-aside.purchase-replay-position.v3";
    // 旧版多报告归档只用于启动时清理；当前每种方案只保留最近一次结果。
    var REPORT_ARCHIVE_KEY = "silas.cache-aside.purchase-report-archive.v1";
    var PURCHASE_COUNT = 150;
    var PROBE_RATE = 20;
    var PROBE_INTERVAL_MS = 1000 / PROBE_RATE;
    var LIVE_RUN_POLL_MS = 160;
    var LIVE_RUN_TIMEOUT_MS = 5 * 60 * 1000;
    // 业务快照仍以 160ms 读取真实进度；教学回放是另一只时钟，必须给中文解释足够阅读时间。
    var REPLAY_STEP_MS = 6000;
    var ACTIVE_STATUSES = ["running", "waiting_outbox", "waiting_consumer"];
    var resultStore = window.SilasPurchaseLabResults;
    var recentResults = {};
    var profiles = {
        4: { name: "星髓" }
    };
    var strategyNames = {
        "sync-invalidate": "同步删除缓存",
        "outbox-mq-invalidate": "Outbox + MQ 异步失效"
    };
    var stageModel = window.SilasPurchaseStages;
    var stageNames = stageModel.order("").map(function (id) { return stageModel.names[id]; });
    function stageId(index) { return stageModel.order(state.strategy)[index]; }
    function stageState(record, index, live) {
        var model = stageModel.inspect(record, live);
        return model.stages[model.ids[index]];
    }

    var replayStatusNames = {
        waiting: "等待",
        running: "进行中",
        completed: "已完成",
        failed: "失败",
        unobserved: "未观测"
    };
    // 同一张结果表始终读取冻结记录；回放游标只控制上方执行图。
    var resultsFocusRequestId = null;
    var evidenceRecord = null;
    // executionMode 表示“真实执行 / 回放 / 暂停 / 结果”边界；replay 只保存前端游标。
    // 只有 startExperiment 会进入购买与重置接口，任何回放控制都不能复用该入口。
    var state = {
        materialId: null,
        profile: null,
        strategy: null,
        stock: null,
        runObservedAt: null,
        observationHalted: false,
        inventoryObservation: { firstMismatch: null },
        liveRun: null,
        liveBaseline: null,
        liveStage: -1,
        record: null,
        executionMode: "idle",
        executionDetail: "",
        probe: createProbeState(),
        replay: {
            index: 0,
            furthest: -1,
            playing: false,
            timer: null
        }
    };

    function byId(id) {
        return document.getElementById(id);
    }

    // 仪表盘直接显示观测值，不在两个真实值之间插入动画数字。
    function setGameMetric(id, value) {
        var element = byId(id);
        if (element) {
            element.textContent = String(value === undefined || value === null ? "—" : value);
        }
    }

    function renderInventoryMonitor() {
        var live = state.executionMode === "executing";
        var interrupted = state.executionMode === "error";
        var record = live ? null : state.record;
        var run = live || interrupted ? state.liveRun : record && record.run;
        var replay = !!record && (state.executionMode === "replaying" || state.executionMode === "paused");
        var evidence = replay ? stageEvidence(record, state.replay.index) : null;
        var mysql = evidence ? evidence.mysql : (run ? run.finalMySQLStock : state.stock && state.stock.mysqlStock);
        var redis = evidence ? evidence.redis : (run ? run.finalRedisStock : state.stock && state.stock.redisStock);
        var probe = live || interrupted ? state.probe : (record ? record.probe : createProbeState());
        var oldReads = Number(probe.oldReads || 0);
        var known = mysql !== null && mysql !== undefined && Number.isFinite(Number(mysql));
        var cached = redis !== null && redis !== undefined && Number.isFinite(Number(redis));
        var mismatch = known && cached && Number(mysql) !== Number(redis);
        var stale = live && (state.observationHalted || (state.runObservedAt && Date.now() - state.runObservedAt > 2000));
        var failedProbe = live && probe.lastSampleFailed;
        var observation = record ? record.inventoryObservation || {} : state.inventoryObservation;
        // 物理缓存库存只来自 State/GetRun。查询样本 stock 可能是 MISS 后的回源结果，不能冒充 Redis 当前值。
        if (live && mismatch && !stale && !observation.firstMismatch) {
            observation.firstMismatch = {
                mysql: mysql, redis: redis,
                atMs: probe.startedAt ? Math.max(0, performance.now() - probe.startedAt) : 0
            };
        }
        var firstOld = (probe.samples || []).find(function (sample) { return sample.old === true; });
        var hadIncident = oldReads > 0 || !!observation.firstMismatch;
        var done = !!run && run.status === "completed" && !replay && !live;
        var tone = !known || stale || interrupted ? "unknown" :
            (mismatch ? "mismatch" : (!cached ? "empty" :
                (failedProbe ? "checking" : (hadIncident && done ? "recovered" : "consistent"))));
        var label = {
            unknown: interrupted ? "观测已中断" : (stale ? "快照待刷新" : "等待观测"),
            mismatch: "库存不一致",
            empty: "缓存未命中",
            checking: "探针异常",
            consistent: "库存一致",
            recovered: "库存已恢复"
        }[tone];
        var panel = byId("inventory-monitor");
        panel.dataset.state = tone;
        setGameMetric("stage-mysql-stock", known ? formatNumber(mysql) : "—");
        setGameMetric("stage-redis-stock", cached ? formatNumber(redis) : (redis === null ? "未缓存" : "—"));
        byId("stage-redis-stock").dataset.empty = String(!cached);
        byId("inventory-symbol").textContent = tone === "mismatch" ? "≠" :
            (tone === "consistent" || tone === "recovered" ? "=" : "…");
        byId("inventory-status-text").textContent = label;
        byId("inventory-delta").textContent = tone === "mismatch" ?
            "库存差值 " + formatNumber(Number(redis) - Number(mysql)) :
            (tone === "empty" ? "等待后续查询回填" :
                (tone === "unknown" ? "尚无有效库存对照" :
                    (tone === "checking" ? "等待有效样本复核" : "MySQL / Redis 已对齐")));
        if (replay && stageId(state.replay.index) !== "result") {
            var currentStage = stageId(state.replay.index);
            panel.dataset.state = currentStage === "invalidate" && evidence.status === "completed" ? "empty" : "unknown";
            byId("inventory-status-text").textContent = currentStage === "invalidate" && evidence.status === "completed" ?
                "旧缓存已删除" : (currentStage === "rebuild" && evidence.status === "completed" ? "缓存已重建" : "阶段证据");
            byId("inventory-symbol").textContent = "…";
            byId("inventory-delta").textContent = currentStage === "rebuild" ? "最终一致性留到第 06 步检查" :
                (currentStage === "invalidate" ? "DEL 动作后态 · 不代表当前库存快照" : "批次 Trace 采样值 · 非逐笔事务快照");
        }
        byId("inventory-source").textContent = replay ? "阶段事件证据 · 下方统计为全轮冻结值" :
            (record ? "已冻结的实验结果" : (interrupted ? "最后一次库存快照 · 非实时" :
                (live ? (stale ? "最后一次库存快照 · 等待刷新" :
                    (run ? "实时库存快照 · 160 ms 更新" : "实验基线 · 正在准备")) : "当前库存快照 · 实验未开始")));

        byId("inventory-incident").hidden = !hadIncident;
        byId("incident-title").textContent = tone === "mismatch" ? "检测到不一致" :
            (tone === "recovered" ? "本轮曾出现不一致 · 现已恢复" :
                (tone === "empty" ? "旧缓存已删除 · 等待回填" : "本轮不一致证据"));
        var incident = observation.firstMismatch;
        byId("incident-evidence").textContent = incident ?
            "首次库存差异：MySQL " + stockText(incident.mysql) + " / Redis " + stockText(incident.redis) :
            (firstOld ? "首次旧读：查询返回 " + stockText(firstOld.stock) +
                "，当时 MySQL " + stockText(firstOld.authoritativeStock) : "");
        var requested = Number(run && run.purchaseRequested || PURCHASE_COUNT);
        var processed = run ? (run.purchaseProcessed === undefined ?
            (run.criticalPathCompleted ? requested : 0) : Number(run.purchaseProcessed)) : 0;
        byId("metric-requests").textContent = formatNumber(processed) + " / " + formatNumber(requested);
        byId("metric-request-note").textContent = run ?
            (run.criticalPathCompleted ? "请求已全部返回" : "后端持续处理") : "等待开始";
        setGameMetric("game-success-count", formatNumber(run && run.purchaseSucceeded || 0));
        byId("metric-sold-out").textContent = "售罄 " + formatNumber(run && run.soldOutRequests || 0) +
            " · 幂等拦截 " + formatNumber(run && run.duplicateRequests || 0);
        setGameMetric("game-old-read-count", formatNumber(oldReads));
        byId("metric-inconsistency").dataset.incident = String(hadIncident);
        byId("metric-probes").textContent = "有效探针 " + formatNumber(probe.completed) +
            (Number(probe.errors) > 0 ? " · 错误 " + formatNumber(probe.errors) : "");
        var recovery = interrupted ? "观测中断" : (!run ? "待观测" :
            (run.status === "failed" || state.executionMode === "error" ? "执行失败" :
                (stale || failedProbe ? "观测异常" :
                    (mismatch ? "等待恢复" : (!cached ? "等待回填" :
                        (done ? (hadIncident ? "已恢复" : "最终一致") :
                            (replay ? "回放快照" : "持续观测")))))));
        byId("metric-recovery").textContent = recovery;
        var windowMS = live ? probeWindowMS() : Number(probe.maxStaleWindowMs || 0);
        byId("metric-window").textContent = "最长旧读窗口 " + (windowMS > 0 ? formatMS(windowMS) : "—");
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
            lastMiss: null,
            startedAt: null
        };
    }

    function incomingMaterial() {
        return { id: 4, profile: profiles[4] };
    }

    function incomingPurchasePlan() {
        var query = new URLSearchParams(window.location.search);
        var strategy = query.get("strategy") || "";
        var validStrategy = Object.prototype.hasOwnProperty.call(strategyNames, strategy) ?
            strategy : "";
        return {
            strategy: validStrategy,
            // 从导览新进入时先选方案；历史对比仍保留，但不能把用户直接带进旧回放。
            fresh: query.get("intent") === "new"
        };
    }

    function updateFreshPurchasePlanStrategy(strategy) {
        var nextURL = new URL(window.location.href);
        if (nextURL.searchParams.get("intent") !== "new") {
            return;
        }
        nextURL.searchParams.set("strategy", strategy);
        window.history.replaceState(null, "", nextURL.toString());
    }

    function consumeFreshPurchasePlan() {
        var nextURL = new URL(window.location.href);
        if (nextURL.searchParams.get("intent") !== "new") {
            return;
        }
        nextURL.searchParams.delete("intent");
        if (state.strategy) {
            nextURL.searchParams.set("strategy", state.strategy);
        }
        window.history.replaceState(null, "", nextURL.toString());
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
                furthest: state.replay.furthest
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

    function formatDateTime(value) {
        if (!value) {
            return "—";
        }
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return "—";
        }
        return date.toLocaleString("zh-CN", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        });
    }

    function formatTraceMoment(step, durationLabel) {
        if (!step) {
            return "未记录";
        }
        var at = Number(step.atMs);
        var duration = Number(step.durationMs);
        var parts = [];
        if (Number.isFinite(at) && at >= 0) {
            parts.push("T+" + (at === 0 ? "0 ms" : formatMS(at)));
        }
        if (durationLabel && Number.isFinite(duration) && duration > 0) {
            parts.push(durationLabel + " " + formatMS(duration));
        }
        return parts.length ? parts.join(" · ") : "已记录阶段证据";
    }

    function outboxTimeRange(run, key) {
        var values = (run && Array.isArray(run.outbox) ? run.outbox : [])
            .map(function (event) { return event[key]; })
            .filter(Boolean)
            .map(function (value) { return new Date(value); })
            .filter(function (date) { return !Number.isNaN(date.getTime()); })
            .sort(function (left, right) { return left.getTime() - right.getTime(); });
        if (!values.length) {
            return run && run.strategy === "sync-invalidate" ? "本方案不使用" : "未记录";
        }
        if (values.length === 1 || values[0].getTime() === values[values.length - 1].getTime()) {
            return formatDateTime(values[0]);
        }
        return formatDateTime(values[0]) + " ～ " + formatDateTime(values[values.length - 1]) +
            "（" + values.length + " 项）";
    }

    function probeRecoveryText(probe) {
        var samples = probe && Array.isArray(probe.samples) ? probe.samples : [];
        var lastOldIndex = -1;
        for (var index = 0; index < samples.length; index += 1) {
            if (samples[index].old === true) {
                lastOldIndex = index;
            }
        }
        if (lastOldIndex < 0) {
            return "探针未观察到旧缓存窗口";
        }
        for (var next = lastOldIndex + 1; next < samples.length; next += 1) {
            if (samples[next].old === false) {
                return "探针 T+" + formatMS(samples[next].observedAtMs) + " 观察到恢复";
            }
        }
        return "本轮结束前未观察到恢复";
    }

    function probeEvidenceQuality(probe) {
        var completed = Number(probe && probe.completed || 0);
        var errors = Number(probe && probe.errors || 0);
        var samples = probe && Array.isArray(probe.samples) ? probe.samples.length : 0;
        return {
            completed: completed,
            errors: errors,
            samples: samples,
            usable: completed >= 5 && samples >= Math.min(5, completed) &&
                errors <= Math.max(1, Math.floor(completed * 0.25))
        };
    }

    function probesAreComparable(syncProbe, asyncProbe) {
        var syncQuality = probeEvidenceQuality(syncProbe);
        var asyncQuality = probeEvidenceQuality(asyncProbe);
        if (!syncQuality.usable || !asyncQuality.usable) {
            return false;
        }
        var larger = Math.max(syncQuality.completed, asyncQuality.completed);
        var smaller = Math.min(syncQuality.completed, asyncQuality.completed);
        return larger > 0 && smaller / larger >= 0.5;
    }

    function stockText(value) {
        return value === null || value === undefined ? "未缓存" : formatNumber(value);
    }

    function probeSourceName(source) {
        var names = {
            "redis-hit": "Redis 命中",
            "redis-miss": "Redis 未命中",
            "mysql-fallback": "MySQL 回源"
        };
        return names[String(source || "").toLowerCase()] || "未知来源";
    }

    function runtimeStatusName(status) {
        var names = {
            running: "运行中",
            waiting_outbox: "等待 Outbox",
            waiting_consumer: "等待消费者",
            completed: "已完成",
            failed: "失败",
            pending: "待处理",
            publishing: "发布中",
            published: "已发布",
            retry: "等待重试",
            cancelled: "已取消",
            "not-used": "未使用",
            "waiting-publisher": "等待发布器",
            "waiting-consumer": "等待消费者",
            "publisher-retrying": "发布器重试中",
            consumed: "已消费"
        };
        return names[String(status || "").toLowerCase()] || String(status || "—");
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
        var summary = {
            total: events.length,
            pending: 0,
            publishing: 0,
            published: 0,
            completed: 0,
            retry: 0,
            failed: 0
        };
        events.forEach(function (event) {
            if (event.status === "completed") {
                summary.completed += 1;
            } else if (event.status === "published") {
                summary.published += 1;
            } else if (event.status === "publishing") {
                summary.publishing += 1;
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

    // 当前步骤讲解只在“业务阶段”变化时替换静态文字；完整 trace 继续留在本轮执行记录中。
    // 这样真实执行可以很快，教学文字仍保持稳定，避免把业务时钟错误地当成阅读时钟。
    function setStepExplanation(details) {
        var panel = byId("system-subtitle");
        if (!panel) {
            return;
        }
        details = details || {};
        var mode = details.mode;
        if (!mode) {
            if (state.executionMode === "executing") {
                mode = "实时执行";
            } else if (state.executionMode === "replaying") {
                mode = "自动回放";
            } else if (state.executionMode === "paused") {
                mode = "单步讲解";
            } else if (state.executionMode === "result") {
                mode = "实验结果";
            } else if (state.executionMode === "error") {
                mode = "执行失败";
            } else {
                mode = "准备";
            }
        }
        var phase = details.phase || "idle";
        var tone = details.tone || "idle";
        var staticSignature = [
            phase,
            details.term,
            details.action,
            details.reason,
            tone,
            mode,
            details.final ? "final" : "next"
        ].join("\u0000");
        if (panel.dataset.staticSignature !== staticSignature) {
            panel.dataset.staticSignature = staticSignature;
            panel.dataset.phase = phase;
            panel.dataset.tone = tone;
            byId("system-step-mode").textContent = mode;
            byId("system-subtitle-term").textContent = details.term || "当前步骤";
            byId("system-subtitle-line").textContent = details.action || "—";
            byId("system-subtitle-reason").textContent = details.reason || "—";
            // 单独的隐藏播报区只在语义阶段变化时更新，并同时读出步骤名与核心动作。
            byId("system-subtitle-announcement").textContent =
                (details.term || "当前步骤") + "。发生了什么：" + (details.action || "—");
        }
    }

    function currentMaterialName() {
        return state.profile ? state.profile.name : "当前材料";
    }

    function outboxInvalidationTiming(run) {
        var events = run && Array.isArray(run.outbox) ? run.outbox : [];
        var created = events
            .map(function (event) { return event.createdAt; })
            .filter(Boolean)
            .map(function (value) { return new Date(value).getTime(); })
            .filter(Number.isFinite)
            .sort(function (left, right) { return left - right; });
        var invalidated = events
            .map(function (event) { return event.invalidatedAt; })
            .filter(Boolean)
            .map(function (value) { return new Date(value).getTime(); })
            .filter(Number.isFinite)
            .sort(function (left, right) { return left - right; });
        if (!invalidated.length) {
            return null;
        }
        // createdAt 与 invalidatedAt 都由同一批 Outbox 行持久化，避免 run 从数据库
        // 恢复时重建 executedAt 导致“全部确认用时”被历史回放时间污染。
        var origin = created.length ? created[0] : invalidated[0];
        return {
            firstMs: Math.max(0, invalidated[0] - origin),
            allMs: Math.max(0, invalidated[invalidated.length - 1] - origin)
        };
    }

    function renderIdleStepExplanation() {
        if (state.strategy === "sync-invalidate") {
            setStepExplanation({
                phase: "idle-sync",
                term: "同步删除缓存",
                action: "事务提交后先删除 Redis 旧副本，再返回购买结果。",
                reason: "把缓存失效留在请求内，让后续查询更快看到最新库存。",
                evidence: "权威数据：MySQL · 缓存动作：Redis DEL",
                next: "开始后先释放 150 个购买请求。",
                tone: "critical"
            });
            return;
        }
        if (state.strategy === "outbox-mq-invalidate") {
            setStepExplanation({
                phase: "idle-async",
                term: "Outbox + MQ 异步失效",
                action: "事务同时写入 Outbox，购买响应不等待后台删除缓存。",
                reason: "把删缓存移出请求关键路径，并用可靠待办承接失败重试。",
                evidence: "订单 Consumer 与缓存失效 Consumer 已分离",
                next: "开始后先释放 150 个购买请求。",
                tone: "async"
            });
            return;
        }
        setStepExplanation({
            phase: "idle",
            term: "MySQL 是权威数据，Redis 是查询副本",
            action: "MySQL 保存真实库存，Redis 保存一份可删除、可回填的查询副本。",
            reason: "删除缓存不会删除库存，只会让下一次查询重新加载最新数据。",
            evidence: "MySQL：真实库存 · Redis：查询副本",
            next: "先选择同步或异步缓存失效方案。",
            tone: "idle"
        });
    }

    function renderCompletedAsyncExplanation(run, outbox, context, resultProbe) {
        var timing = outboxInvalidationTiming(run);
        var total = outbox.total || Number(run.purchaseSucceeded || 0);
        var timingEvidence = timing ?
            ("首次 DEL：" + formatMS(timing.firstMs) + " · 全部确认：" + formatMS(timing.allMs)) :
            "失效时间：已完成";
        var isResult = context === "result";
        var probe = resultProbe || {};
        var consistent = currentConsistency(run);
        var resultEvidence = "MySQL：" + stockText(run.finalMySQLStock) +
            " · Redis：" + stockText(run.finalRedisStock) +
            " · 旧读：" + Number(probe.oldReads || 0) +
            " · 最大窗口：" + formatMS(Number(probe.maxStaleWindowMs || 0));
        var resultConclusion = consistent === true ?
            "最终一致；异步方案缩短请求关键路径，代价是允许短暂旧读，并依靠 Outbox + MQ 收敛。" :
            (consistent === false ?
                "最终库存仍未一致，本轮不能盖章通过；需要检查失效重试与探针结果。" :
                "Redis 最终仍是 MISS；MySQL 账本有效，但需再次查询确认缓存回填结果。");
        setStepExplanation({
            phase: isResult ? "result-async" : "async-invalidation-complete",
            term: isResult ?
                (consistent === true ? "异步购买实验：最终一致" : "异步购买实验：需要复核") :
                "缓存失效链路完成",
            action: "缓存失效 Consumer 已校验事件、执行 Redis DEL 并完成 ACK。",
            reason: "所有消息指向同一条材料缓存；消息数量不等于缓存 Key 数量。",
            evidence: isResult ? resultEvidence :
                ("消息：" + outbox.completed + "/" + total + " · Key：1 · " + timingEvidence +
                    " · 重试：" + Number(run.retryCount || 0)),
            next: isResult ? resultConclusion :
                (context === "replay" ?
                    "查看一致性探针是否观察到短暂旧值。" :
                    "真实执行已收敛，结束后可逐步回看。"),
            tone: "complete",
            final: isResult
        });
    }

    function renderStageExplanation(record, index, live) {
        var stage = stageState(record, index, live);
        setStepExplanation({
            phase: (live ? "live-" : "replay-") + stage.id + "-" + stage.status,
            term: String(index + 1).padStart(2, "0") + " · " + stage.title,
            action: stage.summary,
            reason: stage.id === "invalidate" ? "DEL 只删除旧副本，不负责回源或重建。" :
                (stage.id === "rebuild" ? "只认删除之后的真实 MISS 与 SET 结果；缺少证据就保留未观测。" :
                    "各阶段只读取后端 Trace、Outbox 和真实查询样本。"),
            tone: stage.status === "failed" ? "error" : (stage.id === "rebuild" ? "probe" : "critical"),
            final: stage.id === "result"
        });
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

    function setFlowEdge(id, edgeState) {
        var edge = byId(id);
        if (edge) {
            edge.dataset.state = edgeState;
        }
    }

    function setPhaseState(id, phaseState, copy) {
        var phase = byId(id);
        if (!phase) {
            return;
        }
        phase.dataset.phaseState = phaseState;
        var status = byId(id === "critical-phase" ? "critical-phase-status" : "async-phase-status");
        if (status && copy) {
            status.textContent = copy;
        }
    }

    function focusFlowNode(id, phase, title, detail) {
        document.querySelectorAll("[data-flow-node]").forEach(function (node) {
            node.classList.toggle("is-current", Boolean(id && node.id === id));
        });
        if (phase === "async") {
            setPhaseState("critical-phase", "completed", "请求关键路径已经结束");
            setPhaseState("async-phase", "active", detail || "缓存失效事件正在推进");
        } else if (phase === "critical") {
            setPhaseState("critical-phase", "active", detail || "请求关键路径正在推进");
            setPhaseState("async-phase", state.strategy === "outbox-mq-invalidate" ? "locked" : "unused",
                state.strategy === "outbox-mq-invalidate" ? "等待事务提交后展开" : "同步方案不进入异步支线");
        } else if (phase === "complete") {
            setPhaseState("critical-phase", "completed", "请求关键路径已经结束");
            setPhaseState("async-phase", state.strategy === "outbox-mq-invalidate" ? "completed" : "unused",
                state.strategy === "outbox-mq-invalidate" ? "缓存失效支线已经完成" : "同步方案不进入异步支线");
        }
        if (title) {
            byId("allegory-status").textContent = title;
        }
    }

    function renderProbeStream(probe, mode) {
        probe = probe || state.probe || createProbeState();
        var latest = probe.latest;
        var active = mode === "active" || probe.active === true;
        var completed = Number(probe.completed || 0);
        var oldReads = Number(probe.oldReads || 0);
        var windowMS = probe === state.probe ? probeWindowMS() : Number(probe.maxStaleWindowMs || 0);
        byId("probe-stream").dataset.state = active ? "active" : (completed ? "completed" : "idle");
        byId("probe-live-state").textContent = active ?
            ("正在采样 · 已完成 " + completed + " 次") : (completed ? "采样已冻结" : "尚未采样");
        setNode("node-probe", active ? "running" : (completed ? "success" : "idle"),
            active ? "库存探针 · 采样中" : "库存探针", completed + " 个样本", "旧读 " + oldReads);
        setNode("node-probe-redis", oldReads ? "retry" : (completed ? "success" : "idle"),
            latest ? probeSourceName(latest.source) : "Redis / MySQL 对比",
            "命中 " + Number(probe.hits || 0),
            "未命中 " + (Number(probe.misses || 0) + Number(probe.fallbacks || 0)));
        byId("story-redis-stock").textContent = latest ? stockText(latest.stock) : "—";
        byId("probe-live-mysql").textContent = latest ? stockText(latest.authoritativeStock) : "—";
        byId("probe-live-old").textContent = latest ? (latest.old ? "观察到旧值" : "当前样本一致") : "未观察";
        byId("probe-live-old").className = latest && latest.old ? "is-old" : "";
        byId("probe-live-window").textContent = windowMS > 0 ? formatMS(windowMS) : "0 ms";

        var stream = byId("probe-sample-stream");
        stream.replaceChildren();
        (probe.samples || []).slice(-8).forEach(function (sample) {
            var item = document.createElement("li");
            item.dataset.old = String(sample.old === true);
            item.title = String(sample.source || "unknown") + " · Redis " + sample.stock +
                " · MySQL " + sample.authoritativeStock;
            item.appendChild(document.createElement("i"));
            var value = document.createElement("span");
            value.textContent = String(sample.stock);
            item.appendChild(value);
            stream.appendChild(item);
        });
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
        if (state.executionMode === "result" && state.record && state.record.run.status === "failed") {
            return "执行失败 · 结果快照";
        }
        var labels = {
            idle: "准备实验",
            executing: "正在运行 · 实时观测",
            replaying: "正在回放实验过程",
            paused: "回放已暂停",
            result: "实验已完成 · 结果快照",
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
        var activeIndex = busy ? state.liveStage : (ready ? state.replay.index : -1);
        byId("running-phase").textContent = label + (activeIndex >= 0 ?
            " · " + (activeIndex + 1) + "/6 " + stageNames[activeIndex] : "");
        byId("running-material").textContent = state.profile ? state.profile.name : "—";
        byId("running-strategy").textContent = strategyNames[state.strategy] || "尚未选择方案";
        byId("running-strategy-code").textContent = state.strategy === "sync-invalidate" ? "A" :
            (state.strategy === "outbox-mq-invalidate" ? "B" : "—");
        byId("execution-boundary-copy").textContent = state.executionDetail ||
            (busy ? "后端正在真实扣减库存并完成失效链路；此时尚未播放任何阶段。" :
                "真实执行与回放相互分离；回放按钮只读取本轮 Trace。");
        byId("replay-position").textContent = activeIndex >= 0 ?
            ((activeIndex + 1) + " / " + stageNames.length) : "— / " + stageNames.length;
        byId("timeline-mode").textContent = label;
        byId("start-purchase-run").disabled = busy || !state.strategy;
        byId("start-purchase-run").textContent = busy ? "实验运行中…" : "开始实验";
        byId("prepare-action-hint").textContent = state.strategy ?
            "开始时重置实验库存；请勿同时运行查询压测。" :
            "请先选择一种缓存失效方案。";
        byId("replay-previous").disabled = !ready || busy || state.replay.index <= 0;
        byId("replay-next").disabled = !ready || busy || state.replay.index >= stageNames.length - 1;
        byId("replay-toggle").disabled = !ready || busy;
        byId("replay-toggle").textContent = state.replay.playing ? "暂停" : "播放";
        byId("replay-toggle").setAttribute("aria-label", state.replay.playing ? "暂停回放" : "播放回放");
        byId("replay-toggle").setAttribute("aria-pressed", String(state.replay.playing));
        document.querySelector(".purchase-replay-controls").hidden = !ready || busy;
        byId("buyers-metric-label").textContent = ready && state.replay.index === 0 ? "时间点" : "进度";
        byId("service-metric-label").textContent = ready && state.replay.index >= 1 ? "平均耗时" : "进度";
        byId("mysql-metric-label").textContent = activeIndex >= 0 && stageId(activeIndex) === "rebuild" ? "查询耗时" :
            (ready && state.replay.index >= 1 ? "提交耗时" : "进度");
        document.querySelectorAll(".purchase-strategy-card").forEach(function (button) {
            button.disabled = busy;
        });
        var resultReady = !!(state.record || evidenceRecord);
        byId("view-full-process").disabled = !resultReady || busy;
        byId("run-other-strategy").disabled = !resultReady || busy;
        byId("rerun-current-strategy").disabled = !resultReady || busy;
        document.body.dataset.purchaseStrategy = state.strategy || "unselected";
        document.body.dataset.purchaseStatus = state.executionMode;
        renderInventoryMonitor();
    }

    function renderTimeline() {
        var live = state.executionMode === "executing";
        var record = live ? liveRecord() : state.record;
        var model = stageModel.inspect(record, live);
        var selected = live ? state.liveStage : state.replay.index;
        document.querySelectorAll("[data-replay-step]").forEach(function (button) {
            var index = Number(button.dataset.replayStep);
            var stage = model.stages[model.ids[index]];
            var status = record ? stage.status : "waiting";
            // 回放的“已访问”不是业务的“已完成”；失败或未观测不能被 furthest 覆盖。
            if (!live && index > state.replay.furthest) { status = "waiting"; }
            button.querySelector("strong").textContent = stage.title;
            button.dataset.stage = stage.id;
            button.dataset.status = status;
            button.classList.toggle("is-current", !!record && index === selected);
            button.setAttribute("aria-current", record && index === selected ? "step" : "false");
            button.disabled = live || !record || index > state.replay.furthest;
            button.querySelector("[data-step-status]").textContent = replayStatusNames[status] || status;
            button.title = stage.title + " · " + (replayStatusNames[status] || status);
        });
    }

    function setSelectedStrategy(strategy) {
        state.strategy = strategy;
        stageNames = stageModel.order(strategy).map(function (id) { return stageModel.names[id]; });
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
        byId("allegory-status").textContent = record ? "等待回放" : "等待执行";
        byId("topology-status").textContent = record ? "链路已保存" : "待命";
        byId("story-redis-stock").textContent = stockText(initialRedis);
        setNode("node-buyers", "idle", "等待释放任务", "0 / 150", "150 × 1");
        setNode("node-service", "idle", "等待请求", "—", "—");
        setNode("node-mysql", "idle", "等待事务", "0 / 150", stockText(initialMySQL) + " → —");
        byId("node-mysql").querySelector("header strong").textContent = "MySQL 事务";
        setNode("node-response", "idle", "等待返回", "—", "—");
        setNode("node-sync-redis", "idle", "等待事务提交", "—", "—");
        setNode("node-outbox", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不写入" : "等待事务", "同事务", "—");
        setNode("node-worker", "idle", "等待 Outbox 记录", "0", "—");
        setNode("node-mq", "idle", "等待发布", "0", "—");
        setNode("node-consumer", "idle", "等待消息", "0 / 150", "—");
        setNode("node-async-redis", "idle", "等待缓存失效消费者", "1 个键", "0 条消息");
        ["edge-tasks-service", "edge-service-mysql", "edge-mysql-response", "edge-worker-mq",
            "edge-mq-consumer", "edge-consumer-redis"].forEach(function (edge) {
            setFlowEdge(edge, "idle");
        });
        focusFlowNode(null, "critical", record ? "链路已保存" : "等待执行", "等待购买任务");
        renderProbeStream(record && record.probe, record ? "completed" : "idle");
        byId("purchase-fault-banner").hidden = true;
    }

    function stageEvidence(record, index) {
        var stage = stageState(record, index, false);
        return Object.assign({}, stage, {
            kicker: "步骤 " + String(index + 1).padStart(2, "0") + " / 06",
            message: replayStatusNames[stage.status],
            duration: stage.evidence ? formatMS(stage.evidence.durationMs || stage.evidence.latencyMs) : "—"
        });
    }

    function stageVerdict(record, index) {
        return stageState(record, index, false).summary;
    }

    function renderStageReadout(record, index) {
        var evidence = stageEvidence(record, index);
        byId("stage-kicker").textContent = evidence.kicker;
        byId("stage-title").textContent = evidence.title;
        byId("stage-summary").textContent = evidence.summary;
        setGameMetric("game-success-count", formatNumber(record.run.purchaseSucceeded));
        setGameMetric("stage-mysql-stock", stockText(evidence.mysql));
        setGameMetric("stage-redis-stock", stockText(evidence.redis));
        setGameMetric("game-old-read-count", formatNumber(record.probe.oldReads));
        byId("stage-message-state").textContent = evidence.message;
        setGameMetric("stage-duration", evidence.duration);
        byId("game-verdict-line").textContent = stageVerdict(record, index);
        byId("purchase-stock-summary").textContent =
            "阶段证据 · MySQL " + stockText(evidence.mysql) + " · Redis " + stockText(evidence.redis);
    }

    function applyRequestFrame(record) {
        var run = record.run;
        var request = traceStep(run, ["transaction_started"]);
        byId("allegory-status").textContent = "购买任务正在进入";
        byId("topology-status").textContent = "已接收请求";
        setNode("node-buyers", "running", "150 个唯一请求正在释放", formatMS(request && request.atMs), "150 × 1");
        setNode("node-service", "running", "购买接口已接收", "—", "150 个请求");
        setNode("node-mysql", "waiting", "等待事务提交", "—", run.initialStock + " → ?");
        setFlowEdge("edge-tasks-service", "running");
        focusFlowNode("node-service", "critical", "购买服务正在编排", "请求关键路径正在推进");
        setStepExplanation({
            phase: "replay-requests",
            term: "购买任务进入服务",
            action: "一批唯一购买请求已经释放，并开始进入购买服务。",
            reason: "独立 request_id 让每次购买都能验证并发、幂等与售罄判断。",
            evidence: "请求：" + run.purchaseRequested + " · TRACE：" + formatMS(request && request.atMs),
            next: "成功请求进入各自的 MySQL 事务。",
            tone: "critical"
        });
    }

    function applyTransactionFrame(record) {
        var run = record.run;
        var transaction = traceStep(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        var outbox = outboxSummary(run);
        setNode("node-buyers", "success", "150 个唯一请求已释放", "150 / 150", "150 × 1");
        setNode("node-service", "running", "MySQL 提交已确认，响应待后续步骤", "—",
            run.purchaseSucceeded + " 个成功");
        setNode("node-mysql", "success", "事务已提交", formatMS(transaction && transaction.durationMs),
            run.initialStock + " → " + run.finalMySQLStock);
        setFlowEdge("edge-tasks-service", "completed");
        setFlowEdge("edge-service-mysql", "completed");
        if (state.strategy === "outbox-mq-invalidate") {
            setNode("node-outbox", "success", "订单与事件同事务提交", "同事务", outbox.total + " 条事件");
        } else {
            setNode("node-outbox", "unused", "同步方案不写入", "—", "未使用");
        }
        focusFlowNode("node-mysql", "critical", "MySQL 事务已提交", "事务边界已确认");
        setStepExplanation({
            phase: "replay-transaction",
            term: state.strategy === "outbox-mq-invalidate" ?
                "MySQL 事务：库存、订单与 Outbox" : "MySQL 事务：库存与订单",
            action: state.strategy === "outbox-mq-invalidate" ?
                "库存、订单和缓存失效待办已经在同一个事务内提交。" :
                "库存条件扣减与订单已经在同一个事务内提交。",
            reason: "这些写入必须一起成功或一起回滚，避免账本出现半完成状态。",
            evidence: "成功：" + run.purchaseSucceeded + " · 库存：" + run.initialStock + " → " +
                run.finalMySQLStock + (state.strategy === "outbox-mq-invalidate" ?
                    " · Outbox：" + outbox.total : ""),
            next: state.strategy === "sync-invalidate" ? "先删除旧缓存，再返回响应。" : "返回响应后，后台继续失效。",
            tone: "critical"
        });
    }

    function applyResponseFrame(record) {
        var run = record.run;
        setNode("node-service", "success", "响应已收集", formatMS(run.purchaseLatencyMs),
            run.purchaseSucceeded + " 个成功");
        if (state.strategy === "sync-invalidate") {
            var failedStep = traceStep(run, ["cache_invalidation_failed", "delete_cache_failed"]);
            setNode("node-sync-redis", failedStep ? "failed" : "success",
                failedStep ? "DEL 重试耗尽" : "Redis DEL 已完成",
                formatMS(run.cacheInvalidationLatencyMs), failedStep ? "失败" : "缓存已删除");
        }
        setNode("node-response", run.status === "failed" ? "failed" : "success", "购买响应已返回",
            formatMS(run.purchaseP99Ms), run.purchaseSucceeded + " / " + PURCHASE_COUNT);
        setFlowEdge("edge-mysql-response", run.status === "failed" ? "failed" : "completed");
        focusFlowNode("node-response", "critical", "响应边界已到达",
            state.strategy === "sync-invalidate" ? "同步 Redis DEL 已包含在关键路径" : "请求关键路径结束，异步阶段可以展开");
        setStepExplanation({
            phase: "replay-response",
            term: "购买请求到达响应边界",
            action: state.strategy === "sync-invalidate" ?
                "Redis DEL 已包含在请求内，完成后购买结果才返回。" :
                "MySQL 与 Outbox 已提交，购买结果先返回，后台链路继续。",
            reason: state.strategy === "sync-invalidate" ?
                "同步方案用更长的请求路径换取更早的缓存失效。" :
                "异步方案缩短请求路径，把删缓存交给可靠事件链。",
            evidence: "成功：" + run.purchaseSucceeded + " · 响应 P99：" + formatMS(run.purchaseP99Ms),
            next: state.strategy === "sync-invalidate" ?
                "查看同步删除与后续缓存回填。" : "Outbox 发布器开始扫描记录。",
            tone: "critical"
        });
    }

    function applyInvalidationFrame(record) {
        var run = record.run;
        var outbox = outboxSummary(run);
        var failedStep = traceStep(run, ["cache_invalidation_failed", "delete_cache_failed"]);
        if (state.strategy === "sync-invalidate") {
            var invalidated = traceStep(run, ["cache_invalidated", "delete_cache"]);
            setNode("node-sync-redis", failedStep ? "failed" : "success",
                failedStep ? "DEL 重试耗尽" : "Redis DEL 已完成",
                formatMS(run.cacheInvalidationLatencyMs), invalidated ? "缓存已删除" : "—");
            focusFlowNode("node-sync-redis", "critical", failedStep ? "同步失效失败" : "旧缓存已删除，响应尚未展示",
                failedStep ? "检查 Redis DEL 失败证据" : "没有异步支线");
            setStepExplanation({
                phase: failedStep ? "replay-sync-invalidation-failed" : "replay-sync-invalidation",
                term: failedStep ? "同步 Redis DEL 失败" : "同步 Redis DEL 完成",
                action: failedStep ?
                    "Redis 旧副本未能成功删除，失败证据已经保留。" :
                    "请求已经删除" + currentMaterialName() + "的 Redis 查询副本。",
                reason: "DEL 只删除查询副本，不删除 MySQL 中的真实库存。",
                evidence: "平均删除耗时：" + formatMS(run.cacheInvalidationLatencyMs) +
                    " · Redis：" + (failedStep ? "删除失败" : "未命中"),
                next: failedStep ? "检查 Redis 错误与请求失败信息。" : "查看探针是否从 MySQL 回填最新值。",
                tone: failedStep ? "error" : "complete"
            });
        } else {
            setNode("node-worker", outbox.retry ? "retry" : "success",
                outbox.retry ? "发布失败，等待重试" : "凭证已认领发布",
                String(run.retryCount || 0) + " 次重试", outbox.total + " 条事件");
            setNode("node-mq", outbox.retry ? "retry" : "success",
                outbox.retry ? "发布包含重试" : "消息已由 Broker 接收",
                String(outbox.published + outbox.completed), run.mqStatus || "—");
            setNode("node-consumer", outbox.completed === outbox.total && outbox.total ? "success" : "running",
                outbox.completed ? "幂等失效已执行" : "正在消费消息",
                outbox.completed + " / " + (outbox.total || PURCHASE_COUNT) + " 条消息",
                outbox.completed ? "Redis 删除缓存" : "—");
            setNode("node-async-redis", outbox.completed === outbox.total && outbox.total ? "success" : "running",
                outbox.completed ? "缓存键已删除" : "等待幂等 DEL",
                "1 个键", outbox.completed + " / " + (outbox.total || PURCHASE_COUNT) + " 条事件");
            setFlowEdge("edge-worker-mq", "completed");
            setFlowEdge("edge-mq-consumer", "completed");
            setFlowEdge("edge-consumer-redis", outbox.completed ? "completed" : "running");
            focusFlowNode(outbox.completed === outbox.total && outbox.total ? "node-async-redis" : "node-consumer",
                "async", "异步失效链路", "发布器 → MQ → 缓存失效消费者 → Redis 删除缓存");
            if (outbox.completed === outbox.total && outbox.total) {
                renderCompletedAsyncExplanation(run, outbox, "replay");
            } else {
                setStepExplanation({
                    phase: "replay-async-invalidation",
                    term: "Outbox → RocketMQ → 缓存失效消费者 → 删除缓存",
                    action: "缓存失效事件正沿独立消息链删除" + currentMaterialName() + "的查询副本。",
                    reason: "专用消费者不处理订单消息，失败时不确认，等待幂等重投。",
                    evidence: "完成：" + outbox.completed + "/" + (outbox.total || PURCHASE_COUNT) +
                        " · 重试：" + Number(run.retryCount || 0) + " · 缓存键：1",
                    next: "全部确认后查看一致性探针。",
                    tone: "async"
                });
            }
        }
        byId("story-redis-stock").textContent = "未缓存";
    }

    function applyRebuildFrame(record) {
        var stage = stageModel.inspect(record, false).stages.rebuild;
        var sample = stage.evidence;
        var completed = stage.status === "completed";
        renderProbeStream(record.probe, "completed");
        setNode("node-mysql", "success", "Cache MISS 后回源读取",
            sample ? formatMS(sample.latencyMs) : "—", sample ? "读取库存 " + stockText(sample.stock) : "—");
        byId("node-mysql").querySelector("header strong").textContent = "MySQL 回源查询";
        setNode("node-probe", completed ? "success" : "failed", "Cache MISS → MySQL 回源",
            sample ? formatMS(sample.latencyMs) : "—", sample ? "读取库存 " + stockText(sample.stock) : "无证据");
        setNode("node-probe-redis", completed ? "success" : "failed",
            completed ? "Redis SET 已确认" : "Redis SET 失败", sample ? stockText(sample.stock) : "—",
            completed ? "新副本已写入" : "不能确认缓存重建");
        byId("story-redis-stock").textContent = completed ? stockText(sample.stock) : "未确认回填";
        focusFlowNode("node-mysql", "complete", "查询回源 / 缓存重建", stage.summary);
        byId("topology-status").textContent = completed ? "MISS → MySQL → Redis SET" : "CACHE REBUILD FAILED";
    }

    function applyCompleteFrame(record) {
        var run = record.run;
        var transaction = traceStep(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        if (transaction) {
            byId("node-mysql").querySelector("header strong").textContent = "MySQL 事务";
            setNode("node-mysql", "success", "事务已提交", formatMS(transaction.durationMs),
                stockText(run.initialStock) + " → " + stockText(transaction.mysqlStock));
        }
        byId("allegory-status").textContent = run.status === "failed" ? "实验失败" : "实验结果";
        byId("topology-status").textContent = String(run.status || "completed").toUpperCase();
        focusFlowNode(null, "complete", run.status === "failed" ? "实验失败" : "实验完成",
            run.status === "failed" ? "请检查失败证据" : "请求路径与失效路径均已结束");
        if (run.status === "failed") {
            setStepExplanation({
                phase: "result-failed",
                term: "实验未完整结束",
                action: "页面保留了已经发生的真实动作和失败节点。",
                reason: "失败链路不能用展示动画补成成功，恢复必须依靠重试或人工处理。",
                evidence: "状态：failed · " + (run.errorMessage || "查看失败证据"),
                next: "本轮不能判定成功；先检查失败 trace。",
                tone: "error",
                final: true
            });
        } else if (state.strategy === "outbox-mq-invalidate") {
            renderCompletedAsyncExplanation(run, outboxSummary(run), "result", record.probe);
        } else {
            var probe = record.probe || {};
            var consistent = currentConsistency(run);
            setStepExplanation({
                phase: "result-sync",
                term: consistent === true ? "同步购买实验：最终一致" : "同步购买实验：需要复核",
                action: "购买、MySQL 提交、Redis DEL 和 Response 都已经结束。",
                reason: "同步 DEL 位于请求关键路径，最终库存仍以 MySQL 为准。",
                evidence: "MySQL：" + stockText(run.finalMySQLStock) +
                    " · Redis：" + stockText(run.finalRedisStock) +
                    " · 旧读：" + Number(probe.oldReads || 0) +
                    " · 最大窗口：" + formatMS(Number(probe.maxStaleWindowMs || 0)),
                next: consistent === true ?
                    "最终一致；同步方案把 DEL 留在响应路径，以请求耗时换取更直接的失效时点。" :
                    (consistent === false ?
                        "最终库存仍未一致，本轮不能盖章通过；需要检查同步 DEL 与探针结果。" :
                        "Redis 最终仍是 MISS；MySQL 账本有效，但需再次查询确认缓存回填结果。"),
                tone: "complete",
                final: true
            });
        }
        if (run.status === "failed") {
            byId("purchase-fault-banner").hidden = false;
            byId("purchase-fault-title").textContent = "真实链路返回失败状态";
            byId("purchase-fault-copy").textContent = run.errorMessage || "请查看本轮保存的 trace。";
        }
    }

    function stageEvents(record, index) {
        var stage = stageState(record, index, false);
        var actions = {
            request: ["transaction_started"],
            transaction: ["transaction_committed", "update_mysql", "idempotent_order", "sold_out", "outbox_created", "write_outbox"],
            response: ["purchase_responded"],
            invalidate: ["cache_invalidated", "delete_cache", "cache_invalidation_failed", "delete_cache_failed"],
            rebuild: [], result: ["query_material"]
        };
        var events = (record.run.trace || []).filter(function (step) {
            return actions[stage.id].indexOf(step.action) >= 0;
        }).map(function (step) {
            return { clock: "+" + (formatMS(step.atMs) === "—" ? "0 ms" : formatMS(step.atMs)),
                label: step.label || step.action, detail: step.detail || "", failed: /failed/i.test(step.action) };
        });
        if (stage.id === "invalidate" && record.strategy === "outbox-mq-invalidate") {
            (record.run.outbox || []).forEach(function (event) {
                events.push({ clock: event.invalidatedAt || event.publishedAt || "OUTBOX",
                    label: "OUTBOX / MQ · " + event.status,
                    detail: event.eventId + (event.invalidatedAt ? " · DEL 已确认" : " · 未确认 DEL"),
                    failed: !!event.lastError });
            });
        }
        if (stage.id === "rebuild") {
            var sample = stage.evidence;
            events.push({ clock: sample ? sample.completedAt : "PROBE", label: "MISS / CACHE REBUILD",
                detail: stage.summary + (sample ? " · 回源库存 " + sample.stock + " · MySQL 对照 " + sample.authoritativeStock : ""),
                failed: stage.status === "failed" });
        }
        if (stage.id === "result") {
            events.push({ clock: "RESULT", label: record.run.status,
                detail: stage.summary + " · MySQL " + stockText(stage.mysql) + " / Redis " + stockText(stage.redis),
                failed: stage.status === "failed" });
        }
        return events;
    }

    function showResults(record, focus) {
        renderSavedResults();
        if (!record || !focus || resultsFocusRequestId === record.run.requestId) {
            return;
        }
        resultsFocusRequestId = record.run.requestId;
        window.requestAnimationFrame(function () {
            byId("purchase-results").scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                block: "start"
            });
        });
    }

    function renderTechnicalDetails(record) {
        var run = record.run;
        var probe = record.probe;
        var outbox = outboxSummary(run);
        var tx = traceStep(run, ["transaction_committed", "update_mysql"]);
        var invalidation = traceStep(run, [
            "cache_invalidated",
            "delete_cache",
            "cache_invalidation_failed",
            "delete_cache_failed"
        ]);
        byId("evidence-context").textContent = strategyNames[record.strategy] + " · " +
            formatDateTime(record.frozenAt || run.executedAt) + " · " + run.requestId;
        byId("detail-p50").textContent = formatMS(run.purchaseP50Ms);
        byId("detail-p95").textContent = formatMS(run.purchaseP95Ms);
        byId("detail-success").textContent = formatNumber(run.purchaseSucceeded);
        byId("detail-soldout").textContent = formatNumber(run.soldOutRequests);
        byId("detail-duplicates").textContent = formatNumber(run.duplicateRequests);
        byId("detail-purchase-average").textContent = formatMS(run.purchaseLatencyMs);
        byId("detail-mysql-time").textContent = formatTraceMoment(tx, "最大单笔事务");
        byId("detail-invalidation-time").textContent = record.strategy === "sync-invalidate" ?
            (formatTraceMoment(invalidation) + " · 平均 DEL " +
                formatMS(run.cacheInvalidationLatencyMs)) :
            (Number(run.cacheInvalidationLatencyMs) > 0 ?
                "平均链路 " + formatMS(run.cacheInvalidationLatencyMs) : "等待消息链路证据");
        byId("detail-outbox-created").textContent = outboxTimeRange(run, "createdAt");
        byId("detail-mq-published").textContent = outboxTimeRange(run, "publishedAt");
        // invalidatedAt 在缓存失效 Consumer 成功执行幂等 DEL 后写入，是消费与 Redis 删除共享的完成证据。
        byId("detail-consumer-completed").textContent = outboxTimeRange(run, "invalidatedAt");
        byId("detail-cache-recovered").textContent = probeRecoveryText(probe);
        byId("detail-outbox-backlog").textContent = String(outbox.pending + outbox.published + outbox.retry);
        byId("detail-retries").textContent = record.strategy === "sync-invalidate" ?
            "接口未暴露逐次重试计数" : formatNumber(run.retryCount || 0) + " 次";
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
        (run.outbox || []).forEach(function (event) {
            var item = document.createElement("li");
            item.textContent = "OUTBOX · " + event.status + " · " + event.eventId +
                (event.retryCount ? " · 重试 " + event.retryCount : "") +
                (event.lastError ? " · " + event.lastError : "");
            trace.appendChild(item);
        });
        (probe.samples || []).filter(function (sample, index) {
            return sample.old || index === 0 || index === probe.samples.length - 1;
        }).forEach(function (sample) {
            var item = document.createElement("li");
            item.textContent = "PROBE T+" +
                (Number(sample.observedAtMs) > 0 ? formatMS(sample.observedAtMs) : "0 ms") + " · " +
                (sample.old ? "旧库存" : "当前库存") + " " + sample.stock +
                " · MySQL " + sample.authoritativeStock + " · " + sample.source;
            trace.appendChild(item);
        });
    }

    function renderEvidenceScene(record, index, live) {
        var model = stageModel.inspect(record, live);
        var renderers = { request: applyRequestFrame, transaction: applyTransactionFrame,
            invalidate: applyInvalidationFrame, response: applyResponseFrame,
            rebuild: applyRebuildFrame, result: applyCompleteFrame };
        renderSceneBaseline(record);
        model.ids.slice(0, index + 1).forEach(function (id) {
            var stage = model.stages[id];
            if (stage.status === "completed" || stage.status === "failed") {
                renderers[id](record);
            }
        });
        var current = model.stages[model.ids[index]];
        if (current.status === "waiting" || current.status === "unobserved" || current.status === "running") {
            var nodes = { request: "node-service", transaction: "node-mysql",
                response: "node-response", invalidate: state.strategy === "sync-invalidate" ? "node-sync-redis" : "node-consumer",
                rebuild: "node-probe", result: "node-probe-redis" };
            var node = nodes[current.id];
            setNode(node, current.status === "running" ? "running" : "waiting",
                replayStatusNames[current.status], "—", "待真实证据");
            focusFlowNode(node, current.id === "invalidate" && state.strategy === "outbox-mq-invalidate" ? "async" : null,
                current.title, current.summary);
        }
        byId("stage-kicker").textContent = (live ? "实时阶段 " : "回放步骤 ") + (index + 1) + " / 6";
        byId("stage-title").textContent = current.title;
        byId("stage-summary").textContent = current.summary;
        renderStageExplanation(record, index, live);
    }

    function renderPlaybackFrame(index, options) {
        if (!state.record || !state.record.run) { return; }
        options = options || {};
        state.replay.index = Math.max(0, Math.min(stageNames.length - 1, Number(index) || 0));
        if (options.advance !== false) {
            state.replay.furthest = Math.max(state.replay.furthest, state.replay.index);
        }
        renderEvidenceScene(state.record, state.replay.index, false);
        renderStageReadout(state.record, state.replay.index);
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
        showResults(state.record, true);
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
        }, REPLAY_STEP_MS);
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
            "正在按本轮已保存 Trace 自动回放；每个关键步骤停留 6 秒。");
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
        if (next === stageNames.length - 1) {
            setExecutionMode("result",
                "实验结果来自已经完成的真实执行；单步到达结算页不会再次执行购买。");
            showResults(state.record, true);
        }
    }

    function chooseTimelineStep(index) {
        if (!state.record || index > state.replay.furthest) {
            return;
        }
        pauseReplay("正在回看“" + stageNames[index] + "”；此操作只读取本轮 trace。");
        renderPlaybackFrame(index, { advance: false });
        if (index === stageNames.length - 1) {
            setExecutionMode("result",
                "正在查看已保存报告；此操作只读取本轮 trace。");
            showResults(state.record, true);
        }
    }

    function resetIdleVisuals() {
        stopProbe();
        state.record = null;
        state.liveRun = null;
        state.liveStage = -1;
        state.liveBaseline = null;
        state.runObservedAt = null;
        state.observationHalted = false;
        state.inventoryObservation = { firstMismatch: null };
        state.probe = createProbeState();
        clearReplayTimer();
        byId("technical-details-panel").open = false;
        state.replay.index = 0;
        state.replay.furthest = -1;
        state.replay.playing = false;
        renderSceneBaseline(null);
        byId("stage-kicker").textContent = "NOT STARTED";
        byId("stage-title").textContent = "选择方案并开始真实实验";
        byId("stage-summary").textContent =
            "启动后将沿 Purchase Tasks → Service → Transaction → Response 推进，提交后再展开异步支线。";
        setGameMetric("game-success-count", "0");
        setGameMetric("stage-mysql-stock", stockText(state.stock && state.stock.mysqlStock));
        setGameMetric("stage-redis-stock", stockText(state.stock && state.stock.redisStock));
        setGameMetric("game-old-read-count", "0");
        byId("stage-message-state").textContent = "—";
        setGameMetric("stage-duration", "—");
        byId("game-verdict-line").textContent =
            "执行解释：选择一种方案，观察请求边界与缓存失效边界如何分离。";
        setExecutionMode("idle");
        renderIdleStepExplanation();
        renderSavedResults();
        renderInventoryMonitor();
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
            samples: clone(state.probe.samples),
            lastMiss: state.probe.lastMiss ? clone(state.probe.lastMiss) : null
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
        renderProbeStream(state.probe, state.probe.completed ? "completed" : "idle");
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
        renderProbeStream(state.probe, "active");
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
            probe.lastSampleFailed = false;
            probe.latest = sample;
            if (probe.samples.length < 1000) {
                probe.samples.push(sample);
            }
            if (sample.source === "redis-hit") {
                probe.hits += 1;
            } else if (sample.source === "redis-miss") {
                probe.misses += 1;
                probe.lastMiss = sample;
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
            if (state.executionMode === "executing" && probe === state.probe) {
                setGameMetric("game-old-read-count", formatNumber(probe.oldReads));
            }
        } catch (_) {
            probe.errors += 1;
            probe.lastSampleFailed = true;
        } finally {
            probe.inFlight -= 1;
            // 已离开的实验，其迟到响应不能覆盖新一轮界面。
            if (probe === state.probe) {
                renderProbeStream(probe, probe.active ? "active" : "completed");
                if (state.executionMode === "executing") {
                    if (state.liveRun) { renderLiveRunHUD(state.liveRun, false); }
                    else { renderInventoryMonitor(); }
                }
            }
        }
    }

    async function fetchStockState() {
        state.stock = await requestJSON("/api/purchase-lab/" + state.materialId + "/state");
        byId("story-initial-stock").textContent = formatNumber(state.stock.initialStock);
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
        byId("story-initial-stock").textContent = formatNumber(state.stock.initialStock);
        return payload.state;
    }

    function requestID() {
        return "purchase-web-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 10);
    }

    function liveRecord() {
        return state.liveRun ? { run: state.liveRun, strategy: state.strategy,
            baseline: state.liveBaseline, probe: state.probe } : null;
    }

    function renderLiveRunHUD(run, freshSnapshot) {
        if (!run) { return; }
        if (freshSnapshot !== false) { state.runObservedAt = Date.now(); }
        var record = liveRecord();
        var model = stageModel.inspect(record, true);
        state.liveStage = model.current;
        renderEvidenceScene(record, state.liveStage, true);
        if (!run.criticalPathCompleted) {
            var processed = Number(run.purchaseProcessed || 0);
            setNode("node-buyers", "success", "唯一请求已释放", processed + " / " + run.purchaseRequested, "12 concurrent");
            setNode("node-service", "running", "请求池持续处理", processed + " / " + run.purchaseRequested,
                Number(run.purchaseSucceeded || 0) + " success");
            setNode("node-mysql", processed ? "running" : "waiting", "并发事务持续推进",
                processed + " 个请求已处理", stockText(run.finalMySQLStock));
        } else if (state.strategy === "outbox-mq-invalidate" && model.stages.invalidate.status === "running") {
            var outbox = outboxSummary(run);
            var accepted = outbox.published + outbox.completed;
            setNode("node-worker", outbox.retry ? "retry" : "running", "扫描 / 发布 Outbox",
                Number(run.retryCount || 0) + " 次重试", accepted + " / " + outbox.total);
            setNode("node-mq", accepted ? "running" : "waiting", accepted ? "Broker 已接收事件" : "等待发布",
                String(accepted), run.mqStatus || "—");
            setNode("node-consumer", accepted > outbox.completed ? "running" : "waiting", "校验事件并删除缓存",
                outbox.completed + " / " + outbox.total, "DEL + ACK");
            setNode("node-async-redis", outbox.completed ? "running" : "waiting", "等待全部 DEL 确认",
                "1 个键", outbox.completed + " / " + outbox.total);
            focusFlowNode(accepted > outbox.completed ? "node-consumer" : "node-worker", "async", "Redis 缓存失效", "请求已返回，后台继续处理");
        }
        // 实时数字始终显示最新后端快照；不会为了复现 DEL 而把当前 Redis 强制清空。
        renderProbeStream(state.probe, state.probe.active ? "active" : "completed");
        renderTimeline();
        renderHeaderAndControls();
    }

    async function pollCriticalPath(id, isActive) {
        while (isActive()) {
            try {
                var run = await requestJSON("/api/purchase-lab/runs/" + encodeURIComponent(id));
                state.liveRun = run;
                renderLiveRunHUD(run);
                if (run.criticalPathCompleted) {
                    return run;
                }
            } catch (_) {
                // POST 刚发出时 run 可能尚未注册；下一次 160ms 轮询会读取真实快照。
            }
            await new Promise(function (resolve) { window.setTimeout(resolve, LIVE_RUN_POLL_MS); });
        }
        return null;
    }

    async function pollRun(id) {
        var deadline = Date.now() + LIVE_RUN_TIMEOUT_MS;
        while (Date.now() < deadline) {
            var run = await requestJSON("/api/purchase-lab/runs/" + encodeURIComponent(id));
            state.liveRun = run;
            renderLiveRunHUD(run);
            setExecutionMode("executing",
                run.status === "waiting_consumer" ?
                    "后端真实购买已响应，正在等待缓存失效 Consumer 完成删缓存；回放尚未开始。" :
                    "后端正在等待 Outbox / MQ 完成真实失效；回放尚未开始。");
            if (!runningStatus(run)) {
                return run;
            }
            await new Promise(function (resolve) { window.setTimeout(resolve, LIVE_RUN_POLL_MS); });
        }
        var timeout = new Error("异步链路在 5 分钟内仍未完成；后端可能仍在继续重试或消费");
        timeout.runStillActive = true;
        throw timeout;
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
            playbackVersion: 3,
            strategy: state.strategy,
            materialId: state.materialId,
            materialName: state.profile.name,
            frozenAt: new Date().toISOString(),
            baseline: clone(baseline || {}),
            run: clone(run),
            probe: probe,
            inventoryObservation: clone(state.inventoryObservation),
            purchaseP50Ms: Number(run.purchaseP50Ms || 0),
            purchaseP95Ms: Number(run.purchaseP95Ms || 0),
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
        if (!record || !record.run) {
            return record;
        }
        if (record.run.status === "completed") {
            recentResults[record.strategy] = record;
        }
        return record.run.status === "completed" && resultStore ?
            resultStore.save(record) : record;
    }

    function loadReplayRecord(record, options) {
        options = options || {};
        clearReplayTimer();
        state.record = clone(record);
        state.liveRun = clone(record.run);
        evidenceRecord = state.record;
        setSelectedStrategy(record.strategy);
        state.replay.index = Math.max(0, Math.min(stageNames.length - 1, Number(options.index || 0)));
        state.replay.furthest = options.furthest === undefined ?
            (options.autoplay ? 0 : stageNames.length - 1) :
            Math.max(0, Math.min(stageNames.length - 1, Number(options.furthest)));
        state.replay.playing = !!options.autoplay;
        setExecutionMode(options.autoplay ? "replaying" :
            (state.replay.index === stageNames.length - 1 ? "result" : "paused"),
            options.autoplay ?
                "真实执行已经完成，正在自动回放六个关键步骤。" :
                "真实执行已经完成；可使用上一步、播放暂停和下一步回看 Trace。");
        renderPlaybackFrame(state.replay.index, { advance: true });
        renderSavedResults();
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
        // 店外计划只负责预选方案；用户在店内明确点击后才消费该计划并调用真实购买接口。
        consumeFreshPurchasePlan();
        clearReplayTimer();
        resetIdleVisuals();
        setExecutionMode("executing",
            "正在重置库存并执行 150 个真实购买请求；中心视图读取进行中的 run 快照。");
        byId("allegory-status").textContent = "正在真实执行";
        byId("topology-status").textContent = "REAL EXECUTION";
        byId("stage-kicker").textContent = "REAL EXECUTION";
        byId("stage-title").textContent = "准备释放 Purchase Tasks";
        byId("stage-summary").textContent =
            "节点将由后端增量状态推进；事务提交后才会解锁异步失效阶段。";
        byId("game-verdict-line").textContent =
            "执行解释：当前活跃节点只反映真实 run、Outbox 与探针证据。";
        setStepExplanation({
            phase: "live-reset",
            term: "重置库存并预热查询缓存",
            action: "实验正在恢复 MySQL 库存起点，并放入一份 Redis 查询副本。",
            reason: "两个方案必须从同一库存和缓存状态开始，结果才可比较。",
            evidence: "基线：重置中 · Redis：预热中",
            next: "基线完成后释放 150 个购买请求。",
            tone: "critical"
        });
        renderSavedResults();
        window.requestAnimationFrame(function () {
            var executionView = byId("execution-heading").closest(".purchase-execution-view");
            executionView.scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                block: "start"
            });
        });
        try {
            var baseline = await resetExperiment();
            state.liveBaseline = clone(baseline);
            setGameMetric("game-success-count", "0");
            setGameMetric("stage-mysql-stock", stockText(baseline.mysqlStock));
            setGameMetric("stage-redis-stock", stockText(baseline.redisStock));
            setGameMetric("game-old-read-count", "0");
            startProbe();
            var id = requestID();
            var criticalPollActive = true;
            var criticalPollPromise = pollCriticalPath(id, function () { return criticalPollActive; });
            var runRequest = requestJSON("/api/purchase-lab/" + state.materialId + "/run", {
                method: "POST",
                body: JSON.stringify({
                    requestId: id,
                    strategy: state.strategy,
                    purchaseCount: PURCHASE_COUNT,
                    queryCount: 0
                })
            });
            var run;
            try {
                run = await runRequest;
            } finally {
                criticalPollActive = false;
                await criticalPollPromise;
            }
            state.liveRun = run;
            renderLiveRunHUD(run);
            if (runningStatus(run)) {
                run = await pollRun(id);
            }
            run = await ensureFinalCacheView(run);
            stopProbe();
            var record = buildRecord(run, baseline);
            var saved = saveRecord(record);
            // 完成后停在真实终态；历史步骤仅在用户点击回放时展示。
            loadReplayRecord(saved || record, { autoplay: false, index: stageNames.length - 1, furthest: stageNames.length - 1 });
            showToast(run.status === "completed" ?
                "实验完成，库存与 A/B 结果已冻结。" :
                "本轮执行失败，已保留真实证据。",
            run.status === "completed" ? "success" : "error");
        } catch (error) {
            stopProbe();
            clearReplayTimer();
            state.replay.playing = false;
            if (error.runStillActive && state.liveRun) {
                state.observationHalted = true;
                renderLiveRunHUD(state.liveRun);
                setExecutionMode("executing",
                    "页面已停止高频探针，但后端 run 仍在推进；这不是购买事务失败。请检查 Publisher / 缓存失效 Consumer 状态。");
                byId("stage-kicker").textContent = "ASYNC RUN STILL ACTIVE";
                byId("stage-title").textContent = "异步链路仍在后台收敛";
                byId("stage-summary").textContent = error.message;
                byId("game-verdict-line").textContent =
                    "执行解释：主事务已经结束；当前只是在等待 Outbox / MQ / 缓存失效 Consumer 的终态。";
                byId("purchase-fault-banner").hidden = false;
                byId("purchase-fault-title").textContent = "异步链路尚未完成";
                byId("purchase-fault-copy").textContent = error.message;
                showToast("购买事务已完成，异步链路仍在运行。", "error");
                return;
            }
            setExecutionMode("error",
                "真实执行未能返回完整 trace：" + error.message + "。页面没有启动回放。");
            setStepExplanation({
                phase: "request-failed",
                term: "真实执行没有返回完整结果",
                action: "请求在取得完整 trace 前失败，页面已经停止推进。",
                reason: "缺少真实证据时不能继续展示成功步骤。",
                evidence: "错误：" + error.message,
                next: "查看当前失败节点与错误信息。",
                tone: "error",
                final: true
            });
            var first = document.querySelector("[data-replay-step='0']");
            first.dataset.status = "failed";
            first.classList.add("is-current");
            first.querySelector("[data-step-status]").textContent = "failed";
            byId("stage-kicker").textContent = "REAL EXECUTION FAILED";
            byId("stage-title").textContent = "后端真实执行失败";
            byId("stage-summary").textContent = error.message;
            byId("game-verdict-line").textContent =
                "执行解释：链路没有完整结束；页面保留失败证据，不用动画补造完成态。";
            byId("purchase-fault-banner").hidden = false;
            byId("purchase-fault-title").textContent = "真实执行失败";
            byId("purchase-fault-copy").textContent = error.message;
            renderSavedResults();
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
        updateFreshPurchasePlanStrategy(strategy);
        resetIdleVisuals();
    }

    function lowerMetricWinner(syncValue, asyncValue, allowZero, toleranceRatio) {
        var syncNumber = Number(syncValue);
        var asyncNumber = Number(asyncValue);
        var minimum = allowZero ? 0 : Number.EPSILON;
        if (!Number.isFinite(syncNumber) || !Number.isFinite(asyncNumber) ||
                syncNumber < minimum || asyncNumber < minimum) {
            return "unknown";
        }
        var tolerance = Math.max(allowZero ? 0.5 : 1, Math.min(syncNumber, asyncNumber) * (toleranceRatio || 0));
        if (Math.abs(syncNumber - asyncNumber) <= tolerance) {
            return "tie";
        }
        return syncNumber < asyncNumber ? "sync" : "async";
    }

    function winnerLabel(winner) {
        if (winner === "sync") {
            return "同步删除缓存";
        }
        if (winner === "async") {
            return "Outbox + MQ";
        }
        if (winner === "tie") {
            return "本轮接近";
        }
        return "证据不足";
    }

    function resultCell(value, note, tone) {
        return { value: value, note: note || "", tone: tone || "" };
    }

    function resultRows() {
        return [
            {
                title: "响应 P99", note: "成功购买的尾部延迟", metric: function (record) { return record.run.purchaseP99Ms; },
                read: function (record) { return resultCell(formatMS(record.run.purchaseP99Ms)); }
            },
            {
                title: "缓存失效耗时", note: "提交后到删除缓存 · 平均值",
                metric: function (record) { return record.run.cacheInvalidationLatencyMs; },
                read: function (record) { return resultCell(formatMS(record.run.cacheInvalidationLatencyMs)); }
            },
            {
                title: "不一致样本", note: "旧读次数 / 有效探针样本",
                read: function (record) {
                    var probe = record.probe;
                    return resultCell(formatNumber(probe.oldReads) + " / " + formatNumber(probe.completed) + " 次",
                        probeEvidenceQuality(probe).usable ? "" : "样本不足，暂不判断");
                }
            },
            {
                title: "最长旧读窗口", note: "探针观测到的连续旧读时长", probe: true,
                metric: function (record) { return record.probe.maxStaleWindowMs; },
                read: function (record) {
                    if (!probeEvidenceQuality(record.probe).usable) {
                        return resultCell("证据不足", "探针样本或错误率未达要求");
                    }
                    return resultCell(record.probe.maxStaleWindowMs > 0 ?
                        formatMS(record.probe.maxStaleWindowMs) : "未观测到");
                }
            },
            {
                title: "最终库存", note: "MySQL 与 Redis 是否对齐",
                read: function (record) {
                    var consistent = currentConsistency(record.run);
                    return resultCell(consistent === null ? "未回填" : (consistent ? "已对齐" : "未对齐"),
                        "MySQL " + stockText(record.run.finalMySQLStock) + " / Redis " + stockText(record.run.finalRedisStock),
                        consistent === true ? "good" : "attention");
                }
            }
        ];
    }

    function appendResultText(element, value, note) {
        var strong = document.createElement("strong");
        strong.textContent = value;
        element.appendChild(strong);
        if (note) {
            var small = document.createElement("small");
            small.textContent = note;
            element.appendChild(small);
        }
    }

    function renderResultTable(records) {
        var head = byId("results-table-head");
        var body = byId("results-table-body");
        head.replaceChildren();
        body.replaceChildren();
        var header = document.createElement("tr");
        var label = document.createElement("th");
        label.scope = "col";
        label.textContent = "观察指标";
        header.appendChild(label);
        records.forEach(function (record) {
            var cell = document.createElement("th");
            cell.scope = "col";
            cell.dataset.strategy = record.strategy;
            appendResultText(cell, record.strategy === "sync-invalidate" ? "A · 同步删除缓存" : "B · Outbox + MQ",
                formatNumber(record.run.purchaseRequested) + " 请求 · " +
                formatNumber(record.run.purchaseSucceeded) + " 成功" +
                (record.run.status === "failed" ? " · 本轮失败" : ""));
            header.appendChild(cell);
        });
        head.appendChild(header);
        resultRows().forEach(function (row) {
            var tr = document.createElement("tr");
            var heading = document.createElement("th");
            heading.scope = "row";
            appendResultText(heading, row.title, row.note);
            tr.appendChild(heading);
            var comparable = records.length === 2 && records.every(function (record) {
                return record.run.status === "completed";
            }) && (!row.probe || probesAreComparable(records[0].probe, records[1].probe));
            var winner = comparable && row.metric ?
                lowerMetricWinner(row.metric(records[0]), row.metric(records[1]), !!row.probe, 0.03) : "unknown";
            records.forEach(function (record, index) {
                var cell = document.createElement("td");
                var result = row.read(record);
                var lower = (index === 0 && winner === "sync") || (index === 1 && winner === "async");
                cell.dataset.tone = result.tone || (lower ? "good" : "");
                appendResultText(cell, result.value, result.note);
                tr.appendChild(cell);
            });
            body.appendChild(tr);
        });
    }

    function renderResultVerdict(records) {
        var current = state.record || records[records.length - 1];
        var failed = records.find(function (record) { return record.run.status === "failed"; });
        var title = byId("results-verdict-title");
        var copy = byId("results-verdict");
        if (failed) {
            title.textContent = "这轮没有完成";
            copy.textContent = failed.run.errorMessage || "链路留下失败证据，请展开工程证据查看原因。";
        } else if (records.length === 1) {
            title.textContent = current.strategy === "sync-invalidate" ? "先删缓存，再返回响应" : "响应先返回，缓存随后失效";
            copy.textContent = current.strategy === "sync-invalidate" ?
                "Redis DEL 留在购买请求内，响应需要等待删缓存完成。" :
                "购买响应在事务提交后结束，Outbox + MQ 继续完成删缓存。";
            copy.textContent += currentConsistency(current.run) === true ?
                "本轮最终库存已对齐。" : "本轮最终库存尚未对齐，请查看工程证据。";
        } else {
            var speed = lowerMetricWinner(records[0].run.purchaseP99Ms, records[1].run.purchaseP99Ms, false, 0.03);
            title.textContent = speed === "unknown" ? "本轮响应数据不足" :
                (speed === "tie" ? "本轮响应 P99 接近" : "本轮 " + winnerLabel(speed) + " 的 P99 更低");
            var comparable = probesAreComparable(records[0].probe, records[1].probe);
            var windowWinner = comparable ? lowerMetricWinner(
                records[0].probe.maxStaleWindowMs, records[1].probe.maxStaleWindowMs, true, 0.03) : "unknown";
            var observation = windowWinner === "unknown" ?
                (records.every(function (record) { return probeEvidenceQuality(record.probe).usable; }) ?
                    "两轮采样量不同，旧读窗口按各自实测展示。" : "旧读窗口的证据不足以比较。") :
                (windowWinner === "tie" ? "两轮观测到的旧读窗口接近。" : winnerLabel(windowWinner) + "的旧读窗口更短。");
            copy.textContent = observation + "同步实现简单；异步把删缓存移出响应链，但需要 Outbox、MQ 和重试机制。";
        }

        var qualityNotes = records.filter(function (record) {
            return !probeEvidenceQuality(record.probe).usable;
        }).map(function (record) {
            var quality = probeEvidenceQuality(record.probe);
            return strategyNames[record.strategy] + "：有效样本 " + quality.completed + "，错误 " + quality.errors;
        });
        byId("results-quality").textContent = qualityNotes.length ?
            "探针证据不足 · " + qualityNotes.join("；") :
            (records.some(function (record) { return Number(record.probe.oldReads) === 0; }) ?
                "20 QPS 探针实测；未观测到旧读，不代表旧读窗口不存在。" :
                "20 QPS 探针实测 · 旧读次数受采样时长影响，请结合窗口与最终库存判断。");
    }

    function selectResultEvidence(record) {
        evidenceRecord = record;
        renderTechnicalDetails(record);
        document.querySelectorAll("[data-evidence-strategy]").forEach(function (button) {
            button.setAttribute("aria-pressed", String(button.dataset.evidenceStrategy === record.strategy));
        });
    }

    function renderSavedResults() {
        // 存储被禁用时，同一页面仍保留两轮真实结果用于比较。
        var saved = Object.assign({}, resultStore ? resultStore.list() : {}, recentResults);
        // 失败轮也应显示自己的证据，不能被同方案上一次成功结果覆盖。
        if (state.record && state.record.run) {
            saved[state.record.strategy] = state.record;
        }
        var records = ["sync-invalidate", "outbox-mq-invalidate"].map(function (strategy) {
            return saved[strategy];
        }).filter(function (record) {
            return record && Number(record.materialId) === state.materialId && record.run && record.probe &&
                (record.run.status === "completed" || record.run.status === "failed");
        });
        var panel = byId("purchase-results");
        panel.hidden = !records.length || state.executionMode === "executing";
        if (!records.length) {
            evidenceRecord = null;
            return;
        }
        panel.dataset.resultCount = String(records.length);
        byId("purchase-results").dataset.failed = String(records.some(function (record) { return record.run.status === "failed"; }));
        byId("results-status").textContent = records.some(function (record) { return record.run.status === "failed"; }) ?
            "含失败记录" : (records.length === 2 ? "两种方案已完成" : "已完成一种方案");
        byId("results-context").textContent = records.length === 2 ?
            "星髓 · 每种方案最近一次实测 · 相同指标直接对照" :
            "星髓 · " + strategyNames[records[0].strategy] + " · 运行另一方案后在此对比";
        renderResultTable(records);
        renderResultVerdict(records);

        var choices = byId("evidence-strategies");
        choices.replaceChildren();
        choices.hidden = records.length < 2;
        records.forEach(function (record) {
            var button = document.createElement("button");
            button.type = "button";
            button.dataset.evidenceStrategy = record.strategy;
            button.textContent = strategyNames[record.strategy];
            button.addEventListener("click", function () { selectResultEvidence(record); });
            choices.appendChild(button);
        });
        var selected = records.find(function (record) {
            return evidenceRecord && record.run.requestId === evidenceRecord.run.requestId;
        }) || state.record || records[records.length - 1];
        selectResultEvidence(selected);
        byId("run-other-strategy").textContent = records.length === 1 ?
            (records[0].strategy === "sync-invalidate" ? "运行 Outbox + MQ，看看差别" : "运行同步方案，看看差别") :
            "再跑另一方案";
        renderHeaderAndControls();
    }

    function runOtherStrategy() {
        var current = evidenceRecord || state.record;
        var next = current && current.strategy === "sync-invalidate" ?
            "outbox-mq-invalidate" : "sync-invalidate";
        setSelectedStrategy(next);
        startExperiment();
    }

    function rerunCurrentStrategy() {
        var current = evidenceRecord || state.record;
        if (current) {
            setSelectedStrategy(current.strategy);
            startExperiment();
        }
    }

    function viewFullProcess() {
        var record = evidenceRecord || state.record;
        if (!record) {
            return;
        }
        loadReplayRecord(record, { autoplay: false, index: 0, furthest: stageNames.length - 1 });
        byId("execution-heading").closest(".purchase-execution-view").scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            block: "start"
        });
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
        byId("start-purchase-run").addEventListener("click", startExperiment);
        byId("replay-previous").addEventListener("click", function () { stepReplay(-1); });
        byId("replay-toggle").addEventListener("click", playReplay);
        byId("replay-next").addEventListener("click", function () { stepReplay(1); });
        byId("view-full-process").addEventListener("click", viewFullProcess);
        byId("run-other-strategy").addEventListener("click", runOtherStrategy);
        byId("rerun-current-strategy").addEventListener("click", rerunCurrentStrategy);
        byId("technical-details-panel").addEventListener("toggle", function () {
            byId("technical-details-panel").querySelector("summary i").textContent =
                byId("technical-details-panel").open ? "收起" : "展开";
        });
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
        document.body.dataset.materialKind = "star";
        byId("purchase-current-name").textContent = material.profile.name;
        byId("story-material-name").textContent = material.profile.name;
        byId("purchase-empty").hidden = true;
        byId("purchase-content").hidden = false;
        return true;
    }

    function restoreSavedReplay() {
        var cursor = readReplayPosition();
        if (!cursor || Number(cursor.materialId) !== state.materialId) {
            return false;
        }
        var saved = resultStore ? resultStore.list() : {};
        var record = saved[cursor.strategy];
        if (!record || !record.run || !record.probe || record.run.requestId !== cursor.requestId) {
            return false;
        }
        var restoredIndex = Math.min(stageNames.length - 1, Math.max(0, Number(cursor.index || 0)));
        loadReplayRecord(record, {
            autoplay: false,
            index: restoredIndex,
            furthest: Math.max(Number(cursor.furthest || 0), restoredIndex)
        });
        setExecutionMode(restoredIndex === stageNames.length - 1 ? "result" : "paused",
            "已从本页会话恢复上次回放位置；没有调用购买接口。");
        if (restoredIndex === stageNames.length - 1) {
            showResults(state.record, false);
        }
        return true;
    }

    async function init() {
        var incomingPlan = incomingPurchasePlan();
        if (!showContext(incomingMaterial())) {
            return;
        }
        try {
            window.sessionStorage.removeItem(REPORT_ARCHIVE_KEY);
        } catch (_) {
            // 历史报告归档已下线；无法访问存储时不影响最新结果模式。
        }
        bindEvents();
        if (incomingPlan.strategy) {
            setSelectedStrategy(incomingPlan.strategy);
        }
        try {
            await fetchStockState();
        } catch (error) {
            byId("purchase-stock-summary").textContent = "库存读取失败";
            showToast(error.message, "error");
        }
        // 显式的新计划优先于旧回放位置；否则旧报告会覆盖刚从店外带入的方案。
        if (incomingPlan.fresh || !restoreSavedReplay()) {
            resetIdleVisuals();
        }
        renderSavedResults();
    }

    init();
}());
