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
    var state = "arrival";
    var selectedCode = null;
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var crowdStream = null;
    var crowdPollTimer = null;
    var activeTask = null;
    var enteringCrowdLab = false;
    var ACTIVE_TASK_KEY = "silas.cache-aside.active-loadtest.v1";
    // ID 是前端唯一提交给后端的压力参数；数值只用于展示和生成等价调试命令。
    var crowdTiers = Object.freeze({
        visitors: Object.freeze({ label: "零星访客", rate: 100, connections: 16, duration: 20, visibleFigures: 3 }),
        tide_eve: Object.freeze({ label: "潮汐前夜", rate: 500, connections: 32, duration: 20, visibleFigures: 9 }),
        crowd: Object.freeze({ label: "人潮涌入", rate: 1500, connections: 64, duration: 20, visibleFigures: 19 }),
        boiling_city: Object.freeze({ label: "王城沸腾", rate: 3000, connections: 96, duration: 20, visibleFigures: 30 })
    });
    var crowdShells = Object.freeze({
        powershell: Object.freeze({ label: "PowerShell 5.1+" }),
        bash: Object.freeze({ label: "Bash / WSL" })
    });
    var crowdTierID = "tide_eve";
    var crowdShell = "powershell";

    function byId(id) {
        return document.getElementById(id);
    }

    function setState(next) {
        state = next;
        document.body.dataset.eventState = next;
        var labels = {
            arrival: "抵达",
            dialogue: "交谈",
            choosing: "选择材料",
            record_selected: "取得档案片",
            crowd_preparing: "召集人潮",
            crowd_submitting: "请求投递",
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
        var loadCommand = "docker compose --profile loadtest run --rm --no-deps " +
            "-e RATE=" + tier.rate + " -e DURATION=" + tier.duration + "s -e THREADS=1 -e CONNECTIONS=" + tier.connections + " " +
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
        var cached = next.mode === "cached";
        var directButton = byId("roof-mode-direct");
        var cachedButton = byId("roof-mode-cached");
        directButton.classList.toggle("is-active", !cached);
        cachedButton.classList.toggle("is-active", cached);
        directButton.setAttribute("aria-pressed", cached ? "false" : "true");
        cachedButton.setAttribute("aria-pressed", cached ? "true" : "false");
        byId("roof-cache-settings").hidden = !cached;
        Array.prototype.forEach.call(document.querySelectorAll("[name='cache-temperature']"), function (radio) {
            radio.checked = radio.value === next.cacheTemperature;
        });
        byId("roof-strategy-summary").textContent = cached ?
            "当前：Redis Cache-Aside · " + (next.cacheTemperature === "cold" ? "冷缓存" : "热缓存") :
            "当前：MySQL Direct";

        if (selectedCode && state === "crowd_preparing" && !isTaskActive()) {
            renderCrowdTier();
        }
    }

    function renderCrowdTier() {
        var tier = crowdTiers[crowdTierID] || crowdTiers.tide_eve;
        if (!crowdTiers[crowdTierID]) {
            crowdTierID = "tide_eve";
        }
        Array.prototype.forEach.call(document.querySelectorAll("[data-crowd-tier]"), function (button) {
            var active = button.dataset.crowdTier === crowdTierID;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
        byId("crowd-size-value").textContent = tier.label + " · " + tier.rate.toLocaleString("zh-CN") +
            " req/s · " + tier.connections + " 连接";
        byId("crowd-size-note").textContent = "固定运行 " + tier.duration +
            " 秒；批量实验会先重置数据，参数由 Runner 白名单决定。";
        if (selectedCode) {
            byId("market-load-command").textContent = crowdCommand();
        }

        Array.prototype.forEach.call(byId("crowd-queue").children, function (figure, index) {
            figure.classList.toggle("is-visible", index < tier.visibleFigures);
        });

        if (state === "crowd_preparing" && !activeTask) {
            byId("crowd-status-copy").textContent = tier.label + "已就绪，点击后由页面直接启动实验。";
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
        ["roof-mode-direct", "roof-mode-cached", "choose-again", "single-request", "leave-crowd-mode"].forEach(function (id) {
            byId(id).disabled = locked;
        });
        Array.prototype.forEach.call(document.querySelectorAll("[name='cache-temperature'], [data-crowd-tier]"), function (control) {
            control.disabled = locked;
        });
    }

    function formatClock(seconds) {
        var safe = Math.max(0, Number(seconds || 0));
        return String(Math.floor(safe / 60)).padStart(2, "0") + ":" + String(safe % 60).padStart(2, "0");
    }

    function renderTask(task) {
        activeTask = task;
        if (task.tier && task.tier.id && crowdTiers[task.tier.id]) {
            crowdTierID = task.tier.id;
            renderCrowdTier();
        }
        var active = isTaskActive(task);
        var titles = {
            starting: "准备实验",
            resetting: "正在重置数据",
            running: "人潮正在涌入",
            collecting: "正在收集结果",
            completed: "实验已完成",
            failed: "实验失败",
            stopped: "实验已停止"
        };
        var copies = {
            starting: "委托已受理，正在打开通往店内实验室的门。",
            resetting: "店内正在清理上一轮记录。",
            running: "人潮已经进入店内，完整指标在实验室中展示。",
            collecting: "店内正在整理本轮记录。",
            completed: "本轮记录已整理完成，可进入店内查看。",
            failed: task.errorMessage || "实验未能完成，可进入店内查看原因。",
            stopped: "本轮人潮已经停止。"
        };
        setState(active ? "crowd_submitting" : "crowd_preparing");
        setExperimentControlsLocked(active);
        byId("start-crowd-test").disabled = active;
        byId("start-crowd-test").textContent = active ? "人潮正在涌入" : (task.status === "completed" ? "再次召集人潮" : "召集人潮");
        byId("enter-crowd-lab").hidden = !task.taskId;
        byId("enter-crowd-lab").textContent = active ? "进入店内查看" : "进入店内查看结果";
        byId("crowd-status-title").textContent = titles[task.status] || "等待召集";
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
        byId("market-announcer").textContent = "人潮已受理，正在跟随请求进入材料情报店";
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
        byId("start-crowd-test").textContent = "人潮正在涌入";
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
                    tier: crowdTierID
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
            byId("start-crowd-test").textContent = "召集人潮";
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

    function enterLab() {
        if (!selectedCode || state !== "record_selected") {
            return;
        }
        setState("inserting_record");
        byId("market-announcer").textContent = selectedCode + " 档案片正在插入检索槽";
        animateRecordIntoSlot();

        window.setTimeout(function () {
            setState("entering_lab");
            byId("accepted-stamp").setAttribute("aria-hidden", "false");
            byId("market-announcer").textContent = "档案片已接受，正在进入机器内部";
            window.setTimeout(function () {
                window.location.assign("/lab?material=" + encodeURIComponent(selectedCode) + "&entry=single");
            }, reducedMotion ? 80 : 820);
        }, reducedMotion ? 40 : 700);
    }

    function bindEvents() {
        byId("show-materials").addEventListener("click", function () {
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
        byId("single-request").addEventListener("click", enterLab);
        byId("crowd-test").addEventListener("click", openCrowdMode);
        byId("start-crowd-test").addEventListener("click", startCrowdTest);
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
        byId("roof-mode-direct").addEventListener("click", function () {
            if (!isTaskActive()) {
                experimentState.set({ mode: "direct" });
            }
        });
        byId("roof-mode-cached").addEventListener("click", function () {
            if (!isTaskActive()) {
                experimentState.set({ mode: "cached" });
            }
        });
        Array.prototype.forEach.call(document.querySelectorAll("[name='cache-temperature']"), function (radio) {
            radio.addEventListener("change", function () {
                if (radio.checked && !isTaskActive()) {
                    experimentState.set({ cacheTemperature: radio.value });
                }
            });
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        bindEvents();
        renderExperimentState(experimentState.get());
        experimentState.subscribe(renderExperimentState);
        restoreActiveTask();
        window.setTimeout(function () {
            if (state === "arrival") {
                setState("dialogue");
                byId("show-materials").focus({ preventScroll: true });
            }
        }, reducedMotion ? 80 : 480);
    });

    window.addEventListener("beforeunload", closeTaskTracking);
}());
