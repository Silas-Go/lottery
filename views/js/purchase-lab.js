(function () {
    "use strict";

    var MATERIAL_STORAGE_KEY = "silas.cache-aside.material-id";
    var REPLAY_POSITION_KEY = "silas.cache-aside.purchase-replay-position.v2";
    // 独立实验报告使用新的前端信封保存，record/trace 本身保持原结构不变。
    // requestId 既是幂等键也是精确回看索引，避免同一方案重跑后误载最新一轮。
    var REPORT_ARCHIVE_KEY = "silas.cache-aside.purchase-report-archive.v1";
    var PURCHASE_COUNT = 150;
    var PROBE_RATE = 20;
    var PROBE_INTERVAL_MS = 1000 / PROBE_RATE;
    var LIVE_RUN_POLL_MS = 160;
    var LIVE_RUN_TIMEOUT_MS = 5 * 60 * 1000;
    var REPLAY_STEP_MS = 1800;
    var SETTLEMENT_REVEAL_MS = 2800;
    var ACTIVE_STATUSES = ["running", "waiting_outbox", "waiting_consumer"];
    var resultStore = window.SilasPurchaseLabResults;
    var reportArchiveMemory = null;
    // 对比选择和生成结果不写回实验 record，也不复用真实执行/回放状态机。
    var comparisonState = {
        syncReportId: null,
        asyncReportId: null,
        generated: null
    };
    var profiles = {
        1: { code: "ARC-001", name: "月盐" },
        2: { code: "ARC-002", name: "雾银" },
        3: { code: "ARC-003", name: "龙息琥珀" },
        4: { code: "ARC-004", name: "星髓" }
    };
    var strategyNames = {
        "sync-invalidate": "同步删除缓存",
        "outbox-mq-invalidate": "Outbox + MQ 异步失效"
    };
    var stageNames = [
        "Purchase Tasks 进入",
        "MySQL 事务提交",
        "Response 边界",
        "缓存失效链路",
        "Consistency Probe",
        "实验完成"
    ];
    // settlement 只负责“结算动画 -> 展开报告”的视觉节奏。
    // 它不进入 executionMode，也不写回 trace，防止结果动画扩大实验状态机。
    var settlement = {
        requestId: null,
        timer: null,
        revealed: Object.create(null)
    };
    // HUD 只在真实状态或保存 trace 切换时滚动到新数值；动画不生成业务进度。
    var metricAnimations = new WeakMap();
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

    function setGameMetric(id, value) {
        var element = byId(id);
        if (!element) {
            return;
        }
        var nextText = String(value === undefined || value === null ? "—" : value);
        var nextMatch = nextText.match(/-?\d[\d,]*(?:\.\d+)?/);
        var currentMatch = String(element.textContent || "").match(/-?\d[\d,]*(?:\.\d+)?/);
        var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        var previousFrame = metricAnimations.get(element);
        if (previousFrame) {
            window.cancelAnimationFrame(previousFrame);
            metricAnimations.delete(element);
        }
        element.classList.remove("is-counting");
        if (!nextMatch || !currentMatch || reduced) {
            element.textContent = nextText;
            element.classList.add("is-counting");
            window.setTimeout(function () {
                element.classList.remove("is-counting");
            }, reduced ? 0 : 420);
            return;
        }

        var from = Number(currentMatch[0].replace(/,/g, ""));
        var to = Number(nextMatch[0].replace(/,/g, ""));
        if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
            element.textContent = nextText;
            return;
        }
        var prefix = nextText.slice(0, nextMatch.index);
        var suffix = nextText.slice(nextMatch.index + nextMatch[0].length);
        var decimalPart = nextMatch[0].split(".")[1];
        var decimals = decimalPart ? decimalPart.length : 0;
        var startedAt = performance.now();
        var duration = 520;
        element.classList.add("is-counting");

        function draw(now) {
            var progress = Math.min(1, (now - startedAt) / duration);
            var stepped = Math.floor(progress * 10) / 10;
            var current = from + (to - from) * stepped;
            var formatted = decimals > 0 ?
                current.toFixed(decimals) :
                Math.round(current).toLocaleString("zh-CN");
            element.textContent = prefix + formatted + suffix;
            if (progress < 1) {
                metricAnimations.set(element, window.requestAnimationFrame(draw));
                return;
            }
            element.textContent = nextText;
            element.classList.remove("is-counting");
            metricAnimations.delete(element);
        }

        metricAnimations.set(element, window.requestAnimationFrame(draw));
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function emptyReportArchive() {
        return {
            schemaVersion: 1,
            nextSequenceByMaterial: {},
            reports: []
        };
    }

    function readReportArchive() {
        if (reportArchiveMemory) {
            return clone(reportArchiveMemory);
        }
        var archive = null;
        try {
            archive = JSON.parse(window.sessionStorage.getItem(REPORT_ARCHIVE_KEY) || "null");
        } catch (_) {
            archive = null;
        }
        if (!archive || archive.schemaVersion !== 1 || !Array.isArray(archive.reports)) {
            archive = emptyReportArchive();
        }
        if (!archive.nextSequenceByMaterial ||
                typeof archive.nextSequenceByMaterial !== "object") {
            archive.nextSequenceByMaterial = {};
        }
        reportArchiveMemory = archive;
        return clone(archive);
    }

    function writeReportArchive(archive) {
        reportArchiveMemory = clone(archive);
        try {
            window.sessionStorage.setItem(REPORT_ARCHIVE_KEY, JSON.stringify(archive));
            return true;
        } catch (_) {
            return false;
        }
    }

    function reportRequestId(record) {
        return record && record.run && record.run.requestId ?
            String(record.run.requestId) : "";
    }

    function isReportableRecord(record) {
        return !!(record && record.run && record.probe &&
            (record.run.status === "completed" || record.run.status === "failed") &&
            Array.isArray(record.run.trace) &&
            reportRequestId(record));
    }

    function isCompleteReportRecord(record) {
        return isReportableRecord(record) && record.run.status === "completed";
    }

    function saveReportEnvelope(record, options) {
        options = options || {};
        if (!isReportableRecord(record)) {
            return null;
        }
        var archive = readReportArchive();
        var reportId = reportRequestId(record);
        var existing = archive.reports.find(function (envelope) {
            return envelope && envelope.reportId === reportId;
        });
        if (existing) {
            return clone(existing);
        }
        var materialKey = String(Number(record.materialId || 0));
        var highestSequence = archive.reports.reduce(function (highest, envelope) {
            if (!envelope || !envelope.record ||
                    String(Number(envelope.record.materialId || 0)) !== materialKey) {
                return highest;
            }
            return Math.max(highest, Number(envelope.sequence || 0));
        }, 0);
        var sequence = Math.max(
            Number(archive.nextSequenceByMaterial[materialKey] || 1),
            highestSequence + 1
        );
        var envelope = {
            reportId: reportId,
            sequence: sequence,
            savedAt: record.frozenAt || new Date().toISOString(),
            record: clone(record)
        };
        archive.reports.push(envelope);
        archive.nextSequenceByMaterial[materialKey] = sequence + 1;
        var persisted = writeReportArchive(archive);
        if (!persisted && !options.silent) {
            showToast("实验报告已保留在当前页面，但浏览器存储空间不足，刷新后可能无法恢复。", "error");
        }
        return clone(envelope);
    }

    function migrateLatestResultsToArchive() {
        var legacy = resultStore ? resultStore.list() : {};
        Object.keys(legacy || {}).map(function (strategy) {
            return legacy[strategy];
        }).filter(isReportableRecord).sort(function (left, right) {
            return new Date(left.frozenAt || left.run.executedAt || 0).getTime() -
                new Date(right.frozenAt || right.run.executedAt || 0).getTime();
        }).forEach(function (record) {
            saveReportEnvelope(record, { silent: true });
        });
    }

    function reportEnvelopesForMaterial(materialId) {
        return readReportArchive().reports.filter(function (envelope) {
            return envelope && isReportableRecord(envelope.record) &&
                Number(envelope.record.materialId) === Number(materialId);
        }).sort(function (left, right) {
            return Number(left.sequence || 0) - Number(right.sequence || 0);
        });
    }

    function findReportEnvelope(reportId) {
        if (!reportId) {
            return null;
        }
        var envelope = readReportArchive().reports.find(function (candidate) {
            return candidate && candidate.reportId === String(reportId);
        });
        return envelope ? clone(envelope) : null;
    }

    function reportLabel(envelope) {
        var sequence = Number(envelope && envelope.sequence || 0);
        return "实验报告 " + String(sequence).padStart(2, "0");
    }

    function reportEnvelopeForRecord(record) {
        return findReportEnvelope(reportRequestId(record));
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

    // 技术节点继续使用真实名称；字幕只负责把当前动作即时翻译成白话，
    // 并且只由真实 run / 保存 trace 驱动，不用前端计时器伪造业务进度。
    function setSystemSubtitle(term, line, next, tone) {
        var panel = byId("system-subtitle");
        if (!panel) {
            return;
        }
        var signature = [term, line, next, tone].join("\u0000");
        if (panel.dataset.signature === signature) {
            return;
        }
        panel.dataset.signature = signature;
        panel.dataset.tone = tone || "idle";
        byId("system-subtitle-term").textContent = term;
        byId("system-subtitle-line").textContent = line;
        byId("system-subtitle-next").textContent = "下一句：" + next;
        panel.classList.remove("is-changing");
        window.requestAnimationFrame(function () {
            panel.classList.add("is-changing");
            window.clearTimeout(setSystemSubtitle.timer);
            setSystemSubtitle.timer = window.setTimeout(function () {
                panel.classList.remove("is-changing");
            }, 560);
        });
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

    function renderIdleSystemSubtitle() {
        if (state.strategy === "sync-invalidate") {
            setSystemSubtitle(
                "SYNC INVALIDATION · COMMIT → DEL → RESPONSE",
                "MySQL 是真实库存。购买提交后，请求会先删除 Redis 旧副本，再把购买结果返回。",
                "Redis 显示 MISS 只表示副本被删；下一次查询会从 MySQL 读取最新库存并回填。",
                "critical"
            );
            return;
        }
        if (state.strategy === "outbox-mq-invalidate") {
            setSystemSubtitle(
                "OUTBOX PATTERN · TRANSACTIONAL EVENT",
                "每成功一笔购买，MySQL 会同时扣库存并写一条 Outbox 待办；两件事一起提交，购买结果不等待后台删缓存。",
                "Publisher 会扫描待办，经 RocketMQ 交给 Consumer 删除 Redis 旧副本。",
                "async"
            );
            return;
        }
        setSystemSubtitle(
            "MYSQL SOURCE OF TRUTH · REDIS CACHE",
            "MySQL 保存真实库存；Redis 只是为了查询更快而保存的一份临时副本。删除副本不会删除库存。",
            "选择方案后，字幕会随着当前技术节点继续播放。",
            "idle"
        );
    }

    function renderCompletedAsyncSubtitle(run, outbox) {
        var timing = outboxInvalidationTiming(run);
        var total = outbox.total || Number(run.purchaseSucceeded || 0);
        var timingCopy = timing ?
            ("首条 Outbox 写入后，首次 DEL 约 " + formatMS(timing.firstMs) +
                "；全部 " + total + " 条消息确认用了 " + formatMS(timing.allMs) + "。") :
            ("全部 " + total + " 条消息都已经处理并确认。");
        setSystemSubtitle(
            "CONSUMER · REDIS DEL · " + outbox.completed + "/" + total + " · ACK",
            timingCopy + " 这些消息都指向" + currentMaterialName() + "的同一条 Redis 详情缓存；消息数量不等于缓存数量。",
            "MISS 只表示查询副本暂时不在；真实库存仍在 MySQL，查询会把最新副本重新填回 Redis。",
            "complete"
        );
    }

    function renderLiveSystemSubtitle(run) {
        if (!run) {
            renderIdleSystemSubtitle();
            return;
        }
        if (run.status === "failed") {
            setSystemSubtitle(
                "REAL EXECUTION FAILED",
                "真实链路返回了失败状态；页面停在已有证据，不会用动画补造成功结果。",
                "查看当前失败节点和最近关键日志。",
                "error"
            );
            return;
        }
        var processed = Number(run.purchaseProcessed || 0);
        var requested = Number(run.purchaseRequested || PURCHASE_COUNT);
        var succeeded = Number(run.purchaseSucceeded || 0);
        if (!run.criticalPathCompleted) {
            if (processed === 0) {
                setSystemSubtitle(
                    "PURCHASE TASKS → PURCHASE SERVICE",
                    requested + " 个真实购买请求正在进入服务；它们会争抢同一种材料的 MySQL 库存。",
                    "每个成功请求都会进入一个独立的 MySQL Transaction。",
                    "critical"
                );
            } else {
                setSystemSubtitle(
                    "MYSQL TRANSACTION · CONDITIONAL UPDATE" +
                        (state.strategy === "outbox-mq-invalidate" ? " + OUTBOX INSERT" : ""),
                    "已经处理 " + processed + "/" + requested + " 个请求，成功 " + succeeded +
                        " 个；每个成功事务都把库存减 1" +
                        (state.strategy === "outbox-mq-invalidate" ? "，并同时写下一条删缓存待办。" : "。"),
                    "事务提交后才会到达 Response 边界。",
                    "critical"
                );
            }
            return;
        }
        if (state.strategy === "sync-invalidate") {
            setSystemSubtitle(
                "REDIS DEL → RESPONSE · SYNC PATH",
                "购买请求已经在返回前删除 Redis 旧副本；这里删的是查询副本，不是 MySQL 库存。",
                "20 QPS 探针遇到 MISS 后，会从 MySQL 读取最新库存并回填 Redis。",
                run.status === "completed" ? "complete" : "critical"
            );
            return;
        }

        var outbox = outboxSummary(run);
        var total = outbox.total || succeeded;
        var brokerAccepted = outbox.published + outbox.completed;
        if (total > 0 && outbox.completed === total) {
            renderCompletedAsyncSubtitle(run, outbox);
        } else if (brokerAccepted > outbox.completed) {
            setSystemSubtitle(
                "ROCKETMQ → CONSUMER → REDIS DEL · " + outbox.completed + "/" + total,
                "MQ 已收到 " + brokerAccepted + "/" + total + " 条通知，Consumer 已处理 " +
                    outbox.completed + " 条。每条通知都会尝试删除" + currentMaterialName() + "的同一条缓存副本。",
                "探针遇到 MISS 会回填，所以这条副本可能经历 DEL → 回填 → 再次 DEL。",
                "async"
            );
        } else {
            setSystemSubtitle(
                "OUTBOX PUBLISHER · SCAN pending/retry · 1 s",
                "购买结果已经返回。Publisher 每 1 秒检查一次 MySQL 待办，把还没发送的删缓存通知交给 RocketMQ。",
                "MQ 收到通知后，Consumer 才会执行 Redis DEL 并 ACK。",
                "async"
            );
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

    function formatClockTime(value) {
        if (!value) {
            return "尚未扫描";
        }
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return "尚未扫描";
        }
        return date.toLocaleTimeString("zh-CN", { hour12: false });
    }

    function renderPublisherClock(run) {
        var beat = byId("publisher-beat");
        if (!beat) {
            return;
        }
        var interval = Math.max(1, Number(run && run.publisherScanIntervalMs || 1000));
        var nextAt = run && run.publisherNextScanAt ? new Date(run.publisherNextScanAt).getTime() : 0;
        var remaining = nextAt ? Math.max(0, nextAt - Date.now()) : interval;
        var active = state.strategy === "outbox-mq-invalidate" && state.executionMode === "executing" &&
            run && (run.status === "waiting_outbox" || run.outboxStatus === "retry");
        beat.dataset.state = active ? "active" : (run && run.publisherScanCount ? "observed" : "idle");
        beat.style.setProperty("--publisher-scan-ms", interval + "ms");
        byId("publisher-countdown").textContent = active ?
            (Math.min(interval, remaining) / 1000).toFixed(1) + " s" : (interval / 1000).toFixed(1) + " s";
        byId("publisher-scan-meta").textContent = run && run.publisherScanCount ?
            ("真实扫描 #" + run.publisherScanCount + " · " + formatClockTime(run.publisherLastScanAt)) :
            "等待真实扫描";
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
            ("正在采样 · " + completed + " completed") : (completed ? "采样已冻结" : "尚未采样");
        setNode("node-probe", active ? "running" : (completed ? "success" : "idle"),
            active ? "Stock Probe · sampling" : "Stock Probe", completed + " samples", "OLD " + oldReads);
        setNode("node-probe-redis", oldReads ? "retry" : (completed ? "success" : "idle"),
            latest ? String(latest.source || "unknown").toUpperCase() : "Redis / MySQL Compare",
            "HIT " + Number(probe.hits || 0),
            "MISS " + (Number(probe.misses || 0) + Number(probe.fallbacks || 0)));
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
        byId("start-purchase-run").textContent = busy ? "后端正在真实执行…" : "开始 150 个请求实验";
        byId("prepare-action-hint").textContent = state.strategy ?
            ("本轮将真实执行“" + strategyNames[state.strategy] + "”；完成后自动按 trace 回放。请先结束其他标签页中的查询压测。") :
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
        byId("allegory-status").textContent = record ? "等待回放" : "等待执行";
        byId("topology-status").textContent = record ? "TRACE READY" : "IDLE";
        byId("story-redis-stock").textContent = stockText(initialRedis);
        setNode("node-buyers", "idle", "等待释放任务", "0 / 150", "150 × 1");
        setNode("node-service", "idle", "等待请求", "—", "—");
        setNode("node-mysql", "idle", "等待事务", "0 / 150", stockText(initialMySQL) + " → —");
        setNode("node-response", "idle", "等待返回", "—", "—");
        setNode("node-sync-redis", "idle", "等待事务提交", "—", "—");
        setNode("node-outbox", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不写入" : "等待事务", "同事务", "—");
        setNode("node-worker", "idle", "等待 Outbox", "0", "—");
        setNode("node-mq", "idle", "等待发布", "0", "—");
        setNode("node-consumer", "idle", "等待消息", "0 / 150", "—");
        setNode("node-async-redis", "idle", "等待 Consumer", "1 key", "0 events");
        ["edge-tasks-service", "edge-service-mysql", "edge-mysql-response", "edge-worker-mq",
            "edge-mq-consumer", "edge-consumer-redis"].forEach(function (edge) {
            setFlowEdge(edge, "idle");
        });
        focusFlowNode(null, "critical", record ? "TRACE READY" : "等待执行", "等待 Purchase Tasks");
        renderPublisherClock(record && record.run);
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

    function stageVerdict(record, index) {
        var run = record.run;
        var probe = record.probe || {};
        if (index === 0) {
            return "执行解释：150 个唯一请求已进入 Purchase Service，事务开始并发推进。";
        }
        if (index === 1) {
            return "执行解释：Inventory、Order 与可选 Outbox 已在 MySQL 事务边界内提交。";
        }
        if (index === 2) {
            return record.strategy === "sync-invalidate" ?
                "执行解释：Response 等待同步 Redis DEL，因此失效耗时属于请求关键路径。" :
                "执行解释：Response 在 COMMIT 后结束；缓存失效转入独立异步阶段。";
        }
        if (index === 3) {
            return record.strategy === "sync-invalidate" ?
                "执行解释：Redis DEL 已在响应前完成，后续读取将按 Cache-Aside 回填。" :
                "执行解释：Publisher 扫描 Outbox，经 MQ 与 Consumer 推进到幂等 Redis DEL。";
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
                "执行解释：最终状态一致；同步 DEL 的耗时计入了 Response。" :
                "执行解释：MySQL 已提交，但 Redis 尚未与权威库存一致。";
        }
        if (consistent) {
            return Number(run.retryCount || 0) > 0 ?
                "执行解释：Publisher 经真实重试后完成失效，Redis 最终一致。" :
                "执行解释：Response 先结束，异步链路随后完成 Redis DEL。";
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
        setGameMetric("game-old-read-count", index >= 4 ? formatNumber(record.probe.oldReads) : "0");
        byId("stage-message-state").textContent = evidence.message;
        setGameMetric("stage-duration", evidence.duration);
        byId("game-verdict-line").textContent = stageVerdict(record, index);
        byId("purchase-stock-summary").textContent =
            "回放快照 · MySQL " + stockText(evidence.mysql) + " · Redis " + stockText(evidence.redis);
        byId("control-status").textContent = evidence.summary;
    }

    function applyRequestFrame(record) {
        var run = record.run;
        var request = traceStep(run, ["transaction_started"]);
        byId("allegory-status").textContent = "Purchase Tasks 正在进入";
        byId("topology-status").textContent = "REQUEST RECEIVED";
        setNode("node-buyers", "running", "150 个唯一请求正在释放", formatMS(request && request.atMs), "150 × 1");
        setNode("node-service", "running", "购买 API 已接收", "—", "150 requests");
        setNode("node-mysql", "waiting", "等待事务提交", "—", run.initialStock + " → ?");
        setFlowEdge("edge-tasks-service", "running");
        focusFlowNode("node-service", "critical", "Purchase Service 正在编排", "请求关键路径正在推进");
        setSystemSubtitle(
            "PURCHASE TASKS → PURCHASE SERVICE",
            run.purchaseRequested + " 个真实购买请求开始争抢" + currentMaterialName() +
                "库存；这里展示的是一整轮请求，不是一次购买。",
            "每个成功请求都会进入一个独立的 MySQL Transaction。",
            "critical"
        );
    }

    function applyTransactionFrame(record) {
        var run = record.run;
        var transaction = traceStep(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        var outbox = outboxSummary(run);
        setNode("node-buyers", "success", "150 个唯一请求已释放", "150 / 150", "150 × 1");
        setNode("node-service", "success", "购买结果已收集", formatMS(run.purchaseLatencyMs),
            run.purchaseSucceeded + " success");
        setNode("node-mysql", "success", "事务已提交", formatMS(transaction && transaction.durationMs),
            run.initialStock + " → " + run.finalMySQLStock);
        setFlowEdge("edge-tasks-service", "completed");
        setFlowEdge("edge-service-mysql", "completed");
        if (state.strategy === "outbox-mq-invalidate") {
            setNode("node-outbox", "success", "订单与事件同事务提交", "同事务", outbox.total + " events");
        } else {
            setNode("node-outbox", "unused", "同步方案不写入", "—", "not used");
        }
        focusFlowNode("node-mysql", "critical", "MySQL Transaction 已提交", "事务边界已确认");
        setSystemSubtitle(
            "MYSQL TRANSACTION · INVENTORY" +
                (state.strategy === "outbox-mq-invalidate" ? " + OUTBOX" : ""),
            "成功 " + run.purchaseSucceeded + " 笔：每一笔都在 MySQL 中把库存减 1" +
                (state.strategy === "outbox-mq-invalidate" ?
                    "，并在同一个事务里写下一条后台删缓存待办。两件事要么一起成功，要么一起回滚。" :
                    "；MySQL 仍然是真实库存。"),
            "事务提交之后才到 Response；异步方案不会让用户等待 Consumer。",
            "critical"
        );
    }

    function applyResponseFrame(record) {
        var run = record.run;
        setNode("node-service", "success", "响应已收集", formatMS(run.purchaseLatencyMs),
            run.purchaseSucceeded + " success");
        if (state.strategy === "sync-invalidate") {
            var failedStep = traceStep(run, ["cache_invalidation_failed", "delete_cache_failed"]);
            setNode("node-sync-redis", failedStep ? "failed" : "success",
                failedStep ? "DEL 重试耗尽" : "Redis DEL 已完成",
                formatMS(run.cacheInvalidationLatencyMs), failedStep ? "failed" : "cache deleted");
        }
        setNode("node-response", run.status === "failed" ? "failed" : "success", "购买响应已返回",
            formatMS(run.purchaseP99Ms), run.purchaseSucceeded + " / " + PURCHASE_COUNT);
        setFlowEdge("edge-mysql-response", run.status === "failed" ? "failed" : "completed");
        focusFlowNode("node-response", "critical", "Response 边界已到达",
            state.strategy === "sync-invalidate" ? "同步 Redis DEL 已包含在关键路径" : "请求关键路径结束，异步阶段可以展开");
        setSystemSubtitle(
            "RESPONSE BOUNDARY · " + formatMS(run.purchaseP99Ms),
            state.strategy === "sync-invalidate" ?
                "购买结果已经返回；同步方案在返回前已经完成 Redis DEL，所以删除缓存的等待算在响应时间里。" :
                "购买结果已经返回。MySQL 库存和 Outbox 待办已经保存，但 Publisher、MQ、Consumer 仍会在后台继续。",
            state.strategy === "sync-invalidate" ?
                "下一次查询遇到 MISS 后，从 MySQL 重新装入最新缓存。" :
                "接下来 Publisher 每 1 秒扫描 Outbox，把删缓存通知发给 MQ。",
            "critical"
        );
    }

    function applyInvalidationFrame(record) {
        var run = record.run;
        var outbox = outboxSummary(run);
        var failedStep = traceStep(run, ["cache_invalidation_failed", "delete_cache_failed"]);
        if (state.strategy === "sync-invalidate") {
            var invalidated = traceStep(run, ["cache_invalidated", "delete_cache"]);
            setNode("node-sync-redis", failedStep ? "failed" : "success",
                failedStep ? "DEL 重试耗尽" : "Redis DEL 已完成",
                formatMS(run.cacheInvalidationLatencyMs), invalidated ? "cache deleted" : "—");
            focusFlowNode(null, "complete", failedStep ? "同步失效失败" : "同步请求链路已完成",
                failedStep ? "检查 Redis DEL 失败证据" : "没有异步支线");
            setSystemSubtitle(
                "REDIS DEL · SYNC INVALIDATION",
                failedStep ?
                    "Redis 旧副本没有成功删除；MySQL 事务可能已经提交，需要查看失败证据。" :
                    "请求已经删除" + currentMaterialName() + "的 Redis 查询副本。DEL 不会删除 MySQL 库存；副本缺失时显示 MISS。",
                failedStep ? "失败会直接影响本次 Response。" : "下一次查询会从 MySQL 读取最新库存并回填 Redis。",
                failedStep ? "error" : "complete"
            );
        } else {
            setNode("node-worker", outbox.retry ? "retry" : "success",
                outbox.retry ? "发布失败，等待重试" : "凭证已认领发布",
                String(run.retryCount || 0) + " retries", outbox.total + " events");
            setNode("node-mq", outbox.retry ? "retry" : "success",
                outbox.retry ? "发布包含重试" : "消息已由 Broker 接收",
                String(outbox.published + outbox.completed), run.mqStatus || "—");
            setNode("node-consumer", outbox.completed === outbox.total && outbox.total ? "success" : "running",
                outbox.completed ? "幂等失效已执行" : "正在消费消息",
                outbox.completed + " / " + (outbox.total || PURCHASE_COUNT) + " msgs",
                outbox.completed ? "Redis DEL" : "—");
            setNode("node-async-redis", outbox.completed === outbox.total && outbox.total ? "success" : "running",
                outbox.completed ? "缓存键已删除" : "等待幂等 DEL",
                "1 key", outbox.completed + " / " + (outbox.total || PURCHASE_COUNT) + " events");
            setFlowEdge("edge-worker-mq", "completed");
            setFlowEdge("edge-mq-consumer", "completed");
            setFlowEdge("edge-consumer-redis", outbox.completed ? "completed" : "running");
            focusFlowNode(outbox.completed === outbox.total && outbox.total ? "node-async-redis" : "node-consumer",
                "async", "异步失效链路", "Publisher → MQ → Consumer → Redis DEL");
            renderPublisherClock(run);
            if (outbox.completed === outbox.total && outbox.total) {
                renderCompletedAsyncSubtitle(run, outbox);
            } else {
                setSystemSubtitle(
                    "OUTBOX PUBLISHER → ROCKETMQ → CONSUMER → REDIS DEL",
                    "每条 Outbox 消息都要求 Consumer 尝试删除一次" + currentMaterialName() +
                        "缓存；多条消息可以指向同一个 Redis Key。",
                    "DEL 后会出现 MISS；20 QPS 探针随后可能从 MySQL 回填，后到的消息又可以再次 DEL。",
                    "async"
                );
            }
        }
        byId("story-redis-stock").textContent = "MISS";
    }

    function applyProbeFrame(record) {
        var run = record.run;
        var probe = record.probe;
        renderProbeStream(probe, "completed");
        byId("story-redis-stock").textContent = stockText(run.finalRedisStock);
        focusFlowNode("node-probe", state.strategy === "outbox-mq-invalidate" ? "async" : "critical",
            "Consistency Probe 已冻结", probe.completed + " 个真实样本");
        setSystemSubtitle(
            "CONSISTENCY PROBE · 20 QPS · REDIS/MYSQL COMPARE",
            "探针约每 50 ms 查询一次：先走 Redis 缓存路径，再读取 MySQL 真实库存进行比较。Redis MISS 时，它也会把最新值重新填回缓存。",
            "旧值次数表示实际观察到两边不同；它不是购买请求的一部分。",
            "probe"
        );
    }

    function applyCompleteFrame(record) {
        var run = record.run;
        byId("allegory-status").textContent = run.status === "failed" ? "实验失败" : "实验结果";
        byId("topology-status").textContent = String(run.status || "completed").toUpperCase();
        focusFlowNode(null, "complete", run.status === "failed" ? "实验失败" : "实验完成",
            run.status === "failed" ? "请检查失败证据" : "请求路径与失效路径均已结束");
        if (run.status === "failed") {
            setSystemSubtitle(
                "EXPERIMENT FAILED · REAL TRACE PRESERVED",
                "真实链路没有完整结束；页面保留已有证据，不会把未完成步骤显示成成功。",
                "查看失败节点、Outbox 状态和最近关键日志。",
                "error"
            );
        } else if (state.strategy === "outbox-mq-invalidate") {
            renderCompletedAsyncSubtitle(run, outboxSummary(run));
        } else {
            setSystemSubtitle(
                "EXPERIMENT COMPLETED · SYNC INVALIDATION",
                "购买、MySQL 提交、Redis DEL 和 Response 都已经结束；最终库存以 MySQL 为准。",
                "可以用时间线回看每个技术步骤，回放不会再次购买。",
                "complete"
            );
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

    function renderBattleEvidence(record) {
        var run = record.run;
        var probe = record.probe || {};
        var evidence = byId("report-evidence");
        var quality = probeEvidenceQuality(probe);
        var chips = [
            "P99 " + formatMS(run.purchaseP99Ms),
            "旧读 " + formatNumber(probe.oldReads) + " 次",
            "窗口 " + (Number(probe.maxStaleWindowMs) > 0 ? formatMS(probe.maxStaleWindowMs) : "0 ms"),
            "最终库存 " + stockText(run.finalMySQLStock) + " / " + stockText(run.finalRedisStock),
            "探针完成 " + quality.completed + " · 错误 " + quality.errors
        ];
        if (Number(run.retryCount) > 0) {
            chips.push("Publisher 重试 " + formatNumber(run.retryCount) + " 次");
        }
        if (Number(probe.errors) > 0) {
            chips.push("探针错误 " + formatNumber(probe.errors) + " 次");
        }
        evidence.replaceChildren();
        chips.forEach(function (copy) {
            var chip = document.createElement("span");
            chip.textContent = copy;
            evidence.appendChild(chip);
        });
    }

    function shopkeeperVerdict(record) {
        var run = record.run;
        var probe = record.probe || {};
        var p99 = formatMS(run.purchaseP99Ms);
        var oldReads = Number(probe.oldReads || 0);
        var staleWindow = Number(probe.maxStaleWindowMs || 0);
        var retries = Number(run.retryCount || 0);
        var consistent = currentConsistency(run);
        var probeQuality = probeEvidenceQuality(probe);
        if (run.status === "failed") {
            return "这轮采购没有顺利结算。已经完成的账本动作仍然保留，但链路在“" +
                (run.errorMessage || "未知步骤") + "”处留下了失败证据；应先展开工程证据，再决定是否重跑。";
        }
        if (record.strategy === "sync-invalidate") {
            var syncOpening = "同步方案把 Redis DEL 放在请求关键路径，本轮 Response P99 为 " + p99 + "。";
            var syncConsistency = !probeQuality.usable ?
                "库存探针仅完成 " + probeQuality.completed + " 次并出现 " +
                    probeQuality.errors + " 次错误，样本不足以评价旧读窗口。" :
                (oldReads === 0 ?
                "20 QPS 探针没有观察到旧库存读取，这只能说明本轮观测窗口内更新足够及时。" :
                "探针仍读到 " + oldReads + " 次旧库存，最大不一致窗口为 " +
                    formatMS(staleWindow) + "，需要检查同步删除耗时与查询并发。");
            var syncEnding = consistent === true ?
                "最终 MySQL 与 Redis 已经对齐；代价是每笔购买响应都要把缓存删除留在请求链内。" :
                "最终库存尚未对齐，不能因为采用同步方案就假定一致性已经成立。";
            return syncOpening + syncConsistency + syncEnding;
        }
        var asyncOpening = "异步方案在 MySQL COMMIT 后结束请求关键路径，本轮 Response P99 为 " + p99 + "。";
        var asyncConsistency = !probeQuality.usable ?
            "库存探针仅完成 " + probeQuality.completed + " 次并出现 " +
                probeQuality.errors + " 次错误，不能据此声称没有短暂旧读。" :
            (oldReads === 0 ?
            "探针没有观察到旧读，异步链路在本轮负载下及时完成，但这不代表延迟窗口永远为零。" :
            "异步失效完成前出现 " + oldReads + " 次旧读，最大不一致窗口为 " +
                formatMS(staleWindow) + "。");
        var asyncRecovery = retries > 0 ?
            "消息链路经历 " + retries + " 次真实重试后" + (consistent ? "仍收敛到最终一致。" : "仍未收敛到最终一致。") :
            (consistent ? "消息链路没有记录重试，并已收敛到最终一致。" : "消息链路没有记录重试，但最终库存仍未对齐。");
        return asyncOpening + asyncConsistency + asyncRecovery;
    }

    function renderBattleOverview(record) {
        var run = record.run;
        var materialName = record.materialName || (state.profile && state.profile.name) || "材料";
        var strategyName = strategyNames[record.strategy] || record.strategy || "—";
        var envelope = reportEnvelopeForRecord(record);
        byId("report-document-number").textContent = envelope ?
            reportLabel(envelope) : "独立实验报告";
        byId("report-material-title").textContent = materialName;
        byId("report-strategy-subtitle").textContent = strategyName;
        byId("report-material").textContent = materialName;
        byId("report-strategy").textContent = strategyName;
        byId("report-participants").textContent = formatNumber(run.purchaseRequested) + " 个请求";
        byId("report-success").textContent = formatNumber(run.purchaseSucceeded) + " 个";
        byId("report-soldout").textContent = formatNumber(run.soldOutRequests) + " 个";
        byId("report-initial-stock").textContent = formatNumber(run.initialStock);
        // frozenAt 是 Outbox、Consumer 和最终探针都已收集后的前端结算时刻。
        byId("report-executed-at").textContent = formatDateTime(record.frozenAt || run.executedAt);
        var quality = probeEvidenceQuality(record.probe);
        byId("report-probe-quality").textContent =
            "完成 " + quality.completed + " 次 · 错误 " + quality.errors + " 次" +
            (quality.usable ? "" : " · 证据不足");
        byId("purchase-conclusion").textContent = shopkeeperVerdict(record);
        renderBattleEvidence(record);
    }

    function clearSettlementTimer() {
        if (settlement.timer) {
            window.clearTimeout(settlement.timer);
            settlement.timer = null;
        }
    }

    function resetBattleReportVisual() {
        clearSettlementTimer();
        settlement.requestId = null;
        var section = byId("purchase-main-results");
        var placeholder = byId("battle-report-placeholder");
        var progress = byId("battle-settlement");
        var report = byId("battle-report-scroll");
        section.dataset.reportState = "waiting";
        placeholder.hidden = false;
        progress.hidden = true;
        report.setAttribute("aria-hidden", "true");
        byId("shop-allegory-stage").classList.remove("is-settling");
        byId("technical-details-panel").open = false;
        byId("open-technical-details").textContent = "展开工程证据";
    }

    function prepareBattleReport(record) {
        var requestId = record && record.run && record.run.requestId;
        if (!requestId || settlement.requestId === requestId) {
            return;
        }
        clearSettlementTimer();
        settlement.requestId = requestId;
        var section = byId("purchase-main-results");
        var report = byId("battle-report-scroll");
        byId("battle-report-placeholder").hidden = false;
        byId("battle-settlement").hidden = true;
        report.setAttribute("aria-hidden", "true");
        section.dataset.reportState = "waiting";
        byId("shop-allegory-stage").classList.remove("is-settling");
        byId("technical-details-panel").open = false;
        byId("open-technical-details").textContent = "展开工程证据";
        if (settlement.revealed[requestId]) {
            section.dataset.reportState = "revealed";
            byId("battle-report-placeholder").hidden = true;
            report.setAttribute("aria-hidden", "false");
        }
    }

    function revealBattleReport(requestId) {
        if (!requestId || settlement.requestId !== requestId) {
            return;
        }
        clearSettlementTimer();
        settlement.revealed[requestId] = true;
        byId("purchase-main-results").dataset.reportState = "revealed";
        byId("battle-report-placeholder").hidden = true;
        byId("battle-settlement").hidden = true;
        byId("battle-report-scroll").setAttribute("aria-hidden", "false");
        byId("shop-allegory-stage").classList.remove("is-settling");
        var envelope = findReportEnvelope(requestId);
        byId("result-status").textContent = envelope ?
            reportLabel(envelope) + " 已生成" : "真实报告已生成";
        renderSavedResults();
    }

    function suspendBattleSettlement() {
        if (byId("purchase-main-results").dataset.reportState !== "settling") {
            return;
        }
        clearSettlementTimer();
        byId("purchase-main-results").dataset.reportState = "waiting";
        byId("battle-report-placeholder").hidden = false;
        byId("battle-settlement").hidden = true;
        byId("battle-report-scroll").setAttribute("aria-hidden", "true");
        byId("shop-allegory-stage").classList.remove("is-settling");
    }

    function settleBattleReport(record, animate) {
        if (!record || !record.run) {
            return;
        }
        prepareBattleReport(record);
        renderResults(record);
        var requestId = record.run.requestId;
        if (settlement.revealed[requestId] || animate === false) {
            revealBattleReport(requestId);
            return;
        }
        clearSettlementTimer();
        byId("purchase-main-results").dataset.reportState = "settling";
        byId("battle-report-placeholder").hidden = true;
        byId("battle-settlement").hidden = false;
        byId("battle-report-scroll").setAttribute("aria-hidden", "true");
        byId("shop-allegory-stage").classList.add("is-settling");
        var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        settlement.timer = window.setTimeout(function () {
            revealBattleReport(requestId);
        }, reduced ? 80 : SETTLEMENT_REVEAL_MS);
    }

    function renderResults(record) {
        var run = record.run;
        var probe = record.probe;
        var consistent = currentConsistency(run);
        byId("result-p99").textContent = formatMS(run.purchaseP99Ms);
        byId("result-old-reads").textContent = formatNumber(probe.oldReads) + " 次";
        byId("result-stale-window").textContent = probe.maxStaleWindowMs > 0 ?
            formatMS(probe.maxStaleWindowMs) : "0 ms";
        byId("result-consistency").textContent = consistent === null ? "待回填" : (consistent ? "一致" : "不一致");
        byId("result-consistency").className = consistent === true ? "is-good" : (consistent === false ? "is-bad" : "");
        byId("result-stock-pair").textContent = "MySQL " + stockText(run.finalMySQLStock) +
            " / Redis " + stockText(run.finalRedisStock);
        var envelope = reportEnvelopeForRecord(record);
        byId("result-status").textContent = run.status === "failed" ?
            "真实运行失败" :
            (envelope ? reportLabel(envelope) + " 已保存" : "真实结果已保存");
        renderBattleOverview(record);
        renderTechnicalDetails(record);
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
        // invalidatedAt 在 Consumer 成功执行幂等 DEL 后写入，是 Consumer 与 Redis 删除共享的完成证据。
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
        if (state.replay.index < stageNames.length - 1) {
            suspendBattleSettlement();
        }
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
        settleBattleReport(state.record, true);
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
        if (next === stageNames.length - 1) {
            setExecutionMode("result",
                "实验结果来自已经完成的真实执行；单步到达结算页不会再次执行购买。");
            settleBattleReport(state.record, true);
        }
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
        settleBattleReport(state.record, true);
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
            settleBattleReport(state.record, true);
        }
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
        resetBattleReportVisual();
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
        byId("story-event-log").replaceChildren();
        var item = document.createElement("li");
        var time = document.createElement("time");
        var body = document.createElement("span");
        time.textContent = "READY";
        body.textContent = "等待真实 run 快照；节点状态只由后端进度、Outbox 与探针样本驱动。";
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
            "每次运行都会签发一份独立实验报告；完成两个不同方案后，才会解锁手动生成的方案对比。";
        setExecutionMode("idle");
        renderIdleSystemSubtitle();
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
            if (state.executionMode === "executing") {
                setGameMetric("game-old-read-count", formatNumber(probe.oldReads));
            }
        } catch (_) {
            probe.errors += 1;
        } finally {
            probe.inFlight -= 1;
            renderProbeStream(probe, probe.active ? "active" : "completed");
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
                consumerDone ? "Redis DEL 已完成" : (brokerAccepted > outbox.completed ? "正在执行幂等 DEL" : "等待 Consumer"),
                "1 key", outbox.completed + " / " + outboxTotal + " events");
            setFlowEdge("edge-worker-mq", workerDone ? "completed" : (outbox.publishing > 0 || brokerAccepted > 0 ? "running" : "idle"));
            setFlowEdge("edge-mq-consumer", consumerDone ? "completed" : (brokerAccepted > 0 ? "running" : "idle"));
            setFlowEdge("edge-consumer-redis", consumerDone ? "completed" : (brokerAccepted > outbox.completed ? "running" : "idle"));

            if (completed) {
                byId("stage-title").textContent = "异步失效链路已完成";
                byId("stage-summary").textContent = "Publisher、MQ、Consumer 与 Redis DEL 已处理 " +
                    outbox.completed + " / " + outboxTotal + " 个真实事件。";
                focusFlowNode(null, "complete", "异步链路完成", "缓存已与 MySQL 权威库存收敛");
            } else if (waitingConsumer || brokerAccepted > outbox.completed) {
                byId("stage-title").textContent = "Consumer 正在推进 Redis DEL";
                byId("stage-summary").textContent = "MQ 已接收 " + brokerAccepted + " 个事件；Consumer 已完成 " +
                    outbox.completed + " / " + outboxTotal + " 次幂等失效。";
                focusFlowNode("node-consumer", "async", "Consumer 正在消费", "缓存失效事件已经离开请求关键路径");
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
            (criticalDone ? ("Consumer " + outbox.completed + " / " + outboxTotal) : "Outbox 尚未展开") :
            (criticalDone ? "同步链路结束" : "Redis DEL 位于关键路径");
        setGameMetric("stage-duration", Number(run.purchaseP99Ms) > 0 ?
            formatMS(run.purchaseP99Ms) : "采集中");
        byId("game-verdict-line").textContent = !criticalDone ?
            "执行解释：当前亮点来自后端增量快照，不是前端定时器推演。" :
            (asyncStrategy ? "执行解释：Response 已结束，缓存失效正沿独立事件链推进。" :
                "执行解释：同步 Redis DEL 已计入购买响应耗时。");
        renderPublisherClock(run);
        renderProbeStream(state.probe, state.probe.active ? "active" : "completed");
        renderLiveSystemSubtitle(run);
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
                    "后端真实购买已响应，正在等待 Consumer 完成失效；回放尚未开始。" :
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
        var saved = record.run.status === "completed" && resultStore ?
            resultStore.save(record) : record;
        var envelope = saveReportEnvelope(saved || record);
        return envelope ? envelope.record : (saved || record);
    }

    function loadReplayRecord(record, options) {
        options = options || {};
        clearReplayTimer();
        state.record = clone(record);
        state.liveRun = clone(record.run);
        prepareBattleReport(state.record);
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
        setSystemSubtitle(
            "RESET BASELINE · CACHE PREHEAT",
            "实验正在把 MySQL 库存恢复到固定起点，并预先放入一份 Redis 查询副本；这一步完成后才释放 150 个购买请求。",
            "购买开始后，字幕只跟随后端真实状态推进。",
            "critical"
        );
        byId("control-status").textContent = "真实执行进行中；回放控制暂不可用。";
        byId("result-status").textContent = "正在真实执行";
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
            loadReplayRecord(saved || record, { autoplay: true, index: 0, furthest: 0, speed: 1 });
            showToast(run.status === "completed" ?
                "真实执行已完成，正在按本轮 trace 回放。" :
                "真实执行返回失败状态，正在回放已取得的证据。",
            run.status === "completed" ? "success" : "error");
        } catch (error) {
            stopProbe();
            clearReplayTimer();
            state.replay.playing = false;
            if (error.runStillActive && state.liveRun) {
                renderLiveRunHUD(state.liveRun);
                setExecutionMode("executing",
                    "页面已停止高频探针，但后端 run 仍在推进；这不是购买事务失败。请检查 Publisher / Consumer 状态。");
                byId("stage-kicker").textContent = "ASYNC RUN STILL ACTIVE";
                byId("stage-title").textContent = "异步链路仍在后台收敛";
                byId("stage-summary").textContent = error.message;
                byId("game-verdict-line").textContent =
                    "执行解释：主事务已经结束；当前只是在等待 Outbox / MQ / Consumer 的终态。";
                byId("purchase-fault-banner").hidden = false;
                byId("purchase-fault-title").textContent = "异步链路尚未完成";
                byId("purchase-fault-copy").textContent = error.message;
                showToast("购买事务已完成，异步链路仍在运行。", "error");
                return;
            }
            setExecutionMode("error",
                "真实执行未能返回完整 trace：" + error.message + "。页面没有启动回放。");
            setSystemSubtitle(
                "REAL EXECUTION FAILED",
                "真实执行没有返回完整结果：" + error.message + "。页面不会继续播放伪造的完成步骤。",
                "查看失败节点和真实事件日志。",
                "error"
            );
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

    function setComparisonMedal(ownerId, metricId, winner, metric) {
        byId(ownerId).textContent = winnerLabel(winner);
        byId(metricId).textContent = metric;
    }

    function renderComparisonBattle(sync, asyncRecord) {
        var syncRun = sync.run;
        var asyncRun = asyncRecord.run;
        var syncProbe = sync.probe;
        var asyncProbe = asyncRecord.probe;
        var materialName = sync.materialName || asyncRecord.materialName ||
            (state.profile && state.profile.name) || "材料";
        byId("duel-title").textContent = materialName + "购买方案对比";

        var speedWinner = lowerMetricWinner(
            syncRun.purchaseP99Ms,
            asyncRun.purchaseP99Ms,
            false,
            0.03
        );
        byId("compare-sync-p99").textContent = formatMS(syncRun.purchaseP99Ms);
        byId("compare-async-p99").textContent = formatMS(asyncRun.purchaseP99Ms);
        byId("compare-speed-winner").textContent = winnerLabel(speedWinner);
        byId("compare-speed-note").textContent = speedWinner === "tie" ?
            "裁决原因：两种方案的 P99 位于 3% 或 1 ms 容差内，本轮响应表现接近。" :
            (speedWinner === "unknown" ?
                "结论依据：至少一份报告缺少有效 P99，本维度不强行比较。" :
                "胜出原因：" + winnerLabel(speedWinner) + "的 P99 更低，差距为 " +
                    formatMS(Math.abs(Number(syncRun.purchaseP99Ms) - Number(asyncRun.purchaseP99Ms))) + "。");
        setComparisonMedal(
            "medal-speed-owner",
            "medal-speed-metric",
            speedWinner,
            "同步 " + formatMS(syncRun.purchaseP99Ms) + " · 异步 " + formatMS(asyncRun.purchaseP99Ms)
        );

        var syncOld = Number(syncProbe.oldReads || 0);
        var asyncOld = Number(asyncProbe.oldReads || 0);
        var consistencyWinner = "unknown";
        if (!probesAreComparable(syncProbe, asyncProbe)) {
            consistencyWinner = "unknown";
        } else if (syncOld === asyncOld) {
            consistencyWinner = lowerMetricWinner(
                syncProbe.maxStaleWindowMs,
                asyncProbe.maxStaleWindowMs,
                true,
                0.03
            );
        } else {
            consistencyWinner = syncOld < asyncOld ? "sync" : "async";
        }
        byId("compare-sync-old").textContent = formatNumber(syncOld) + " 次";
        byId("compare-async-old").textContent = formatNumber(asyncOld) + " 次";
        byId("compare-sync-window").textContent = syncProbe.maxStaleWindowMs > 0 ?
            formatMS(syncProbe.maxStaleWindowMs) : "0 ms";
        byId("compare-async-window").textContent = asyncProbe.maxStaleWindowMs > 0 ?
            formatMS(asyncProbe.maxStaleWindowMs) : "0 ms";
        byId("compare-consistency-winner").textContent = winnerLabel(consistencyWinner);
        byId("compare-consistency-note").textContent = consistencyWinner === "tie" ?
            "裁决原因：两轮探针的旧读次数和不一致窗口都接近，本轮不区分胜负。" :
            (consistencyWinner === "unknown" ?
                "裁决原因：两轮有效样本不足或覆盖量差距过大，本维度不强行裁决。同步完成 " +
                    formatNumber(syncProbe.completed) + " 次，异步完成 " +
                    formatNumber(asyncProbe.completed) + " 次。" :
                "胜出原因：" + winnerLabel(consistencyWinner) +
                    "观察到更少旧读；旧读相同时以最大窗口作为次级判据。");
        setComparisonMedal(
            "medal-consistency-owner",
            "medal-consistency-metric",
            consistencyWinner,
            consistencyWinner === "unknown" ?
                "有效探针 " + formatNumber(syncProbe.completed) + " / " +
                    formatNumber(asyncProbe.completed) + " 次" :
                "旧读 " + syncOld + " / " + asyncOld + " 次"
        );

        var syncFailure = !!traceStep(syncRun, [
            "cache_invalidation_failed",
            "delete_cache_failed"
        ]);
        var asyncRetryCount = Number(asyncRun.retryCount || 0);
        var asyncHasErrorEvidence = (asyncRun.outbox || []).some(function (event) {
            return !!event.lastError || event.status === "retry";
        });
        var asyncFailure = asyncHasErrorEvidence && asyncRun.status !== "completed";
        var asyncRecovered = (asyncRetryCount > 0 || asyncHasErrorEvidence) &&
            asyncRun.status === "completed" && currentConsistency(asyncRun) === true;
        var isolationWinner = "async";
        var isolationMeasured = false;
        if (syncFailure && !asyncFailure) {
            isolationWinner = "async";
            isolationMeasured = true;
        } else if (asyncFailure && !syncFailure) {
            isolationWinner = "sync";
            isolationMeasured = true;
        } else if (asyncRecovered && !syncFailure) {
            isolationWinner = "async";
            isolationMeasured = true;
        } else if (syncFailure && asyncFailure) {
            isolationWinner = "tie";
            isolationMeasured = true;
        }
        byId("compare-sync-isolation").textContent = syncFailure ?
            "请求链出现失效失败" : "Redis DEL 位于购买请求链";
        byId("compare-async-isolation").textContent = asyncFailure ? "消息链未完成" :
            (asyncRecovered ? "重试 " + asyncRetryCount + " 次后收敛" : "缓存失效移出购买请求链");
        byId("compare-isolation-winner").textContent = winnerLabel(isolationWinner);
        byId("compare-isolation-note").textContent = !isolationMeasured ?
            "结论依据：两轮 trace 都没有故障样本；按实际链路结构，Outbox + MQ 将缓存失效移出购买请求，故障不会直接阻断 Response。此项是机制分析，不冒充故障实测。" :
            (isolationWinner === "async" ?
                "胜出原因：本轮证据显示购买完成后，缓存失效可以由消息链路重试并继续收敛。" :
                (isolationWinner === "sync" ?
                    "胜出原因：本轮异步消息链路未完成，而同步链路完成了请求内失效。" :
                    "裁决原因：两种方案都留下故障证据，本维度不强行选边。"));
        setComparisonMedal(
            "medal-isolation-owner",
            "medal-isolation-metric",
            isolationWinner,
            !isolationMeasured ? "机制裁决 · 本轮无故障样本" :
                "同步 " + (syncFailure ? "失败" : "完成") + " · 异步重试 " + asyncRetryCount + " 次"
        );

        var speedSentence = speedWinner === "unknown" ?
            "响应速度缺少足够证据。" :
            (speedWinner === "tie" ?
                "两种方案的购买响应速度接近。" :
                winnerLabel(speedWinner) + "在本轮购买响应速度上占优。");
        var consistencySentence = consistencyWinner === "tie" ?
            "两轮缓存及时性接近。" :
            (consistencyWinner === "unknown" ?
                "缓存及时性缺少足够探针证据。" :
                winnerLabel(consistencyWinner) + "在旧读与不一致窗口上更稳。");
        var isolationSentence = isolationMeasured ?
            winnerLabel(isolationWinner) + "获得了本轮故障证据支持。" :
            "本轮没有触发故障；从已保存链路结构看，Outbox + MQ 的缓存失效不阻塞 Response，因此故障隔离更强。";
        var recommendation;
        if (speedWinner === "async" && currentConsistency(asyncRun) === true) {
            recommendation = "如果采购规模继续放大且业务能接受可观测的短暂旧读窗口，异步失效更值得优先评估；对库存展示必须立即更新的交易，仍应保留同步方案。";
        } else if (consistencyWinner === "sync" && asyncOld > syncOld) {
            recommendation = "对库存及时性敏感的小规模交易，同步失效更直接；只有当响应延迟或故障隔离成为主要矛盾时，再承担异步链路的工程复杂度。";
        } else {
            recommendation = "最终选择应由流量规模、可接受的不一致窗口和运维能力共同决定，而不是给方案贴上永久胜负标签。";
        }
        byId("alchemist-conclusion").textContent =
            "本次" + materialName + "采购中，" + speedSentence + consistencySentence +
            isolationSentence +
            "从架构结构看，同步删除缓存更简单，也更容易让缓存及时更新；" +
            "Outbox + MQ 把缓存失效移出核心响应链，减少核心链路依赖，更适合需要高并发与故障恢复能力的场景。" +
            recommendation;
    }

    function reportSelectionKey(strategy) {
        return strategy === "sync-invalidate" ? "syncReportId" : "asyncReportId";
    }

    function ensureComparisonSelection(reports) {
        ["sync-invalidate", "outbox-mq-invalidate"].forEach(function (strategy) {
            var key = reportSelectionKey(strategy);
            var selectedExists = reports.some(function (envelope) {
                return envelope.reportId === comparisonState[key] &&
                    envelope.record.strategy === strategy &&
                    isCompleteReportRecord(envelope.record);
            });
            if (selectedExists) {
                return;
            }
            var candidates = reports.filter(function (envelope) {
                return envelope.record.strategy === strategy &&
                    isCompleteReportRecord(envelope.record);
            });
            comparisonState[key] = candidates.length ?
                candidates[candidates.length - 1].reportId : null;
        });
    }

    function selectedComparisonPair(reports) {
        var sync = reports.find(function (envelope) {
            return envelope.reportId === comparisonState.syncReportId &&
                envelope.record.strategy === "sync-invalidate";
        });
        var asyncRecord = reports.find(function (envelope) {
            return envelope.reportId === comparisonState.asyncReportId &&
                envelope.record.strategy === "outbox-mq-invalidate";
        });
        if (!sync || !asyncRecord || sync.reportId === asyncRecord.reportId ||
                Number(sync.record.materialId) !== Number(asyncRecord.record.materialId) ||
                !isCompleteReportRecord(sync.record) ||
                !isCompleteReportRecord(asyncRecord.record)) {
            return null;
        }
        return { sync: sync, asyncRecord: asyncRecord };
    }

    function addReportCardMetric(list, label, value) {
        var item = document.createElement("div");
        var term = document.createElement("dt");
        var detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        item.appendChild(term);
        item.appendChild(detail);
        list.appendChild(item);
    }

    function selectReportForComparison(reportId) {
        var envelope = findReportEnvelope(reportId);
        if (!envelope || Number(envelope.record.materialId) !== state.materialId ||
                !isCompleteReportRecord(envelope.record)) {
            showToast("只有完整完成的实验报告可以加入方案对比。", "error");
            return;
        }
        comparisonState[reportSelectionKey(envelope.record.strategy)] = envelope.reportId;
        renderSavedResults();
        showToast(reportLabel(envelope) + " 已设为" +
            (envelope.record.strategy === "sync-invalidate" ? "同步" : "异步") +
            "方案的对比样本。");
    }

    function createSavedCard(envelope) {
        var record = envelope.record;
        var run = record.run;
        var probe = record.probe;
        var comparable = isCompleteReportRecord(record);
        var card = document.createElement("article");
        card.className = "purchase-saved-card battle-saved-card";
        card.setAttribute("role", "listitem");
        card.dataset.reportId = envelope.reportId;
        var selectionKey = reportSelectionKey(record.strategy);
        var selected = comparisonState[selectionKey] === envelope.reportId;
        if (selected) {
            card.classList.add("is-selected-for-comparison");
        }
        var meta = document.createElement("div");
        meta.className = "battle-saved-meta";
        var number = document.createElement("strong");
        number.textContent = "《" + reportLabel(envelope) + "》";
        var time = document.createElement("time");
        time.dateTime = envelope.savedAt || record.frozenAt || "";
        time.textContent = formatDateTime(envelope.savedAt || record.frozenAt || run.executedAt);
        meta.appendChild(number);
        meta.appendChild(time);
        var name = document.createElement("small");
        name.className = "battle-saved-strategy";
        name.textContent = strategyNames[record.strategy] || record.strategy;
        var title = document.createElement("h3");
        title.textContent = (record.materialName || "材料") + " · " +
            (record.strategy === "sync-invalidate" ? "同步删除缓存" : "Outbox + MQ");
        var metrics = document.createElement("dl");
        metrics.className = "battle-saved-metrics";
        addReportCardMetric(
            metrics,
            "成功购买",
            formatNumber(run.purchaseSucceeded) + " / " + formatNumber(run.purchaseRequested)
        );
        addReportCardMetric(metrics, "Response P99", formatMS(run.purchaseP99Ms));
        addReportCardMetric(
            metrics,
            "一致性窗口",
            Number(probe.maxStaleWindowMs) > 0 ? formatMS(probe.maxStaleWindowMs) : "0 ms"
        );
        addReportCardMetric(metrics, "旧库存读取", formatNumber(probe.oldReads) + " 次");
        addReportCardMetric(
            metrics,
            "最终状态",
            run.status === "failed" ? "实验失败" :
                (currentConsistency(run) === true ? "库存一致" : "库存未一致")
        );
        var conclusion = document.createElement("p");
        conclusion.className = "battle-saved-conclusion";
        conclusion.textContent = shopkeeperVerdict(record);
        var actions = document.createElement("div");
        actions.className = "battle-saved-actions";
        var reportButton = document.createElement("button");
        var processButton = document.createElement("button");
        var compareButton = document.createElement("button");
        reportButton.type = "button";
        reportButton.textContent = "查看本次报告";
        reportButton.setAttribute("aria-label", "查看" + reportLabel(envelope) + "的独立实验报告");
        reportButton.addEventListener("click", function () {
            loadArchivedReport(envelope.reportId, true);
        });
        processButton.type = "button";
        processButton.textContent = "重新查看实验过程";
        processButton.setAttribute("aria-label", "回看" + reportLabel(envelope) + "的完整实验过程");
        processButton.addEventListener("click", function () {
            loadArchivedReport(envelope.reportId, false);
        });
        compareButton.type = "button";
        compareButton.className = "battle-select-report";
        compareButton.setAttribute("aria-pressed", selected ? "true" : "false");
        compareButton.disabled = !comparable;
        compareButton.textContent = comparable ?
            (selected ? "已选为对比样本" : "设为对比样本") : "失败报告不可对比";
        compareButton.setAttribute("aria-label", "将" + reportLabel(envelope) + "设为" +
            (record.strategy === "sync-invalidate" ? "同步" : "异步") + "对比样本");
        compareButton.addEventListener("click", function () {
            selectReportForComparison(envelope.reportId);
        });
        actions.appendChild(reportButton);
        actions.appendChild(processButton);
        actions.appendChild(compareButton);
        card.appendChild(meta);
        card.appendChild(name);
        card.appendChild(title);
        card.appendChild(metrics);
        card.appendChild(conclusion);
        card.appendChild(actions);
        return card;
    }

    function visibleReportEnvelopes() {
        var reports = reportEnvelopesForMaterial(state.materialId);
        // 新记录写入 sessionStorage 后仍需完成六步回放与结算动画；在卷轴揭示前，
        // 报告列表不能提前泄露本轮指标。
        var currentRequestId = state.record && state.record.run && state.record.run.requestId;
        if (currentRequestId && !settlement.revealed[currentRequestId]) {
            reports = reports.filter(function (envelope) {
                return envelope.reportId !== currentRequestId;
            });
        }
        return reports;
    }

    function renderSavedResults() {
        var reports = visibleReportEnvelopes();
        var section = byId("purchase-saved-results");
        var grid = byId("purchase-saved-grid");
        section.hidden = reports.length === 0;
        ensureComparisonSelection(reports);
        grid.replaceChildren();
        reports.forEach(function (envelope) {
            grid.appendChild(createSavedCard(envelope));
        });
        var syncCount = reports.filter(function (envelope) {
            return envelope.record.strategy === "sync-invalidate" &&
                isCompleteReportRecord(envelope.record);
        }).length;
        var asyncCount = reports.filter(function (envelope) {
            return envelope.record.strategy === "outbox-mq-invalidate" &&
                isCompleteReportRecord(envelope.record);
        }).length;
        var pair = selectedComparisonPair(reports);
        var button = byId("generate-comparison-report");
        button.disabled = !pair;
        if (syncCount && asyncCount) {
            byId("comparison-readiness").textContent =
                "已解锁：存在同步删除缓存和 Outbox + MQ 两种不同方案的完整报告。";
            byId("comparison-selection-summary").textContent = pair ?
                "当前选择：" + reportLabel(pair.sync) + "（同步） + " +
                    reportLabel(pair.asyncRecord) + "（异步）。点击按钮后才会生成对比。" :
                "请分别选择一份同步报告和一份异步报告。";
        } else if (syncCount) {
            byId("comparison-readiness").textContent =
                "已保存 " + syncCount + " 份同步报告；还需完成一份 Outbox + MQ 实验报告。";
            byId("comparison-selection-summary").textContent =
                "同一方案的多次实验不会解锁方案对比。";
        } else if (asyncCount) {
            byId("comparison-readiness").textContent =
                "已保存 " + asyncCount + " 份 Outbox + MQ 报告；还需完成一份同步删除缓存实验报告。";
            byId("comparison-selection-summary").textContent =
                "同一方案的多次实验不会解锁方案对比。";
        } else {
            byId("comparison-readiness").textContent =
                "现有报告记录了失败过程；还需要两个不同方案的完整完成报告。";
            byId("comparison-selection-summary").textContent =
                "失败报告可以回看，但不会作为架构对比样本。";
        }
    }

    function loadArchivedReport(reportId, showReport) {
        var envelope = findReportEnvelope(reportId);
        if (!envelope || Number(envelope.record.materialId) !== state.materialId ||
                !isReportableRecord(envelope.record)) {
            showToast("这份报告没有保存完整 trace，无法回看过程。", "error");
            return;
        }
        var record = envelope.record;
        loadReplayRecord(record, {
            autoplay: false,
            index: showReport ? 5 : 0,
            furthest: 5,
            speed: 1
        });
        if (showReport) {
            settleBattleReport(state.record, false);
            showToast("已载入" + reportLabel(envelope) + "；没有调用购买接口。");
        } else {
            showToast("已载入" + reportLabel(envelope) + "的完整过程；没有调用购买接口。");
        }
    }

    function generateComparisonReport() {
        var reports = visibleReportEnvelopes();
        var pair = selectedComparisonPair(reports);
        if (!pair) {
            showToast("请先保存并选择两个不同方案的完整实验报告。", "error");
            return;
        }
        // 只有这个显式按钮入口会计算对比；保存、回放和列表渲染都不会调用比较函数。
        renderComparisonBattle(pair.sync.record, pair.asyncRecord.record);
        byId("duel-sync-source").textContent =
            reportLabel(pair.sync) + " · " + formatDateTime(pair.sync.savedAt);
        byId("duel-async-source").textContent =
            reportLabel(pair.asyncRecord) + " · " + formatDateTime(pair.asyncRecord.savedAt);
        comparisonState.generated = {
            sourceReportIds: [pair.sync.reportId, pair.asyncRecord.reportId],
            generatedAt: new Date().toISOString()
        };
        var dialog = byId("comparison-report-dialog");
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
        byId("duel-title").focus();
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
        var details = byId("technical-details-panel");
        details.open = !details.open;
        byId("open-technical-details").textContent = details.open ? "收起工程证据" : "展开工程证据";
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
        byId("generate-comparison-report").addEventListener("click", generateComparisonReport);
        byId("comparison-report-dialog").addEventListener("close", function () {
            byId("generate-comparison-report").focus();
        });
        byId("technical-details-panel").addEventListener("toggle", function () {
            byId("open-technical-details").textContent =
                byId("technical-details-panel").open ? "收起工程证据" : "展开工程证据";
        });
        window.addEventListener("beforeunload", function () {
            stopProbe();
            clearReplayTimer();
            clearSettlementTimer();
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
        document.body.dataset.materialKind = material.profile.code === "ARC-004" ? "star" : "standard";
        rememberMaterial(material.profile);
        byId("purchase-current-code").textContent = material.profile.code;
        byId("purchase-current-name").textContent = material.profile.name;
        byId("story-material-name").textContent = material.profile.name;
        byId("purchase-shop-link").href = "/material-shop";
        byId("back-to-query").href = "/lab?material=" + encodeURIComponent(material.profile.code);
        byId("purchase-empty").hidden = true;
        byId("purchase-content").hidden = false;
        return true;
    }

    function restoreSavedReplay() {
        var cursor = readReplayPosition();
        if (!cursor || Number(cursor.materialId) !== state.materialId) {
            return false;
        }
        var envelope = findReportEnvelope(cursor.requestId);
        var record = envelope && envelope.record;
        if (!record) {
            var saved = resultStore ? resultStore.list() : {};
            record = saved[cursor.strategy];
        }
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
        if (Number(cursor.index) === 5) {
            settleBattleReport(state.record, false);
        }
        return true;
    }

    async function init() {
        var incomingPlan = incomingPurchasePlan();
        if (!showContext(incomingMaterial())) {
            return;
        }
        migrateLatestResultsToArchive();
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
