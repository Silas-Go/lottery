(function () {
    "use strict";

    var page = document.body;
    var materials = [];
    var materialByID = new Map();
    var requestBusy = false;
    var toastTimer = null;
    var chainTimers = [];
    var statusTimer = null;
    var activeTask = null;
    var currentRateLimitQPS = null;
    var taskPollTimer = null;
    var taskStream = null;
    var taskRefreshBusy = false;
    var TASK_STORAGE_KEY = "silas.seckill.pipeline-task.v1";

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

    async function loadMaterials() {
        var response = await fetch("/api/seckill/materials", { headers: { "Accept": "application/json" } });
        if (!response.ok) {
            throw new Error(await errorMessage(response));
        }
        materials = await response.json();
        materials.forEach(function (material) { materialByID.set(String(material.id), material); });
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
        ["limit", "redis", "mq", "mysql"].forEach(function (name, index) {
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
        ["uid", "gid", "name", "price", "order_status", "inventory_mode", "order_id", "run_id"].forEach(function (name) {
            document.cookie = name + "=; Max-Age=0; Path=/";
        });
    }

    function showReceipt(material) {
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
        var orderID = readCookie("order_id");
        var runID = readCookie("run_id");
        if (!uid || !gid) {
            return;
        }
        var attempts = 0;
        async function poll() {
            attempts += 1;
            try {
                var response = await fetch("/api/order/status?uid=" + encodeURIComponent(uid) + "&gid=" + encodeURIComponent(gid) + "&order_id=" + encodeURIComponent(orderID) + "&run_id=" + encodeURIComponent(runID));
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
        if (requestBusy || taskIsActive(activeTask)) {
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
                setRequestState("failed", "本次未取得", "当前没有可分配库存，本次未取得资格。");
                showToast("本次未取得材料");
                requestBusy = false;
                byId("draw-material").disabled = taskIsActive(activeTask);
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
            byId("draw-material").disabled = taskIsActive(activeTask);
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
        currentRateLimitQPS = typeof snapshot.rateLimitQps === "number" ? snapshot.rateLimitQps : null;
        renderLimitThreshold(currentRateLimitQPS);
        renderEvents(snapshot.events);
    }

    function renderLimitThreshold(threshold) {
        setText("limit-threshold", threshold == null ? "—" : formatNumber(threshold));
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

    function setTaskControls(task) {
        var active = taskIsActive(task);
        byId("start-stock-test").disabled = active;
        byId("stop-stock-test").disabled = !active;
        byId("reset-seckill").disabled = active;
        byId("draw-material").disabled = active || requestBusy;
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
            "已完成 " + formatNumber(metrics.actualRequests) + " / " + formatNumber(task.plannedRequests || 1500) + " 个请求" :
            (task.status === "completed" ? "本轮结果已冻结" : taskStatusLabel(task.status)));
        setText("stock-result-total", formatNumber(metrics.actualRequests));
        setText("stock-result-limited", formatNumber(metrics.rateLimited));
        // 旧任务没有独立 Lua 计数，必须显示缺失，不能拿入队数冒充。
        var hasLuaCount = typeof metrics.luaAdmissionSuccess === "number";
        setText("stock-result-admitted", hasLuaCount ? formatNumber(metrics.luaAdmissionSuccess) : "—");
        setText("stock-process-admitted", hasLuaCount ? formatNumber(metrics.luaAdmissionSuccess) : "—");
        setText("stock-result-failed", formatNumber(metrics.stockFailed));
        setText("stock-process-rejected", formatNumber(metrics.stockFailed));
        // 库存过程只跟随本轮服务端快照，不用前端计时模拟扣减。
        var hasInventory = typeof metrics.activityStock === "number" && metrics.activityStock > 0;
        var remaining = Number(metrics.redisStock || 0);
        setText("stock-process-remaining", hasInventory ? formatNumber(remaining) : "—");
        byId("stock-inventory-fill").style.width = hasInventory ? Math.max(0, Math.min(100, remaining / metrics.activityStock * 100)) + "%" : "0%";
        setText("stock-result-remaining", formatNumber(metrics.redisStock));
        setText("stock-result-errors", formatNumber(metrics.systemErrors));
        setText("stock-result-enqueued", formatNumber(metrics.createOrderEnqueued));
        setText("stock-result-consumed", formatNumber(metrics.createOrderConsumed));
        setText("stock-result-backlog", formatNumber(metrics.createOrderBacklog));
        setText("stock-result-http-errors", formatNumber(metrics.httpUnexpected));
        setText("pipeline-allowed", hasInventory ? formatNumber(metrics.allowedRequests) : "—");
        setText("pipeline-limited", hasInventory ? formatNumber(metrics.rateLimited) : "—");
        setText("pipeline-enqueued", hasInventory ? formatNumber(metrics.createOrderEnqueued) : "—");
        setText("pipeline-orders", hasInventory ? formatNumber(metrics.createOrderConsumed) : "—");
        if (typeof metrics.rateLimitQps === "number") { renderLimitThreshold(metrics.rateLimitQps); }
        setText("pipeline-order-note", hasInventory ? "待处理 " + formatNumber(metrics.createOrderBacklog) + " 条" +
            (task.status === "completed" ? " · 本轮观察值已冻结，消费者继续处理。" : " · 抢到资格不代表订单瞬间完成。") : "抢到资格不代表订单瞬间完成，消息会异步处理。");
        byId("stock-experiment").dataset.runState = task.status;
        renderTaskLogs("stock", task.logs);

        var verdict = byId("stock-verdict");
        byId("stock-conclusion").removeAttribute("data-tone");
        verdict.removeAttribute("data-tone");
        if (task.status === "completed") {
            var allowed = Number(metrics.allowedRequests || 0);
            var accountingClosed = Number(metrics.luaAdmissionSuccess || 0) + Number(metrics.stockFailed || 0) === allowed;
            var enqueued = Number(metrics.createOrderEnqueued || 0);
            var consumed = Number(metrics.createOrderConsumed || 0);
            var backlog = Number(metrics.createOrderBacklog || 0);
            var mqAccountingClosed = enqueued === Number(metrics.luaAdmissionSuccess || 0) &&
                consumed <= enqueued && backlog === enqueued - consumed;
            var passed = hasLuaCount && metrics.activityStock === 1000 && metrics.rateLimitQps === 1200 &&
                allowed + Number(metrics.rateLimited || 0) === Number(metrics.actualRequests || 0) &&
                Number(metrics.actualRequests || 0) === Number(task.plannedRequests || 1500) &&
                Number(metrics.http429 || 0) === Number(metrics.rateLimited || 0) &&
                Number(metrics.luaAdmissionSuccess || 0) === Number(metrics.activityStock || 1000) &&
                Number(metrics.redisStock || 0) === 0 &&
                Number(metrics.systemErrors || 0) === 0 &&
                Number(metrics.httpUnexpected || 0) === 0 &&
                !metrics.oversold && accountingClosed && mqAccountingClosed;
            var bothDefensesObserved = passed && Number(metrics.rateLimited || 0) > 0 && Number(metrics.stockFailed || 0) > 0;
            verdict.dataset.tone = passed ? "success" : "pending";
            byId("stock-conclusion").dataset.tone = verdict.dataset.tone;
            verdict.textContent = passed ? "✓ 本轮库存准入未发生超卖" : "本轮结果待核对";
            setText("stock-conclusion-copy", bothDefensesObserved ?
                "限流器拦截 " + formatNumber(metrics.rateLimited) + " 个请求，资格裁判再拒绝 " + formatNumber(metrics.stockFailed) + " 个；最终 " + formatNumber(metrics.luaAdmissionSuccess) + " 人获得资格。" :
                (passed ? "库存核对通过。本轮" + (Number(metrics.rateLimited || 0) === 0 ? "未触发入口限流" : "未观察到库存不足拒绝") + "，尚未完整展示两次筛选。" : "查看详细指标与日志，确认请求分流与库存结果。"));
            setText("stock-verdict-detail", passed ? (backlog > 0 ? "库存核对通过，仍有 " + formatNumber(backlog) + " 条落单消息待处理。" : "库存核对通过，落单观察已完成。") :
                (hasLuaCount ? "本轮请求分流、资格或库存未满足核对条件，暂不能得出未超卖结论。" : "这份结果缺少独立 Lua 准入计数，请重新运行实验。"));
        } else if (task.status === "failed" || task.status === "stopped") {
            verdict.textContent = task.status === "failed" ? "实验未完成" : "实验已停止";
            setText("stock-conclusion-copy", "本轮尚不能形成库存正确性结论。");
            setText("stock-verdict-detail", task.errorMessage || "任务没有完整结束，本轮不能形成库存正确性结论。");
        } else {
            verdict.textContent = task.status === "collecting" ? "争抢结束，正在核对" : "请求正在争抢库存";
            setText("stock-conclusion-copy", "结束后，根据本轮请求、资格与库存给出结论。");
            setText("stock-verdict-detail", "正在核对请求、资格与库存，结束后给出本轮结论。");
        }
    }

    function renderTask(task) {
        // 旧版独立实验仍可经 API 查询，但不能套进 1500 人的新流水线。
        if (task.experiment !== "seckill-stock-burst" || task.plannedRequests !== 1500) {
            showToast("这份结果属于旧版实验，请开始一轮新的抢购。");
            window.sessionStorage.removeItem(TASK_STORAGE_KEY);
            return;
        }
        activeTask = task;
        renderStockTask(task);
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

    async function startTask() {
        if (taskIsActive(activeTask)) {
            showToast("已有实验正在运行");
            return;
        }
        if (requestBusy && page.dataset.requestState === "requesting") {
            showToast("请等待单次请求结束");
            return;
        }
        if (currentRateLimitQPS !== 1200) {
            showToast("本场景需要入口阈值为 1200 QPS，请检查服务配置与指标连接");
            return;
        }
        if (!window.confirm("将重置秒杀订单和库存，让 1500 个用户经过限流器，争抢 1000 份星髓。开始吗？")) { return; }
        var body = { experiment: "seckill-stock-burst" };
        setTaskControls({ status: "starting", experiment: body.experiment });
        try {
            var created = await requestJSON("/api/loadtests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            clearOrderCookies();
            clearChain();
            setRequestState("idle", "等待递交", "获得资格会占用 1 份库存；支付或放弃后返回本页。");
            window.clearTimeout(statusTimer);
            requestBusy = false;
            setText("draw-material", "发送一次请求");
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

    async function stopTask() {
        if (!taskIsActive(activeTask)) {
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
            if (!saved || !saved.id || saved.experiment !== "seckill-stock-burst") {
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
            byId("request-receipt").hidden = true;
            requestBusy = false;
            byId("draw-material").disabled = taskIsActive(activeTask);
            setText("draw-material", "发送一次请求");
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

    // 移动原卡片而非复制：保留实时数字和事件，原位置占位，流水线不发生重排。
    function setupNodeInspection() {
        var dialog = byId("node-zoom");
        var content = byId("node-zoom-content");
        var active = null;
        var closing = false;
        var motion = window.matchMedia("(prefers-reduced-motion: reduce)");

        function originTransform(rect) {
            var target = dialog.getBoundingClientRect();
            var scale = Math.min(rect.width / target.width, rect.height / target.height);
            return "translate(" + (rect.left + rect.width / 2 - target.left - target.width / 2) + "px," +
                (rect.top + rect.height / 2 - target.top - target.height / 2) + "px) scale(" + scale + ")";
        }
        function openNode(node, trigger) {
            if (active) { return; }
            var rect = node.getBoundingClientRect();
            var placeholder = document.createElement("div");
            placeholder.className = "node-zoom-placeholder";
            placeholder.style.height = window.getComputedStyle(node).height;
            placeholder.setAttribute("aria-hidden", "true");
            node.before(placeholder);
            active = { node: node, placeholder: placeholder, trigger: trigger, scroll: window.scrollY };
            content.appendChild(node);
            node.classList.add("is-zoomed");
            node.querySelector(".node-details").open = true;
            node.querySelector(".node-overview").setAttribute("aria-expanded", "true");
            document.body.classList.add("has-node-zoom");
            dialog.showModal();
            byId("close-node-zoom").focus({ preventScroll: true });
            window.scrollTo({ top: active.scroll, behavior: "instant" });
            if (!motion.matches) {
                dialog.animate([{ transform: originTransform(rect), opacity: .5 }, { transform: "none", opacity: 1 }],
                    { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
            }
        }
        async function closeNode() {
            if (!active || closing) { return; }
            closing = true;
            dialog.getAnimations().forEach(function (animation) { animation.cancel(); });
            if (!motion.matches) {
                var animation = dialog.animate([{ transform: "none", opacity: 1 },
                    { transform: originTransform(active.placeholder.getBoundingClientRect()), opacity: .2 }],
                    { duration: 220, easing: "ease-in", fill: "forwards" });
                await animation.finished.catch(function () {});
                animation.cancel();
            }
            dialog.close();
            active.node.classList.remove("is-zoomed");
            active.node.querySelector(".node-details").open = false;
            active.node.querySelector(".node-overview").setAttribute("aria-expanded", "false");
            active.placeholder.replaceWith(active.node);
            document.body.classList.remove("has-node-zoom");
            active.trigger.focus({ preventScroll: true });
            window.scrollTo({ top: active.scroll, behavior: "instant" });
            active = null;
            closing = false;
        }
        document.querySelectorAll("[data-inspectable]").forEach(function (node) {
            var overview = node.querySelector(".node-overview");
            var summary = node.querySelector(".node-details > summary");
            overview.setAttribute("aria-haspopup", "dialog");
            summary.setAttribute("aria-haspopup", "dialog");
            summary.addEventListener("click", function (event) {
                event.preventDefault();
                openNode(node, summary);
            });
            overview.addEventListener("click", function (event) {
                if (event.target.closest(".pipeline-branch") || window.getSelection().toString()) { return; }
                openNode(node, overview);
            });
            overview.addEventListener("keydown", function (event) {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openNode(node, overview);
                }
            });
        });
        byId("close-node-zoom").addEventListener("click", closeNode);
        dialog.addEventListener("cancel", function (event) { event.preventDefault(); closeNode(); });
        dialog.addEventListener("click", function (event) {
            var rect = dialog.getBoundingClientRect();
            if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
                event.clientY < rect.top || event.clientY > rect.bottom)) { closeNode(); }
        });
    }

    document.addEventListener("DOMContentLoaded", async function () {
        setupNodeInspection();
        byId("draw-material").addEventListener("click", drawMaterial);
        byId("reset-seckill").addEventListener("click", resetLab);
        byId("start-stock-test").addEventListener("click", startTask);
        byId("stop-stock-test").addEventListener("click", stopTask);
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
