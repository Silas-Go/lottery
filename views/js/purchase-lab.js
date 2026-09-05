(function () {
    "use strict";

    var REPLAY_POSITION_KEY = "silas.cache-aside.purchase-replay-position.v2";
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
    var stageNames = [
        "购买任务进入",
        "MySQL 事务提交",
        "响应边界",
        "缓存失效链路",
        "一致性结果"
    ];
    var replayStatusNames = {
        waiting: "等待",
        running: "进行中",
        completed: "已完成",
        failed: "失败"
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
        var done = !!run && run.status === "completed" && !replay;
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
        setGameMetric("stage-redis-stock", cached ? formatNumber(redis) : (known ? "未缓存" : "—"));
        byId("stage-redis-stock").dataset.empty = String(!cached);
        byId("inventory-symbol").textContent = tone === "mismatch" ? "≠" :
            (tone === "consistent" || tone === "recovered" ? "=" : "…");
        byId("inventory-status-text").textContent = label;
        byId("inventory-delta").textContent = tone === "mismatch" ?
            "库存差值 " + formatNumber(Number(redis) - Number(mysql)) :
            (tone === "empty" ? "等待后续查询回填" :
                (tone === "unknown" ? "尚无有效库存对照" :
                    (tone === "checking" ? "等待有效样本复核" : "MySQL / Redis 已对齐")));
        byId("inventory-source").textContent = replay ? "回放步骤快照 · 统计已冻结" :
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
            fresh: Boolean(validStrategy && query.get("intent") === "new")
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

    function renderLiveStepExplanation(run) {
        if (!run) {
            renderIdleStepExplanation();
            return;
        }
        if (run.status === "failed") {
            setStepExplanation({
                phase: "live-failed",
                term: "真实执行失败",
                action: "真实链路返回失败，页面停在已经取得的证据。",
                reason: "未完成的节点不能用动画补成成功，必须等待重试或人工处理。",
                evidence: "状态：failed · " + (run.errorMessage || "查看错误详情"),
                next: "查看失败节点和最近关键日志。",
                tone: "error",
                final: true
            });
            return;
        }
        var processed = Number(run.purchaseProcessed || 0);
        var requested = Number(run.purchaseRequested || PURCHASE_COUNT);
        var succeeded = Number(run.purchaseSucceeded || 0);
        if (!run.criticalPathCompleted) {
            if (processed === 0) {
                setStepExplanation({
                    phase: "live-requests",
                    term: "购买请求进入 Purchase Service",
                    action: "一批唯一购买请求正在进入服务，准备争抢同一种材料库存。",
                    reason: "每个请求都使用独立 request_id，才能验证并发与幂等。",
                    evidence: "请求：" + requested + " · 已处理：0",
                    next: "成功请求会进入独立的 MySQL 事务。",
                    tone: "critical"
                });
            } else {
                setStepExplanation({
                    phase: "live-transactions",
                    term: state.strategy === "outbox-mq-invalidate" ?
                        "MySQL 事务：库存、订单与 Outbox" : "MySQL 事务：库存与订单",
                    action: state.strategy === "outbox-mq-invalidate" ?
                        "成功事务正在同时扣库存、写订单和缓存失效待办。" :
                        "成功事务正在同时扣库存并写入订单。",
                    reason: "这些写入必须一起提交或一起回滚，避免账本与待办分离。",
                    evidence: "已处理：" + processed + "/" + requested + " · 成功：" + succeeded,
                    next: "全部事务收集后到达 Response 边界。",
                    tone: "critical"
                });
            }
            return;
        }
        if (state.strategy === "sync-invalidate") {
            setStepExplanation({
                phase: "live-sync-delete",
                term: "同步 Redis DEL 后返回 Response",
                action: "购买请求已在返回前删除 Redis 查询副本。",
                reason: "把旧副本先删掉，后续查询才不会继续读取旧库存。",
                evidence: "成功：" + succeeded + " · P99：" + formatMS(run.purchaseP99Ms) +
                    " · Redis：" + stockText(run.finalRedisStock),
                next: "查询遇到 MISS 后从 MySQL 回填最新副本。",
                tone: run.status === "completed" ? "complete" : "critical"
            });
            return;
        }

        var outbox = outboxSummary(run);
        var total = outbox.total || succeeded;
        var brokerAccepted = outbox.published + outbox.completed;
        if (total > 0 && outbox.completed === total) {
            renderCompletedAsyncExplanation(run, outbox, "live");
        } else if (brokerAccepted > outbox.completed) {
            setStepExplanation({
                phase: "live-cache-consumer",
                term: "RocketMQ → 缓存失效 Consumer → Redis DEL",
                action: "缓存失效 Consumer 正在校验通知、删除缓存并 ACK。",
                reason: "它与订单 Consumer 分开，因此不会排在创建、取消订单消息后面。",
                evidence: "MQ 接收：" + brokerAccepted + "/" + total + " · DEL 完成：" +
                    outbox.completed + "/" + total,
                next: "全部消息确认后，检查最终一致性。",
                tone: "async"
            });
        } else {
            setStepExplanation({
                phase: "live-outbox-publisher",
                term: "Outbox Publisher 等待扫描",
                action: "购买结果已经返回，Publisher 正在扫描待发布的缓存失效事件。",
                reason: "后台扫描让请求无需等待 MQ，同时保留失败后的重试凭证。",
                evidence: "Outbox：" + total + " · 已发布：" + brokerAccepted + " · 扫描周期：1s",
                next: "事件发布到 RocketMQ 后交给缓存失效 Consumer。",
                tone: "async"
            });
        }
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
        byId("running-phase").textContent = label;
        byId("running-material").textContent = state.profile ? state.profile.name : "—";
        byId("running-strategy").textContent = strategyNames[state.strategy] || "尚未选择方案";
        byId("running-strategy-code").textContent = state.strategy === "sync-invalidate" ? "A" :
            (state.strategy === "outbox-mq-invalidate" ? "B" : "—");
        byId("execution-boundary-copy").textContent = state.executionDetail ||
            (busy ? "后端正在真实扣减库存并完成失效链路；此时尚未播放任何阶段。" :
                "真实执行与回放相互分离；回放按钮只读取本轮 Trace。");
        byId("replay-position").textContent = ready ?
            ((state.replay.index + 1) + " / " + stageNames.length) : "— / " + stageNames.length;
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
        byId("mysql-metric-label").textContent = ready && state.replay.index >= 1 ? "提交耗时" : "进度";
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
            button.querySelector("[data-step-status]").textContent = replayStatusNames[status] || status;
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
        byId("allegory-status").textContent = record ? "等待回放" : "等待执行";
        byId("topology-status").textContent = record ? "链路已保存" : "待命";
        byId("story-redis-stock").textContent = stockText(initialRedis);
        setNode("node-buyers", "idle", "等待释放任务", "0 / 150", "150 × 1");
        setNode("node-service", "idle", "等待请求", "—", "—");
        setNode("node-mysql", "idle", "等待事务", "0 / 150", stockText(initialMySQL) + " → —");
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
        var run = record.run;
        var probe = record.probe;
        var outbox = outboxSummary(run);
        var request = traceStep(run, ["transaction_started"]);
        var transaction = traceStep(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        var response = traceStep(run, ["purchase_responded"]);
        var invalidation = traceStep(run, ["cache_invalidated", "delete_cache", "cache_invalidation_failed", "delete_cache_failed"]);
        var evidence = {
            kicker: "步骤 " + String(index + 1).padStart(2, "0") + " / " + String(stageNames.length).padStart(2, "0"),
            title: stageNames[index],
            summary: "",
            mysql: run.initialStock,
            redis: record.baseline ? record.baseline.redisStock : null,
            message: state.strategy === "sync-invalidate" ? "未使用" : "等待 Outbox 记录",
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
            evidence.message = state.strategy === "sync-invalidate" ? "响应等待 Redis 删除缓存" : "响应不等待后台删缓存";
            evidence.duration = formatMS(run.purchaseP99Ms);
        } else if (index === 3) {
            evidence.summary = state.strategy === "sync-invalidate" ?
                (invalidation ? invalidation.detail : "同步 Redis DEL 已执行。") :
                ("Outbox " + outbox.completed + " / " + outbox.total + " 已完成，MQ " +
                    runtimeStatusName(run.mqStatus) + "。");
            evidence.mysql = run.finalMySQLStock;
            evidence.redis = invalidation ? invalidation.redisStock : null;
            evidence.message = state.strategy === "sync-invalidate" ?
                (invalidation && /failed/i.test(invalidation.action) ? "Redis 删除失败" : "同步删除完成") :
                ("Outbox " + runtimeStatusName(run.outboxStatus) + " / MQ " + runtimeStatusName(run.mqStatus));
            evidence.duration = formatMS(run.cacheInvalidationLatencyMs);
        } else if (index === 4) {
            evidence.summary = "真实缓存探针完成 " + probe.completed + " 次，观察到 " + probe.oldReads + " 次旧库存读取。";
            evidence.mysql = run.finalMySQLStock;
            evidence.redis = run.finalRedisStock;
            evidence.message = state.strategy === "sync-invalidate" ? "未使用" : ("重试 " + Number(run.retryCount || 0) + " 次");
            evidence.duration = probe.maxStaleWindowMs > 0 ? formatMS(probe.maxStaleWindowMs) : "0 ms";
        } else {
            evidence.kicker = run.status === "failed" ? "失败链路" : "结果链路";
            evidence.summary = run.status === "failed" ?
                (run.errorMessage || "后端返回失败状态，已保留本轮证据。") :
                ("成功购买 " + run.purchaseSucceeded + "，最终 MySQL 与 Redis " +
                    (currentConsistency(run) ? "一致。" : "仍不一致。"));
            evidence.mysql = run.finalMySQLStock;
            evidence.redis = run.finalRedisStock;
            evidence.message = state.strategy === "sync-invalidate" ? "同步链路结束" :
                ("Outbox " + runtimeStatusName(run.outboxStatus) + " / MQ " + runtimeStatusName(run.mqStatus));
            evidence.duration = formatMS(run.purchaseP99Ms);
        }
        return evidence;
    }

    function stageVerdict(record, index) {
        var run = record.run;
        var probe = record.probe || {};
        if (index === 0) {
            return "执行解释：150 个唯一请求已进入购买服务，事务开始并发推进。";
        }
        if (index === 1) {
            return "执行解释：库存、订单与可选 Outbox 已在 MySQL 事务边界内提交。";
        }
        if (index === 2) {
            return record.strategy === "sync-invalidate" ?
                "执行解释：响应等待同步删除缓存，因此失效耗时属于请求关键路径。" :
                "执行解释：响应在事务提交后结束；缓存失效转入独立异步阶段。";
        }
        if (index === 3) {
            return record.strategy === "sync-invalidate" ?
                "执行解释：Redis 删除缓存已在响应前完成，后续读取将按旁路缓存模式回填。" :
                "执行解释：发布器扫描 Outbox，经 MQ 与缓存失效消费者推进到幂等删除缓存。";
        }
        if (index === 4) {
            return Number(probe.oldReads || 0) > 0 ?
                "执行解释：探针观察到旧值；最终一致不代表过程中没有不一致窗口。" :
                "执行解释：本轮探针未观察到旧值，但单次实验不能证明任何时序都安全。";
        }
        if (run.status === "failed") {
            return "执行解释：链路未完整结束，应先检查失败 trace 与重试状态。";
        }
        var consistent = currentConsistency(run);
        if (Number(run.soldOutRequests || 0) > 0 && consistent) {
            return "执行解释：成功 " + run.purchaseSucceeded + "，售罄 " +
                run.soldOutRequests + "；未超卖，Redis 最终追平 MySQL。";
        }
        if (record.strategy === "sync-invalidate") {
            return consistent ?
                "执行解释：最终状态一致；同步删除缓存的耗时计入了响应。" :
                "执行解释：MySQL 已提交，但 Redis 尚未与权威库存一致。";
        }
        if (consistent) {
            return Number(run.retryCount || 0) > 0 ?
                "执行解释：发布器经真实重试后完成失效，Redis 最终一致。" :
                "执行解释：响应先结束，异步链路随后完成 Redis 删除缓存。";
        }
        return "执行解释：请求关键路径已结束，缓存失效链路仍未收敛。";
    }

    function renderStageReadout(record, index) {
        var evidence = stageEvidence(record, index);
        byId("stage-kicker").textContent = evidence.kicker;
        byId("stage-title").textContent = evidence.title;
        byId("stage-summary").textContent = evidence.summary;
        setGameMetric("game-success-count", index >= 2 ? formatNumber(record.run.purchaseSucceeded) : "0");
        setGameMetric("stage-mysql-stock", stockText(evidence.mysql));
        setGameMetric("stage-redis-stock", stockText(evidence.redis));
        setGameMetric("game-old-read-count", formatNumber(record.probe.oldReads));
        byId("stage-message-state").textContent = evidence.message;
        setGameMetric("stage-duration", evidence.duration);
        byId("game-verdict-line").textContent = stageVerdict(record, index);
        byId("purchase-stock-summary").textContent =
            "回放快照 · MySQL " + stockText(evidence.mysql) + " · Redis " + stockText(evidence.redis);
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
        setNode("node-service", "success", "购买结果已收集", formatMS(run.purchaseLatencyMs),
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
            next: "事务提交后到达响应边界。",
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
            focusFlowNode(null, "complete", failedStep ? "同步失效失败" : "同步请求链路已完成",
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

    function applyProbeFrame(record) {
        var run = record.run;
        var probe = record.probe;
        renderProbeStream(probe, "completed");
        byId("story-redis-stock").textContent = stockText(run.finalRedisStock);
        focusFlowNode("node-probe", state.strategy === "outbox-mq-invalidate" ? "async" : "critical",
            "一致性探针已冻结", probe.completed + " 个真实样本");
        setStepExplanation({
            phase: "replay-probe",
            term: "一致性探针检查缓存窗口",
            action: "探针持续比较 Redis 查询结果与 MySQL 真实库存。",
            reason: "最终一致不代表过程中没有旧读，必须观察整个失效窗口。",
            evidence: "样本：" + probe.completed + " · 旧读：" + probe.oldReads +
                " · 最大窗口：" + formatMS(probe.maxStaleWindowMs),
            next: "汇总响应速度、旧读和最终库存。",
            tone: "probe"
        });
    }

    function applyCompleteFrame(record) {
        var run = record.run;
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
        var actionsByStage = [
            ["transaction_started"],
            ["transaction_committed", "update_mysql", "idempotent_order", "sold_out", "outbox_created", "write_outbox"],
            ["purchase_responded"],
            ["cache_invalidated", "delete_cache", "cache_invalidation_failed", "delete_cache_failed"],
            ["query_material"]
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
        if (index === 3 && record.strategy === "outbox-mq-invalidate") {
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
        if (index === stageNames.length - 1) {
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
            applyCompleteFrame(state.record);
        }
        renderStageReadout(state.record, state.replay.index);
        renderTimeline();
        renderHeaderAndControls();
        renderInventoryMonitor();
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
                    renderInventoryMonitor();
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

    function renderLiveRunHUD(run) {
        if (!run) {
            return;
        }
        state.runObservedAt = Date.now();
        var outbox = outboxSummary(run);
        var processed = Math.min(Number(run.purchaseProcessed || 0), Number(run.purchaseRequested || PURCHASE_COUNT));
        var requested = Number(run.purchaseRequested || PURCHASE_COUNT);
        var criticalDone = run.criticalPathCompleted === true;
        var asyncStrategy = state.strategy === "outbox-mq-invalidate";
        var outboxTotal = outbox.total || Number(run.purchaseSucceeded || 0);
        var brokerAccepted = outbox.published + outbox.completed;
        var waitingConsumer = asyncStrategy && criticalDone && run.status === "waiting_consumer";
        var completed = run.status === "completed";

        byId("stage-kicker").textContent = "LIVE EXECUTION";
        byId("topology-status").textContent = criticalDone ?
            (asyncStrategy ? "PHASE 02" : "CRITICAL PATH COMPLETE") : "PHASE 01";

        setNode("node-buyers", processed > 0 || criticalDone ? "success" : "running",
            processed > 0 || criticalDone ? "150 个唯一请求已释放" : "正在释放唯一请求",
            processed + " / " + requested, "12 concurrent");
        setNode("node-service", criticalDone ? "success" : "running",
            criticalDone ? "购买结果已收集" : "正在编排购买请求",
            processed + " / " + requested, formatNumber(run.purchaseSucceeded || 0) + " success");
        setNode("node-mysql", criticalDone ? "success" : (processed > 0 ? "running" : "waiting"),
            criticalDone ? "事务批次已提交" : (processed > 0 ? "事务持续提交中" : "等待首个事务"),
            processed + " / " + requested,
            stockText(run.initialStock) + " → " + stockText(run.finalMySQLStock));
        setNode("node-response", criticalDone ? (run.status === "failed" ? "failed" : "success") : "waiting",
            criticalDone ? "购买响应已返回" : "等待关键路径结束",
            criticalDone ? formatMS(run.purchaseP99Ms) : "—",
            criticalDone ? (formatNumber(run.purchaseSucceeded || 0) + " success") : "—");
        setFlowEdge("edge-tasks-service", processed > 0 || criticalDone ? "completed" : "running");
        setFlowEdge("edge-service-mysql", criticalDone ? "completed" : (processed > 0 ? "running" : "idle"));
        setFlowEdge("edge-mysql-response", criticalDone ? "completed" : "idle");

        if (asyncStrategy) {
            setNode("node-outbox", criticalDone ? "success" : (processed > 0 ? "running" : "waiting"),
                criticalDone ? "与订单同事务提交" : "随成功订单写入",
                criticalDone ? "COMMIT" : (processed + " / " + requested),
                criticalDone ? (outboxTotal + " events") : "pending");
            setNode("node-sync-redis", "unused", "异步方案不阻塞 Response", "—", "not used");
        } else {
            setNode("node-outbox", "unused", "同步方案不写入", "—", "not used");
            setNode("node-sync-redis", criticalDone ? (run.status === "failed" ? "failed" : "success") :
                (processed > 0 ? "running" : "waiting"),
            criticalDone ? (run.status === "failed" ? "Redis DEL 失败" : "同步 Redis DEL 已完成") :
                (processed > 0 ? "每笔提交后执行 DEL" : "等待事务提交"),
            criticalDone ? formatMS(run.cacheInvalidationLatencyMs) : (processed + " / " + requested),
            criticalDone ? (run.status === "failed" ? "failed" : "cache deleted") : "in request path");
        }

        if (!criticalDone) {
            byId("stage-title").textContent = processed > 0 ? "MySQL Transaction 正在推进" : "Purchase Service 已接收任务";
            byId("stage-summary").textContent = "已处理 " + processed + " / " + requested +
                " 个真实请求；Response 与异步支线仍未开始。";
            focusFlowNode(processed > 0 ? "node-mysql" : "node-service", "critical",
                processed > 0 ? "MySQL Transaction 正在提交" : "Purchase Service 正在编排",
                "请求关键路径正在推进");
        } else if (!asyncStrategy) {
            byId("stage-title").textContent = completed ? "同步请求关键路径已完成" : "同步 Redis DEL 正在收尾";
            byId("stage-summary").textContent = "Response 已包含 Redis DEL 结果；本方案没有异步失效阶段。";
            focusFlowNode(completed ? null : "node-sync-redis", completed ? "complete" : "critical",
                completed ? "同步实验完成" : "同步 Redis DEL", "同步失效属于请求关键路径");
        } else {
            var workerDone = outboxTotal > 0 && brokerAccepted === outboxTotal;
            var consumerDone = outboxTotal > 0 && outbox.completed === outboxTotal;
            setNode("node-worker", outbox.retry ? "retry" : (workerDone ? "success" : "running"),
                outbox.retry ? "发布失败，等待重试" : (workerDone ? "Outbox 已全部发布" : "扫描 pending / retry"),
                Number(run.retryCount || 0) + " retries",
                (outbox.pending + outbox.publishing + outbox.retry) + " waiting");
            setNode("node-mq", workerDone ? "success" : (brokerAccepted > 0 ? "running" : "waiting"),
                brokerAccepted > 0 ? "Broker 已接收失效事件" : "等待 Publisher",
                brokerAccepted + " / " + outboxTotal, run.mqStatus || "—");
            setNode("node-consumer", consumerDone ? "success" : (brokerAccepted > outbox.completed ? "running" : "waiting"),
                consumerDone ? "消息已幂等消费" : (brokerAccepted > outbox.completed ? "正在消费并校验事件" : "等待消息"),
                outbox.completed + " / " + outboxTotal + " msgs", "event_id dedupe");
            setNode("node-async-redis", consumerDone ? "success" : (brokerAccepted > outbox.completed ? "running" : "waiting"),
                consumerDone ? "Redis DEL 已完成" : (brokerAccepted > outbox.completed ? "正在执行幂等 DEL" : "等待缓存失效 Consumer"),
                "1 key", outbox.completed + " / " + outboxTotal + " events");
            setFlowEdge("edge-worker-mq", workerDone ? "completed" : (outbox.publishing > 0 || brokerAccepted > 0 ? "running" : "idle"));
            setFlowEdge("edge-mq-consumer", consumerDone ? "completed" : (brokerAccepted > 0 ? "running" : "idle"));
            setFlowEdge("edge-consumer-redis", consumerDone ? "completed" : (brokerAccepted > outbox.completed ? "running" : "idle"));

            if (completed) {
                byId("stage-title").textContent = "异步失效链路已完成";
                byId("stage-summary").textContent = "Publisher、MQ、缓存失效 Consumer 与 Redis DEL 已处理 " +
                    outbox.completed + " / " + outboxTotal + " 个真实事件。";
                focusFlowNode(null, "complete", "异步链路完成", "缓存已与 MySQL 权威库存收敛");
            } else if (waitingConsumer || brokerAccepted > outbox.completed) {
                byId("stage-title").textContent = "缓存失效 Consumer 正在处理删缓存通知";
                byId("stage-summary").textContent = "MQ 已接收 " + brokerAccepted + " 个事件；缓存失效 Consumer 已完成 " +
                    outbox.completed + " / " + outboxTotal + " 次校验、DEL 与确认。";
                focusFlowNode("node-consumer", "async", "缓存失效 Consumer 正在消费", "它不处理创建或取消订单");
            } else {
                byId("stage-title").textContent = "Outbox Publisher 等待下一次扫描";
                byId("stage-summary").textContent = "请求关键路径已结束；Publisher 每 1 秒真实扫描 pending / retry。";
                focusFlowNode("node-worker", "async", "Outbox Publisher 正在等待扫描节拍", "事务提交后的异步阶段");
            }
        }

        setGameMetric("game-success-count", formatNumber(run.purchaseSucceeded || 0));
        setGameMetric("stage-mysql-stock", stockText(run.finalMySQLStock));
        setGameMetric("stage-redis-stock", stockText(run.finalRedisStock));
        setGameMetric("game-old-read-count", formatNumber(state.probe.oldReads || 0));
        byId("stage-message-state").textContent = asyncStrategy ?
            (criticalDone ? ("缓存失效 Consumer " + outbox.completed + " / " + outboxTotal) : "Outbox 尚未展开") :
            (criticalDone ? "同步链路结束" : "Redis DEL 位于关键路径");
        setGameMetric("stage-duration", Number(run.purchaseP99Ms) > 0 ?
            formatMS(run.purchaseP99Ms) : "采集中");
        byId("game-verdict-line").textContent = !criticalDone ?
            "执行解释：当前亮点来自后端增量快照，不是前端定时器推演。" :
            (asyncStrategy ? "执行解释：Response 已结束，缓存失效正沿独立事件链推进。" :
                "执行解释：同步 Redis DEL 已计入购买响应耗时。");
        renderProbeStream(state.probe, state.probe.active ? "active" : "completed");
        renderLiveStepExplanation(run);
        renderInventoryMonitor();
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
            playbackVersion: 2,
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
                "真实执行已经完成，正在自动回放五个关键步骤。" :
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
