(function () {
    "use strict";

    var page = document.body;
    var materials = [];
    var materialByID = new Map();
    var requestBusy = false;
    var toastTimer = null;
    var chainTimers = [];
    var statusTimer = null;
    var selectedLimitRate = 300;
    var activeTask = null;
    var taskPollTimer = null;
    var taskStream = null;
    var taskRefreshBusy = false;
    var TASK_STORAGE_KEY = "silas.seckill.active-task.v1";

    function byId(id) {
        return document.getElementById(id);
    }

    function setText(id, value) {
        var element = byId(id);
        if (element) {
            element.textContent = value;
        }
    }

    function showToast(message) {
        var toast = byId("lab-toast");
        toast.textContent = message;
        toast.classList.add("is-visible");
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () { toast.classList.remove("is-visible"); }, 2600);
    }

    function setRequestState(state, badge, message) {
        page.dataset.requestState = state;
        setText("request-badge", badge);
        setText("request-message", message);
    }

    async function errorMessage(response) {
        var raw = await response.text();
        try {
            var payload = JSON.parse(raw);
            return payload.message || raw;
        } catch (_) {
            return raw || ("HTTP " + response.status);
        }
    }

    function renderMaterials() {
        var grid = byId("material-grid");
        grid.innerHTML = "";
        materials.forEach(function (material) {
            var card = document.createElement("article");
            var image = document.createElement("img");
            var content = document.createElement("div");
            var label = document.createElement("small");
            var name = document.createElement("h3");
            var description = document.createElement("p");

            card.className = "material-card";
            card.dataset.materialId = String(material.id);
            image.src = material.picture;
            image.alt = material.name;
            label.textContent = "唯一实验材料";
            name.textContent = material.name;
            description.textContent = material.description;
            content.appendChild(label);
            content.appendChild(name);
            content.appendChild(description);
            card.appendChild(image);
            card.appendChild(content);
            grid.appendChild(card);
            materialByID.set(String(material.id), material);
        });
        setText("material-count", materials.length === 1 ? "星髓" : materials.length + " 种材料");
    }

    async function loadMaterials() {
        var response = await fetch("/api/seckill/materials", { headers: { "Accept": "application/json" } });
        if (!response.ok) {
            throw new Error(await errorMessage(response));
        }
        materials = await response.json();
        renderMaterials();
    }

    function activateMaterial(id) {
        Array.prototype.forEach.call(document.querySelectorAll(".material-card"), function (card) {
            card.classList.toggle("is-selected", card.dataset.materialId === String(id));
        });
    }

    function clearChain() {
        chainTimers.forEach(window.clearTimeout);
        chainTimers = [];
        Array.prototype.forEach.call(document.querySelectorAll("[data-chain-step]"), function (step) {
            step.classList.remove("is-active");
        });
    }

    // 链路高亮只解释当前真实请求将经过的组件；指标和业务结果仍全部来自服务端。
    function playChain() {
        clearChain();
        ["http", "limit", "redis", "mq", "mysql"].forEach(function (name, index) {
            chainTimers.push(window.setTimeout(function () {
                var step = document.querySelector('[data-chain-step="' + name + '"]');
                if (step) {
                    step.classList.add("is-active");
                }
            }, index * 170));
        });
    }

    function readCookie(name) {
        var prefix = name + "=";
        var item = document.cookie.split("; ").find(function (part) { return part.indexOf(prefix) === 0; });
        return item ? decodeURIComponent(item.substring(prefix.length)) : "";
    }

    function clearOrderCookies() {
        ["uid", "gid", "name", "price", "order_status", "inventory_mode"].forEach(function (name) {
            document.cookie = name + "=; Max-Age=0; Path=/";
        });
    }

    function showReceipt(material) {
        activateMaterial(material.id);
        byId("receipt-image").src = material.picture;
        byId("receipt-image").alt = material.name;
        setText("receipt-name", material.name);
        setText("receipt-status", "库存资格已取得，等待 MQ 建立待支付订单");
        byId("request-receipt").hidden = false;
    }

    // Redis 模式先返回 stock_acquired，MySQL 正式账本由普通 MQ 异步建立；
    // 轮询只负责更新页面说明，绝不能在前端自行推进订单状态。
    function watchOrderStatus() {
        window.clearTimeout(statusTimer);
        var uid = readCookie("uid");
        var gid = readCookie("gid");
        if (!uid || !gid) {
            return;
        }
        var attempts = 0;
        async function poll() {
            attempts += 1;
            try {
                var response = await fetch("/api/order/status?uid=" + encodeURIComponent(uid) + "&gid=" + encodeURIComponent(gid));
                if (response.ok) {
                    var order = await response.json();
                    if (order.status === "pending_payment") {
                        setText("receipt-status", "正式订单已进入 pending_payment，可前往支付");
                        return;
                    }
                    if (order.status === "paid" || order.status === "cancelled") {
                        setText("receipt-status", order.status === "paid" ? "订单已支付" : "订单已取消，库存已按规则回补");
                        return;
                    }
                }
            } catch (_) {
                // SSE 与状态轮询短暂断开时保留已知资格，下一轮继续向权威接口查询。
            }
            if (attempts < 20) {
                statusTimer = window.setTimeout(poll, 600);
            }
        }
        poll();
    }

    async function drawMaterial() {
        if (requestBusy) {
            return;
        }
        requestBusy = true;
        byId("draw-material").disabled = true;
        byId("request-receipt").hidden = true;
        setRequestState("requesting", "请求裁决中", "正在调用 GET /lucky；结果由限流器与 Redis Lua 共同裁决。");
        playChain();

        try {
            var response = await fetch("/lucky", { method: "GET", credentials: "same-origin" });
            if (!response.ok) {
                throw new Error(await errorMessage(response));
            }
            var giftID = (await response.text()).trim();
            if (giftID === "0") {
                setRequestState("failed", "本次未取得", "当前没有可分配库存；Redis 没有产生负库存，也没有创建订单。");
                showToast("本次未取得材料");
                requestBusy = false;
                byId("draw-material").disabled = false;
                return;
            }
            var material = materialByID.get(giftID);
            if (!material) {
                throw new Error("服务端返回了目录外的材料编号：" + giftID);
            }
            showReceipt(material);
            setRequestState("won", "资格已取得", "已取得 " + material.name + "；成功响应只代表库存资格，支付后才进入最终完成状态。");
            showToast("取得材料：" + material.name);
            watchOrderStatus();
            // 成功后锁住按钮，防止浏览器 cookie 被下一次临时订单覆盖；完成或放弃请进入订单页。
            setText("draw-material", "请先处理当前订单");
        } catch (error) {
            setRequestState("failed", "请求失败", error.message);
            showToast(error.message);
            requestBusy = false;
            byId("draw-material").disabled = false;
        }
    }

    function renderEvents(events) {
        var list = byId("server-events");
        list.innerHTML = "";
        if (!events || events.length === 0) {
            list.innerHTML = '<li class="is-empty">尚无业务事件；递交请求后这里会显示服务端事实。</li>';
            return;
        }
        events.slice().reverse().forEach(function (event) {
            var item = document.createElement("li");
            var time = document.createElement("time");
            var title = document.createElement("strong");
            var detail = document.createElement("span");
            item.dataset.tone = event.tone || "success";
            time.textContent = event.time || "—";
            title.textContent = event.title;
            detail.textContent = event.detail;
            item.appendChild(time);
            item.appendChild(title);
            item.appendChild(detail);
            list.appendChild(item);
        });
    }

    function renderMetrics(snapshot) {
        if (!snapshot) {
            return;
        }
        setText("metric-stock", Number(snapshot.redisStock || 0).toLocaleString("zh-CN"));
        setText("metric-requests", Number(snapshot.totalRequests || 0).toLocaleString("zh-CN"));
        setText("metric-queued", Number(snapshot.queueSuccess || 0).toLocaleString("zh-CN"));
        setText("metric-limited", Number(snapshot.rateLimited || 0).toLocaleString("zh-CN"));
        setText("metric-failed", Number(snapshot.stockFailed || 0).toLocaleString("zh-CN"));
        setText("metric-mq", Number(snapshot.mqPending || 0).toLocaleString("zh-CN"));
        setText("metric-create-backlog", Number(snapshot.createOrderBacklog || 0).toLocaleString("zh-CN"));
        setText("metric-paid", Number(snapshot.completedOrders || 0).toLocaleString("zh-CN"));
        setText("metric-qps", Number(snapshot.qps || 0).toLocaleString("zh-CN"));
        setText("metric-p95", Number(snapshot.p95 || 0) + " ms");
        var oversold = byId("metric-oversold");
        oversold.textContent = snapshot.oversold ? "是" : "否";
        oversold.dataset.value = snapshot.oversold ? "danger" : "safe";
        setText("metrics-time", snapshot.at || "实时快照");
        setText("limit-threshold", Number(snapshot.rateLimitQps || 0).toLocaleString("zh-CN"));
        renderEvents(snapshot.events);
    }

    function formatNumber(value, digits) {
        var number = Number(value || 0);
        if (digits !== undefined) {
            return number.toFixed(digits);
        }
        return number.toLocaleString("zh-CN");
    }

    async function requestJSON(url, options) {
        var response = await fetch(url, options || {});
        if (!response.ok) {
            throw new Error(await errorMessage(response));
        }
        return response.json();
    }

    function taskIsActive(task) {
        return Boolean(task && ["starting", "resetting", "running", "collecting"].indexOf(task.status) >= 0);
    }

    function taskStatusLabel(status) {
        return {
            starting: "准备任务",
            resetting: "重置基线",
            running: "真实运行中",
            collecting: "收集结果",
            completed: "实验完成",
            failed: "实验失败",
            stopped: "已停止"
        }[status] || "尚未运行";
    }

    function taskKind(task) {
        return task && task.experiment === "seckill-stock-burst" ? "stock" : "limit";
    }

    function setTaskControls(task) {
        var active = taskIsActive(task);
        byId("start-stock-test").disabled = active;
        byId("start-limit-test").disabled = active;
        byId("stop-stock-test").disabled = !(active && taskKind(task) === "stock");
        byId("stop-limit-test").disabled = !(active && taskKind(task) === "limit");
        byId("reset-seckill").disabled = active;
        Array.prototype.forEach.call(document.querySelectorAll("[data-limit-rate]"), function (button) {
            button.disabled = active;
        });
    }

    function renderTaskLogs(kind, logs) {
        var list = byId(kind + "-task-logs");
        list.innerHTML = "";
        if (!logs || logs.length === 0) {
            list.innerHTML = "<li>等待 Runner 日志</li>";
            return;
        }
        logs.slice(-8).reverse().forEach(function (log) {
            var item = document.createElement("li");
            item.dataset.level = log.level || "info";
            item.textContent = new Date(log.at).toLocaleTimeString("zh-CN", { hour12: false }) + " · " + log.message;
            list.appendChild(item);
        });
    }

    function renderStockTask(task) {
        var metrics = task.metrics || {};
        var badge = byId("stock-task-status");
        badge.textContent = taskStatusLabel(task.status);
        badge.dataset.status = task.status;
        setText("stock-progress", taskIsActive(task) ?
            "已完成 " + formatNumber(metrics.actualRequests) + " / " + formatNumber(task.plannedRequests || 600) + " 个请求" :
            "本轮任务 " + task.taskId);
        setText("stock-result-total", formatNumber(metrics.actualRequests));
        setText("stock-result-limited", formatNumber(metrics.rateLimited));
        setText("stock-result-admitted", formatNumber(metrics.admissionSuccess));
        setText("stock-result-failed", formatNumber(metrics.stockFailed));
        setText("stock-result-remaining", formatNumber(metrics.redisStock));
        setText("stock-result-errors", formatNumber(Number(metrics.systemErrors || 0) + Number(metrics.httpUnexpected || 0)));
        setText("stock-result-enqueued", formatNumber(metrics.createOrderEnqueued));
        setText("stock-result-consumed", formatNumber(metrics.createOrderConsumed));
        setText("stock-result-backlog", formatNumber(metrics.createOrderBacklog));
        setText("stock-result-oversold", metrics.oversold ? "是" : "否");
        renderTaskLogs("stock", task.logs);

        var verdict = byId("stock-verdict");
        verdict.removeAttribute("data-tone");
        if (task.status === "completed") {
            var allowed = Number(metrics.allowedRequests || 0);
            var accountingClosed = Number(metrics.admissionSuccess || 0) + Number(metrics.stockFailed || 0) === allowed;
            var enqueued = Number(metrics.createOrderEnqueued || 0);
            var consumed = Number(metrics.createOrderConsumed || 0);
            var backlog = Number(metrics.createOrderBacklog || 0);
            var mqAccountingClosed = enqueued === Number(metrics.admissionSuccess || 0) &&
                consumed <= enqueued && backlog === enqueued - consumed;
            var passed = Number(metrics.actualRequests || 0) === Number(task.plannedRequests || 600) &&
                Number(metrics.rateLimited || 0) === 0 &&
                Number(metrics.admissionSuccess || 0) === Number(metrics.activityStock || 300) &&
                Number(metrics.redisStock || 0) === 0 &&
                Number(metrics.systemErrors || 0) === 0 &&
                Number(metrics.httpUnexpected || 0) === 0 &&
                !metrics.oversold && accountingClosed && mqAccountingClosed;
            verdict.dataset.tone = passed ? "success" : "danger";
            verdict.textContent = passed ?
                (backlog === 0 ?
                    "库存结论成立：600 个唯一请求全部越过限流器，Lua 恰好放行 300 个，剩余请求售罄，库存归零且没有超卖；普通落单消息也已排空。" :
                    "库存结论成立：600 个唯一请求全部越过限流器，Lua 恰好放行 300 个，剩余请求售罄，库存归零且没有超卖。普通落单已消费 " + consumed + " 条、仍积压 " + backlog + " 条，这是异步削峰的独立证据，不参与库存正确性判定。") :
                "本轮没有满足全部不变量。请查看限流、系统异常、库存记账和普通落单积压，不能把这轮结果宣称为“无超卖证明”。";
        } else if (task.status === "failed" || task.status === "stopped") {
            verdict.dataset.tone = "danger";
            verdict.textContent = task.errorMessage || "任务没有完整结束，本轮不能形成库存正确性结论。";
        } else {
            verdict.textContent = "实验运行中：限流、库存和 MQ 指标均来自当前服务端任务。";
        }
    }

    function renderLimitTask(task) {
        var metrics = task.metrics || {};
        var badge = byId("limit-task-status");
        badge.textContent = taskStatusLabel(task.status);
        badge.dataset.status = task.status;
        setText("limit-progress", taskIsActive(task) ?
            "已运行 " + formatNumber(task.elapsedSeconds) + " 秒，剩余约 " + formatNumber(task.remainingSeconds) + " 秒" :
            "本轮任务 " + task.taskId);
        setText("limit-result-target", formatNumber(task.tier && task.tier.rate));
        setText("limit-result-actual", formatNumber(metrics.actualQps, 1));
        setText("limit-result-allowed-qps", formatNumber(metrics.allowedQps, 1));
        setText("limit-result-total", formatNumber(metrics.actualRequests));
        setText("limit-result-allowed", formatNumber(metrics.allowedRequests));
        setText("limit-result-limited", formatNumber(metrics.rateLimited));
        setText("limit-result-rate", formatNumber(metrics.rateLimitRate, 1) + "%");
        setText("limit-result-errors", formatNumber(metrics.httpUnexpected));
        renderTaskLogs("limit", task.logs);

        var verdict = byId("limit-verdict");
        verdict.removeAttribute("data-tone");
        if (task.status === "completed") {
            var target = Number(task.tier && task.tier.rate || 0);
            var threshold = Number(byId("limit-threshold").textContent.replace(/,/g, "")) || 800;
            var unexpected = Number(metrics.httpUnexpected || 0);
            var passed;
            if (target > threshold) {
                passed = Number(metrics.rateLimited || 0) > 0 && Number(metrics.allowedQps || 0) <= threshold * 1.15 && unexpected === 0;
            } else {
                passed = Number(metrics.rateLimitRate || 0) <= 3 && Number(metrics.allowedQps || 0) >= target * .85 && unexpected === 0;
            }
            verdict.dataset.tone = passed ? "success" : "danger";
            verdict.textContent = passed ?
                (target > threshold ?
                    "结论成立：实际到达速率超过保护线后产生了真实 429；令牌放行速率被控制在保护线及一秒突发容量允许的范围内。" :
                    "结论成立：目标流量没有超过保护线，绝大多数探针获得令牌，并且没有访问库存、MQ 或 MySQL。") :
                "本轮没有形成清晰的限流结论：检查实际到达速率、429、令牌放行 QPS 和非预期错误后再解释。";
        } else if (task.status === "failed" || task.status === "stopped") {
            verdict.dataset.tone = "danger";
            verdict.textContent = task.errorMessage || "任务没有完整结束，本轮不能形成限流结论。";
        } else {
            verdict.textContent = "限流探针运行中：这一轮不会读取或扣减星髓库存。";
        }
    }

    function renderTask(task) {
        activeTask = task;
        if (taskKind(task) === "stock") {
            renderStockTask(task);
        } else {
            renderLimitTask(task);
        }
        setTaskControls(task);
        try {
            window.sessionStorage.setItem(TASK_STORAGE_KEY, JSON.stringify({ id: task.taskId, experiment: task.experiment }));
        } catch (_) {
            // 任务真相保存在 Runner；sessionStorage 失败只影响刷新后的自动恢复。
        }
        if (!taskIsActive(task)) {
            window.clearInterval(taskPollTimer);
            taskPollTimer = null;
            if (taskStream) {
                taskStream.close();
                taskStream = null;
            }
        }
    }

    async function refreshTask(taskID) {
        if (taskRefreshBusy) {
            return;
        }
        taskRefreshBusy = true;
        try {
            renderTask(await requestJSON("/api/loadtests/" + encodeURIComponent(taskID)));
        } finally {
            taskRefreshBusy = false;
        }
    }

    function observeTask(taskID) {
        window.clearInterval(taskPollTimer);
        if (taskStream) {
            taskStream.close();
        }
        taskPollTimer = window.setInterval(function () {
            refreshTask(taskID).catch(function (error) { showToast(error.message); });
        }, 500);
        if (window.EventSource) {
            taskStream = new EventSource("/api/loadtests/" + encodeURIComponent(taskID) + "/events");
            ["task_started", "reset_completed", "loadtest_started", "progress", "metric", "log", "completed", "failed", "stopped"].forEach(function (name) {
                taskStream.addEventListener(name, function () {
                    refreshTask(taskID).catch(function (error) { showToast(error.message); });
                });
            });
        }
    }

    async function startTask(experiment) {
        if (taskIsActive(activeTask)) {
            showToast("已有实验正在运行");
            return;
        }
        var question = experiment === "seckill-stock-burst" ?
            "将重置秒杀订单与库存，然后让 600 个唯一用户同时争抢 300 份星髓。开始吗？" :
            "将重置令牌桶与实验指标，然后运行 10 秒限流探针。探针不会扣库存。开始吗？";
        if (!window.confirm(question)) {
            return;
        }
        var body = { experiment: experiment };
        if (experiment === "seckill-rate-limit") {
            body.rate = selectedLimitRate;
        }
        setTaskControls({ status: "starting", experiment: experiment });
        try {
            var created = await requestJSON("/api/loadtests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            clearOrderCookies();
            byId("request-receipt").hidden = true;
            await refreshTask(created.taskId);
            observeTask(created.taskId);
            showToast("服务器端实验任务已创建");
        } catch (error) {
            activeTask = null;
            setTaskControls(null);
            showToast(error.message);
        }
    }

    async function stopTask(kind) {
        if (!taskIsActive(activeTask) || taskKind(activeTask) !== kind) {
            return;
        }
        try {
            renderTask(await requestJSON("/api/loadtests/" + encodeURIComponent(activeTask.taskId) + "/stop", { method: "POST" }));
            showToast("任务已停止并回收");
        } catch (error) {
            showToast(error.message);
        }
    }

    async function restoreTask() {
        try {
            var saved = JSON.parse(window.sessionStorage.getItem(TASK_STORAGE_KEY) || "null");
            if (!saved || !saved.id || ["seckill-stock-burst", "seckill-rate-limit"].indexOf(saved.experiment) < 0) {
                return;
            }
            await refreshTask(saved.id);
            if (taskIsActive(activeTask)) {
                observeTask(saved.id);
            }
        } catch (_) {
            // Runner 不存在旧任务时保留空白实验台，不伪造恢复结果。
        }
    }

    async function loadMetricsSnapshot() {
        var response = await fetch("/api/metrics/snapshot");
        if (!response.ok) {
            throw new Error(await errorMessage(response));
        }
        renderMetrics(await response.json());
    }

    function connectMetrics() {
        if (!window.EventSource) {
            byId("metrics-connection").parentElement.classList.add("is-error");
            setText("metrics-connection", "浏览器不支持 SSE");
            return;
        }
        var stream = new EventSource("/api/metrics/stream");
        stream.addEventListener("metrics", function (event) {
            renderMetrics(JSON.parse(event.data));
            var state = byId("metrics-connection").parentElement;
            state.classList.remove("is-error");
            state.classList.add("is-live");
            setText("metrics-connection", "真实指标已连接");
        });
        stream.onerror = function () {
            var state = byId("metrics-connection").parentElement;
            state.classList.remove("is-live");
            state.classList.add("is-error");
            setText("metrics-connection", "SSE 重连中");
        };
    }

    async function resetLab() {
        if (!window.confirm("这会清空实验订单、临时资格并恢复星髓活动库存。确定重置吗？")) {
            return;
        }
        byId("reset-seckill").disabled = true;
        try {
            var response = await fetch("/api/lab/reset", { method: "POST" });
            if (!response.ok) {
                throw new Error(await errorMessage(response));
            }
            var payload = await response.json();
            clearOrderCookies();
            activateMaterial(0);
            byId("request-receipt").hidden = true;
            requestBusy = false;
            byId("draw-material").disabled = false;
            setText("draw-material", "递交真实申领");
            setRequestState("idle", "等待递交", "实验已恢复基线，可以递交一次新的真实申领。");
            clearChain();
            renderMetrics(payload.snapshot);
            showToast(payload.message || "实验数据已重置");
        } catch (error) {
            showToast(error.message);
        } finally {
            byId("reset-seckill").disabled = false;
        }
    }

    document.addEventListener("DOMContentLoaded", async function () {
        byId("draw-material").addEventListener("click", drawMaterial);
        byId("reset-seckill").addEventListener("click", resetLab);
        byId("start-stock-test").addEventListener("click", function () { startTask("seckill-stock-burst"); });
        byId("stop-stock-test").addEventListener("click", function () { stopTask("stock"); });
        byId("start-limit-test").addEventListener("click", function () { startTask("seckill-rate-limit"); });
        byId("stop-limit-test").addEventListener("click", function () { stopTask("limit"); });
        Array.prototype.forEach.call(document.querySelectorAll("[data-limit-rate]"), function (button) {
            button.addEventListener("click", function () {
                selectedLimitRate = Number(button.dataset.limitRate);
                Array.prototype.forEach.call(document.querySelectorAll("[data-limit-rate]"), function (candidate) {
                    candidate.classList.toggle("is-selected", candidate === button);
                });
            });
        });
        try {
            await Promise.all([loadMaterials(), loadMetricsSnapshot()]);
        } catch (error) {
            setRequestState("failed", "初始化失败", error.message);
            showToast(error.message);
        }
        connectMetrics();
        setTaskControls(null);
        restoreTask();
    });
}());
