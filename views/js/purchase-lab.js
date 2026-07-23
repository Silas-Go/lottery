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
        "intro.title": "同步失效与 Outbox + MQ 异步失效",
        "intro.body": "购买与查询共享 materials.stock 和同一个材料详情缓存。服务端完成真实事务、缓存失效与查询采样后，再把步骤交给页面回放。",
        "intro.boundaryTitle": "本店实验边界",
        "intro.boundaryBody": "主实验创建独立购买订单并接入 RocketMQ，但不触碰秒杀 inventory、支付或正式订单账本。",
        "scheme.title": "选择缓存失效方案",
        "scheme.aTitle": "同步缓存失效",
        "scheme.aBody": "事务提交后由当前请求重试删除缓存，返回路径更长但状态直观。",
        "scheme.bTitle": "Outbox + MQ 异步失效",
        "scheme.bBody": "购买提交不等待 Redis；Worker 和 Consumer 负责可重试的最终失效。",
        "timeline.title": "购买事务、查询样本与缓存失效",
        "state.title": "真实状态与结果",
        "state.warning": "缓存失效尚未完成",
        "controls.title": "执行与教学回放",
        "results.title": "两种缓存失效方案的冻结结果"
    };
    var strategyCopy = {
        "sync-invalidate": "同步缓存失效",
        "outbox-mq-invalidate": "Outbox + MQ 异步失效"
    };
    var activeStatuses = ["running", "waiting_outbox", "waiting_consumer"];
    var state = {
        materialId: null,
        profile: null,
        strategy: "sync-invalidate",
        run: null,
        stepIndex: -1,
        playing: false,
        playTimer: null,
        requesting: false,
        polling: false,
        warnedDirty: false,
        baseline: null,
        comparisonOpen: false,
        crowdContext: null,
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

    function incomingCrowdContext() {
        var query = new URLSearchParams(window.location.search);
        var crowdSize = Number(query.get("crowd") || 0);
        if ([100, 500, 1500, 3000].indexOf(crowdSize) < 0) {
            return null;
        }
        var taskId = query.get("sourceTask") || "";
        if (!/^lt-[a-zA-Z0-9-]+$/.test(taskId)) {
            taskId = "";
        }
        var buyers = Math.round(crowdSize * .1);
        return { crowdSize: crowdSize, buyers: buyers, observers: crowdSize - buyers, taskId: taskId };
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
            if (copy[element.dataset.i18n]) {
                element.textContent = copy[element.dataset.i18n];
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
        }, 2600);
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
        if (state.crowdContext && state.crowdContext.taskId) {
            queryURL += "&entry=crowd&task=" + encodeURIComponent(state.crowdContext.taskId);
        }
        byId("purchase-query-link").href = queryURL;
        byId("back-to-query").href = queryURL;
        byId("purchase-empty").querySelector("a").href = queryURL;
        return true;
    }

    function renderCrowdContext() {
        var context = state.crowdContext;
        if (!context) {
            return;
        }
        byId("purchase-crowd-context").hidden = false;
        byId("purchase-crowd-title").textContent = state.profile.name + "的购买队伍已经抵达。";
        byId("purchase-crowd-copy").textContent = context.buyers.toLocaleString("zh-CN") +
            " 名购买者与 " + context.observers.toLocaleString("zh-CN") +
            " 名观察者仍是叙事背景；本阶段只执行下方选择的小批真实请求。";
        byId("purchase-crowd-total").textContent = context.crowdSize.toLocaleString("zh-CN") + " 人";
        byId("purchase-crowd-buyers").textContent = context.buyers.toLocaleString("zh-CN") + " 人";
        byId("purchase-crowd-observers").textContent = context.observers.toLocaleString("zh-CN") + " 人";
    }

    function formatStock(value) {
        return value === null || value === undefined ? "MISS" : String(value);
    }

    function formatLatency(value) {
        var number = Number(value || 0);
        if (!number) {
            return "—";
        }
        return (number < 0.1 ? number.toFixed(3) : number.toFixed(2)) + " ms";
    }

    function renderFixture(fixture) {
        state.baseline = fixture;
        byId("purchase-stock-summary").textContent = "MySQL " + fixture.mysqlStock + " · Redis " + formatStock(fixture.redisStock);
        byId("stage-mysql-stock").textContent = fixture.mysqlStock;
        byId("stage-redis-stock").textContent = formatStock(fixture.redisStock);
        byId("state-mysql-stock").textContent = fixture.mysqlStock;
        byId("state-redis-stock").textContent = formatStock(fixture.redisStock);
        byId("state-purchase-counts").textContent = "0 / 0 / 0";
        byId("state-old-reads").textContent = "0 / 0";
        byId("state-purchase-latency").textContent = "—";
        byId("state-invalidation-latency").textContent = "—";
        byId("state-outbox-status").textContent = "—";
        byId("state-retry-count").textContent = "0";
        byId("consistency-title").textContent = "共享库存已读取";
        byId("consistency-copy").textContent = fixture.redisStock === null ?
            "Redis 当前为 MISS；重置会从 materials.stock 重新组装并预热同一个 DTO。" :
            "查询与购买共享 materials.stock，Redis 保存同一份材料详情 DTO。";
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
        if (state.requesting || state.polling || state.playing || state.run) {
            showToast("请先重置当前实验，再切换缓存失效方案。", "danger");
            return;
        }
        state.strategy = strategy;
        renderStrategy();
    }

    function traceWithOutbox(run) {
        var trace = (run.trace || []).map(function (step) { return Object.assign({}, step); });
        var sequence = trace.reduce(function (max, step) { return Math.max(max, Number(step.sequence || 0)); }, 0);
        (run.outbox || []).forEach(function (event) {
            if (event.publishedAt) {
                trace.push({
                    sequence: ++sequence, actor: "purchase", action: "publish_mq",
                    label: "MQ PUBLISHED", detail: event.eventId + " 已发布到缓存失效 Topic",
                    target: "redis", durationMs: new Date(event.publishedAt) - new Date(event.createdAt),
                    mysqlStock: run.finalMySQLStock, redisStock: run.finalRedisStock
                });
            }
            if (event.invalidatedAt) {
                trace.push({
                    sequence: ++sequence, actor: "purchase", action: "consume_invalidation",
                    label: "CONSUMER INVALIDATED", detail: "Consumer 幂等删除材料详情缓存",
                    target: "redis", durationMs: new Date(event.invalidatedAt) -
                        new Date(event.publishedAt || event.createdAt),
                    mysqlStock: run.finalMySQLStock, redisStock: null
                });
            }
        });
        return trace;
    }

    function renderTrace(run) {
        var trace = traceWithOutbox(run);
        ["purchase", "query"].forEach(function (actor) {
            var list = byId(actor + "-steps");
            var steps = trace.filter(function (step) {
                return actor === "query" ? step.actor === "query" : step.actor !== "query";
            });
            if (!steps.length) {
                list.innerHTML = "<li class=\"is-placeholder\">" +
                    (actor === "query" ? "本轮没有查询样本" : "没有返回执行步骤") + "</li>";
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
        state.playTrace = trace;
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
        var trace = state.playTrace || [];
        if (!state.run || index < 0 || index >= trace.length) {
            return;
        }
        state.stepIndex = index;
        var step = trace[index];
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
        if (index === trace.length - 1) {
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
        var trace = state.playTrace || [];
        if (!state.playing || !state.run) {
            return;
        }
        if (state.stepIndex >= trace.length - 1) {
            finishPlayback();
            return;
        }
        state.playTimer = window.setTimeout(function () {
            applyStep(state.stepIndex + 1);
            scheduleNextStep();
        }, state.reducedMotion ? 80 : 720);
    }

    function toggleAutoplay() {
        var trace = state.playTrace || [];
        if (!state.run || state.stepIndex >= trace.length - 1) {
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
        byId("timeline-step-title").textContent = "实验完成 · 查看真实取舍";
        updateControls();
    }

    function renderRunSummary(run) {
        byId("state-mysql-stock").textContent = run.finalMySQLStock;
        byId("state-redis-stock").textContent = formatStock(run.finalRedisStock);
        byId("state-purchase-counts").textContent = run.purchaseSucceeded + " / " +
            run.duplicateRequests + " / " + run.soldOutRequests;
        byId("state-old-reads").textContent = run.oldReadCount + " / " + run.queryCompleted;
        byId("state-purchase-latency").textContent = formatLatency(run.purchaseLatencyMs);
        byId("state-invalidation-latency").textContent = formatLatency(run.cacheInvalidationLatencyMs);
        byId("state-outbox-status").textContent = run.outboxStatus + " / " + run.mqStatus;
        byId("state-retry-count").textContent = run.retryCount;
        byId("purchase-stock-summary").textContent = "MySQL " + run.finalMySQLStock +
            " · Redis " + formatStock(run.finalRedisStock);
        var pending = activeStatuses.indexOf(run.status) >= 0;
        var staleCache = run.finalRedisStock !== null && run.finalRedisStock !== undefined &&
            Number(run.finalRedisStock) !== Number(run.finalMySQLStock);
        var warning = byId("dirty-warning");
        warning.hidden = !(pending || staleCache || run.status === "failed");
        warning.querySelector("strong").textContent = run.status === "failed" ?
            "缓存失效执行失败" : pending ? "缓存失效正在推进" : "检测到旧缓存";
        warning.querySelector("span").textContent = run.errorMessage ||
            (pending ? "Outbox Worker 或 MQ Consumer 尚未完成，查询可能短暂读到旧值。" :
                "Redis DTO 中的库存与 materials.stock 不一致。");
        if (run.status === "completed") {
            byId("consistency-title").textContent = "本轮缓存失效已完成";
            var finalCacheCopy = run.finalRedisStock === null || run.finalRedisStock === undefined ?
                "最终旧副本已清除" : "最终缓存已回填为最新库存";
            byId("consistency-copy").textContent = run.oldReadCount ?
                finalCacheCopy + "，失效窗口中出现了 " + run.oldReadCount + " 次旧读。" :
                finalCacheCopy + "，本轮查询样本未观察到旧库存。";
        } else if (run.status === "failed") {
            byId("consistency-title").textContent = "购买事务可能已提交";
            byId("consistency-copy").textContent = "可用相同 request_id 重试，幂等订单不会再次扣库存。";
        } else {
            byId("consistency-title").textContent = "等待最终一致";
            byId("consistency-copy").textContent = "购买已提交，后台正在推进 Outbox、MQ 与 Consumer。";
        }
    }

    function createRequestID() {
        if (window.crypto && window.crypto.randomUUID) {
            return "purchase-" + window.crypto.randomUUID();
        }
        return "purchase-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    }

    function wait(ms) {
        return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
    }

    async function pollRun(run) {
        var current = run;
        for (var attempt = 0; attempt < 80 && activeStatuses.indexOf(current.status) >= 0; attempt++) {
            await wait(250);
            current = await requestJSON("/api/purchase-lab/runs/" + encodeURIComponent(current.requestId));
            state.run = current;
            renderRunSummary(current);
            byId("header-status").textContent = current.status === "waiting_consumer" ?
                "等待 Consumer" : "Outbox / MQ 推进中";
            byId("control-status").textContent = current.outboxStatus + " · " + current.mqStatus;
        }
        return current;
    }

    async function startRun() {
        if (state.requesting || state.polling || state.run) {
            return;
        }
        state.requesting = true;
        byId("header-status").textContent = "服务端执行中";
        byId("control-status").textContent = "正在提交真实 MySQL 事务";
        document.body.dataset.purchaseStatus = "running";
        updateControls();
        try {
            var run = await requestJSON("/api/purchase-lab/" + state.materialId + "/run", {
                method: "POST",
                body: JSON.stringify({
                    requestId: createRequestID(),
                    strategy: state.strategy,
                    purchaseCount: Number(byId("purchase-count").value),
                    queryCount: Number(byId("query-count").value)
                })
            });
            state.run = run;
            renderRunSummary(run);
            state.requesting = false;
            if (activeStatuses.indexOf(run.status) >= 0) {
                state.polling = true;
                updateControls();
                run = await pollRun(run);
                state.polling = false;
                state.run = run;
            }
            renderTrace(run);
            resetStepVisuals();
            renderRunSummary(run);
            state.run = resultStore.save(run);
            renderSavedResults();
            byId("header-status").textContent = run.status === "completed" ? "真实执行完成" : "实验需要关注";
            byId("control-status").textContent = "结果已冻结 · 可单步或自动回放";
            byId("purchase-freeze-status").textContent = strategyCopy[run.strategy] + "结果已冻结";
            document.body.dataset.purchaseStatus = "ready-to-replay";
            showToast("真实购买、查询和缓存失效结果已冻结。",
                run.status === "completed" ? "success" : "danger");
        } catch (error) {
            byId("header-status").textContent = "执行失败";
            byId("control-status").textContent = "实验未完成";
            document.body.dataset.purchaseStatus = "error";
            showToast(error.message, "danger");
        } finally {
            state.requesting = false;
            state.polling = false;
            updateControls();
        }
    }

    async function resetRun() {
        if (state.requesting || state.polling) {
            return;
        }
        state.requesting = true;
        state.playing = false;
        clearPlaybackTimer();
        byId("header-status").textContent = "正在重置";
        byId("control-status").textContent = "恢复 materials.stock 并重新预热材料 DTO";
        updateControls();
        try {
            var response = await requestJSON("/api/purchase-lab/" + state.materialId + "/reset", { method: "POST" });
            state.run = null;
            state.playTrace = [];
            state.stepIndex = -1;
            byId("dirty-warning").hidden = true;
            byId("purchase-steps").innerHTML = "<li class=\"is-placeholder\">真实执行后生成步骤</li>";
            byId("query-steps").innerHTML = "<li class=\"is-placeholder\">等待真实查询样本</li>";
            renderFixture(response.state);
            resetStepVisuals();
            byId("header-status").textContent = "等待开始";
            byId("control-status").textContent = "权威库存和共享 DTO 已重置 · 历史结果保留";
            document.body.dataset.purchaseStatus = "idle";
            showToast("materials.stock 已恢复，共享材料缓存已经预热。", "success");
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
        showToast("本次结果已保存到当前方案槽位。", "success");
    }

    function renderResultCard(cardId, result) {
        var card = byId(cardId);
        card.classList.toggle("is-empty", !result);
        if (!result) {
            return;
        }
        card.querySelector("header > span").textContent = "已冻结";
        var profile = profiles[result.materialId] || { code: "ARC-???", name: "未知材料" };
        card.querySelector("[data-result-context]").textContent = profile.code + " · " + profile.name +
            " · 购买 " + result.purchaseRequested + " / 查询 " + result.queryRequested;
        card.querySelector("[data-result='initial']").textContent = result.initialStock;
        card.querySelector("[data-result='mysql']").textContent = result.finalMySQLStock;
        card.querySelector("[data-result='redis']").textContent = formatStock(result.finalRedisStock);
        card.querySelector("[data-result='oldReads']").textContent = result.oldReadCount + " / " + result.queryCompleted;
        card.querySelector("[data-result='purchaseLatency']").textContent = formatLatency(result.purchaseLatencyMs);
        card.querySelector("[data-result='invalidationLatency']").textContent = formatLatency(result.cacheInvalidationLatencyMs);
        card.querySelector("[data-result-time]").textContent = "冻结于 " +
            new Date(result.frozenAt || result.executedAt).toLocaleString("zh-CN", { hour12: false });
    }

    function renderSavedResults() {
        var results = resultStore.list();
        var a = results["sync-invalidate"] || null;
        var b = results["outbox-mq-invalidate"] || null;
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
            a.purchaseRequested === b.purchaseRequested &&
            a.queryRequested === b.queryRequested;
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

    function lowerWinner(a, b) {
        return Number(a) === Number(b) ? "tie" : (Number(a) < Number(b) ? "a" : "b");
    }

    function renderComparison(a, b) {
        var fair = comparisonIsFair(a, b);
        var panel = byId("purchase-comparison");
        panel.classList.toggle("is-waiting", !fair);
        byId("purchase-comparison-title").textContent = fair ?
            "同材料、同请求规模的真实 trade-off" : "两轮条件不同：可查看，但不判定指标";
        byId("purchase-overall-winner").textContent = fair ? "TRADE-OFF" : "CONTEXT MISMATCH";
        setComparisonRow("purchase-compare-old", a.oldReadCount, b.oldReadCount,
            fair ? "旧读更少者占优" : "条件不同", fair ? lowerWinner(a.oldReadCount, b.oldReadCount) : null);
        setComparisonRow("purchase-compare-purchase", formatLatency(a.purchaseLatencyMs), formatLatency(b.purchaseLatencyMs),
            fair ? "提交路径更短者占优" : "条件不同", fair ? lowerWinner(a.purchaseLatencyMs, b.purchaseLatencyMs) : null);
        setComparisonRow("purchase-compare-invalidation", formatLatency(a.cacheInvalidationLatencyMs), formatLatency(b.cacheInvalidationLatencyMs),
            fair ? "最终失效更快者占优" : "条件不同",
            fair ? lowerWinner(a.cacheInvalidationLatencyMs, b.cacheInvalidationLatencyMs) : null);
        setComparisonRow("purchase-compare-retry", a.retryCount, b.retryCount,
            fair ? "重试是可靠性成本" : "条件不同", fair ? lowerWinner(a.retryCount, b.retryCount) : null);
        setComparisonRow("purchase-compare-status", a.status, b.status,
            fair ? "不预设方案胜者" : "条件不同", null);
    }

    function toggleComparison() {
        var panel = byId("purchase-comparison");
        if (byId("compare-purchase-results").disabled) {
            return;
        }
        state.comparisonOpen = !state.comparisonOpen;
        panel.hidden = !state.comparisonOpen;
        byId("compare-purchase-results").querySelector("strong").textContent =
            state.comparisonOpen ? "收起方案对比" : "对比两个方案";
    }

    function updateControls() {
        var locked = state.requesting || state.polling || Boolean(state.run);
        var trace = state.playTrace || [];
        document.querySelectorAll(".purchase-scheme-card").forEach(function (button) {
            button.disabled = locked;
        });
        byId("purchase-count").disabled = locked;
        byId("query-count").disabled = locked;
        byId("start-purchase-run").disabled = state.requesting || state.polling || Boolean(state.run);
        byId("step-purchase-run").disabled = !state.run || state.playing || state.stepIndex >= trace.length - 1;
        byId("autoplay-purchase-run").disabled = !state.run || state.stepIndex >= trace.length - 1;
        byId("autoplay-purchase-run").querySelector("strong").textContent =
            state.playing ? "暂停回放" : (state.stepIndex >= 0 ? "继续自动播放" : "自动播放");
        byId("save-purchase-result").disabled = !state.run || state.requesting || state.polling;
        byId("reset-purchase-run").disabled = state.requesting || state.polling;
        byId("scheme-lock-note").classList.toggle("is-locked", locked);
    }

    async function loadFixture() {
        byId("header-status").textContent = "读取共享库存";
        try {
            var fixture = await requestJSON("/api/purchase-lab/" + state.materialId + "/state");
            renderFixture(fixture);
            byId("header-status").textContent = "等待开始";
            byId("control-status").textContent = "materials.stock 与共享 DTO 已读取";
        } catch (error) {
            byId("header-status").textContent = "状态不可用";
            byId("control-status").textContent = "无法读取真实共享库存";
            showToast(error.message, "danger");
        }
    }

    function bindEvents() {
        document.querySelectorAll(".purchase-scheme-card").forEach(function (button) {
            button.addEventListener("click", function () { selectStrategy(button.dataset.strategy); });
        });
        byId("start-purchase-run").addEventListener("click", startRun);
        byId("step-purchase-run").addEventListener("click", singleStep);
        byId("autoplay-purchase-run").addEventListener("click", toggleAutoplay);
        byId("reset-purchase-run").addEventListener("click", resetRun);
        byId("save-purchase-result").addEventListener("click", saveCurrentResult);
        byId("compare-purchase-results").addEventListener("click", toggleComparison);
    }

    document.addEventListener("DOMContentLoaded", function () {
        applyI18n();
        state.crowdContext = incomingCrowdContext();
        if (!showContext(incomingMaterial())) {
            return;
        }
        bindEvents();
        renderCrowdContext();
        renderStrategy();
        renderSavedResults();
        updateControls();
        loadFixture();
    });
}());
