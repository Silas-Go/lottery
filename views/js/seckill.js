(function () {
    "use strict";

    var page = document.body;
    var materials = [];
    var materialByID = new Map();
    var requestBusy = false;
    var toastTimer = null;
    var chainTimers = [];
    var statusTimer = null;

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
            var code = document.createElement("small");
            var name = document.createElement("h3");
            var description = document.createElement("p");

            card.className = "material-card";
            card.dataset.materialId = String(material.id);
            image.src = material.picture;
            image.alt = material.name;
            code.textContent = material.code;
            name.textContent = material.name;
            description.textContent = material.description;
            content.appendChild(code);
            content.appendChild(name);
            content.appendChild(description);
            card.appendChild(image);
            card.appendChild(content);
            grid.appendChild(card);
            materialByID.set(String(material.id), material);
        });
        setText("material-count", materials.length === 1 ? "ARC-004 · 星髓" : materials.length + " 种材料");
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
        setText("receipt-code", material.code);
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
        setText("metric-paid", Number(snapshot.completedOrders || 0).toLocaleString("zh-CN"));
        setText("metric-qps", Number(snapshot.qps || 0).toLocaleString("zh-CN"));
        setText("metric-p95", Number(snapshot.p95 || 0) + " ms");
        var oversold = byId("metric-oversold");
        oversold.textContent = snapshot.oversold ? "是" : "否";
        oversold.dataset.value = snapshot.oversold ? "danger" : "safe";
        setText("metrics-time", snapshot.at || "实时快照");
        renderEvents(snapshot.events);
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
        try {
            await Promise.all([loadMaterials(), loadMetricsSnapshot()]);
        } catch (error) {
            setRequestState("failed", "初始化失败", error.message);
            showToast(error.message);
        }
        connectMetrics();
    });
}());
