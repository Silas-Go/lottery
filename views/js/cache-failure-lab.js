(function () {
    "use strict";

    var STORAGE_KEY = "silas.cache-failure-lab.results.v2";
    var TERMINAL = ["completed", "failed", "stopped"];
    var backendOriginDelayMs = Number(document.body.dataset.originDelayMs) || 0;
    var state = {
        scenario: new URL(window.location.href).searchParams.get("scenario") === "penetration" ? "penetration" : "breakdown",
        protection: "none",
        task: null,
        source: null,
        poll: 0,
        busy: false,
        savedTaskId: "",
        results: readResults()
    };

    function byId(id) { return document.getElementById(id); }
    function activeTask() { return state.task && TERMINAL.indexOf(state.task.status) < 0; }
    function experimentName() { return state.scenario === "breakdown" ? "cache-breakdown" : "cache-penetration"; }
    function protectedMode() { return state.scenario === "breakdown" ? "key-mutex" : "negative-cache"; }
    function resultKey(scenario, protection) { return scenario + ":" + protection; }

    function readResults() {
        try { return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || "{}"); }
        catch (_) { return {}; }
    }

    function saveResults() {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.results));
    }

    async function requestJSON(url, options) {
        var response = await window.fetch(url, options || {});
        var payload = await response.json().catch(function () { return {}; });
        if (!response.ok) {
            throw new Error(payload.message || ("请求失败 · HTTP " + response.status));
        }
        return payload;
    }

    function showToast(message, level) {
        var toast = byId("lab-toast");
        toast.textContent = message;
        toast.className = "lab-toast is-visible " + (level || "");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(function () { toast.className = "lab-toast"; }, 2800);
    }

    function setScenario(scenario) {
        if (activeTask() || (scenario !== "breakdown" && scenario !== "penetration")) { return; }
        closeConnections();
        state.scenario = scenario;
        state.protection = "none";
        state.task = null;
        state.savedTaskId = "";
        var url = new URL(window.location.href);
        url.searchParams.set("scenario", scenario);
        window.history.replaceState(null, "", url.toString());
        render();
    }

    function setProtection(protection) {
        if (activeTask() || (protection !== "none" && protection !== protectedMode())) { return; }
        state.protection = protection;
        state.task = null;
        state.savedTaskId = "";
        render();
    }

    async function startExperiment() {
        if (state.busy || activeTask()) { return; }
        state.busy = true;
        state.task = null;
        render();
        try {
            var response = await requestJSON("/api/loadtests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    experiment: experimentName(),
                    archiveId: 4,
                    mode: "cached",
                    rate: 1500,
                    connectionMode: "auto",
                    protection: state.protection
                })
            });
            await loadTask(response.taskId);
            openEvents(response.taskId);
            startPolling(response.taskId);
        } catch (error) {
            showToast(error.message, "danger");
        } finally {
            state.busy = false;
            render();
        }
    }

    async function evictCache() {
        if (!state.task || state.busy) { return; }
        state.busy = true;
        render();
        try {
            state.task = await requestJSON("/api/loadtests/" + encodeURIComponent(state.task.taskId) + "/cache-eviction", { method: "POST" });
            showToast("HOT KEY DELETED", "success");
        } catch (error) {
            showToast(error.message, "danger");
        } finally {
            state.busy = false;
            render();
        }
    }

    async function loadTask(taskId) {
        try {
            state.task = await requestJSON("/api/loadtests/" + encodeURIComponent(taskId));
            if (state.task.status === "completed") { freezeResult(state.task); }
            if (TERMINAL.indexOf(state.task.status) >= 0) { closeConnections(); }
            render();
        } catch (error) {
            showToast(error.message, "danger");
        }
    }

    function openEvents(taskId) {
        if (state.source) { state.source.close(); }
        var source = new window.EventSource("/api/loadtests/" + encodeURIComponent(taskId) + "/events");
        state.source = source;
        ["task_started", "reset_completed", "loadtest_started", "progress", "metric", "log", "cache_evicted", "cache_rebuilt", "cache_recovered", "completed", "failed", "stopped"].forEach(function (type) {
            source.addEventListener(type, function () { loadTask(taskId); });
        });
        source.onopen = function () { byId("connection-state").textContent = "SSE 已连接"; };
        source.onerror = function () {
            if (state.task && TERMINAL.indexOf(state.task.status) >= 0) { source.close(); }
            else { byId("connection-state").textContent = "SSE 重连中"; }
        };
    }

    function startPolling(taskId) {
        window.clearInterval(state.poll);
        state.poll = window.setInterval(function () {
            if (!state.task || TERMINAL.indexOf(state.task.status) < 0) { loadTask(taskId); }
        }, 1000);
    }

    function closeConnections() {
        if (state.source) { state.source.close(); state.source = null; }
        window.clearInterval(state.poll);
        state.poll = 0;
    }

    function freezeResult(task) {
        if (!task || state.savedTaskId === task.taskId) { return; }
        var metrics = task.metrics || {};
        state.results[resultKey(state.scenario, task.protection)] = {
            taskId: task.taskId,
            scenario: state.scenario,
            protection: task.protection,
            targetQps: task.tier.rate,
            actualQps: metrics.actualQps,
            redisMisses: metrics.redisMisses,
            mysqlFallbacks: metrics.mysqlFallbacks,
            sqlQueries: metrics.sqlQueries,
            p95: metrics.requestP95Ms,
            rate: task.tier.rate,
            connections: task.tier.connections,
            duration: task.tier.durationSeconds,
            archiveId: task.archiveId,
            probeArchiveId: task.probeArchiveId || 0,
            originDelayMs: Number(task.originDelayMs) || 0,
            negativeCacheHits: metrics.negativeCacheHits || 0,
            evictedElapsedMs: metrics.evictedElapsedMs || 0,
            rebuiltElapsedMs: metrics.rebuiltElapsedMs || 0,
            rebuildDurationMs: metrics.rebuildDurationMs || 0
        };
        state.savedTaskId = task.taskId;
        saveResults();
    }

    function render() {
        var breakdown = state.scenario === "breakdown";
        var task = state.task;
        var metrics = task && task.metrics ? task.metrics : {};
        var terminal = task && TERMINAL.indexOf(task.status) >= 0;
        var locked = state.busy || activeTask();

        document.body.dataset.scenario = state.scenario;
        document.body.dataset.taskStatus = task ? task.status : "idle";
        byId("header-scenario").textContent = breakdown ? "热点缓存击穿" : "缓存穿透";
        byId("tab-breakdown").setAttribute("aria-selected", String(breakdown));
        byId("tab-penetration").setAttribute("aria-selected", String(!breakdown));
        byId("tab-breakdown").disabled = locked;
        byId("tab-penetration").disabled = locked;
        byId("subject-label").textContent = breakdown ? "热点数据" : "查询目标";
        byId("subject-value").textContent = breakdown ? "ARC-004 / material id 4" : "MISSING-900004 / material id 900004";
        byId("cache-key").textContent = task && task.cacheKey ? task.cacheKey : (breakdown ? "archive:material-detail:v2:4" : "archive:material-detail:v2:900004");
        byId("protection-label").textContent = breakdown ? "回源保护" : "穿透保护";
        byId("protection-on-label").textContent = breakdown ? "按 Key 互斥 + Double Check" : "负缓存";
        byId("protection-note").textContent = breakdown ? "仅作用于当前 Go 进程" : "不存在结果写入独立短 TTL Key";
        byId("only-variable").textContent = breakdown ? "本轮唯一变量：回源保护" : "本轮唯一变量：穿透保护";
        byId("origin-injection").hidden = !breakdown;
        if (breakdown) {
            byId("origin-delay-tag").textContent = originDelayLabel(originDelayFor(task));
        }
        byId("protection-none").classList.toggle("is-active", state.protection === "none");
        byId("protection-on").classList.toggle("is-active", state.protection !== "none");
        byId("protection-none").setAttribute("aria-checked", String(state.protection === "none"));
        byId("protection-on").setAttribute("aria-checked", String(state.protection !== "none"));
        byId("protection-none").disabled = locked;
        byId("protection-on").disabled = locked;
        byId("fault-control").hidden = !breakdown;
        byId("penetration-control").hidden = breakdown;
        byId("ttl-row").hidden = !breakdown;
        byId("path-redis").innerHTML = breakdown ? "Redis <small>HIT → MISS → HIT</small>" : "Redis <small>MISS / NEGATIVE HIT</small>";

        byId("round-status").textContent = statusLabel(task);
        byId("connection-state").textContent = connectionLabel(task);
        byId("start-experiment").disabled = state.busy || activeTask();
        byId("start-experiment").textContent = terminal ? "开始新一轮" : (state.busy ? "正在准备" : "开始实验");
        byId("elapsed-time").textContent = formatClock(task ? task.elapsedSeconds : 0);
        byId("timeline-progress").style.width = Math.min(100, (task ? task.elapsedSeconds : 0) / 30 * 100) + "%";

        renderCacheState(task, metrics, breakdown);
        renderMetrics(task, metrics);
        renderEvictionControl(task, metrics, breakdown);
        renderLogs(task);
        renderRoundResult(task);
        renderComparison();
    }

    function renderCacheState(task, metrics, breakdown) {
        var label = "IDLE";
        var kind = "is-idle";
        if (task && breakdown) {
            if (metrics.scenarioPhase === "evicted") { label = "MISS"; kind = "is-miss"; }
            else if (metrics.scenarioPhase === "recovering") { label = "REBUILDING"; kind = "is-rebuilding"; }
            else if (metrics.keyPresent) { label = "HIT"; kind = "is-hit"; }
            else { label = "WARMING"; kind = "is-rebuilding"; }
        } else if (task) {
            if (metrics.currentNegativeHits > 0) { label = "NEGATIVE HIT"; kind = "is-hit"; }
            else if (metrics.currentRedisMisses > 0) { label = "MISS"; kind = "is-miss"; }
            else { label = "READY"; kind = "is-rebuilding"; }
        }
        byId("redis-state").textContent = label;
        byId("redis-state").className = "redis-state " + kind;
        byId("ttl-value").textContent = metrics.keyPttlMillis > 0 ? Math.ceil(metrics.keyPttlMillis / 1000) + "s" : "--";
    }

    function renderMetrics(task, metrics) {
        var hasTask = !!task;
        var final = task && task.status === "completed";
        byId("actual-qps").textContent = hasTask ? formatNumber(metrics.actualQps, 1) : "--";
        byId("redis-misses").textContent = hasTask ? formatInteger(metrics.redisMisses) : "--";
        byId("mysql-fallbacks").textContent = hasTask ? formatInteger(metrics.mysqlFallbacks) : "--";
        byId("sql-queries").textContent = hasTask ? formatInteger(metrics.sqlQueries) : "--";
        var p95 = final ? metrics.requestP95Ms : metrics.currentP95Ms;
        byId("p95").textContent = p95 > 0 ? formatNumber(p95, 1) + " ms" : "--";
    }

    function renderEvictionControl(task, metrics, breakdown) {
        var ready = breakdown && task && task.status === "running" && !metrics.evictedAt &&
            metrics.keyPresent && metrics.currentPositiveHits > 0 && Number(metrics.currentRedisMisses || 0) === 0 && metrics.currentHitRate >= 99;
        byId("evict-cache").disabled = state.busy || !ready;
        if (!task) { byId("fault-hint").textContent = "压测运行并形成稳定 HIT 后可删除"; }
        else if (metrics.evictedAt) { byId("fault-hint").textContent = "本轮已完成一次真实 Redis DEL"; }
        else if (ready) { byId("fault-hint").textContent = "热点 HIT 稳定，可以注入故障"; }
        else { byId("fault-hint").textContent = "正在等待稳定 HIT"; }

        var marker = byId("eviction-marker");
        if (metrics.evictedAt) {
            var elapsed = metrics.evictedElapsedMs || elapsedFromTimestamps(task.startedAt, metrics.evictedAt);
            marker.hidden = false;
            marker.style.left = Math.min(100, Math.max(0, elapsed / 30000 * 100)) + "%";
            byId("injection-time").textContent = "HOT KEY DELETED · " + formatOffset(elapsed);
        } else {
            marker.hidden = true;
            byId("injection-time").textContent = breakdown ? "尚未注入" : "持续不存在查询";
        }

        var rebuildWindow = byId("rebuild-window");
        var rebuilt = breakdown && metrics.evictedAt && metrics.rebuiltAt &&
            Number.isFinite(Number(metrics.rebuildDurationMs));
        rebuildWindow.hidden = !rebuilt;
        if (rebuilt) {
            byId("rebuild-evicted-at").textContent = formatPreciseOffset(metrics.evictedElapsedMs);
            byId("rebuild-completed-at").textContent = formatPreciseOffset(metrics.rebuiltElapsedMs);
            byId("rebuild-duration").textContent = formatInteger(metrics.rebuildDurationMs) + " ms";
        }
    }

    function renderLogs(task) {
        var log = byId("event-log");
        if (!task || !task.logs || !task.logs.length) {
            log.innerHTML = "<li><time>--:--</time><span>等待真实任务事件</span></li>";
            return;
        }
        log.innerHTML = task.logs.map(function (item) {
            var elapsed = task.startedAt ? Math.max(0, new Date(item.at).getTime() - new Date(task.startedAt).getTime()) : 0;
            return "<li><time>" + formatOffset(elapsed) + "</time><span>" + escapeHTML(item.message) + "</span></li>";
        }).join("");
        log.scrollTop = log.scrollHeight;
    }

    function renderRoundResult(task) {
        var section = byId("round-result");
        if (!task || task.status !== "completed") { section.hidden = true; return; }
        section.hidden = false;
        var metrics = task.metrics || {};
        var values = [
            ["模式", protectionLabel(task.protection)], ["实际 QPS", formatNumber(metrics.actualQps, 1)],
            ["Cache MISS", formatInteger(metrics.redisMisses)], ["数据库回源", formatInteger(metrics.mysqlFallbacks)],
            ["SQL Queries", formatInteger(metrics.sqlQueries)], ["P95", formatNumber(metrics.requestP95Ms, 1) + " ms"]
        ];
        if (state.scenario === "breakdown" && metrics.rebuildDurationMs >= 0 && metrics.rebuiltAt) {
            values.push(["缓存重建窗口", formatInteger(metrics.rebuildDurationMs) + " ms"]);
        }
        byId("round-result-values").innerHTML = values.map(function (pair) {
            return "<div><dt>" + pair[0] + "</dt><dd>" + pair[1] + "</dd></div>";
        }).join("");
        var next = state.protection === "none" ? protectedMode() : "none";
        byId("next-protection").textContent = state.protection === "none" ? "使用" + protectionLabel(next) + "再跑一次" : "切回无保护再跑一次";
        byId("next-protection").dataset.next = next;
    }

    function renderComparison() {
        var left = state.results[resultKey(state.scenario, "none")];
        var right = state.results[resultKey(state.scenario, protectedMode())];
        var section = byId("comparison");
        if (!left || !right || !sameExperimentConditions(left, right)) { section.hidden = true; return; }
        section.hidden = false;
        byId("compare-right-label").textContent = protectionLabel(protectedMode());
        var breakdown = state.scenario === "breakdown";
        byId("scenario-cold-open").hidden = false;
        byId("comparison-detail-eyebrow").textContent = "FULL EXPERIMENT DATA";
        byId("comparison-detail-title").textContent = "完整实验数据";
        renderScenarioColdOpen(left, right, breakdown);
        byId("comparison-conditions").textContent = "实验条件：" + left.targetQps + " QPS · -c " +
            left.connections + " · " + left.duration + "s" + (breakdown ?
                " · 回源故障注入 +" + left.originDelayMs + "ms" : " · 不存在数据 material id " + left.probeArchiveId);
        byId("comparison-origin-note").textContent = breakdown ? "+" + left.originDelayMs + "ms 为实验注入，用于放大缓存重建窗口；不代表真实 MySQL 查询耗时。" : "";
        byId("comparison-origin-note").hidden = !breakdown;
        var rows = [
            ["目标 QPS", left.targetQps, right.targetQps, false],
            ["实际 QPS", formatNumber(left.actualQps, 1), formatNumber(right.actualQps, 1), false],
            ["Cache MISS", formatInteger(left.redisMisses), formatInteger(right.redisMisses), false],
            ["数据库回源", formatInteger(left.mysqlFallbacks), formatInteger(right.mysqlFallbacks), true],
            ["SQL Queries", formatInteger(left.sqlQueries), formatInteger(right.sqlQueries), false],
            ["P95", formatNumber(left.p95, 1) + " ms", formatNumber(right.p95, 1) + " ms", false]
        ];
        if (breakdown) {
            rows.splice(4, 0, ["缓存重建窗口", formatInteger(left.rebuildDurationMs) + " ms", formatInteger(right.rebuildDurationMs) + " ms", false]);
        } else {
            rows.splice(4, 0, ["负缓存 HIT", formatInteger(left.negativeCacheHits), formatInteger(right.negativeCacheHits), false]);
        }
        byId("comparison-body").innerHTML = rows.map(function (row) {
            return "<tr" + (row[3] ? " class=\"is-key-row\"" : "") + "><td>" + row[0] + "</td><td>" + row[1] + "</td><td>" + row[2] + "</td></tr>";
        }).join("");
    }

    function renderScenarioColdOpen(left, right, breakdown) {
        var leftFallbacks = Number(left.mysqlFallbacks);
        var rightFallbacks = Number(right.mysqlFallbacks);
        var leftValue = formatInteger(leftFallbacks);
        var rightValue = formatInteger(rightFallbacks);
        var impact = originReduction(leftFallbacks, rightFallbacks);

        byId("scenario-cold-open").classList.toggle("has-wide-fallback", Math.max(leftValue.length, rightValue.length) >= 6);
        byId("cold-target-qps").textContent = formatInteger(left.targetQps);
        byId("cold-open-title").textContent = originResultTitle(leftFallbacks, rightFallbacks);
        byId("cold-open-subtitle").textContent = breakdown ?
            "只改变一个变量：是否开启回源保护" : "只改变一个变量：是否开启负缓存";
        byId("cold-left-label").textContent = "无保护";
        byId("cold-right-label").textContent = breakdown ? "回源保护" : "负缓存保护";
        byId("cold-left-fallbacks").textContent = leftValue;
        byId("cold-right-fallbacks").textContent = rightValue;
        byId("cold-shift-from").textContent = leftValue;
        byId("cold-shift-to").textContent = rightValue;
        byId("cold-reduction").textContent = impact.value;
        byId("cold-reduction").className = impact.tone;
        byId("cold-reduction-note").textContent = impact.note;
        byId("cold-primary-label").textContent = "SQL Queries";
        byId("cold-left-sql").textContent = formatInteger(left.sqlQueries);
        byId("cold-right-sql").textContent = formatInteger(right.sqlQueries);
        byId("cold-secondary-label").textContent = breakdown ? "Cache MISS" : "负缓存 HIT";
        byId("cold-left-misses").textContent = formatInteger(breakdown ? left.redisMisses : left.negativeCacheHits);
        byId("cold-right-misses").textContent = formatInteger(breakdown ? right.redisMisses : right.negativeCacheHits);
        byId("cold-load-profile").textContent = formatInteger(left.targetQps) + " QPS · -c" +
            formatInteger(left.connections) + " · " + formatInteger(left.duration) + "s";
        byId("cold-origin-tag").textContent = breakdown ?
            "实验注入：回源 +" + formatInteger(left.originDelayMs) + "ms" :
            "不存在数据：material id " + String(Math.round(Number(left.probeArchiveId)));
        byId("cold-origin-tag").className = breakdown ? "is-injection" : "is-missing-data";
    }

    function originResultTitle(left, right) {
        var leftValue = formatInteger(left);
        var rightValue = formatInteger(right);
        if (Number.isFinite(left) && Number.isFinite(right) && right < left) {
            return leftValue + " 次回源，只剩 " + rightValue + " 次";
        }
        if (Number.isFinite(left) && Number.isFinite(right) && right === left) {
            return leftValue + " 次回源，保护后仍为 " + rightValue + " 次";
        }
        return leftValue + " 次回源，保护后为 " + rightValue + " 次";
    }

    function originReduction(left, right) {
        if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0) {
            return { value: "—", note: "本轮没有可计算的回源降幅", tone: "is-neutral" };
        }
        var reduction = (left - right) / left * 100;
        if (reduction > 0) {
            return {
                value: "↓ " + formatReductionPercent(reduction, right) + "%",
                note: reduction >= 99 ? "重复回源几乎被全部挡住" :
                    (reduction >= 50 ? "多数重复回源被挡住" : "真实回源次数减少"),
                tone: "is-reduced"
            };
        }
        if (reduction === 0) {
            return { value: "持平", note: "本轮真实回源次数没有变化", tone: "is-neutral" };
        }
        return {
            value: "↑ " + formatNumber(Math.abs(reduction), 1) + "%",
            note: "本轮真实回源次数增加",
            tone: "is-increased"
        };
    }

    function formatReductionPercent(reduction, protectedFallbacks) {
        if (protectedFallbacks <= 0) { return formatNumber(reduction, 1); }
        for (var digits = 1; digits <= 6; digits += 1) {
            var value = reduction.toFixed(digits);
            if (Number(value) < 100) { return value; }
        }
        return "<100";
    }

    function clearComparison() {
        delete state.results[resultKey(state.scenario, "none")];
        delete state.results[resultKey(state.scenario, protectedMode())];
        saveResults();
        renderComparison();
        showToast("对比结果已清除", "success");
    }

    function statusLabel(task) {
        if (!task) { return "等待开始"; }
        return ({ starting: "创建任务", resetting: "建立实验环境", running: "压力持续中", collecting: "汇总真实结果", completed: "实验完成", failed: "实验失败", stopped: "实验已停止" })[task.status] || task.status;
    }

    function connectionLabel(task) {
        if (!task) { return "等待实验"; }
        if (task.status === "running") { return "SSE 实时观测"; }
        if (task.status === "completed") { return "真实结果已冻结"; }
        if (task.status === "failed") { return "任务失败"; }
        return "Runner · " + statusLabel(task);
    }

    function protectionLabel(value) {
        if (value === "key-mutex") { return "按 Key 互斥 + Double Check"; }
        if (value === "negative-cache") { return "负缓存"; }
        return "无保护";
    }

    function formatClock(seconds) {
        seconds = Math.max(0, Math.min(30, Number(seconds) || 0));
        return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(Math.floor(seconds % 60)).padStart(2, "0");
    }

    function formatOffset(ms) {
        ms = Math.max(0, Number(ms) || 0);
        var seconds = Math.floor(ms / 1000);
        var hundredths = Math.floor((ms % 1000) / 10);
        return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0") + "." + String(hundredths).padStart(2, "0");
    }

    function formatPreciseOffset(ms) {
        ms = Math.max(0, Math.round(Number(ms) || 0));
        var seconds = Math.floor(ms / 1000);
        return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" +
            String(seconds % 60).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
    }

    function originDelayFor(task) {
        var taskDelay = Number(task && task.originDelayMs);
        return taskDelay > 0 ? taskDelay : backendOriginDelayMs;
    }

    function originDelayLabel(delay) {
        return delay > 0 ? "实验注入：回源 +" + delay + "ms" : "实验注入：等待后端配置";
    }

    function sameExperimentConditions(left, right) {
        if (Number(left.targetQps) !== Number(right.targetQps) ||
            Number(left.connections) !== Number(right.connections) ||
            Number(left.duration) !== Number(right.duration) || Number(left.archiveId) !== Number(right.archiveId)) {
            return false;
        }
        if (state.scenario === "breakdown") {
            return Number(left.originDelayMs) > 0 && Number(left.originDelayMs) === Number(right.originDelayMs);
        }
        return Number(left.probeArchiveId) > 0 && Number(left.probeArchiveId) === Number(right.probeArchiveId);
    }

    function elapsedFromTimestamps(startedAt, at) {
        if (!startedAt || !at) { return 0; }
        return Math.max(0, new Date(at).getTime() - new Date(startedAt).getTime());
    }

    function formatNumber(value, digits) {
        value = Number(value);
        return Number.isFinite(value) ? value.toFixed(digits) : "--";
    }

    function formatInteger(value) {
        value = Number(value);
        return Number.isFinite(value) ? Math.round(value).toLocaleString("zh-CN") : "--";
    }

    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, function (char) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char];
        });
    }

    byId("tab-breakdown").addEventListener("click", function () { setScenario("breakdown"); });
    byId("tab-penetration").addEventListener("click", function () { setScenario("penetration"); });
    byId("protection-none").addEventListener("click", function () { setProtection("none"); });
    byId("protection-on").addEventListener("click", function () { setProtection(protectedMode()); });
    byId("start-experiment").addEventListener("click", startExperiment);
    byId("evict-cache").addEventListener("click", evictCache);
    byId("next-protection").addEventListener("click", function () {
        setProtection(this.dataset.next || protectedMode());
        byId("start-experiment").focus();
    });
    byId("clear-comparison").addEventListener("click", clearComparison);
    window.addEventListener("beforeunload", closeConnections);
    render();
}());
