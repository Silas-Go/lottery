(function () {
    "use strict";

    var MATERIAL_STORAGE_KEY = "silas.cache-aside.material-id";
    var SURVEY_COUNT = 1500;
    var PURCHASE_COUNT = 150;
    var PROBE_RATE = 20;
    var PROBE_INTERVAL_MS = 1000 / PROBE_RATE;
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
    var state = {
        materialId: null,
        profile: null,
        strategy: "sync-invalidate",
        stock: null,
        run: null,
        requesting: false,
        polling: false,
        paused: false,
        pendingRun: null,
        probe: createProbeState()
    };

    function byId(id) {
        return document.getElementById(id);
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
            // URL 已包含材料上下文，存储失败只影响刷新恢复。
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

    function escapeText(value) {
        return String(value === undefined || value === null ? "" : value);
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
            cache: "no-store",
            headers: { "Content-Type": "application/json" }
        }, options || {}));
        var payload = null;
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

    function setWorkflowStep(step) {
        var order = ["choose", "run", "observe"];
        var activeIndex = order.indexOf(step);
        document.querySelectorAll("[data-workflow-step]").forEach(function (element) {
            var index = order.indexOf(element.dataset.workflowStep);
            element.classList.toggle("is-active", index === activeIndex);
            element.classList.toggle("is-complete", index >= 0 && index < activeIndex);
        });
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
        if (!run) {
            return null;
        }
        if (run.finalRedisStock === null || run.finalRedisStock === undefined) {
            return null;
        }
        return Number(run.finalRedisStock) === Number(run.finalMySQLStock);
    }

    function runningStatus(run) {
        return run && ACTIVE_STATUSES.indexOf(run.status) >= 0;
    }

    function updateHeader() {
        byId("header-strategy").textContent = strategyNames[state.strategy];
        var status = "准备观察";
        if (state.requesting) {
            status = "150 个购买请求执行中";
        } else if (state.run) {
            var labels = {
                running: "购买事务执行中",
                waiting_outbox: "Outbox 等待发布",
                waiting_consumer: "等待 Consumer",
                completed: "实验已完成",
                failed: "实验失败"
            };
            status = labels[state.run.status] || state.run.status;
        }
        if (state.paused) {
            status += " · 画面已暂停";
        }
        byId("header-status").textContent = status;
        document.body.dataset.purchaseStrategy = state.strategy;
        document.body.dataset.purchaseStatus = state.run ? state.run.status : (state.requesting ? "running" : "idle");
    }

    function renderBaseline() {
        var mysql = state.stock ? state.stock.mysqlStock : null;
        var redis = state.stock ? state.stock.redisStock : null;
        byId("purchase-stock-summary").textContent = state.stock ?
            ("MySQL " + stockText(mysql) + " · Redis " + stockText(redis)) :
            "等待库存状态";
        byId("story-redis-stock").textContent = stockText(redis);
        setRole("story-mysql", "idle", "账本库存 " + stockText(mysql));
        setRole("story-redis", "idle", redis === null ? "库存牌尚未回填" : "库存牌显示 " + stockText(redis));
        setNode("node-mysql", "idle", "等待事务", "—", stockText(mysql) + " → —");
        renderProbe();
        updateHeader();
    }

    function renderRequestInFlight() {
        setWorkflowStep("run");
        byId("allegory-status").textContent = "真实请求执行中";
        byId("topology-status").textContent = "REQUEST IN FLIGHT";
        setRole("story-buyers", "running", "150 个唯一购买请求已经发出");
        setRole("story-service", "running", "掌柜正在处理购买请求");
        setRole("story-mysql", "waiting", "等待服务端事务证据");
        setRole("story-redis", "waiting", "库存探针持续观察");
        setNode("node-buyers", "success", "150 个唯一请求已发出", "—", "150 × 1");
        setNode("node-service", "running", "购买 API 正在处理", "—", "150 requests");
        setNode("node-mysql", "waiting", "等待真实提交结果", "—", stockText(state.stock && state.stock.mysqlStock) + " → ?");
        byId("control-status").textContent = "购买请求正在服务端真实执行；库存探针继续以 20 QPS 查询。";
        updateHeader();
        updateControls();
    }

    function renderRun(run) {
        if (!run) {
            return;
        }
        if (state.paused) {
            state.pendingRun = run;
            updateHeader();
            return;
        }
        state.run = run;
        state.pendingRun = null;
        setWorkflowStep(runningStatus(run) ? "run" : "observe");

        var txStarted = traceStep(run, ["transaction_started"]);
        var txCommitted = traceStep(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        var responded = traceStep(run, ["purchase_responded"]);
        var syncInvalidated = traceStep(run, ["cache_invalidated", "delete_cache"]);
        var cacheFailed = traceStep(run, ["cache_invalidation_failed", "delete_cache_failed"]);
        var outboxCreated = traceStep(run, ["outbox_created", "write_outbox"]);
        var outbox = outboxSummary(run);
        var failed = run.status === "failed";
        var completed = run.status === "completed";
        var mysqlBefore = Number(run.initialStock);
        var mysqlAfter = Number(run.finalMySQLStock);
        var succeeded = Number(run.purchaseSucceeded || 0);
        var soldOut = Number(run.soldOutRequests || 0);
        var duplicates = Number(run.duplicateRequests || 0);

        byId("allegory-status").textContent = failed ? "链路失败" : (completed ? "观察完成" : "链路进行中");
        byId("topology-status").textContent = escapeText(run.status).toUpperCase();

        setRole("story-buyers", responded ? "success" : "running",
            responded ? ("收到 " + formatNumber(succeeded + soldOut + duplicates) + " 份购买结果") : "购买请求处理中");
        setRole("story-service", failed ? "failed" : (responded ? "success" : "running"),
            responded ? "顾客已收到购买结果" : "掌柜正在处理购买请求");
        setRole("story-mysql", txCommitted ? "success" : (txStarted ? "running" : "waiting"),
            txCommitted ? ("账房已盖章，库存 " + mysqlBefore + " → " + mysqlAfter) : "账房正在登记");
        setRole("story-redis", cacheFailed ? "failed" : (currentConsistency(run) ? "success" : "waiting"),
            cacheFailed ? "伙计未能更新库存牌" :
                (currentConsistency(run) ? "库存牌已经与账本一致" : "库存牌仍在等待更新或回填"));
        byId("story-redis-stock").textContent = stockText(run.finalRedisStock);

        if (state.strategy === "sync-invalidate") {
            setRole("story-outbox", "unused", "同步方案不使用待办凭证");
            setRole("story-mq", "unused", "同步方案不经过驿站");
            setRole("story-consumer", "unused", "当前购买请求直接更新库存牌");
        } else {
            setRole("story-outbox", outboxCreated ? (outbox.pending || outbox.retry ? "waiting" : "success") : "waiting",
                outbox.total ? ("已生成 " + outbox.total + " 张待办凭证") : "等待事务创建凭证");
            setRole("story-mq", outbox.retry ? "retry" : (outbox.published || outbox.completed ? "running" : "waiting"),
                outbox.retry ? "信使投递失败，等待重试" :
                    (outbox.published || outbox.completed ? "信使正在传递失效通知" : "信使等待取走凭证"));
            setRole("story-consumer", outbox.completed ? "success" : (outbox.published ? "running" : "waiting"),
                outbox.completed ? ("伙计已处理 " + outbox.completed + " 次幂等失效") :
                    (outbox.published ? "伙计正在撤下旧库存牌" : "伙计等待消息"));
        }

        setNode("node-buyers", responded ? "success" : "running",
            responded ? "购买结果已返回" : "请求已发出", "—", "150 × 1");
        setNode("node-service", failed ? "failed" : (responded ? "success" : "running"),
            responded ? "响应已收集" : "购买处理中",
            formatMS(run.purchaseLatencyMs), succeeded + " success");
        setNode("node-mysql", txCommitted ? "success" : "running",
            txCommitted ? "事务已提交" : "事务执行中",
            formatMS(txCommitted && txCommitted.durationMs), mysqlBefore + " → " + mysqlAfter);
        setNode("node-response", failed ? "failed" : (responded ? "success" : "waiting"),
            responded ? "购买响应已返回" : "等待返回",
            formatMS(run.purchaseP99Ms), succeeded + " / " + PURCHASE_COUNT);

        if (state.strategy === "sync-invalidate") {
            setNode("node-sync-redis", cacheFailed ? "failed" : (syncInvalidated ? "success" : "waiting"),
                cacheFailed ? "DEL 重试耗尽" : (syncInvalidated ? "Redis DEL 已完成" : "等待事务提交"),
                formatMS(run.cacheInvalidationLatencyMs),
                syncInvalidated ? "cache deleted" : "—");
        } else {
            setNode("node-outbox", outbox.total ? (outbox.pending || outbox.retry ? "waiting" : "success") : "waiting",
                outbox.total ? "订单与事件同事务提交" : "等待事务",
                "同事务", outbox.total + " events");
            setNode("node-worker", outbox.retry ? "retry" : (outbox.published || outbox.completed ? "success" : "waiting"),
                outbox.retry ? "发布失败，等待重试" : (outbox.published || outbox.completed ? "凭证已认领发布" : "等待凭证"),
                String(run.retryCount || 0), run.outboxStatus || "—");
            setNode("node-mq", outbox.retry ? "retry" : (outbox.published ? "running" : (outbox.completed ? "success" : "waiting")),
                outbox.published ? "消息等待消费" : (outbox.completed ? "消息已消费" : "等待发布"),
                String(outbox.pending + outbox.published + outbox.retry), run.mqStatus || "—");
            setNode("node-consumer", outbox.completed === outbox.total && outbox.total ? "success" : (outbox.published ? "running" : "waiting"),
                outbox.completed ? "幂等删除缓存" : "等待消息",
                outbox.completed + " / " + (outbox.total || PURCHASE_COUNT),
                outbox.completed ? "Redis DEL" : "—");
        }

        renderEventLog(run);
        renderProbe();
        renderResults(run);
        renderTechnicalDetails(run);
        renderFault(run, outbox, cacheFailed);
        byId("control-status").textContent = failed ? (run.errorMessage || "实验失败") :
            (completed ? "真实购买与缓存失效路径已经完成。" :
                (run.status === "waiting_consumer" ? "购买响应已返回，Consumer 仍在处理失效消息。" :
                    "购买响应已返回，Outbox Worker 正在发布缓存失效事件。"));
        updateHeader();
        updateControls();
    }

    function realEvents(run) {
        var events = [];
        (run.trace || []).forEach(function (step) {
            events.push({
                key: "trace-" + step.sequence,
                at: Number(step.atMs || 0),
                label: step.label || step.action,
                detail: step.detail || "",
                tone: /failed/i.test(step.action) ? "failed" : "normal"
            });
        });
        var outbox = Array.isArray(run.outbox) ? run.outbox : [];
        var published = outbox.filter(function (event) { return event.publishedAt; });
        var invalidated = outbox.filter(function (event) { return event.invalidatedAt; });
        var retries = outbox.filter(function (event) { return Number(event.retryCount || 0) > 0; });
        if (published.length) {
            events.push({ key: "published", at: 9000001, label: "MESSAGE PUBLISHED", detail: published.length + " 张凭证已有真实 published_at。", tone: "normal" });
        }
        if (invalidated.length) {
            events.push({ key: "invalidated", at: 9000002, label: "CACHE INVALIDATED", detail: invalidated.length + " 条消息已有真实 invalidated_at，Consumer 已执行幂等 DEL。", tone: "normal" });
        }
        if (retries.length) {
            events.push({ key: "retry", at: 9000003, label: "OUTBOX RETRY", detail: retries.length + " 条事件进入真实重试状态。", tone: "failed" });
        }
        return events;
    }

    function renderEventLog(run) {
        var list = byId("story-event-log");
        var events = realEvents(run).slice(-7);
        list.replaceChildren();
        if (!events.length) {
            var empty = document.createElement("li");
            empty.innerHTML = "<time>READY</time><span>等待真实后端事件。</span>";
            list.appendChild(empty);
            return;
        }
        events.forEach(function (event) {
            var item = document.createElement("li");
            if (event.tone === "failed") {
                item.className = "is-failed";
            }
            var time = document.createElement("time");
            time.textContent = event.at < 9000000 ? ("+" + formatMS(event.at)) : "LIVE";
            var body = document.createElement("span");
            var strong = document.createElement("strong");
            strong.textContent = event.label;
            body.appendChild(strong);
            body.appendChild(document.createTextNode(" · " + event.detail));
            item.appendChild(time);
            item.appendChild(body);
            list.appendChild(item);
        });
    }

    function renderFault(run, outbox, cacheFailed) {
        var banner = byId("purchase-fault-banner");
        var title = byId("purchase-fault-title");
        var copy = byId("purchase-fault-copy");
        var failedEvents = (run.outbox || []).filter(function (event) { return event.lastError; });
        if (run.status === "failed" || cacheFailed || outbox.retry || failedEvents.length) {
            banner.hidden = false;
            if (cacheFailed) {
                title.textContent = "伙计未能更新库存牌";
                copy.textContent = "Redis DEL 的真实重试已耗尽；MySQL 事务可能已经提交。";
            } else if (outbox.retry || failedEvents.length) {
                title.textContent = "失效通知正在重试";
                copy.textContent = failedEvents[0] ? failedEvents[0].lastError : "Outbox Worker 返回了 retry 状态。";
            } else {
                title.textContent = "购买链路失败";
                copy.textContent = run.errorMessage || "后端返回 failed。";
            }
            return;
        }
        banner.hidden = true;
    }

    function resetProbe() {
        stopProbe();
        state.probe = createProbeState();
        renderProbe();
    }

    function startProbe() {
        resetProbe();
        state.probe.active = true;
        state.probe.startedAt = Date.now();
        runProbeRequest();
        state.probe.timer = window.setInterval(runProbeRequest, PROBE_INTERVAL_MS);
    }

    function stopProbe() {
        var probe = state.probe;
        if (probe && probe.timer) {
            window.clearInterval(probe.timer);
            probe.timer = null;
        }
        if (probe && probe.staleOpenedAt !== null) {
            probe.maxStaleWindowMs = Math.max(probe.maxStaleWindowMs, performance.now() - probe.staleOpenedAt);
            probe.staleOpenedAt = null;
        }
        if (probe) {
            probe.active = false;
        }
    }

    function stopProbeScheduling() {
        if (state.probe && state.probe.timer) {
            window.clearInterval(state.probe.timer);
            state.probe.timer = null;
        }
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
            probe.completed += 1;
            probe.latest = sample;
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
                probe.maxStaleWindowMs = Math.max(probe.maxStaleWindowMs, performance.now() - probe.staleOpenedAt);
                probe.staleOpenedAt = null;
            }
            if (!state.paused) {
                renderProbe();
            }
        } catch (_) {
            probe.errors += 1;
        } finally {
            probe.inFlight -= 1;
        }
    }

    function probeWindowMS() {
        var probe = state.probe;
        if (probe.staleOpenedAt === null) {
            return probe.maxStaleWindowMs;
        }
        return Math.max(probe.maxStaleWindowMs, performance.now() - probe.staleOpenedAt);
    }

    function renderProbe() {
        var probe = state.probe;
        var active = probe.active;
        var latest = probe.latest;
        setNode("node-probe", active ? "running" : (probe.completed ? "success" : "idle"),
            active ? "固定 20 QPS 真实查询中" : (probe.completed ? "探针已停止" : "固定 20 QPS"),
            String(probe.completed), String(probe.oldReads));
        setNode("node-probe-redis", latest && latest.old ? "retry" : (latest ? "success" : "idle"),
            latest ? (latest.source.toUpperCase() + (latest.old ? " · OLD" : "")) : "HIT / MISS",
            String(probe.hits), String(probe.misses + probe.fallbacks));
        if (latest) {
            byId("story-redis-stock").textContent = stockText(latest.stock);
        }
        if (state.run) {
            renderResults(state.run);
            renderTechnicalDetails(state.run);
        }
    }

    function renderResults(run) {
        var p99 = Number(run.purchaseP99Ms || 0);
        var oldReads = state.probe.oldReads;
        var staleWindow = probeWindowMS();
        var consistent = currentConsistency(run);
        byId("result-p99").textContent = formatMS(p99);
        byId("result-old-reads").textContent = formatNumber(oldReads);
        byId("result-stale-window").textContent = staleWindow > 0 ? formatMS(staleWindow) : "0 ms";
        byId("result-consistency").textContent = consistent === null ? "待回填" : (consistent ? "一致" : "不一致");
        byId("result-consistency").className = consistent === true ? "is-good" : (consistent === false ? "is-bad" : "");
        byId("result-stock-pair").textContent = "MySQL " + stockText(run.finalMySQLStock) + " / Redis " + stockText(run.finalRedisStock);
        byId("result-status").textContent = run.status === "completed" ? "真实运行完成" : escapeText(run.status).toUpperCase();
        renderConclusion(run);
    }

    function renderConclusion(run) {
        var conclusion = byId("purchase-conclusion");
        var consistent = currentConsistency(run);
        if (run.status === "failed") {
            conclusion.textContent = "本次实验失败：" + (run.errorMessage || "查看技术详情中的真实错误状态。");
            return;
        }
        if (run.status !== "completed") {
            conclusion.textContent = state.strategy === "outbox-mq-invalidate" ?
                "顾客已经收到购买响应；Outbox、MQ 与 Consumer 仍在完成缓存失效。" :
                "同步请求仍在等待事务与 Redis 删除路径完成。";
            return;
        }
        var own = state.strategy === "sync-invalidate" ?
            ("同步失效本次购买 P99 为 " + formatMS(run.purchaseP99Ms) + "，探针观察到 " + state.probe.oldReads + " 次旧库存读取。") :
            ("异步失效本次购买 P99 为 " + formatMS(run.purchaseP99Ms) + "，探针观察到 " + state.probe.oldReads + " 次旧库存读取。");
        conclusion.textContent = own + (consistent ? " 最终 MySQL 与 Redis 已一致。" : " 最终库存仍未一致，请查看真实链路状态。");
        var saved = resultStore ? resultStore.list() : {};
        var sync = saved["sync-invalidate"];
        var async = saved["outbox-mq-invalidate"];
        if (sync && async) {
            conclusion.textContent = "两次真实运行中，同步 / 异步购买 P99 分别为 " +
                formatMS(sync.purchaseP99Ms) + " / " + formatMS(async.purchaseP99Ms) +
                "；旧读分别为 " + sync.oldReadCount + " / " + async.oldReadCount +
                "。结果只说明本机这两次运行的延迟与一致性取舍，不预设固定胜者。";
        }
    }

    function renderTechnicalDetails(run) {
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
        byId("detail-hit-miss").textContent = state.probe.hits + " / " + (state.probe.misses + state.probe.fallbacks);
        byId("detail-probe-samples").textContent = state.probe.completed + "（错误 " + state.probe.errors + "）";
        var trace = byId("technical-trace");
        trace.replaceChildren();
        var events = realEvents(run);
        if (!events.length) {
            var empty = document.createElement("li");
            empty.textContent = "尚无后端事件";
            trace.appendChild(empty);
            return;
        }
        events.forEach(function (event) {
            var item = document.createElement("li");
            item.textContent = event.label + " · " + event.detail;
            trace.appendChild(item);
        });
    }

    function saveResult(run) {
        if (!resultStore || !run || run.status !== "completed") {
            return;
        }
        resultStore.save({
            strategy: state.strategy,
            materialId: state.materialId,
            materialName: state.profile.name,
            surveyCount: SURVEY_COUNT,
            purchaseRequested: PURCHASE_COUNT,
            purchaseSucceeded: Number(run.purchaseSucceeded || 0),
            soldOutRequests: Number(run.soldOutRequests || 0),
            duplicateRequests: Number(run.duplicateRequests || 0),
            purchaseP99Ms: Number(run.purchaseP99Ms || 0),
            purchaseLatencyMs: Number(run.purchaseLatencyMs || 0),
            invalidationLatencyMs: Number(run.cacheInvalidationLatencyMs || 0),
            oldReadCount: state.probe.oldReads,
            maxStaleWindowMs: probeWindowMS(),
            finalMySQLStock: run.finalMySQLStock,
            finalRedisStock: run.finalRedisStock,
            consistent: currentConsistency(run) === true,
            probeSamples: state.probe.completed,
            redisHits: state.probe.hits,
            redisMisses: state.probe.misses + state.probe.fallbacks,
            retryCount: Number(run.retryCount || 0)
        });
        renderSavedResults();
    }

    function renderSavedResults() {
        var saved = resultStore ? resultStore.list() : {};
        renderSavedCard("saved-sync", saved["sync-invalidate"]);
        renderSavedCard("saved-async", saved["outbox-mq-invalidate"]);
        if (state.run) {
            renderConclusion(state.run);
        }
    }

    function renderSavedCard(id, result) {
        var card = byId(id);
        if (!result) {
            card.className = "purchase-saved-card is-empty";
            card.querySelector("strong").textContent = "待实验";
            card.querySelector("span").textContent = "尚无真实结果";
            return;
        }
        card.className = "purchase-saved-card";
        card.querySelector("strong").textContent = "P99 " + formatMS(result.purchaseP99Ms);
        card.querySelector("span").textContent =
            "旧读 " + result.oldReadCount + " · 窗口 " + formatMS(result.maxStaleWindowMs) +
            " · 最终" + (result.consistent ? "一致" : "未一致");
    }

    function updateControls() {
        var busy = state.requesting || state.polling || runningStatus(state.run);
        byId("start-purchase-run").disabled = busy;
        byId("start-purchase-run").textContent = busy ? "150 人正在购买" : "开始实验";
        byId("pause-observation").disabled = !busy;
        byId("pause-observation").textContent = state.paused ? "继续观察" : "暂停观察";
        byId("pause-observation").setAttribute("aria-pressed", String(state.paused));
        byId("reset-purchase-run").disabled = busy;
        document.querySelectorAll(".purchase-strategy-card").forEach(function (button) {
            button.disabled = busy;
        });
    }

    async function fetchStockState() {
        state.stock = await requestJSON("/api/purchase-lab/" + state.materialId + "/state");
        renderBaseline();
        return state.stock;
    }

    async function resetExperiment(silent, force) {
        if (!force && (state.requesting || state.polling || runningStatus(state.run))) {
            return;
        }
        stopProbe();
        var payload = await requestJSON("/api/purchase-lab/" + state.materialId + "/reset", {
            method: "POST",
            body: "{}"
        });
        state.stock = payload.state;
        state.run = null;
        state.pendingRun = null;
        state.paused = false;
        state.probe = createProbeState();
        resetVisuals();
        renderBaseline();
        if (!silent) {
            showToast("库存已重置为 300，并重新预热材料缓存。");
        }
    }

    function resetVisuals() {
        setWorkflowStep("choose");
        byId("allegory-status").textContent = "等待开门";
        byId("topology-status").textContent = "IDLE";
        setRole("story-buyers", "idle", "正在店外等待");
        setRole("story-service", "idle", "等待购买请求");
        setRole("story-outbox", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不使用" : "等待事务创建凭证");
        setRole("story-mq", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不使用" : "等待凭证");
        setRole("story-consumer", state.strategy === "sync-invalidate" ? "unused" : "idle",
            state.strategy === "sync-invalidate" ? "同步方案不使用" : "等待消息");
        setNode("node-buyers", "idle", "150 个唯一用户", "—", "150 × 1");
        setNode("node-service", "idle", "等待请求", "—", "—");
        setNode("node-response", "idle", "顾客等待中", "—", "—");
        setNode("node-sync-redis", "idle", "等待事务提交", "—", "—");
        setNode("node-outbox", "idle", "等待事务", "同事务", "—");
        setNode("node-worker", "idle", "等待凭证", "0", "—");
        setNode("node-mq", "idle", "等待发布", "0", "—");
        setNode("node-consumer", "idle", "等待消息", "0 / 150", "—");
        byId("story-event-log").innerHTML = "<li><time>READY</time><span>选择方案后开始实验；这里不会用假动画补齐事件。</span></li>";
        byId("purchase-fault-banner").hidden = true;
        byId("result-p99").textContent = "—";
        byId("result-old-reads").textContent = "—";
        byId("result-stale-window").textContent = "—";
        byId("result-consistency").textContent = "—";
        byId("result-consistency").className = "";
        byId("result-stock-pair").textContent = "MySQL — / Redis —";
        byId("result-status").textContent = "等待实验";
        byId("purchase-conclusion").textContent = "运行两种方案后，页面会依据真实购买 P99、旧读与最终状态说明取舍，不预设胜者。";
        byId("control-status").textContent = "150 个唯一购买请求尚未发出。";
        renderProbe();
        updateHeader();
        updateControls();
    }

    function requestID() {
        return "purchase-web-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 10);
    }

    async function pollRun(id) {
        state.polling = true;
        updateControls();
        var deadline = Date.now() + 60000;
        try {
            while (Date.now() < deadline) {
                var run = await requestJSON("/api/purchase-lab/runs/" + encodeURIComponent(id));
                state.run = run;
                renderRun(run);
                if (!runningStatus(run)) {
                    return run;
                }
                await new Promise(function (resolve) { window.setTimeout(resolve, 250); });
            }
            throw new Error("等待 Outbox / Consumer 完成超时");
        } finally {
            state.polling = false;
            updateControls();
        }
    }

    async function ensureFinalCacheView(run) {
        if (!run || run.status !== "completed") {
            return run;
        }
        // 先停止发新样本并等待在途 Cached 查询排空，避免较早开始的旧读在最终校验后才回填缓存。
        // 随后再做一次真实 Cached 查询，使已删除的 key 从最终 MySQL 库存重新回填。
        stopProbeScheduling();
        await waitForProbeDrain();
        await runProbeRequest();
        await waitForProbeDrain();
        var latestState = await fetchStockState();
        run.finalMySQLStock = latestState.mysqlStock;
        run.finalRedisStock = latestState.redisStock;
        return run;
    }

    async function startExperiment() {
        if (state.requesting || state.polling || !state.materialId) {
            return;
        }
        state.requesting = true;
        state.run = null;
        state.pendingRun = null;
        state.paused = false;
        try {
            await resetExperiment(true, true);
            state.requesting = true;
            startProbe();
            renderRequestInFlight();
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
            state.requesting = false;
            state.run = run;
            renderRun(run);
            if (runningStatus(run)) {
                run = await pollRun(id);
            }
            run = await ensureFinalCacheView(run);
            state.run = run;
            stopProbe();
            renderRun(run);
            saveResult(run);
            showToast(run.status === "completed" ? "真实购买实验已完成。" : "实验返回了失败状态。",
                run.status === "completed" ? "success" : "error");
        } catch (error) {
            stopProbe();
            state.requesting = false;
            state.polling = false;
            byId("purchase-fault-banner").hidden = false;
            byId("purchase-fault-title").textContent = "购买实验请求失败";
            byId("purchase-fault-copy").textContent = error.message;
            byId("control-status").textContent = error.message;
            byId("header-status").textContent = "实验失败";
            showToast(error.message, "error");
        } finally {
            state.requesting = false;
            state.polling = false;
            updateControls();
            updateHeader();
        }
    }

    function togglePause() {
        state.paused = !state.paused;
        if (!state.paused && state.pendingRun) {
            var latest = state.pendingRun;
            state.pendingRun = null;
            renderRun(latest);
        } else if (!state.paused) {
            renderProbe();
        }
        byId("control-status").textContent = state.paused ?
            "画面已暂停；后端购买、Outbox、Consumer 和库存探针仍继续运行。" :
            "已恢复到最新真实状态。";
        updateHeader();
        updateControls();
    }

    function chooseStrategy(strategy) {
        if (state.requesting || state.polling || runningStatus(state.run)) {
            return;
        }
        state.strategy = strategy;
        state.run = null;
        document.querySelectorAll(".purchase-strategy-card").forEach(function (button) {
            var active = button.dataset.strategy === strategy;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-checked", String(active));
        });
        resetVisuals();
    }

    function bindEvents() {
        document.querySelectorAll(".purchase-strategy-card").forEach(function (button) {
            button.addEventListener("click", function () {
                chooseStrategy(button.dataset.strategy);
            });
        });
        byId("start-purchase-run").addEventListener("click", startExperiment);
        byId("pause-observation").addEventListener("click", togglePause);
        byId("reset-purchase-run").addEventListener("click", function () {
            resetExperiment(false).catch(function (error) { showToast(error.message, "error"); });
        });
        byId("open-technical-details").addEventListener("click", function () {
            var dialog = byId("technical-details-dialog");
            if (typeof dialog.showModal === "function") {
                dialog.showModal();
            } else {
                dialog.setAttribute("open", "");
            }
        });
        window.addEventListener("beforeunload", stopProbe);
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

    async function init() {
        if (!showContext(incomingMaterial())) {
            return;
        }
        bindEvents();
        resetVisuals();
        renderSavedResults();
        try {
            await fetchStockState();
        } catch (error) {
            showToast(error.message, "error");
            byId("purchase-stock-summary").textContent = "库存读取失败";
        }
    }

    init();
}());
