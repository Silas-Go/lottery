(function () {
    "use strict";

    var MATERIAL_STORAGE_KEY = "silas.cache-aside.material-id";
    var resultStore = window.SilasPurchaseLabResults;
    var profiles = {
        1: { code: "ARC-001", name: "月盐", kind: "salt" },
        2: { code: "ARC-002", name: "雾银", kind: "silver" },
        3: { code: "ARC-003", name: "龙息琥珀", kind: "amber" },
        4: { code: "ARC-004", name: "星髓", kind: "star" }
    };
    var copy = {
        "nav.backQuery": "返回查询实验",
        "nav.backMarket": "返回室外",
        "empty.title": "尚未选择材料",
        "empty.body": "请先在查询实验中读取一份材料档案，再进入购买实验。",
        "empty.action": "返回查询实验",
        "intro.title": "比较 Cache-Aside 写操作的两种执行顺序",
        "intro.body": "每轮都从相同热缓存库存开始。服务端先完成真实 Redis/MySQL 操作，再把真实步骤与耗时交给页面回放。",
        "intro.boundaryTitle": "本店实验边界",
        "intro.boundaryBody": "只演示材料库存缓存失效顺序；不创建订单，不接入 MQ，也不演示秒杀库存。",
        "scheme.title": "选择写入顺序",
        "scheme.aTitle": "先删缓存，再更新数据库",
        "scheme.aBody": "竞态查询可能在更新前读到旧值，并在更新后把旧值写回缓存。",
        "scheme.bTitle": "先更新数据库，再删缓存",
        "scheme.bBody": "降低旧值长期停留在缓存中的概率，但不等于绝对强一致。",
        "timeline.title": "购买 T1 与查询 T2 的受控交错",
        "state.title": "真实状态与结果",
        "state.warning": "检测到缓存与权威数据不一致",
        "controls.title": "执行与教学回放",
        "results.title": "两种写入顺序的冻结结果"
    };
    var strategyCopy = {
        "delete-then-update": "先删缓存，再更新数据库",
        "update-then-delete": "先更新数据库，再删缓存"
    };
    var state = {
        materialId: null,
        profile: null,
        strategy: "delete-then-update",
        concurrentQuery: false,
        run: null,
        stepIndex: -1,
        playing: false,
        playTimer: null,
        requesting: false,
        warnedDirty: false,
        baseline: null,
        comparisonOpen: false,
        reducedMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    };

    function byId(id) {
        return document.getElementById(id);
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
            // URL 已携带材料上下文，sessionStorage 只负责刷新恢复。
        }
    }

    function applyI18n() {
        document.querySelectorAll("[data-i18n]").forEach(function (element) {
            var value = copy[element.dataset.i18n];
            if (value) {
                element.textContent = value;
            }
        });
    }

    function showToast(message, tone) {
        var toast = byId("lab-toast");
        toast.textContent = message;
        toast.className = "lab-toast is-visible " + (tone || "success");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(function () {
            toast.classList.remove("is-visible");
        }, 2400);
    }

    async function requestJSON(url, options) {
        var response = await window.fetch(url, Object.assign({
            headers: { "Content-Type": "application/json" }
        }, options || {}));
        var body = null;
        try {
            body = await response.json();
        } catch (_) {
            body = null;
        }
        if (!response.ok) {
            throw new Error(body && body.message ? body.message : "购买实验请求失败（HTTP " + response.status + "）");
        }
        return body;
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
        byId("purchase-empty").hidden = true;
        byId("purchase-content").hidden = false;
        byId("purchase-current-code").textContent = material.profile.code;
        byId("purchase-current-name").textContent = material.profile.name;
        document.body.dataset.materialKind = material.profile.kind;
        var queryURL = "/lab?material=" + encodeURIComponent(material.profile.code);
        byId("purchase-query-link").href = queryURL;
        byId("back-to-query").href = queryURL;
        byId("purchase-empty").querySelector("a").href = queryURL;
        return true;
    }

    function formatStock(value) {
        return value === null || value === undefined ? "MISS" : String(value);
    }

    function formatLatency(value) {
        var number = Number(value || 0);
        return (number < 0.1 ? number.toFixed(3) : number.toFixed(2)) + " ms";
    }

    function renderFixture(fixture) {
        state.baseline = fixture;
        byId("purchase-stock-summary").textContent = "MySQL " + fixture.mysqlStock + " · Redis " + formatStock(fixture.redisStock);
        byId("stage-mysql-stock").textContent = fixture.mysqlStock;
        byId("stage-redis-stock").textContent = formatStock(fixture.redisStock);
        byId("state-mysql-stock").textContent = fixture.mysqlStock;
        byId("state-redis-stock").textContent = formatStock(fixture.redisStock);
        byId("state-purchase-success").textContent = "等待";
        byId("state-dirty-cache").textContent = "未检测";
        byId("state-db-reads").textContent = "0";
        byId("state-cache-counts").textContent = "0 / 0";
        byId("state-latency").textContent = "—";
        byId("state-query-stock").textContent = "未插入";
        byId("consistency-title").textContent = "夹具状态已读取";
        byId("consistency-copy").textContent = fixture.redisStock === null ?
            "Redis 当前为 MISS；开始实验时服务端会恢复统一热缓存基线。" :
            "Redis 与 MySQL 当前库存一致，MySQL 是权威数据源。";
    }

    function renderStrategy() {
        document.body.dataset.purchaseStrategy = state.strategy;
        byId("header-strategy").textContent = strategyCopy[state.strategy];
        document.querySelectorAll(".purchase-scheme-card").forEach(function (button) {
            var active = button.dataset.strategy === state.strategy;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-checked", String(active));
        });
        updateControls();
    }

    function selectStrategy(strategy) {
        if (state.requesting || state.playing || state.run) {
            showToast("请先重置当前实验，再切换写入顺序。", "danger");
            return;
        }
        state.strategy = strategy;
        renderStrategy();
    }

    function toggleConcurrentQuery() {
        if (state.requesting || state.playing || state.run) {
            showToast("请先重置当前实验，再调整并发查询。", "danger");
            return;
        }
        state.concurrentQuery = !state.concurrentQuery;
        var button = byId("toggle-concurrent-query");
        button.setAttribute("aria-pressed", String(state.concurrentQuery));
        byId("concurrent-query-state").textContent = state.concurrentQuery ? "已开启 · T2 将进入竞态窗口" : "当前关闭";
        showToast(state.concurrentQuery ? "并发查询 T2 已加入下一轮实验。" : "并发查询 T2 已关闭。", "success");
    }

    function stepElement(sequence) {
        return document.querySelector(".purchase-step[data-sequence='" + sequence + "']");
    }

    function renderTrace(run) {
        ["t1", "t2"].forEach(function (actor) {
            var list = byId(actor + "-steps");
            var steps = run.trace.filter(function (step) { return step.actor === actor; });
            if (!steps.length) {
                list.innerHTML = "<li class=\"is-placeholder\">" + (actor === "t2" ? "本轮未插入并发查询" : "没有返回执行步骤") + "</li>";
                return;
            }
            list.innerHTML = "";
            steps.forEach(function (step) {
                var item = document.createElement("li");
                item.className = "purchase-step";
                item.dataset.sequence = step.sequence;
                item.dataset.target = step.target;
                var badge = document.createElement("span");
                badge.textContent = String(step.sequence).padStart(2, "0");
                var content = document.createElement("div");
                var title = document.createElement("strong");
                title.textContent = step.label;
                var detail = document.createElement("small");
                detail.textContent = step.detail;
                var duration = document.createElement("em");
                duration.textContent = formatLatency(step.durationMs);
                content.append(title, detail);
                item.append(badge, content, duration);
                list.appendChild(item);
            });
        });
    }

    function resetStepVisuals() {
        state.stepIndex = -1;
        document.querySelectorAll(".purchase-step").forEach(function (element) {
            element.classList.remove("is-current", "is-complete");
        });
        byId("purchase-redis-node").className = "purchase-data-node redis-node";
        byId("purchase-mysql-node").className = "purchase-data-node mysql-node";
        byId("stage-redis-action").textContent = "STANDBY";
        byId("stage-mysql-action").textContent = "STANDBY";
        if (state.run) {
            byId("stage-mysql-stock").textContent = state.run.initialStock;
            byId("stage-redis-stock").textContent = state.run.initialStock;
        }
        byId("timeline-step-label").textContent = "READY";
        byId("timeline-step-title").textContent = state.run ? "真实路径已记录，等待回放" : "等待开始真实实验";
    }

    function applyStep(index) {
        if (!state.run || index < 0 || index >= state.run.trace.length) {
            return;
        }
        state.stepIndex = index;
        var step = state.run.trace[index];
        document.querySelectorAll(".purchase-step").forEach(function (element) {
            var sequence = Number(element.dataset.sequence);
            element.classList.toggle("is-current", sequence === step.sequence);
            element.classList.toggle("is-complete", sequence < step.sequence);
        });
        byId("timeline-step-label").textContent = step.actor.toUpperCase() + " · STEP " + String(step.sequence).padStart(2, "0");
        byId("timeline-step-title").textContent = step.label;
        byId("stage-mysql-stock").textContent = step.mysqlStock;
        byId("stage-redis-stock").textContent = formatStock(step.redisStock);
        byId("stage-mysql-action").textContent = step.target === "mysql" ? step.label : "STANDBY";
        byId("stage-redis-action").textContent = step.target === "redis" ? step.label : "STANDBY";
        byId("purchase-mysql-node").classList.toggle("is-active", step.target === "mysql");
        byId("purchase-redis-node").classList.toggle("is-active", step.target === "redis");
        var active = stepElement(step.sequence);
        if (active && active.scrollIntoView && window.innerWidth < 720) {
            active.scrollIntoView({ behavior: state.reducedMotion ? "auto" : "smooth", block: "nearest" });
        }
        if (index === state.run.trace.length - 1) {
            finishPlayback();
        }
        updateControls();
    }

    function singleStep() {
        if (!state.run || state.playing) {
            return;
        }
        applyStep(state.stepIndex + 1);
    }

    function clearPlaybackTimer() {
        if (state.playTimer) {
            window.clearTimeout(state.playTimer);
            state.playTimer = null;
        }
    }

    function scheduleNextStep() {
        clearPlaybackTimer();
        if (!state.playing || !state.run) {
            return;
        }
        if (state.stepIndex >= state.run.trace.length - 1) {
            finishPlayback();
            return;
        }
        state.playTimer = window.setTimeout(function () {
            applyStep(state.stepIndex + 1);
            scheduleNextStep();
        }, state.reducedMotion ? 80 : 720);
    }

    function toggleAutoplay() {
        if (!state.run || state.stepIndex >= state.run.trace.length - 1) {
            return;
        }
        state.playing = !state.playing;
        if (state.playing) {
            byId("control-status").textContent = "正在回放真实步骤";
            byId("header-status").textContent = "教学回放中";
            scheduleNextStep();
        } else {
            clearPlaybackTimer();
            byId("control-status").textContent = "回放已暂停";
            byId("header-status").textContent = "回放已暂停";
        }
        updateControls();
    }

    function finishPlayback() {
        state.playing = false;
        clearPlaybackTimer();
        byId("control-status").textContent = "真实实验与路径回放均已完成";
        byId("header-status").textContent = "实验完成";
        byId("timeline-step-label").textContent = "COMPLETE";
        byId("timeline-step-title").textContent = state.run.dirtyCache ? "实验完成 · 检测到脏缓存" : "实验完成 · 最终缓存状态安全";
        updateControls();
    }

    function renderRunSummary(run) {
        byId("state-mysql-stock").textContent = run.finalMySQLStock;
        byId("state-redis-stock").textContent = formatStock(run.finalRedisStock);
        byId("state-purchase-success").textContent = run.purchaseSuccess ? "成功" : "失败";
        byId("state-dirty-cache").textContent = run.dirtyCache ? "YES · DETECTED" : "NO";
        byId("state-db-reads").textContent = run.dbReads;
        byId("state-cache-counts").textContent = run.redisHits + " / " + run.redisMisses;
        byId("state-latency").textContent = formatLatency(run.latencyMs);
        byId("state-query-stock").textContent = run.queryResponseStock == null ? "未插入" : run.queryResponseStock;
        byId("purchase-stock-summary").textContent = "MySQL " + run.finalMySQLStock + " · Redis " + formatStock(run.finalRedisStock);
        var warning = byId("dirty-warning");
        warning.hidden = !run.dirtyCache;
        if (run.dirtyCache && !state.warnedDirty) {
            state.warnedDirty = true;
            warning.classList.remove("is-alerting");
            void warning.offsetWidth;
            warning.classList.add("is-alerting");
        }
        if (run.dirtyCache) {
            byId("consistency-title").textContent = "脏缓存会继续影响后续命中";
            byId("consistency-copy").textContent = "Redis " + run.finalRedisStock + " 与 MySQL " + run.finalMySQLStock + " 不一致。";
        } else if (run.staleQueryResponse) {
            byId("consistency-title").textContent = "最终缓存已清除，但 T2 曾读到旧值";
            byId("consistency-copy").textContent = "方案 B 缩短了旧值停留时间，不代表并发查询绝不会读到旧值。";
        } else {
            byId("consistency-title").textContent = "最终未检测到脏缓存";
            byId("consistency-copy").textContent = "Redis 为 MISS；下一次查询会从 MySQL 权威库存重建缓存。";
        }
    }

    async function startRun() {
        if (state.requesting || state.run) {
            return;
        }
        state.requesting = true;
        byId("header-status").textContent = "服务端执行中";
        byId("control-status").textContent = "正在执行真实 Redis / MySQL 操作";
        document.body.dataset.purchaseStatus = "running";
        updateControls();
        try {
            var run = await requestJSON("/api/purchase-lab/" + state.materialId + "/run", {
                method: "POST",
                body: JSON.stringify({ strategy: state.strategy, concurrentQuery: state.concurrentQuery })
            });
            state.run = run;
            renderTrace(run);
            resetStepVisuals();
            renderRunSummary(run);
            state.run = resultStore.save(run);
            renderSavedResults();
            byId("header-status").textContent = "真实执行完成";
            byId("control-status").textContent = "结果已冻结 · 可单步或自动回放";
            byId("purchase-freeze-status").textContent = strategyCopy[run.strategy] + "结果已冻结";
            document.body.dataset.purchaseStatus = "ready-to-replay";
            showToast("真实实验完成，结果已冻结。", run.dirtyCache ? "danger" : "success");
        } catch (error) {
            byId("header-status").textContent = "执行失败";
            byId("control-status").textContent = "实验未完成";
            document.body.dataset.purchaseStatus = "error";
            showToast(error.message, "danger");
        } finally {
            state.requesting = false;
            updateControls();
        }
    }

    async function resetRun() {
        if (state.requesting) {
            return;
        }
        state.requesting = true;
        state.playing = false;
        clearPlaybackTimer();
        byId("header-status").textContent = "正在重置";
        byId("control-status").textContent = "恢复当前材料真实库存基线";
        updateControls();
        try {
            var response = await requestJSON("/api/purchase-lab/" + state.materialId + "/reset", { method: "POST" });
            state.run = null;
            state.stepIndex = -1;
            state.warnedDirty = false;
            byId("dirty-warning").hidden = true;
            byId("t1-steps").innerHTML = "<li class=\"is-placeholder\">真实执行后生成步骤</li>";
            byId("t2-steps").innerHTML = "<li class=\"is-placeholder\">" + (state.concurrentQuery ? "T2 将在下一轮进入竞态窗口" : "未插入并发查询") + "</li>";
            renderFixture(response.state);
            resetStepVisuals();
            byId("header-status").textContent = "等待开始";
            byId("control-status").textContent = "当前实验已重置 · 历史结果保留";
            document.body.dataset.purchaseStatus = "idle";
            showToast("当前材料实验已重置，冻结结果仍然保留。", "success");
        } catch (error) {
            byId("header-status").textContent = "重置失败";
            showToast(error.message, "danger");
        } finally {
            state.requesting = false;
            updateControls();
        }
    }

    function saveCurrentResult() {
        if (!state.run) {
            return;
        }
        state.run = resultStore.save(state.run);
        renderSavedResults();
        byId("purchase-freeze-status").textContent = strategyCopy[state.run.strategy] + "结果已保存";
        showToast("本次不可变结果已保存到方案槽位。", "success");
    }

    function renderResultCard(cardId, result) {
        var card = byId(cardId);
        card.classList.toggle("is-empty", !result);
        if (!result) {
            return;
        }
        card.querySelector("header > span").textContent = "已冻结";
        var profile = profiles[result.materialId] || { code: "ARC-???", name: "未知材料" };
        card.querySelector("[data-result-context]").textContent = profile.code + " · " + profile.name + " · " + (result.concurrentQuery ? "已插入 T2" : "无并发查询");
        card.querySelector("[data-result='initial']").textContent = result.initialStock;
        card.querySelector("[data-result='mysql']").textContent = result.finalMySQLStock;
        card.querySelector("[data-result='redis']").textContent = formatStock(result.finalRedisStock);
        card.querySelector("[data-result='dirty']").textContent = result.dirtyCache ? "YES" : "NO";
        card.querySelector("[data-result='dirty']").className = result.dirtyCache ? "is-bad" : "is-good";
        card.querySelector("[data-result='dbReads']").textContent = result.dbReads;
        card.querySelector("[data-result='latency']").textContent = formatLatency(result.latencyMs);
        card.querySelector("[data-result-time]").textContent = "冻结于 " + new Date(result.frozenAt || result.executedAt).toLocaleString("zh-CN", { hour12: false });
    }

    function renderSavedResults() {
        var results = resultStore.list();
        var a = results["delete-then-update"] || null;
        var b = results["update-then-delete"] || null;
        renderResultCard("purchase-result-a", a);
        renderResultCard("purchase-result-b", b);
        byId("compare-purchase-results").disabled = !(a && b);
        if (a && b) {
            renderComparison(a, b);
        }
    }

    function comparisonIsFair(a, b) {
        return a.materialId === b.materialId &&
            a.initialStock === b.initialStock &&
            a.concurrentQuery === b.concurrentQuery;
    }

    function setComparisonRow(id, aValue, bValue, verdict, winner) {
        var row = byId(id);
        row.classList.remove("winner-direct", "winner-cached", "is-tie");
        row.querySelector("[data-a]").textContent = aValue;
        row.querySelector("[data-b]").textContent = bValue;
        row.querySelector("[data-verdict]").textContent = verdict;
        if (winner === "a") {
            row.classList.add("winner-direct");
        } else if (winner === "b") {
            row.classList.add("winner-cached");
        } else if (winner === "tie") {
            row.classList.add("is-tie");
        }
    }

    function renderComparison(a, b) {
        var fair = comparisonIsFair(a, b);
        var panel = byId("purchase-comparison");
        panel.classList.toggle("is-waiting", !fair);
        if (!fair) {
            byId("purchase-comparison-title").textContent = "两轮条件不同：可查看，但不判定胜负";
            byId("purchase-overall-winner").textContent = "CONTEXT MISMATCH";
        } else {
            byId("purchase-comparison-title").textContent = "同材料、同库存、同并发条件的写顺序对比";
            byId("purchase-overall-winner").textContent = "SCHEME B · RECOMMENDED";
        }
        var dirtyWinner = a.dirtyCache === b.dirtyCache ? "tie" : (a.dirtyCache ? "b" : "a");
        setComparisonRow("purchase-compare-dirty", a.dirtyCache ? "DETECTED" : "NO", b.dirtyCache ? "DETECTED" : "NO",
            fair ? (dirtyWinner === "b" ? "方案 B 更安全" : dirtyWinner === "a" ? "方案 A 本轮更好" : "本轮相同") : "条件不同", fair ? dirtyWinner : null);
        setComparisonRow("purchase-compare-consistency", formatStock(a.finalRedisStock), formatStock(b.finalRedisStock),
            fair ? (b.dirtyCache ? "都需关注" : "方案 B 清除旧副本") : "条件不同", fair ? (a.dirtyCache && !b.dirtyCache ? "b" : "tie") : null);
        var dbWinner = a.dbReads === b.dbReads ? "tie" : (a.dbReads < b.dbReads ? "a" : "b");
        setComparisonRow("purchase-compare-db", a.dbReads, b.dbReads, fair ? (dbWinner === "tie" ? "本轮相同" : "更少者胜出") : "条件不同", fair ? dbWinner : null);
        setComparisonRow("purchase-compare-cache", a.redisHits + " / " + a.redisMisses, b.redisHits + " / " + b.redisMisses, "路径特征", null);
        var latencyWinner = a.latencyMs === b.latencyMs ? "tie" : (a.latencyMs < b.latencyMs ? "a" : "b");
        setComparisonRow("purchase-compare-latency", formatLatency(a.latencyMs), formatLatency(b.latencyMs),
            fair ? (latencyWinner === "a" ? "A 本轮较低" : latencyWinner === "b" ? "B 本轮较低" : "本轮相同") : "条件不同", fair ? latencyWinner : null);
    }

    function toggleComparison() {
        var panel = byId("purchase-comparison");
        if (byId("compare-purchase-results").disabled) {
            return;
        }
        state.comparisonOpen = !state.comparisonOpen;
        panel.hidden = !state.comparisonOpen;
        byId("compare-purchase-results").querySelector("strong").textContent = state.comparisonOpen ? "收起方案对比" : "对比两个方案";
        if (state.comparisonOpen) {
            panel.scrollIntoView({ behavior: state.reducedMotion ? "auto" : "smooth", block: "start" });
        }
    }

    function updateControls() {
        var locked = state.requesting || Boolean(state.run);
        document.querySelectorAll(".purchase-scheme-card").forEach(function (button) {
            button.disabled = locked;
        });
        byId("toggle-concurrent-query").disabled = locked;
        byId("start-purchase-run").disabled = state.requesting || Boolean(state.run);
        byId("step-purchase-run").disabled = !state.run || state.playing || state.stepIndex >= (state.run ? state.run.trace.length - 1 : -1);
        byId("autoplay-purchase-run").disabled = !state.run || state.stepIndex >= (state.run ? state.run.trace.length - 1 : -1);
        byId("autoplay-purchase-run").querySelector("strong").textContent = state.playing ? "暂停回放" : (state.stepIndex >= 0 ? "继续自动播放" : "自动播放");
        byId("save-purchase-result").disabled = !state.run || state.requesting;
        byId("reset-purchase-run").disabled = state.requesting;
        byId("scheme-lock-note").classList.toggle("is-locked", locked);
    }

    async function loadFixture() {
        byId("header-status").textContent = "读取真实库存";
        try {
            var fixture = await requestJSON("/api/purchase-lab/" + state.materialId + "/state");
            renderFixture(fixture);
            byId("header-status").textContent = "等待开始";
            byId("control-status").textContent = "真实库存已读取";
        } catch (error) {
            byId("header-status").textContent = "状态不可用";
            byId("control-status").textContent = "无法读取真实夹具";
            showToast(error.message, "danger");
        }
    }

    function bindEvents() {
        document.querySelectorAll(".purchase-scheme-card").forEach(function (button) {
            button.addEventListener("click", function () { selectStrategy(button.dataset.strategy); });
        });
        byId("toggle-concurrent-query").addEventListener("click", toggleConcurrentQuery);
        byId("start-purchase-run").addEventListener("click", startRun);
        byId("step-purchase-run").addEventListener("click", singleStep);
        byId("autoplay-purchase-run").addEventListener("click", toggleAutoplay);
        byId("reset-purchase-run").addEventListener("click", resetRun);
        byId("save-purchase-result").addEventListener("click", saveCurrentResult);
        byId("compare-purchase-results").addEventListener("click", toggleComparison);
    }

    document.addEventListener("DOMContentLoaded", function () {
        applyI18n();
        if (!showContext(incomingMaterial())) {
            return;
        }
        bindEvents();
        renderStrategy();
        renderSavedResults();
        updateControls();
        loadFixture();
    });

    window.addEventListener("beforeunload", clearPlaybackTimer);
}());
