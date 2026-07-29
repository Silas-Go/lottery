(function () {
    "use strict";

    var STORAGE_KEY = "silas.cache-aside.material-id";
    var experimentState = window.SilasExperimentState;
    var experimentResults = window.SilasExperimentResults;
    var materials = {
        "ARC-001": { name: "月盐", sigil: "Ⅰ", kind: "salt" },
        "ARC-002": { name: "雾银", sigil: "Ⅱ", kind: "silver" },
        "ARC-003": { name: "龙息琥珀", sigil: "Ⅲ", kind: "amber" },
        "ARC-004": { name: "星髓", sigil: "Ⅳ", kind: "star" }
    };
    var state = "dialogue";
    var selectedCode = null;
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var crowdStream = null;
    var crowdPollTimer = null;
    var activeTask = null;
    var enteringCrowdLab = false;
    var ACTIVE_TASK_KEY = "silas.cache-aside.active-loadtest.v1";
    var WORLD_TRANSITION_KEY = "silas.world-transition.v1";
    var arrivingFromStreet = false;
    // 查询潮汐描述计划 QPS，不代表人数；通路数量描述 wrk2 保持的 HTTP 连接。
    // 前端只提交白名单速率与通路模式，Runner 仍会再次校验并解析最终连接数。
    var crowdTiers = Object.freeze({
        qps_100: Object.freeze({ label: "涓流", rate: 100, duration: 30 }),
        qps_300: Object.freeze({ label: "涟漪", rate: 300, duration: 30 }),
        qps_800: Object.freeze({ label: "浪潮", rate: 800, duration: 30 }),
        qps_1500: Object.freeze({ label: "满潮", rate: 1500, duration: 30 })
    });
    var allowedConnections = Object.freeze([70, 140, 300, 500]);
    var crowdShells = Object.freeze({
        powershell: Object.freeze({ label: "PowerShell 5.1+" }),
        bash: Object.freeze({ label: "Bash / WSL" })
    });
    var crowdTierID = "qps_1500";
    var connectionMode = "auto";
    var manualConnections = 300;
    var crowdShell = "powershell";

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
        if (!arrivingFromStreet || reducedMotion) {
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
        var labels = {
            arrival: "抵达",
            dialogue: "交谈",
            choosing: "选择材料",
            record_selected: "取得档案片",
            crowd_preparing: "配置查询潮汐",
            crowd_submitting: "卷轴投递",
            inserting_record: "插入档案片",
            entering_lab: "进入机器内部"
        };
        byId("event-step").textContent = labels[next] || "事件";
    }

    function rememberMaterial(code) {
        try {
            window.sessionStorage.setItem(STORAGE_KEY, code);
        } catch (_) {
            // URL 仍会携带材料编号，禁用存储不会阻断流程。
        }
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
        return selectedCode ? Number(selectedCode.slice(-3)) : 0;
    }

    function crowdCommand() {
        var experiment = experimentState.get();
        var tier = crowdTiers[crowdTierID];
        var path = experiment.mode === "cached" ? "cached" : "direct";
        if (connectionMode === "auto") {
            return "# 自动配置会读取 Runner 保存的真实响应历史，并在任务创建时确定 CONNECTIONS。\n" +
                "# 启动后可在实验室查看本轮实际使用的魔法通路数量。";
        }
        var loadCommand = "docker compose --profile loadtest run --rm --no-deps " +
            "-e RATE=" + tier.rate + " -e DURATION=" + tier.duration + "s -e THREADS=1 -e CONNECTIONS=" + manualConnections + " " +
            "-e TARGET_URL=http://app:5678/api/archives/" + materialNumericId() + "/" + path + " " +
            "-e SCRIPT=/opt/wrk2/scripts/read.lua wrk2";
        if (crowdShell === "powershell") {
            return "$ErrorActionPreference = \"Stop\"\n" +
                "Invoke-WebRequest -UseBasicParsing -Method Post " +
                "-Uri \"http://localhost:5678/api/chapters/cache-aside/reset\" | Out-Null\n" +
                loadCommand;
        }
        return "curl -fsS -X POST http://localhost:5678/api/chapters/cache-aside/reset >/dev/null && " + loadCommand;
    }

    function renderExperimentState(next) {
        if (selectedCode && state === "crowd_preparing" && !isTaskActive()) {
            renderCrowdTier();
        }
    }

    function renderCrowdTier() {
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        if (!crowdTiers[crowdTierID]) {
            crowdTierID = "qps_1500";
        }
        Array.prototype.forEach.call(document.querySelectorAll("[data-crowd-tier]"), function (button) {
            var active = button.dataset.crowdTier === crowdTierID;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-connection-mode]"), function (button) {
            var active = button.dataset.connectionMode === connectionMode;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
        var manualPanel = byId("manual-conduit-options");
        manualPanel.hidden = connectionMode !== "manual";
        Array.prototype.forEach.call(document.querySelectorAll("[data-connection-count]"), function (button) {
            var active = Number(button.dataset.connectionCount) === manualConnections;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
        var conduitText = connectionMode === "auto" ? "通路自动配置" : manualConnections + " 条通路";
        byId("crowd-size-value").textContent = "查询潮汐 " + tier.rate.toLocaleString("zh-CN") +
            " 卷轴/秒 · " + conduitText;
        byId("market-conduit-count").textContent = connectionMode === "auto" ? "自动配置" : manualConnections + " 条";
        byId("crowd-size-note").textContent = connectionMode === "auto" ?
            "固定运行 " + tier.duration + " 秒；Runner 会依据目标 QPS 与历史实际响应时间选择足够通路。" :
            "固定运行 " + tier.duration + " 秒；手动通路用于观察响应变慢时卷轴如何在入口形成发送欠账。";
        if (selectedCode) {
            byId("market-load-command").textContent = crowdCommand();
        }

        if (state === "crowd_preparing" && !activeTask) {
            byId("crowd-status-title").textContent = tier.label + "查询潮汐已配置";
            byId("crowd-status-copy").textContent = "带查询卷轴进入实验室，再选择 MySQL 或 Redis 路径。";
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
            ticket.textContent = selectedCode || "ARC-???";
        });
    }

    function applySelectedMaterial(code) {
        var material = materials[code];
        if (!material) {
            return;
        }
        selectedCode = code;
        byId("record-code").textContent = code;
        byId("record-name").textContent = material.name;
        byId("record-sigil").textContent = material.sigil;
        byId("record-card").dataset.kind = material.kind;
        byId("accepted-material").textContent = code + " · " + material.name;
        updateCrowdTicketCodes();
        rememberMaterial(code);
    }

    function selectMaterial(code) {
        if (state !== "choosing") {
            return;
        }
        applySelectedMaterial(code);
        setState("record_selected");
        byId("single-request").focus({ preventScroll: true });
    }

    function animateRecordIntoSlot() {
        var card = byId("record-card");
        var slot = byId("archive-slot");
        var start = card.getBoundingClientRect();
        var end = slot.getBoundingClientRect();
        var clone = card.cloneNode(true);
        var targetScale = Math.max(0.18, Math.min(0.42, end.width / start.width));

        clone.removeAttribute("id");
        Array.prototype.forEach.call(clone.querySelectorAll("[id]"), function (element) {
            element.removeAttribute("id");
        });
        clone.classList.add("record-card-flight");
        clone.style.left = start.left + "px";
        clone.style.top = start.top + "px";
        clone.style.width = start.width + "px";
        clone.style.height = start.height + "px";
        document.body.appendChild(clone);

        var x = end.left + end.width / 2 - (start.left + start.width / 2);
        var y = end.top + end.height / 2 - (start.top + start.height / 2);
        var duration = reducedMotion ? 1 : 620;
        var animation = clone.animate([
            { transform: "translate(0, 0) scale(1)", opacity: 1, filter: "brightness(1)" },
            { transform: "translate(" + (x * 0.72) + "px, " + (y * 0.72 - 18) + "px) scale(.72)", opacity: 1, filter: "brightness(1.08)" },
            { transform: "translate(" + x + "px, " + y + "px) scale(" + targetScale + ")", opacity: .15, filter: "brightness(1.8) blur(1px)" }
        ], {
            duration: duration,
            easing: "cubic-bezier(.34,.74,.22,1)",
            fill: "forwards"
        });
        animation.finished.finally(function () {
            clone.remove();
        });
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
        ["choose-again", "single-request", "leave-crowd-mode"].forEach(function (id) {
            byId(id).disabled = locked;
        });
        Array.prototype.forEach.call(document.querySelectorAll(
            "[data-crowd-tier], [data-connection-mode], [data-connection-count]"), function (control) {
            control.disabled = locked;
        });
    }

    function formatClock(seconds) {
        var safe = Math.max(0, Number(seconds || 0));
        return String(Math.floor(safe / 60)).padStart(2, "0") + ":" + String(safe % 60).padStart(2, "0");
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
            if (legacyProtocol || !matchingTier) {
                byId("crowd-size-value").textContent = "兼容旧任务 · " +
                    Number(task.tier.rate).toLocaleString("zh-CN") + " 卷轴/秒 · " +
                    Number(task.tier.connections || 0).toLocaleString("zh-CN") + " 条旧固定通路";
                byId("crowd-size-note").textContent =
                    "这是升级前已经启动的任务；完成查看后请重新选择新查询潮汐与通路模式。";
            }
            byId("market-conduit-count").textContent = Number(task.tier.connections || 0) > 0 ?
                Number(task.tier.connections).toLocaleString("zh-CN") + " 条" : "自动配置";
        }
        var active = isTaskActive(task);
        var titles = {
            starting: "准备实验",
            resetting: "正在重置数据",
            running: "查询卷轴正在投递",
            collecting: "正在收集结果",
            completed: "实验已完成",
            failed: "实验失败",
            stopped: "实验已停止"
        };
        var copies = {
            starting: "委托已受理，正在打开通往店内实验室的门。",
            resetting: "店内正在清理上一轮记录。",
            running: "法师公会持续生成卷轴；完整的通路周转与入口积压在实验室中展示。",
            collecting: "店内正在整理本轮记录。",
            completed: "本轮记录已整理完成，可进入店内查看。",
            failed: task.errorMessage || "实验未能完成，可进入店内查看原因。",
            stopped: "本轮查询潮汐已经停止。"
        };
        setState(task.status === "running" ? "crowd_submitting" : "crowd_preparing");
        setExperimentControlsLocked(active);
        byId("start-crowd-test").disabled = active;
        var activeButtonCopy = task.status === "running" ? "查询卷轴正在投递" :
            (task.status === "collecting" ? "正在结算查询潮汐" : "正在准备查询潮汐");
        byId("start-crowd-test").textContent = active ? activeButtonCopy :
            (task.status === "completed" ? "再次配置查询潮汐" : "配置查询潮汐");
        byId("enter-crowd-lab").hidden = !task.taskId;
        byId("enter-crowd-lab").textContent = active ? "进入店内查看" : "进入店内查看结果";
        byId("crowd-status-title").textContent = titles[task.status] || "等待查询潮汐";
        byId("crowd-status-copy").textContent = copies[task.status] || "任务状态正在同步。";
        byId("crowd-clock").textContent = formatClock(task.elapsedSeconds) + " / " +
            formatClock((task.elapsedSeconds || 0) + (task.remainingSeconds || 0));
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
                applySelectedMaterial("ARC-" + String(task.archiveId).padStart(3, "0"));
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
            if (activeTask && isTaskActive(activeTask)) {
                refreshTask(taskID);
            }
        }, 2000);
    }

    function enterCrowdLabView() {
        if (!selectedCode || !activeTask || !activeTask.taskId || enteringCrowdLab) {
            return;
        }
        enteringCrowdLab = true;
        setState("crowd_submitting");
        byId("crowd-status-title").textContent = "正在进入材料情报店";
        byId("crowd-status-copy").textContent = "请求档案已经进入槽口，完整实验将在店内继续。";
        byId("market-announcer").textContent = "查询潮汐已受理，正在跟随卷轴进入材料情报店";
        animateRecordIntoSlot();
        window.setTimeout(function () {
            setState("entering_lab");
            byId("accepted-stamp").setAttribute("aria-hidden", "false");
            window.setTimeout(function () {
                window.location.assign("/lab?material=" + encodeURIComponent(selectedCode) +
                    "&entry=crowd&task=" + encodeURIComponent(activeTask.taskId));
            }, reducedMotion ? 40 : 260);
        }, reducedMotion ? 40 : 420);
    }

    async function startCrowdTest() {
        if (!selectedCode || isTaskActive()) {
            return;
        }
        var experiment = experimentState.get();
        setExperimentControlsLocked(true);
        byId("start-crowd-test").disabled = true;
        byId("start-crowd-test").textContent = "查询卷轴正在投递";
        byId("crowd-status-title").textContent = "准备实验";
        byId("crowd-status-copy").textContent = "正在向本地 Runner 创建受控任务。";
        try {
            var response = await fetch("/api/loadtests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    experiment: "cache-aside-read",
                    archiveId: materialNumericId(),
                    mode: experiment.mode,
                    rate: crowdTiers[crowdTierID].rate,
                    connectionMode: connectionMode,
                    connections: connectionMode === "manual" ? manualConnections : 0
                })
            });
            if (!response.ok) {
                throw new Error(await readAPIError(response));
            }
            var created = await response.json();
            activeTask = {
                taskId: created.taskId,
                status: created.status,
                elapsedSeconds: 0,
                remainingSeconds: crowdTiers[crowdTierID].duration,
                metrics: {},
                logs: [{ level: "info", message: "准备实验" }]
            };
            var tier = crowdTiers[crowdTierID];
            experimentResults.arm({
                taskId: created.taskId,
                entry: "crowd",
                materialCode: selectedCode,
                materialName: materials[selectedCode].name,
                mode: experiment.mode,
                cacheTemperature: "cold",
                tier: crowdTierID,
                expectedRate: tier.rate,
                connectionMode: connectionMode,
                requestedConnections: connectionMode === "manual" ? manualConnections : 0,
                expectedDurationSeconds: tier.duration,
                armedAt: new Date().toISOString()
            });
            renderTask(activeTask);
            connectTaskEvents(created.taskId);
            startTaskPolling(created.taskId);
            enterCrowdLabView();
        } catch (error) {
            activeTask = null;
            setExperimentControlsLocked(false);
            byId("start-crowd-test").disabled = false;
            byId("start-crowd-test").textContent = "配置查询潮汐";
            byId("crowd-status-title").textContent = "未能启动实验";
            byId("crowd-status-copy").textContent = error.message;
            showToast(error.message);
        }
    }

    function openCrowdMode() {
        if (!selectedCode || state !== "record_selected") {
            return;
        }
        activeTask = null;
        enteringCrowdLab = false;
        setState("crowd_preparing");
        renderCrowdTier();
        renderCrowdShell();
        byId("enter-crowd-lab").hidden = true;
        byId("start-crowd-test").focus({ preventScroll: true });
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
        activeTask = null;
        setState("record_selected");
        byId("crowd-test").focus({ preventScroll: true });
    }

    async function restoreActiveTask() {
        var taskID = "";
        try { taskID = window.localStorage.getItem(ACTIVE_TASK_KEY) || ""; } catch (_) { /* 无存储时从正常入口启动。 */ }
        if (!taskID) {
            return;
        }
        var task = await refreshTask(taskID);
        if (!task || !isTaskActive(task)) {
            return;
        }
        setState("crowd_submitting");
        connectTaskEvents(taskID);
        startTaskPolling(taskID);
    }

    async function prepareStarMarrow(button, busyLabel, idleLabel) {
        if (state !== "dialogue") {
            return false;
        }
        button.disabled = true;
        button.textContent = busyLabel;
        try {
            var response = await fetch("/api/purchase-lab/4/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}"
            });
            if (!response.ok) {
                throw new Error(await readAPIError(response));
            }
            setState("choosing");
            selectMaterial("ARC-004");
            showToast("星髓首发库存已真实重置为 100 份");
            return true;
        } catch (error) {
            showToast(error.message, "danger");
            return false;
        } finally {
            button.disabled = false;
            button.textContent = idleLabel;
        }
    }

    function enterLab(entryMode) {
        var nextEntry = entryMode === "crowd-setup" ? "crowd-setup" : "single";
        var canEnter = state === "record_selected" ||
            (nextEntry === "crowd-setup" && state === "crowd_preparing");
        if (!selectedCode || !canEnter) {
            return;
        }
        var tier = crowdTiers[crowdTierID] || crowdTiers.qps_1500;
        var tierQuery = nextEntry === "crowd-setup" ?
            "&rate=" + encodeURIComponent(tier.rate) +
            "&connectionMode=" + encodeURIComponent(connectionMode) +
            (connectionMode === "manual" ? "&connections=" + encodeURIComponent(manualConnections) : "") : "";
        setState("inserting_record");
        byId("market-announcer").textContent = selectedCode + " 档案片正在插入检索槽";
        animateRecordIntoSlot();

        window.setTimeout(function () {
            setState("entering_lab");
            byId("accepted-stamp").setAttribute("aria-hidden", "false");
            byId("market-announcer").textContent = "档案片已接受，正在进入机器内部";
            window.setTimeout(function () {
                window.location.assign("/lab?material=" + encodeURIComponent(selectedCode) +
                    "&entry=" + nextEntry + tierQuery);
            }, reducedMotion ? 80 : 820);
        }, reducedMotion ? 40 : 700);
    }

    function bindEvents() {
        byId("show-materials").addEventListener("click", async function () {
            await prepareStarMarrow(byId("show-materials"), "正在开启档案…", "独自查验");
        });

        byId("star-crowd-entry").addEventListener("click", async function () {
            var button = byId("star-crowd-entry");
            if (await prepareStarMarrow(button, "正在配置潮汐…", "配置查询潮汐")) {
                openCrowdMode();
            }
        });

        byId("browse-materials").addEventListener("click", function () {
            if (state !== "dialogue") {
                return;
            }
            setState("choosing");
            var first = document.querySelector("[data-material]");
            if (first) {
                first.focus({ preventScroll: true });
            }
        });

        Array.prototype.forEach.call(document.querySelectorAll("[data-material]"), function (button) {
            button.addEventListener("click", function () {
                selectMaterial(button.dataset.material);
            });
        });

        byId("choose-again").addEventListener("click", function () {
            if ((state !== "record_selected" && state !== "crowd_preparing") || isTaskActive()) {
                return;
            }
            experimentResults.clearPending();
            closeTaskTracking();
            activeTask = null;
            selectedCode = null;
            setState("choosing");
            document.querySelector("[data-material]").focus({ preventScroll: true });
        });
        byId("single-request").addEventListener("click", function () { enterLab("single"); });
        byId("crowd-test").addEventListener("click", openCrowdMode);
        byId("start-crowd-test").addEventListener("click", function () { enterLab("crowd-setup"); });
        byId("enter-crowd-lab").addEventListener("click", enterCrowdLabView);
        Array.prototype.forEach.call(document.querySelectorAll("[data-crowd-tier]"), function (button) {
            button.addEventListener("click", function () {
                var nextTier = button.dataset.crowdTier;
                if (isTaskActive() || !crowdTiers[nextTier] || nextTier === crowdTierID) {
                    return;
                }
                crowdTierID = nextTier;
                renderCrowdTier();
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-connection-mode]"), function (button) {
            button.addEventListener("click", function () {
                if (isTaskActive() || (button.dataset.connectionMode !== "auto" &&
                    button.dataset.connectionMode !== "manual")) {
                    return;
                }
                connectionMode = button.dataset.connectionMode;
                renderCrowdTier();
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll("[data-connection-count]"), function (button) {
            button.addEventListener("click", function () {
                var nextConnections = Number(button.dataset.connectionCount);
                if (isTaskActive() || allowedConnections.indexOf(nextConnections) < 0) {
                    return;
                }
                manualConnections = nextConnections;
                connectionMode = "manual";
                renderCrowdTier();
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
    }

    document.addEventListener("DOMContentLoaded", function () {
        startWorldEntrance();
        bindEvents();
        renderExperimentState(experimentState.get());
        experimentState.subscribe(renderExperimentState);
        restoreActiveTask();
    });

    window.addEventListener("beforeunload", closeTaskTracking);
}());
