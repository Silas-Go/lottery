(function () {
    "use strict";

    var experimentState = window.SilasExperimentState;
    var experimentResults = window.SilasExperimentResults;
    var materials = {
        "star-marrow": { id: 4, name: "星髓", sigil: "Ⅳ", kind: "star" }
    };
    // 查询、购买和抢购三条实验链路只共享星髓这一项业务样本。
    // 代码仍按 material code 编排，未来扩展目录时无需把业务逻辑改成硬编码分支。
    var FEATURED_MATERIAL_CODE = "star-marrow";
    var state = "dialogue";
    var selectedCode = null;
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var crowdStream = null;
    var crowdPollTimer = null;
    var activeTask = null;
    var marketLastActiveStatus = "starting";
    var enteringCrowdLab = false;
    var ACTIVE_TASK_KEY = "silas.cache-aside.active-loadtest.v1";
    var WORLD_TRANSITION_KEY = "silas.world-transition.v1";
    var arrivingFromStreet = false;
    // 两条查询路径固定使用 1500 QPS、wrk2 -c 500 和 30 秒，避免把配置选择
    // 变成实验步骤；QPS 仍表示计划请求速率，-c 表示 HTTP 持久连接数。
    var crowdTiers = Object.freeze({
        qps_1500: Object.freeze({ label: "满潮", rate: 1500, duration: 30 })
    });
    var crowdShells = Object.freeze({
        powershell: Object.freeze({ label: "PowerShell 5.1+" }),
        bash: Object.freeze({ label: "Bash / WSL" })
    });
    var crowdTierID = "qps_1500";
    var connectionMode = "manual";
    var manualConnections = 500;
    var crowdShell = "powershell";
    var connectionPlan = null;
    var connectionPlanRequest = 0;
    var queryExplainerMode = "direct";
    // 详情页只给两轮建立共同条件；直接查询用作自动连接数的预估样本，
    // 进入实验室选择真实路径后会按该路径重新估算，任务创建时再由 Runner 锁定。
    var CONFIG_PREVIEW_MODE = "direct";
    var marketPreviewTimer = null;
    var marketPreviewSignature = "";
    // 详情页只解释两条真实路径；本轮运行方案留到实验室内选择。
    var purchasePathExplanations = Object.freeze({
        "sync-invalidate": Object.freeze({
            label: "同步删除缓存",
            route: "MySQL COMMIT → Redis DEL → Response",
            copy: "顾客响应会等待库存牌删除完成，路径更直接，但 Redis 位于购买请求链路中。"
        }),
        "outbox-mq-invalidate": Object.freeze({
            label: "Outbox + MQ 异步失效",
            route: "TX + Outbox → Response · Worker → MQ → Consumer → Redis DEL",
            copy: "顾客先收到响应，再由信使异步更新库存牌；核心交易链路更短，但允许短暂旧读窗口。"
        })
    });
    var purchaseExplainerMode = "sync-invalidate";

    function byId(id) {
        return document.getElementById(id);
    }

    function startWorldEntrance() {
        try {
            arrivingFromStreet = window.sessionStorage.getItem(WORLD_TRANSITION_KEY) === "street-to-material-shop";
            window.sessionStorage.removeItem(WORLD_TRANSITION_KEY);
        } catch (_) {
            arrivingFromStreet = false;
        }
        if (document.documentElement.dataset.planner || !arrivingFromStreet || reducedMotion) {
            return;
        }
        document.body.classList.add("is-arriving-from-street");
        window.requestAnimationFrame(function () {
            window.requestAnimationFrame(function () {
                document.body.classList.add("is-arrival-settled");
            });
        });
        window.setTimeout(function () {
            document.body.classList.remove("is-arriving-from-street", "is-arrival-settled");
        }, 820);
    }

    function setState(next) {
        state = next;
        document.body.dataset.eventState = next;
        if (next === "crowd_preparing" || next === "crowd_armed" || next === "crowd_submitting") {
            document.documentElement.dataset.planner = "query";
        } else if (next === "purchase_preparing" || next === "entering_purchase_lab") {
            document.documentElement.dataset.planner = "purchase";
        }
        var labels = {
            arrival: "抵达",
            dialogue: "交谈",
            choosing: "选择材料",
            record_selected: "取得档案片",
            crowd_preparing: "查看查询实验",
            purchase_preparing: "查看购买实验",
            crowd_armed: "实验条件已确认",
            crowd_submitting: "卷轴投递",
            entering_purchase_lab: "进入购买实验室"
        };
        byId("event-step").textContent = labels[next] || "事件";
    }

    function showToast(message) {
        var toast = byId("market-toast");
        toast.textContent = message;
        toast.classList.add("is-visible");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(function () {
            toast.classList.remove("is-visible");
        }, 2400);
    }

    function materialNumericId() {
        return selectedCode && materials[selectedCode] ? materials[selectedCode].id : 0;
    }

    function materialCodeForId(id) {
        var numericId = Number(id);
        return Object.keys(materials).find(function (code) {
            return materials[code].id === numericId;
        }) || "";
    }

    function crowdCommand() {
        var tier = crowdTiers[crowdTierID];
        if (connectionMode === "auto") {
            var planned = matchingConnectionPlan();
            return "# 两条读取路径共享 RATE=" + tier.rate + "、DURATION=" + tier.duration + "s。\n" +
                "# 详情页当前预估 CONNECTIONS=" + (planned ? planned.connections : "PENDING") + "；" +
                "进入实验室选择路径后会重新计算，任务创建时锁定最终值。";
        }
        function loadCommand(path) {
            return "docker compose --profile loadtest run --rm --no-deps " +
            "-e RATE=" + tier.rate + " -e DURATION=" + tier.duration + "s -e THREADS=1 -e CONNECTIONS=" + manualConnections + " " +
            "-e TARGET_URL=http://app:5678/api/archives/" + materialNumericId() + "/" + path + " " +
            "-e SCRIPT=/opt/wrk2/scripts/read.lua wrk2";
        }
        if (crowdShell === "powershell") {
            return "$ErrorActionPreference = \"Stop\"\n" +
                "Invoke-WebRequest -UseBasicParsing -Method Post " +
                "-Uri \"http://localhost:5678/api/chapters/cache-aside/reset\" | Out-Null\n" +
                "# 方案 A · MySQL 直接查询\n" + loadCommand("direct") + "\n\n" +
                "# 方案 B · Redis 旁路缓存（保持相同 QPS、-c 与时长）\n" + loadCommand("cached");
        }
        return "curl -fsS -X POST http://localhost:5678/api/chapters/cache-aside/reset >/dev/null\n" +
            "# 方案 A · MySQL 直接查询\n" + loadCommand("direct") + "\n\n" +
            "# 方案 B · Redis 旁路缓存（保持相同 QPS、-c 与时长）\n" + loadCommand("cached");
    }

    function matchingConnectionPlan() {
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        if (!connectionPlan || connectionPlan.rate !== tier.rate ||
            connectionPlan.requestMode !== CONFIG_PREVIEW_MODE || connectionPlan.connectionMode !== connectionMode) {
            return null;
        }
        if (connectionMode === "manual" && connectionPlan.connections !== manualConnections) {
            return null;
        }
        return connectionPlan;
    }

    function marketRequestPath() {
        return "/api/archives/" + materialNumericId() + "/{direct|cached}";
    }

    function renderMarketRequestPreview() {
        var path = marketRequestPath();
        byId("market-request-line").textContent = "GET " + path;
        byId("market-request-preview").textContent =
            "GET " + path + " HTTP/1.1\n" +
            "Host: app:5678\n" +
            "Connection: keep-alive";
    }

    function stopMarketPreview() {
        window.clearTimeout(marketPreviewTimer);
        marketPreviewTimer = null;
        byId("market-mechanism").classList.remove("is-previewing");
    }

    // 详情页只播放一次“请求将如何流动”的预演反馈，不代表 Runner 已经启动。
    // 保存计划或进入真实任务状态后必须立刻停止，真实请求动画只由实验室观测驱动。
    function replayMarketPreview(signature, targetRate) {
        if (!signature || signature === marketPreviewSignature) {
            return;
        }
        marketPreviewSignature = signature;
        stopMarketPreview();
        if (reducedMotion || state !== "crowd_preparing" || isTaskActive()) {
            return;
        }
        var duration = targetRate >= 1500 ? 900 :
            (targetRate >= 800 ? 1080 : (targetRate >= 300 ? 1260 : 1440));
        var mechanism = byId("market-mechanism");
        mechanism.style.setProperty("--market-preview-duration", duration + "ms");
        window.requestAnimationFrame(function () {
            window.requestAnimationFrame(function () {
                mechanism.classList.add("is-previewing");
                marketPreviewTimer = window.setTimeout(stopMarketPreview, duration * 2 + 420);
            });
        });
    }

    // 金色卷轴只表示“把本轮配置交给实验室”，不是 HTTP 请求。
    // 它发生在任何 Runner 任务创建之前，蓝色请求卷轴仍只允许由实验室真实指标驱动。
    function animateTaskOrderHandoff(handoff) {
        return new Promise(function (resolve) {
            var template = byId("market-task-order-template");
            var launcher = document.querySelector(".market-launcher-visual");
            var gate = document.querySelector(".market-shop-door");
            if (!handoff || !template || !launcher || !gate) {
                resolve();
                return;
            }
            var token = template.content.firstElementChild.cloneNode(true);
            var connections = Number(handoff.plannedConnections || 0);
            var connectionCopy = connections > 0 ?
                "-c " + connections.toLocaleString("zh-CN") :
                "自动 -c 待锁定";
            var pathCopy = handoff.sharedConditions ? "DIRECT / CACHE-ASIDE" :
                (handoff.mode === "cached" ? "CACHE-ASIDE" : "MYSQL DIRECT");
            token.querySelector("small").textContent =
                Number(handoff.expectedRate || 0).toLocaleString("zh-CN") +
                " req/s · " + connectionCopy + " · " + pathCopy;
            document.body.appendChild(token);

            var launcherBounds = launcher.getBoundingClientRect();
            var gateBounds = gate.getBoundingClientRect();
            var startX = launcherBounds.left + launcherBounds.width / 2 - token.offsetWidth / 2;
            var startY = launcherBounds.top + launcherBounds.height / 2 - token.offsetHeight / 2;
            var endX = gateBounds.left + gateBounds.width / 2 - token.offsetWidth / 2;
            var endY = gateBounds.top + gateBounds.height / 2 - token.offsetHeight / 2;
            var deltaX = endX - startX;
            var deltaY = endY - startY;
            token.style.left = startX + "px";
            token.style.top = startY + "px";
            document.body.classList.add("is-task-order-flying");

            var settled = false;
            function finish() {
                if (settled) {
                    return;
                }
                settled = true;
                token.remove();
                document.body.classList.remove("is-task-order-flying");
                resolve();
            }

            if (reducedMotion || !token.animate) {
                token.style.opacity = "1";
                token.style.transform =
                    "translate3d(" + deltaX + "px," + deltaY + "px,0) scale(.78)";
                window.setTimeout(finish, reducedMotion ? 90 : 520);
                return;
            }
            var animation = token.animate([
                {
                    opacity: 0,
                    transform: "translate3d(0,0,0) scale(.9)"
                },
                {
                    offset: .12,
                    opacity: 1,
                    transform: "translate3d(0,0,0) scale(1)"
                },
                {
                    offset: .48,
                    opacity: 1,
                    transform: "translate3d(" + (deltaX * .46) + "px," +
                        (deltaY * .46 - 18) + "px,0) scale(1)"
                },
                {
                    offset: .82,
                    opacity: 1,
                    transform: "translate3d(" + (deltaX * .82) + "px," +
                        (deltaY * .82 - 8) + "px,0) scale(.9)"
                },
                {
                    opacity: 0,
                    transform: "translate3d(" + deltaX + "px," + deltaY +
                        "px,0) scale(.72)"
                }
            ], {
                duration: 880,
                easing: "steps(8, end)",
                fill: "forwards"
            });
            animation.finished.then(finish, finish);
        });
    }

    // 光束只表达 wrk2 -c 的相对档位；精确配置仍由文字给出，
    // 不能把象征性光束误称为已经成功建立的 socket 数量。
    function renderMarketConduits(connections, status) {
        var safeConnections = Math.max(0, Number(connections || 0));
        var visualCount = safeConnections > 0 ?
            Math.max(1, Math.ceil(Math.min(500, safeConnections) / 500 * 10)) : 0;
        Array.prototype.forEach.call(
            document.querySelectorAll(".market-conduit-bundle i"),
            function (conduit, index) {
                conduit.classList.toggle("is-active", index < visualCount);
            });

        var phase = status || "planned";
        var prefix = "计划";
        var modeCopy = "配置预览";
        if (phase === "starting" || phase === "resetting") {
            prefix = "已锁定";
            modeCopy = "Runner 尚未发送";
        } else if (phase === "running") {
            prefix = "运行配置";
            modeCopy = "实验室运行中";
        } else if (phase === "collecting" || phase === "completed" ||
            phase === "failed" || phase === "stopped") {
            prefix = "本轮配置";
            modeCopy = phase === "collecting" ? "正在结算" : "已停止承载";
        }

        byId("market-conduit-count").textContent = safeConnections > 0 ?
            prefix + " · -c " + safeConnections.toLocaleString("zh-CN") :
            "Runner 计划计算中";
        byId("query-preview-connections").textContent = safeConnections > 0 ?
            "-c " + safeConnections.toLocaleString("zh-CN") : "计算中";
        byId("market-conduit-mode").textContent = modeCopy;
        byId("market-conduit-scale").textContent = safeConnections > 0 ?
            visualCount + " 束预演通路 · 连接容量档位" :
            "等待 Runner 生成连接计划";
        byId("market-mechanism").dataset.conduitLevel = String(visualCount);
        if (phase === "planned" && safeConnections > 0) {
            var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
            replayMarketPreview(
                experimentState.get().mode + ":" + tier.rate + ":" + safeConnections,
                Number(tier.rate || 0));
        } else {
            marketPreviewSignature = "";
            stopMarketPreview();
        }
    }

    function incomingFoyerExperiment() {
        var query = new URLSearchParams(window.location.search);
        var experiment = query.get("experiment");
        return experiment === "query" || experiment === "purchase" ? experiment : "";
    }

    function updateFoyerExperimentQuery(experiment) {
        var nextURL = new URL(window.location.href);
        if (experiment) {
            nextURL.searchParams.set("experiment", experiment);
        } else {
            nextURL.searchParams.delete("experiment");
        }
        window.history.replaceState(null, "", nextURL.toString());
    }

    function renderConnectionPlan() {
        var plan = matchingConnectionPlan();
        var connections = manualConnections;
        byId("crowd-connection-plan").textContent = "固定 · -c " +
            connections.toLocaleString("zh-CN");
        byId("query-preview-connections").textContent = "-c " +
            connections.toLocaleString("zh-CN");
        byId("crowd-connection-current").textContent = "尚未创建";
        byId("crowd-connection-copy").textContent =
            "QPS、连接数和时长均已固定，不再需要选择档位或连接策略。" +
            (plan && plan.reason ? " Runner 已确认该配置。" : "");
        renderMarketConduits(connections, "planned");
        return connections;
    }

    async function refreshConnectionPlan() {
        if (!selectedCode || isTaskActive()) {
            return;
        }
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        var mode = CONFIG_PREVIEW_MODE;
        var requestID = ++connectionPlanRequest;
        connectionPlan = null;
        renderCrowdTier();
        try {
            var response = await fetch("/api/loadtests/connection-plan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    experiment: "cache-aside-read",
                    archiveId: materialNumericId(),
                    mode: mode,
                    rate: tier.rate,
                    connectionMode: connectionMode,
                    connections: connectionMode === "manual" ? manualConnections : 0
                })
            });
            if (!response.ok) {
                throw new Error(await readAPIError(response));
            }
            var plan = await response.json();
            if (requestID !== connectionPlanRequest) {
                return;
            }
            connectionPlan = Object.assign({}, plan, { requestMode: mode });
            renderCrowdTier();
        } catch (error) {
            if (requestID !== connectionPlanRequest) {
                return;
            }
            byId("crowd-connection-plan").textContent = "固定 · -c " + manualConnections;
            byId("query-preview-connections").textContent = "-c " + manualConnections;
            byId("crowd-connection-copy").textContent =
                "固定配置不受预览接口影响；Runner 暂时无法确认：" + error.message;
        }
    }

    function renderExperimentState(next) {
        byId("crowd-summary-path").textContent = "直接查询 vs 旁路缓存";
        byId("market-backend-icon").textContent = "A/B";
        byId("market-backend-name").textContent = "直接查询 vs 旁路缓存";
        byId("market-mechanism").dataset.path = "comparison";
        renderMarketRequestPreview();
    }

    function renderQueryExplainer() {
        var cached = queryExplainerMode === "cached";
        Array.prototype.forEach.call(document.querySelectorAll("[data-query-explainer]"), function (button) {
            var active = button.dataset.queryExplainer === queryExplainerMode;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
            var action = button.querySelector(".query-path-card-action");
            if (action) {
                action.textContent = active ? "正在解说" : "查看方案解说 →";
            }
        });
        byId("query-plan-preview-eyebrow").textContent =
            "方案解说 · " + (cached ? "方案 B" : "方案 A");
        byId("query-plan-preview-heading").textContent =
            "方案解说 · " + (cached ? "Redis 旁路缓存" : "MySQL 直接查询");
        byId("query-preview-route").textContent =
            "GET /api/archives/4/" + (cached ? "cached" : "direct");
        byId("query-preview-copy").textContent = cached ?
            "请求先查询 Redis；命中后直接返回，只有未命中才进入回源保护、查询 MySQL 并回填完整 DTO。" :
            "每个 HTTP 请求都进入 MySQL，完成 4 条查询后现场组装同一份 MaterialDetailDTO。";
        byId("query-explainer-chain").textContent = cached ?
            "Go API → Redis；未命中 → 按缓存键互斥并双检 → MySQL → 回填 Redis。" :
            "Go API → MySQL → 4 条 SQL → DTO。";
        byId("query-explainer-trait-label").textContent = cached ? "工程价值" : "性能特征";
        byId("query-explainer-trait").textContent = cached ?
            "缓存命中会避开数据库查询与 DTO 组装，用少量等待换取 MySQL 稳定。" :
            "没有缓存命中收益，每次请求都会重复查询和组装。";
        byId("query-explainer-proof-label").textContent = cached ? "潜在问题" : "重点观察";
        byId("query-explainer-proof").textContent = cached ?
            "热点缓存键失效可能引发缓存击穿；不存在的材料反复回源会形成缓存穿透，后续阶段分别验证。" :
            "MySQL 回源、SQL 查询数，以及 P95 / P99 延迟。";
        byId("query-risk-map").hidden = !cached;
    }

    function renderCrowdTier() {
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        if (!crowdTiers[crowdTierID]) {
            crowdTierID = "qps_1500";
        }
        var plannedConnections = renderConnectionPlan();
        byId("crowd-size-value").textContent = tier.rate.toLocaleString("zh-CN") + " req/s";
        byId("query-preview-rate").textContent = tier.rate.toLocaleString("zh-CN") + " req/s";
        byId("crowd-size-note").textContent = "固定运行 " + tier.duration +
            " 秒；进入实验室选择读取路径并手动开始。";
        byId("market-source-rate").textContent = tier.rate.toLocaleString("zh-CN") + " req/s";
        byId("market-flow-target").textContent = tier.rate.toLocaleString("zh-CN") + " req/s";
        byId("market-flow-actual-label").textContent = "运行事实";
        byId("market-flow-actual").textContent = "实验室观测";
        byId("market-flow-errors").textContent = "—";
        byId("market-queue-state").textContent = "任务尚未创建";
        byId("market-response-rate").textContent = "等待实验运行";
        byId("market-flow-status").textContent = "计划预演";
        byId("market-mechanism").dataset.flowState = plannedConnections > 0 ? "planned" : "waiting";
        byId("market-mechanism").dataset.taskPhase = plannedConnections > 0 ? "planned" : "waiting";
        byId("market-mechanism").dataset.capacityState = "unknown";
        renderMarketRequestPreview();
        renderMarketLifecycle(null);
        if (selectedCode) {
            byId("market-load-command").textContent = crowdCommand();
        }

        if (state === "crowd_preparing" && !activeTask) {
            byId("crowd-status-title").textContent = "实验条件待确认";
            byId("crowd-status-copy").textContent = "进入实验室后仍需手动开始，不会自动发送压测请求。";
            byId("crowd-clock").hidden = true;
        }
    }

    function renderCrowdShell() {
        var shell = crowdShells[crowdShell] || crowdShells.powershell;
        if (!crowdShells[crowdShell]) {
            crowdShell = "powershell";
        }
        Array.prototype.forEach.call(document.querySelectorAll("[data-crowd-shell]"), function (button) {
            var active = button.dataset.crowdShell === crowdShell;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
        if (selectedCode) {
            byId("market-load-command").textContent = crowdCommand();
        }
        byId("copy-market-command").setAttribute("aria-label", "复制 " + shell.label + " 等价命令");
    }

    function updateCrowdTicketCodes() {
        Array.prototype.forEach.call(document.querySelectorAll("[data-crowd-ticket]"), function (ticket) {
            ticket.textContent = selectedCode && materials[selectedCode] ? materials[selectedCode].name : "星髓";
        });
    }

    function applySelectedMaterial(code) {
        var material = materials[code];
        if (!material) {
            return;
        }
        selectedCode = code;
        byId("record-name").textContent = material.name;
        byId("record-sigil").textContent = material.sigil;
        byId("record-card").dataset.kind = material.kind;
        updateCrowdTicketCodes();
        renderMarketRequestPreview();
    }

    function openFeaturedMaterial() {
        applySelectedMaterial(FEATURED_MATERIAL_CODE);
        setState("record_selected");
    }

    function isTaskActive(task) {
        var status = (task || activeTask || {}).status;
        return status === "starting" || status === "resetting" || status === "running" || status === "collecting";
    }

    function closeTaskTracking() {
        if (crowdStream) {
            crowdStream.close();
            crowdStream = null;
        }
        if (crowdPollTimer) {
            window.clearInterval(crowdPollTimer);
            crowdPollTimer = null;
        }
    }

    function setExperimentControlsLocked(locked) {
        ["leave-crowd-mode"].forEach(function (id) {
            byId(id).disabled = locked;
        });
        Array.prototype.forEach.call(document.querySelectorAll(
            "[data-query-explainer]"), function (control) {
            control.disabled = locked;
        });
    }

    function formatClock(seconds) {
        var safe = Math.max(0, Number(seconds || 0));
        return String(Math.floor(safe / 60)).padStart(2, "0") + ":" + String(safe % 60).padStart(2, "0");
    }

    function renderMarketLifecycle(task) {
        var status = task && task.status || "draft";
        var failed = status === "failed";
        var stopped = status === "stopped";
        var messages = (Array.isArray(task && task.logs) ? task.logs : [])
            .map(function (entry) { return entry.message || ""; })
            .concat(task && task.errorMessage || "")
            .join("\n");
        var effectiveStatus = status;
        if (failed || stopped) {
            if (/收集|指标解析|指标收集|wrk2 结束|结果/.test(messages)) {
                effectiveStatus = "collecting";
            } else if (Number(task && task.metrics && task.metrics.actualRequests || 0) > 0 ||
                Number(task && task.elapsedSeconds || 0) > 0 ||
                /wrk2 已启动|wrk2 异常退出|子进程/.test(messages)) {
                effectiveStatus = "running";
            } else if (/数据重置完成|wrk2 启动失败|启动阶段/.test(messages)) {
                effectiveStatus = "launching";
            } else if (/重置/.test(messages)) {
                effectiveStatus = "resetting";
            } else {
                effectiveStatus = marketLastActiveStatus || "starting";
            }
        }
        var completed = [];
        var current = "plan";
        if (effectiveStatus === "starting" || effectiveStatus === "resetting" ||
            effectiveStatus === "launching" || effectiveStatus === "running") {
            completed = ["plan"];
            current = "lab";
        } else if (effectiveStatus === "collecting") {
            completed = ["plan", "lab"];
            current = "result";
        } else if (effectiveStatus === "completed") {
            completed = ["plan", "lab", "result"];
            current = "";
        } else {
            current = "plan";
        }
        Array.prototype.forEach.call(byId("market-task-lifecycle").children, function (item) {
            var stage = item.dataset.marketStage;
            item.classList.toggle("is-complete", completed.indexOf(stage) >= 0);
            item.classList.toggle("is-current", current === stage);
            item.classList.toggle("is-failed", failed && current === stage);
            item.classList.toggle("is-stopped", stopped && current === stage);
        });
    }

    function renderMarketMechanism(task) {
        var tier = task && task.tier || crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        var target = Number(tier.rate || 0);
        var metrics = task && task.metrics || {};
        var status = task && task.status || "draft";
        var requests = Number(metrics.actualRequests || 0);
        var actualQPS = Number(metrics.actualQps || 0);
        var completion = target > 0 ? Math.min(100, actualQPS * 100 / target) : 0;
        var resolvedConnections = Number(tier.connections || 0);
        var socketErrorsAvailable = task &&
            task.status === "completed" &&
            (task.connectionMode === "auto" || task.connectionMode === "manual");
        var socketErrors = Number(metrics.socketErrors || 0);
        var overloaded = completion < 90 &&
            (status === "completed" ||
                (status === "running" && Number(task && task.elapsedSeconds || 0) >= 3));
        var hasObservedRequests = requests > 0 && actualQPS > 0;
        var taskPhase = status === "draft" ? "planned" : status;
        var capacityState = status === "running" ?
            (!hasObservedRequests ? "observing" : (overloaded ? "backlogged" : "healthy")) :
            (status === "completed" ? (overloaded ? "backlogged" : "healthy") : "unknown");
        var statusCopy = {
            draft: "计划预览",
            starting: "任务已创建",
            resetting: "正在重置数据",
            running: overloaded ? "实验室运行 · 入口欠账" : "任务正在实验室运行",
            collecting: "正在结算",
            completed: "结果已输出",
            failed: "任务失败",
            stopped: "任务已停止"
        };
        byId("market-mechanism").dataset.flowState = taskPhase;
        byId("market-mechanism").dataset.taskPhase = taskPhase;
        byId("market-mechanism").dataset.capacityState = capacityState;
        byId("market-mechanism").dataset.faultLayer =
            socketErrorsAvailable && socketErrors > 0 ? "connections" :
                (status === "completed" && Number(metrics.errorRate || 0) > 0 ? "response" : "none");
        byId("market-flow-status").textContent = statusCopy[status] || "任务状态同步中";
        byId("market-source-rate").textContent = target.toLocaleString("zh-CN") + " req/s";
        byId("market-flow-target").textContent = target.toLocaleString("zh-CN") + " req/s";
        renderMarketConduits(resolvedConnections, status);
        byId("market-queue-state").textContent = overloaded ? "入口投递欠账" :
            (status === "running" ? "实验室按计划投递" :
                (status === "collecting" ? "停止产生新请求" :
                    (status === "completed" ? "本轮投递已结束" :
                        (status === "resetting" ? "重置中 · 尚未发送" :
                            (status === "starting" ? "等待 Runner 启动" : "任务尚未创建")))));
        byId("market-response-rate").textContent =
            status === "completed" ?
                (requests > 0 ?
                    actualQPS.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + " req/s 已归档" :
                    "本轮无完成响应") :
                (status === "collecting" ? "正在结算响应" :
                    (status === "running" ? "响应结果等待结算" :
                        (status === "failed" || status === "stopped" ?
                            "未形成完整归档" : "等待实验运行")));
        byId("market-flow-actual-label").textContent =
            status === "completed" ? "完成速率" :
                (status === "running" ? "后端已接收" : "运行事实");
        byId("market-flow-actual").textContent =
            (status === "running" || status === "completed") && requests > 0 ?
                actualQPS.toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + " req/s" :
                (status === "collecting" ? "正在结算" : "实验室观测");
        byId("market-flow-errors").textContent = socketErrorsAvailable ?
            socketErrors.toLocaleString("zh-CN") :
            (status === "failed" || status === "stopped" ? "未形成完整结算" :
                (status === "collecting" ? "正在结算" :
                    (isTaskActive(task) ? "结算后可见" : "—")));
        renderMarketRequestPreview();
        renderMarketLifecycle(task);
    }

    function renderTask(task) {
        activeTask = task;
        if (task.tier && task.tier.rate) {
            var legacyProtocol = task.connectionMode !== "auto" && task.connectionMode !== "manual";
            var matchingTier = Object.keys(crowdTiers).find(function (key) {
                return crowdTiers[key].rate === Number(task.tier.rate);
            });
            if (matchingTier) {
                crowdTierID = matchingTier;
            }
            if (task.connectionMode === "manual") {
                connectionMode = "manual";
                manualConnections = Number(task.tier.connections || task.requestedConnections || manualConnections);
            } else if (task.connectionMode === "auto") {
                connectionMode = "auto";
            }
            renderCrowdTier();
            var resolved = Number(task.tier.connections || 0);
            if (legacyProtocol || !matchingTier) {
                byId("crowd-size-value").textContent =
                    Number(task.tier.rate).toLocaleString("zh-CN") + " req/s";
                byId("crowd-size-note").textContent =
                    "兼容旧任务固定参数。";
            }
            if (resolved > 0) {
                byId("crowd-connection-plan").textContent =
                    (task.connectionMode === "manual" ? "已锁定 · 手动 · -c " : "已锁定 · 自动 · -c ") +
                    resolved.toLocaleString("zh-CN");
                byId("crowd-connection-copy").textContent =
                    task.connectionReason ||
                    (task.connectionMode === "manual" ? "用户手动指定" : "Runner 自动选择");
                byId("crowd-size-value").textContent =
                    Number(task.tier.rate).toLocaleString("zh-CN") + " req/s";
            }
        }
        var active = isTaskActive(task);
        if (active) {
            marketLastActiveStatus = task.status;
        }
        var titles = {
            starting: "任务已创建",
            resetting: "正在重置运行环境",
            running: "查询卷轴正在投递",
            collecting: "正在收集结果",
            completed: "实验已完成",
            failed: "实验失败",
            stopped: "实验已停止"
        };
        var copies = {
            starting: "Runner 已接收任务，准备本轮运行环境。",
            resetting: "正在清空缓存与指标；wrk2 尚未启动。",
            running: "请求正在连接、后端与响应之间循环。",
            collecting: "请求已停止产生，正在输出结果。",
            completed: "本轮已结束，动态卷轴已停止；创建新任务可在实验室观看请求与响应往返。",
            failed: task.errorMessage || "实验未能完成，可进入实验室查看原因。",
            stopped: "本轮查询潮汐已经停止。"
        };
        setState(task.status === "running" ? "crowd_submitting" : "crowd_preparing");
        setExperimentControlsLocked(active);
        byId("crowd-connection-current").textContent = titles[task.status] || "任务状态同步中";
        byId("start-crowd-test").disabled = active;
        var activeButtonCopy = task.status === "running" ? "查询卷轴正在投递" :
            (task.status === "collecting" ? "正在结算查询潮汐" : "正在准备查询潮汐");
        byId("start-crowd-test").textContent = active ? activeButtonCopy :
            (task.status === "completed" ? "查看下一轮实验" : "重新进入实验室");
        byId("enter-crowd-lab").hidden = !task.taskId;
        byId("enter-crowd-lab").textContent = active ? "进入实验室查看" : "进入实验室查看结果";
        byId("crowd-status-title").textContent = titles[task.status] || "等待查询潮汐";
        byId("crowd-status-copy").textContent = copies[task.status] || "任务状态正在同步。";
        byId("crowd-clock").textContent = formatClock(task.elapsedSeconds) + " / " +
            formatClock((task.elapsedSeconds || 0) + (task.remainingSeconds || 0));
        byId("crowd-clock").hidden = !task.taskId;
        renderMarketMechanism(task);
        if (active) {
            try { window.localStorage.setItem(ACTIVE_TASK_KEY, task.taskId); } catch (_) { /* 状态查询仍可继续。 */ }
        } else {
            closeTaskTracking();
            try { window.localStorage.removeItem(ACTIVE_TASK_KEY); } catch (_) { /* 无持久化不影响当前结果。 */ }
        }
    }

    async function readAPIError(response) {
        try {
            var body = await response.json();
            return body.message || body.detail || ("HTTP " + response.status);
        } catch (_) {
            return "HTTP " + response.status;
        }
    }

    async function refreshTask(taskID) {
        try {
            var response = await fetch("/api/loadtests/" + encodeURIComponent(taskID), { cache: "no-store" });
            if (!response.ok) {
                throw new Error(await readAPIError(response));
            }
            var task = await response.json();
            if (!selectedCode) {
                var taskMaterialCode = materialCodeForId(task.archiveId);
                if (taskMaterialCode) {
                    applySelectedMaterial(taskMaterialCode);
                }
            }
            if (experimentState.get().mode !== task.mode) {
                experimentState.set({ mode: task.mode, cacheTemperature: "cold" });
            }
            renderTask(task);
            return task;
        } catch (error) {
            byId("crowd-status-copy").textContent = "状态查询暂时中断，SSE 将自动重连：" + error.message;
            return null;
        }
    }

    function handleTaskEvent(event) {
        try {
            var data = JSON.parse(event.data);
            if (!activeTask || data.taskId !== activeTask.taskId) {
                return;
            }
            activeTask.status = data.status || activeTask.status;
            activeTask.elapsedSeconds = data.elapsedSeconds;
            activeTask.remainingSeconds = data.remainingSeconds;
            if (data.metrics) {
                activeTask.metrics = data.metrics;
            }
            renderTask(activeTask);
            if (data.type === "log" || data.type === "completed" || data.type === "failed" || data.type === "stopped") {
                refreshTask(data.taskId);
            }
        } catch (_) {
            refreshTask(activeTask.taskId);
        }
    }

    function connectTaskEvents(taskID) {
        if (!window.EventSource) {
            return;
        }
        if (crowdStream) {
            crowdStream.close();
        }
        crowdStream = new EventSource("/api/loadtests/" + encodeURIComponent(taskID) + "/events");
        ["task_started", "reset_completed", "loadtest_started", "progress", "metric", "log", "completed", "failed", "stopped"].forEach(function (type) {
            crowdStream.addEventListener(type, handleTaskEvent);
        });
        crowdStream.onerror = function () {
            if (activeTask && isTaskActive(activeTask)) {
                byId("crowd-status-copy").textContent = "实时连接正在重连，任务仍在 Runner 中继续。";
                refreshTask(taskID);
            }
        };
    }

    function startTaskPolling(taskID) {
        if (crowdPollTimer) {
            window.clearInterval(crowdPollTimer);
        }
        crowdPollTimer = window.setInterval(function () {
            if (!activeTask || isTaskActive(activeTask)) {
                refreshTask(taskID);
            }
        }, 2000);
    }

    async function enterCrowdLabView(handoff) {
        // 新保存的计划必须优先于页面里残留的已完成任务；它只负责转场，
        // 是否创建 Runner 任务必须由实验室内的显式开始按钮决定。
        var plan = handoff && !handoff.taskId ? handoff : null;
        var task = !plan && activeTask && activeTask.taskId ? activeTask : null;
        if (!selectedCode || (!task && !plan) || enteringCrowdLab) {
            return;
        }
        stopMarketPreview();
        enteringCrowdLab = true;
        // 当前实验条件进入的是观测现场，不是档案读取槽。此处只确认条件交接，
        // 不播放请求卷轴，也不复用单次查验的插卡/接受印章动画。
        setState("crowd_armed");
        document.body.classList.add("crowd-lab-handoff");
        byId("crowd-status-title").textContent = "实验条件已确认";
        byId("crowd-status-copy").textContent = task ?
            "正在进入实验室恢复任务观测。" :
            "正在进入实验室建立观测；Runner 尚未创建，没有请求发出。";
        byId("market-flow-status").textContent = task ? "恢复任务观测" : "等待实验室观测";
        byId("market-announcer").textContent = task ?
            "正在进入实验室恢复任务观测" :
            "实验条件已确认，正在进入实验室建立观测，当前没有真实请求";
        if (plan) {
            await animateTaskOrderHandoff(plan);
            byId("crowd-status-copy").textContent =
                "实验条件已确认；即将进入实验室建立观测，Runner 仍未创建。";
            byId("market-flow-status").textContent = "任务指令已送达";
        }
        document.body.classList.add("is-crowd-lab-departing");
        window.setTimeout(function () {
            var tier = task && task.tier || crowdTiers[crowdTierID];
            var finalMode = task && task.connectionMode || connectionMode;
            var query = "/lab?entry=crowd" +
                "&mode=" + encodeURIComponent(task && task.mode || "direct") +
                "&rate=" + encodeURIComponent(tier.rate) +
                "&connectionMode=" + encodeURIComponent(finalMode);
            if (task) {
                query += "&task=" + encodeURIComponent(task.taskId);
            }
            if (finalMode === "manual") {
                query += "&connections=" + encodeURIComponent(
                    task ? tier.connections : manualConnections);
            }
            window.location.assign(query);
        }, reducedMotion ? 40 : 340);
    }

    async function startCrowdTest() {
        if (!selectedCode || isTaskActive()) {
            return;
        }
        stopMarketPreview();
        setExperimentControlsLocked(true);
        byId("start-crowd-test").disabled = true;
        byId("start-crowd-test").textContent = "正在进入实验室";
        byId("crowd-status-title").textContent = "正在交接实验条件";
        byId("crowd-status-copy").textContent = "本次操作只保存当前条件并进入实验室，Runner 不会自动创建任务。";
        byId("crowd-connection-current").textContent = "尚未创建";
        byId("market-flow-status").textContent = "计划交接中";
        byId("market-mechanism").dataset.flowState = "planned";
        byId("market-mechanism").dataset.taskPhase = "planned";
        byId("market-mechanism").dataset.capacityState = "unknown";
        renderMarketLifecycle({ status: "submitting" });
        try {
            crowdTierID = "qps_1500";
            connectionMode = "manual";
            manualConnections = 500;
            var tier = crowdTiers[crowdTierID];
            var preview = matchingConnectionPlan();
            var plannedConnections = connectionMode === "manual" ?
                manualConnections : Number(preview && preview.connections || 0);
            var handoff = {
                taskId: "",
                entry: "crowd",
                launchWhenObserved: false,
                sharedConditions: true,
                materialName: materials[selectedCode].name,
                // 详情页不替用户选择运行路径；直接查询只是实验室打开时的默认选项。
                mode: "direct",
                cacheTemperature: "cold",
                tier: crowdTierID,
                expectedRate: tier.rate,
                connectionMode: connectionMode,
                connectionReason: preview && preview.reason || "",
                plannedConnections: plannedConnections,
                requestedConnections: connectionMode === "manual" ? manualConnections : 0,
                expectedDurationSeconds: tier.duration,
                armedAt: new Date().toISOString()
            };
            experimentResults.arm({
                taskId: handoff.taskId,
                entry: handoff.entry,
                launchWhenObserved: handoff.launchWhenObserved,
                sharedConditions: handoff.sharedConditions,
                materialName: handoff.materialName,
                mode: handoff.mode,
                cacheTemperature: handoff.cacheTemperature,
                tier: handoff.tier,
                expectedRate: handoff.expectedRate,
                connectionMode: handoff.connectionMode,
                connectionReason: handoff.connectionReason,
                plannedConnections: handoff.plannedConnections,
                requestedConnections: handoff.requestedConnections,
                expectedDurationSeconds: handoff.expectedDurationSeconds,
                armedAt: handoff.armedAt
            });
            enterCrowdLabView(handoff);
        } catch (error) {
            activeTask = null;
            setExperimentControlsLocked(false);
            byId("start-crowd-test").disabled = false;
            byId("start-crowd-test").textContent = "重新进入实验室";
            byId("crowd-status-title").textContent = "未能保存实验条件";
            byId("crowd-status-copy").textContent = error.message;
            byId("crowd-connection-current").textContent = "尚未创建";
            byId("market-flow-status").textContent = "计划交接失败";
            byId("market-mechanism").dataset.flowState = "failed";
            byId("market-mechanism").dataset.taskPhase = "failed";
            byId("market-mechanism").dataset.capacityState = "unknown";
            renderMarketLifecycle({ status: "failed" });
            showToast(error.message);
        }
    }

    function openCrowdMode() {
        if (!selectedCode || state !== "record_selected") {
            return;
        }
        activeTask = null;
        crowdTierID = "qps_1500";
        connectionMode = "manual";
        manualConnections = 500;
        enteringCrowdLab = false;
        marketPreviewSignature = "";
        setState("crowd_preparing");
        updateFoyerExperimentQuery("query");
        renderCrowdTier();
        renderCrowdShell();
        refreshConnectionPlan();
        byId("enter-crowd-lab").hidden = true;
        byId("start-crowd-test").focus({ preventScroll: true });
    }

    function renderPurchaseExplainer() {
        var explanation = purchasePathExplanations[purchaseExplainerMode];
        document.querySelectorAll("[data-purchase-explainer]").forEach(function (button) {
            var active = button.dataset.purchaseExplainer === purchaseExplainerMode;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        });
        byId("purchase-plan-preview-heading").textContent = "方案解说 · " + explanation.label;
        byId("purchase-plan-route-code").textContent = explanation.route;
        byId("purchase-plan-route-copy").textContent = explanation.copy;
    }

    function openPurchaseMode() {
        if (isTaskActive()) {
            showToast("查询潮汐仍在运行，请先结束当前任务再查看购买实验。");
            return;
        }
        if (state === "crowd_preparing") {
            leaveCrowdMode();
        }
        if (state === "dialogue") {
            openFeaturedMaterial();
        }
        if (!selectedCode || (state !== "record_selected" && state !== "purchase_preparing")) {
            return;
        }
        setState("purchase_preparing");
        updateFoyerExperimentQuery("purchase");
        renderPurchaseExplainer();
        byId("confirm-purchase-plan").focus({ preventScroll: true });
    }

    function selectPurchaseExplainer(mode) {
        if (state !== "purchase_preparing" || !purchasePathExplanations[mode]) {
            return;
        }
        purchaseExplainerMode = mode;
        renderPurchaseExplainer();
    }

    function leavePurchaseMode() {
        if (state !== "purchase_preparing") {
            return;
        }
        window.location.assign("/");
    }

    function beginNextMarketDraft() {
        if (!activeTask || isTaskActive(activeTask)) {
            return;
        }
        activeTask = null;
        crowdTierID = "qps_1500";
        connectionMode = "manual";
        manualConnections = 500;
        marketLastActiveStatus = "starting";
        marketPreviewSignature = "";
        setState("crowd_preparing");
        setExperimentControlsLocked(false);
        byId("start-crowd-test").disabled = false;
        byId("start-crowd-test").textContent = "进入查询实验室";
        byId("enter-crowd-lab").hidden = true;
        byId("crowd-connection-current").textContent = "尚未创建";
        byId("crowd-status-title").textContent = "实验条件待确认";
        byId("crowd-status-copy").textContent = "进入实验室后仍需手动开始，不会自动发送压测请求。";
        byId("crowd-clock").textContent = "00:00 / 00:30";
        byId("crowd-clock").hidden = true;
        byId("market-mechanism").dataset.faultLayer = "none";
    }

    async function copyCrowdCommand() {
        var command = byId("market-load-command").textContent;
        try {
            await navigator.clipboard.writeText(command);
        } catch (_) {
            var textarea = document.createElement("textarea");
            textarea.value = command;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            textarea.remove();
        }
        showToast("等价命令已复制");
        byId("market-announcer").textContent = "当前终端版本的等价压测命令已复制";
    }

    function leaveCrowdMode() {
        if (state !== "crowd_preparing" || isTaskActive()) {
            return;
        }
        window.location.assign("/");
    }

    async function restoreActiveTask() {
        var taskID = "";
        try { taskID = window.localStorage.getItem(ACTIVE_TASK_KEY) || ""; } catch (_) { /* 无存储时从正常入口启动。 */ }
        if (!taskID) {
            return;
        }
        // 先建立持续恢复，再读取首个快照；临时 GET 失败不能让已知任务永久失联。
        connectTaskEvents(taskID);
        startTaskPolling(taskID);
        var task = await refreshTask(taskID);
        if (!task || !isTaskActive(task)) {
            return;
        }
    }

    function enterPurchaseLabFromMarket() {
        if (!selectedCode || state !== "purchase_preparing") {
            return;
        }
        setState("entering_purchase_lab");
        byId("market-announcer").textContent =
            "正在前往" + materials[selectedCode].name + "购买实验室";
        window.setTimeout(function () {
            window.location.assign("/purchase-lab?intent=new");
        }, reducedMotion ? 0 : 180);
    }

    function bindEvents() {
        byId("start-crowd-test").addEventListener("click", startCrowdTest);
        byId("enter-crowd-lab").addEventListener("click", function () {
            enterCrowdLabView();
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-query-explainer]"), function (button) {
            button.addEventListener("click", function () {
                var mode = button.dataset.queryExplainer;
                if ((mode !== "direct" && mode !== "cached") || mode === queryExplainerMode) {
                    return;
                }
                queryExplainerMode = mode;
                renderQueryExplainer();
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-crowd-shell]"), function (button) {
            button.addEventListener("click", function () {
                var nextShell = button.dataset.crowdShell;
                if (!crowdShells[nextShell] || nextShell === crowdShell) {
                    return;
                }
                crowdShell = nextShell;
                renderCrowdShell();
            });
        });
        byId("copy-market-command").addEventListener("click", copyCrowdCommand);
        byId("leave-crowd-mode").addEventListener("click", leaveCrowdMode);
        document.querySelectorAll("[data-purchase-explainer]").forEach(function (button) {
            button.addEventListener("click", function () {
                selectPurchaseExplainer(button.dataset.purchaseExplainer);
            });
        });
        byId("confirm-purchase-plan").addEventListener("click", enterPurchaseLabFromMarket);
        byId("leave-purchase-mode").addEventListener("click", leavePurchaseMode);
    }

    document.addEventListener("DOMContentLoaded", function () {
        startWorldEntrance();
        bindEvents();
        renderExperimentState(experimentState.get());
        renderQueryExplainer();
        experimentState.subscribe(renderExperimentState);
        var requestedExperiment = incomingFoyerExperiment();
        restoreActiveTask().then(function () {
            if (requestedExperiment === "purchase" && !isTaskActive()) {
                openPurchaseMode();
            } else if (requestedExperiment === "query" && !isTaskActive()) {
                openFeaturedMaterial();
                openCrowdMode();
            }
        }, function () {
            if (requestedExperiment === "purchase" && !isTaskActive()) {
                openPurchaseMode();
            } else if (requestedExperiment === "query" && !isTaskActive()) {
                openFeaturedMaterial();
                openCrowdMode();
            }
        });
    });

    // 浏览器返回可能直接恢复 BFCache；解除上次离场时的防重复导航锁，
    // 让用户能够从已完成结果真正创建下一轮任务。
    window.addEventListener("pageshow", function (event) {
        enteringCrowdLab = false;
        document.body.classList.remove("crowd-lab-handoff", "is-crowd-lab-departing");
        if (event.persisted) {
            closeTaskTracking();
            if (state === "entering_purchase_lab") {
                setState("purchase_preparing");
                renderPurchasePlan();
            }
            restoreActiveTask();
        }
    });
    window.addEventListener("beforeunload", closeTaskTracking);
}());
