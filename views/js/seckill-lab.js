(function () {
    "use strict";

    var MATERIAL_STORAGE_KEY = "silas.cache-aside.material-id";

    var state = {
        archives: [],
        selectedId: null,
        entrySelectedId: null,
        cameraView: "internal",
        mode: "direct",
        rate: 300,
        connections: 96,
        duration: "20s",
        snapshot: null,
        previousArchiveRead: null,
        stream: null,
        pollTimer: null,
        waitingMode: null,
        routeTimeline: null,
        ttlTween: null,
        numberFrames: {},
        drawerTrigger: null,
        readModelArchive: null,
        isQuerying: false,
        isReplaying: false,
        lastRead: null,
        manualReplayGuard: null,
        terminalState: "idle",
        terminalBeforeSelecting: "idle",
        terminalTransitionTimer: null,
        terminalCapsuleTimer: null,
        sceneState: "idle",
        sceneTimeline: null,
        sceneIntroPlayed: false,
        sceneWaitingForTraffic: false,
        sceneLastTraffic: null,
        pendingSceneRoute: null,
        reducedMotion: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    };

    var materialThemes = {
        1: {
            code: "MOON SALT",
            name: "月盐",
            rarity: "COMMON · 常见",
            title: "低温炼成中的稳定介质",
            sigil: "Ⅰ",
            accent: "#78a7bd",
            rgb: "120, 167, 189",
            kind: "salt",
            origin: "霜潮盐沼",
            attribute: "低温稳定 · 吸热",
            usage: "炼成介质与温控缓冲",
            risk: "过量使用会造成局部低温脆化。",
            hint: "潮水退去后留下的苍白结晶，据说能稳定失控的热量。",
            summary: "灰白色细晶，能吸收炼成反应中多余的热量。属性稳定、读取频繁，适合作为详情读取基线。",
            note: "材料主题只用于展示；真实请求仍读取同一个后端 archive 对象。"
        },
        2: {
            code: "MIST SILVER",
            name: "雾银",
            rarity: "RARE · 稀有",
            title: "会折射魔力波动的液态金属",
            sigil: "Ⅱ",
            accent: "#65c7c0",
            rgb: "101, 199, 192",
            kind: "silver",
            origin: "雾海银脉",
            attribute: "折射 · 液态金属",
            usage: "镜面术式与感应组件",
            risk: "强魔力场中形态不稳定，需隔离保存。",
            hint: "只在晨雾最浓时显露轮廓的轻质金属。",
            summary: "常温下呈流动银雾，接触能量后形成短暂镜面。详情变化缓慢，适合使用短 TTL 缓存。",
            note: "Redis 保存可丢弃副本，MySQL 仍是权威数据源。"
        },
        3: {
            code: "DRAGON AMBER",
            name: "龙息琥珀",
            rarity: "EPIC · 史诗",
            title: "封存高温能量的燃烧晶体",
            sigil: "Ⅲ",
            accent: "#e88b56",
            rgb: "232, 139, 86",
            kind: "amber",
            origin: "赤脊火山带",
            attribute: "高温封存 · 持续放能",
            usage: "动力核心与耐热封装",
            risk: "高温或撞击可能触发能量泄漏。",
            hint: "内部封存着微弱灼热反应的古老树脂。",
            summary: "琥珀内部保持稳定的橙红核心。一次真实查询与一千次重复查询返回完全相同的详情。",
            note: "重复读取应该离开 MySQL 热路径。"
        },
        4: {
            code: "STAR MARROW",
            name: "星髓",
            rarity: "LEGENDARY · 传说",
            title: "从坠落星核中分离出的高密度结晶",
            sigil: "Ⅳ",
            accent: "#d9a55d",
            rgb: "217, 165, 93",
            kind: "star",
            origin: "坠星盆地",
            attribute: "高密度魔力 · 星光迁移",
            usage: "高阶炼成与能量校准",
            risk: "高密度魔力会干扰未经屏蔽的仪器。",
            hint: "从坠星残核中分离出的高密度结晶。",
            summary: "深色晶体内部有细小光点持续迁移。它是本实验的默认材料，但不会改变任何缓存或库存语义。",
            note: "缓存的是材料详情，不是材料库存与归属。"
        }
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function formatNumber(value) {
        return Number(value || 0).toLocaleString("zh-CN");
    }

    function wait(ms) {
        return new Promise(function (resolve) {
            window.setTimeout(resolve, ms);
        });
    }

    function showToast(message, tone) {
        var toast = byId("story-toast");
        toast.textContent = message;
        toast.className = "lab-toast is-visible " + (tone || "");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(function () {
            toast.classList.remove("is-visible");
        }, 2600);
    }

    function sceneIntroIsRunning() {
        return state.sceneState === "crowd_arriving" ||
            state.sceneState === "tickets_submitting" ||
            state.sceneState === "entering_machine";
    }

    function setCameraView(view, announce) {
        view = view === "exterior" ? "exterior" : "internal";
        state.cameraView = view;
        byId("architecture-canvas").dataset.cameraView = view;
        ["exterior", "internal"].forEach(function (name) {
            var active = name === view;
            var button = byId("camera-" + name);
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
        if (announce) {
            showToast(view === "exterior" ?
                "已切换到外景视角：观察访客和查询凭证。" :
                "已切换到内部视角：观察真实数据处理路径。", "success");
        }
    }

    function syncSceneControls() {
        var introRunning = sceneIntroIsRunning();
        var hasMaterial = Boolean(state.selectedId);
        byId("copy-command").disabled = introRunning || !hasMaterial;
        byId("read-again").disabled = introRunning || !hasMaterial || state.isQuerying || state.isReplaying;
        byId("terminal-read-again").disabled = introRunning || !hasMaterial || state.isQuerying || state.isReplaying;
        byId("start-direct").disabled = introRunning || state.isQuerying || state.isReplaying;
        byId("start-cached").disabled = introRunning || state.isQuerying || state.isReplaying;
        byId("camera-exterior").disabled = introRunning;
        byId("camera-internal").disabled = introRunning;
    }

    function updateSceneTicketCode() {
        var archive = selectedArchive();
        var code = archive ? "ARC-" + String(archive.id).padStart(3, "0") : "ARC-???";
        Array.prototype.forEach.call(document.querySelectorAll("[data-scene-ticket-code]"), function (ticket) {
            ticket.textContent = code;
        });
    }

    function setSceneActualLatency(latency, isP99) {
        var label = byId("scene-actual-label");
        var value = byId("scene-actual-value");
        if (latency === null || latency === "" || !Number.isFinite(Number(latency))) {
            label.textContent = "Actual latency";
            value.textContent = "—";
            return;
        }
        label.textContent = isP99 ? "Actual latency · P99" : "Actual latency";
        value.textContent = Number(latency).toFixed(isP99 ? 0 : 1) + " ms";
    }

    function setLabSceneState(nextState, payload) {
        var validStates = ["idle", "crowd_arriving", "tickets_submitting", "entering_machine", "lab_running"];
        if (validStates.indexOf(nextState) === -1) {
            return;
        }
        payload = payload || {};
        var canvas = byId("architecture-canvas");
        var control = byId("scene-intro-control");
        var qps = Math.max(0, Number(payload.qps || 0));
        var delta = Math.max(0, Number(payload.delta || 0));
        var modeLabel = payload.mode === "cached" ? "Redis Cache-Aside" : "MySQL Direct";
        var intensity = clamp(qps / 600, .28, 1);

        state.sceneState = nextState;
        canvas.dataset.sceneState = nextState;
        canvas.dataset.trafficActive = qps > 0 || delta > 0 ? "true" : "false";
        canvas.style.setProperty("--traffic-intensity", intensity.toFixed(2));
        canvas.style.setProperty("--crowd-opacity", (.42 + intensity * .28).toFixed(2));
        canvas.style.setProperty("--ticket-speed", clamp(.58 - qps * .0007, .24, .52).toFixed(2) + "s");

        if (payload.resetTelemetry) {
            setSceneActualLatency(null, false);
        } else if (Number(payload.p99) > 0) {
            setSceneActualLatency(payload.p99, true);
        }

        control.hidden = nextState === "idle";
        control.textContent = nextState === "lab_running" ? "重播场景导入" : "跳过导入";

        if (nextState === "idle") {
            byId("scene-state-label").textContent = state.sceneWaitingForTraffic ?
                "WAITING FOR TERMINAL TRAFFIC" : "SCENE READY";
            byId("scene-state-title").textContent = "魔法潮汐将至";
            byId("scene-state-copy").textContent = state.sceneWaitingForTraffic ?
                "等待终端流量进入实验室……" : "当前只有一名访客正在查询材料档案。";
            byId("scene-visual-status").textContent = state.sceneWaitingForTraffic ? "ARMED" : "IDLE";
        } else if (nextState === "crowd_arriving") {
            setCameraView("exterior", false);
            byId("scene-state-label").textContent = "TRAFFIC DETECTED";
            byId("scene-state-title").textContent = qps > 0 ?
                formatNumber(qps) + " req/s · 每秒约 " + formatNumber(qps) + " 次材料档案查询" :
                formatNumber(delta) + " requests · 检测到真实请求增量";
            byId("scene-state-copy").textContent = "访客查询正在形成请求洪峰；req/s 表示请求速率。";
            byId("scene-visual-status").textContent = "CROWD ARRIVING";
        } else if (nextState === "tickets_submitting") {
            setCameraView("exterior", false);
            byId("scene-state-label").textContent = "QUERY TOKENS ACCEPTED";
            byId("scene-state-title").textContent = "查询凭证正在转化为系统请求";
            byId("scene-state-copy").textContent = modeLabel + " · 聚合凭证流进入柜台接收口。";
            byId("scene-visual-status").textContent = "TOKENS → REQUESTS";
        } else if (nextState === "entering_machine") {
            setCameraView("internal", false);
            byId("scene-state-label").textContent = "ENTERING DATA ROUTING ENGINE";
            byId("scene-state-title").textContent = "请求已送入双路数据检索机";
            byId("scene-state-copy").textContent = "教学镜头正在进入透明机械剖面，不计入真实请求耗时。";
            byId("scene-visual-status").textContent = "CAMERA PUSH-IN";
        } else {
            byId("scene-state-label").textContent = "LIVE ARCHITECTURE";
            byId("scene-state-title").textContent = modeLabel + " · " + formatNumber(qps) + " req/s";
            byId("scene-state-copy").textContent = payload.mode === "cached" ?
                "镜头已固定；Redis 命中、回源与回填继续由真实指标驱动。" :
                "镜头已固定；请求脉冲、DB Reads 与连接池压力继续由真实指标驱动。";
            byId("scene-visual-status").textContent = "LAB VIEW FIXED";
        }

        syncSceneControls();
    }

    function killSceneIntro() {
        if (state.sceneTimeline) {
            state.sceneTimeline.kill();
            state.sceneTimeline = null;
        }
    }

    function finishSceneIntro() {
        var payload = state.sceneLastTraffic || {};
        state.sceneIntroPlayed = true;
        state.sceneTimeline = null;
        setLabSceneState("lab_running", payload);
        if (state.pendingSceneRoute) {
            var pending = state.pendingSceneRoute;
            state.pendingSceneRoute = null;
            playRoute(pending.source, pending.qps);
        }
    }

    function startSceneIntro(payload) {
        if (state.sceneState !== "idle" || state.sceneIntroPlayed) {
            return;
        }
        payload = payload || {};
        state.sceneWaitingForTraffic = false;
        state.sceneLastTraffic = payload;
        state.pendingSceneRoute = payload.source ? { source: payload.source, qps: payload.qps } : null;

        if (state.reducedMotion || !window.gsap) {
            setCameraView("internal", false);
            finishSceneIntro();
            return;
        }

        killSceneIntro();
        setLabSceneState("crowd_arriving", payload);
        state.sceneTimeline = window.gsap.timeline();
        state.sceneTimeline.to({}, { duration: .55 });
        state.sceneTimeline.call(function () {
            setLabSceneState("tickets_submitting", state.sceneLastTraffic);
        });
        state.sceneTimeline.to({}, { duration: .52 });
        state.sceneTimeline.call(function () {
            setLabSceneState("entering_machine", state.sceneLastTraffic);
        });
        state.sceneTimeline.to({}, { duration: .7 });
        state.sceneTimeline.call(finishSceneIntro);
    }

    function skipSceneIntro() {
        if (!sceneIntroIsRunning()) {
            return;
        }
        killSceneIntro();
        finishSceneIntro();
    }

    function replaySceneIntro() {
        if (state.sceneState !== "lab_running" || !state.sceneLastTraffic) {
            return;
        }
        var payload = state.sceneLastTraffic;
        killRouteAnimation();
        killSceneIntro();
        state.sceneIntroPlayed = false;
        state.sceneWaitingForTraffic = false;
        state.pendingSceneRoute = null;
        setLabSceneState("idle", payload);
        void byId("architecture-canvas").offsetWidth;
        startSceneIntro(payload);
    }

    function resetLabScene() {
        killSceneIntro();
        state.sceneIntroPlayed = false;
        state.sceneWaitingForTraffic = false;
        state.sceneLastTraffic = null;
        state.pendingSceneRoute = null;
        setLabSceneState("idle", { resetTelemetry: true });
    }

    async function requestJSON(url, options) {
        var response = await fetch(url, options || {});
        var raw = await response.text();
        var body = raw ? JSON.parse(raw) : null;
        if (!response.ok) {
            throw new Error((body && body.message) || "请求失败（" + response.status + "）");
        }
        return { body: body, response: response };
    }

    function readStoredMaterialId() {
        try {
            var id = Number(window.sessionStorage.getItem(MATERIAL_STORAGE_KEY));
            return Number.isInteger(id) && id > 0 ? id : null;
        } catch (_) {
            return null;
        }
    }

    function storeMaterialId(id) {
        try {
            window.sessionStorage.setItem(MATERIAL_STORAGE_KEY, String(id));
        } catch (_) {
            // query 参数仍可完成跨页传递。
        }
    }

    function incomingMaterialId() {
        var queryId = Number(new URLSearchParams(window.location.search).get("material"));
        if (Number.isInteger(queryId) && queryId > 0) {
            return queryId;
        }
        return readStoredMaterialId();
    }

    function selectedArchive() {
        return state.archives.find(function (archive) {
            return archive.id === state.selectedId;
        }) || null;
    }

    function materialForArchive(archive) {
        var theme = materialThemes[archive && archive.id];
        if (theme) {
            return Object.assign({ id: archive.id }, theme);
        }
        return {
            id: archive ? archive.id : 0,
            code: archive ? archive.code : "MATERIAL",
            name: archive ? archive.name : "未知材料",
            rarity: "ARCHIVE",
            title: archive ? archive.title : "暂无详情",
            sigil: archive ? archive.sigil : "·",
            accent: archive ? archive.accent : "#78a7bd",
            rgb: "120, 167, 189",
            kind: "unknown",
            origin: "服务端档案库",
            attribute: archive ? archive.title : "暂无属性映射",
            usage: archive ? archive.oath : "只读详情展示",
            risk: "服务端未提供风险映射。",
            hint: "目录仅记录了一条尚未核验的材料线索。",
            summary: archive ? archive.summary : "服务端没有返回材料详情。",
            note: archive ? archive.oath : "MySQL 是权威数据源。"
        };
    }

    function selectEntryMaterial(archive) {
        var material = materialForArchive(archive);
        state.entrySelectedId = archive.id;
        storeMaterialId(archive.id);
        Array.prototype.forEach.call(document.querySelectorAll(".entry-material-card"), function (card) {
            var selected = Number(card.dataset.id) === archive.id;
            card.classList.toggle("is-selected", selected);
            card.setAttribute("aria-selected", selected ? "true" : "false");
        });
        byId("entry-selected-title").textContent = material.name + " · ARC-" + String(material.id).padStart(3, "0");
        byId("entry-selected-copy").textContent = material.hint;
        byId("enter-lab").disabled = false;
        var ticket = document.querySelector(".entry-query-ticket");
        if (ticket) {
            ticket.textContent = "ARC-" + String(material.id).padStart(3, "0");
        }
    }

    function renderEntryMaterialCards(archives) {
        var host = byId("entry-material-grid");
        host.innerHTML = "";
        archives.forEach(function (archive) {
            var material = materialForArchive(archive);
            var button = document.createElement("button");
            button.type = "button";
            button.className = "entry-material-card";
            button.dataset.id = archive.id;
            button.dataset.kind = material.kind;
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", "false");
            button.style.setProperty("--entry-rgb", material.rgb);
            button.innerHTML =
                "<small>ARC-" + String(material.id).padStart(3, "0") + "</small>" +
                "<i class=\"entry-material-silhouette\" aria-hidden=\"true\"></i>" +
                "<strong>" + material.name + "</strong>" +
                "<em>" + material.hint + "</em>";
            button.addEventListener("click", function () {
                selectEntryMaterial(archive);
            });
            host.appendChild(button);
        });
        byId("entry-directory-status").textContent = formatNumber(archives.length) + " 份材料索引可查询";

        var storedId = readStoredMaterialId();
        var storedArchive = archives.find(function (archive) { return archive.id === storedId; });
        if (storedArchive) {
            selectEntryMaterial(storedArchive);
        }
    }

    async function startMarketEntryPage() {
        byId("enter-lab").addEventListener("click", function () {
            if (!state.entrySelectedId) {
                return;
            }
            storeMaterialId(state.entrySelectedId);
            window.location.assign("/lab?material=" + encodeURIComponent(state.entrySelectedId));
        });
        try {
            var result = await requestJSON("/api/archives");
            state.archives = result.body || [];
            renderEntryMaterialCards(state.archives);
        } catch (error) {
            byId("entry-directory-status").textContent = "材料目录暂时不可用";
            showToast(error.message, "danger");
        }
    }

    function applyMaterialTheme(archive) {
        var material = materialForArchive(archive);
        document.body.dataset.materialKind = material.kind;
        document.body.style.setProperty("--material-accent", material.accent);
        document.body.style.setProperty("--material-rgb", material.rgb);
        byId("redis-key-label").textContent = "archive:profession:" + material.id;
        return material;
    }

    function clearTerminalTimers() {
        ["terminalTransitionTimer", "terminalCapsuleTimer"].forEach(function (key) {
            if (state[key]) {
                window.clearTimeout(state[key]);
                state[key] = null;
            }
        });
        byId("terminal-request-pulse").classList.remove("is-active");
        byId("terminal-response-capsule").classList.remove("is-active");
    }

    function setTerminalState(name, archive, read) {
        var terminal = byId("material-terminal");
        var material = archive ? materialForArchive(archive) : null;
        var eyebrow = "MATERIAL QUERY TERMINAL";
        var title = "魔法潮汐将至";
        var primary = "你想了解哪一种材料？";
        var secondary = "从目录选择一份材料索引。";

        if (name === "material-selecting") {
            eyebrow = "MATERIAL INDEX";
            title = "材料情报目录";
            primary = "请选择一份材料索引";
            secondary = "目录只展示档案编号、模糊轮廓和线索。";
        } else if (name === "material-selected" && material) {
            eyebrow = "TARGET RECORD";
            title = "目标档案 ARC-" + String(material.id).padStart(3, "0");
            primary = material.name;
            secondary = "尚未读取完整资料，可选择 MySQL Direct 或 Redis Cache-Aside。";
        } else if (name === "requesting" && material) {
            eyebrow = "REAL HTTP REQUEST";
            title = "目标档案 ARC-" + String(material.id).padStart(3, "0");
            primary = "正在检索";
            secondary = "真实请求已发送，不等待路径动画。";
        } else if (name === "response-received" && material && read) {
            eyebrow = "RESPONSE RECEIVED";
            title = "档案已返回 · 实际响应 " + read.latency.toFixed(1) + "ms";
            primary = "正在回放本次数据路径";
            secondary = "路径回放 · 教学演示，不计入真实请求耗时。";
        } else if (name === "record-visible" && material && read) {
            eyebrow = "READ-ONLY RECORD · 只读档案";
            title = material.name + " · ARC-" + String(material.id).padStart(3, "0");
            primary = "完整档案已映射到检索终端";
            secondary = "只读展示，不代表已经获得或占用材料。";
        }

        state.terminalState = name;
        terminal.dataset.terminalState = name;
        byId("terminal-eyebrow").textContent = eyebrow;
        byId("terminal-title").textContent = title;
        byId("terminal-primary-line").textContent = primary;
        byId("terminal-secondary-line").textContent = secondary;
        byId("terminal-record").setAttribute("aria-hidden", name === "record-visible" ? "false" : "true");
        byId("read-again").disabled = !material || state.isQuerying || state.isReplaying;

        terminal.classList.remove("is-transitioning");
        void terminal.offsetWidth;
        terminal.classList.add("is-transitioning");
        window.clearTimeout(state.terminalTransitionTimer);
        state.terminalTransitionTimer = window.setTimeout(function () {
            terminal.classList.remove("is-transitioning");
            state.terminalTransitionTimer = null;
        }, state.reducedMotion ? 0 : 300);
        syncSceneControls();
    }

    function showSelectionState(archive) {
        var material = archive ? applyMaterialTheme(archive) : null;
        if (!material) {
            byId("redis-key-label").textContent = "archive:profession:{id}";
        }
        document.body.dataset.selectionState = material ? "selected" : "empty";
        setTerminalState(material ? "material-selected" : "idle", archive, null);
        byId("route-status").textContent = material ?
            "已选择 ARC-" + String(material.id).padStart(3, "0") + " · 等待查询" : "请选择材料档案";
        byId("route-source").textContent = "—";
    }

    function clearMaterialSelection() {
        state.selectedId = null;
        state.readModelArchive = null;
        state.lastRead = null;
        clearTerminalTimers();

        Array.prototype.forEach.call(document.querySelectorAll(".material-option"), function (button) {
            button.classList.remove("is-active");
            button.setAttribute("aria-selected", "false");
        });
        showSelectionState(null);
        updateSceneTicketCode();
        updateCommands();
    }

    function showMissingMaterialPrompt() {
        byId("terminal-eyebrow").textContent = "MATERIAL REQUIRED";
        byId("terminal-title").textContent = "尚未选择材料";
        byId("terminal-primary-line").textContent = "请先返回店铺门口选择材料索引。";
        byId("terminal-secondary-line").textContent = "也可以点击上方“材料”按钮，在实验室内重新选择。";
        byId("route-status").textContent = "等待材料索引";
    }

    function selectMaterial(archive) {
        if (state.isQuerying || state.isReplaying) {
            showToast("本次查询尚未完成，请稍候。", "danger");
            return;
        }
        state.selectedId = archive.id;
        storeMaterialId(archive.id);
        if (window.location.pathname === "/lab") {
            window.history.replaceState(null, "", "/lab?material=" + encodeURIComponent(archive.id));
        }
        state.readModelArchive = null;
        state.lastRead = null;
        clearTerminalTimers();
        resetRouteVisual();
        showSelectionState(archive);

        Array.prototype.forEach.call(document.querySelectorAll(".material-option"), function (button) {
            var active = Number(button.dataset.id) === archive.id;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-selected", active ? "true" : "false");
        });
        updateSceneTicketCode();
        updateCommands();
        if (document.body.classList.contains("has-drawer-open")) {
            closeDrawers(false);
        }
    }

    function renderMaterialTabs() {
        var host = byId("material-tabs");
        host.innerHTML = "";
        state.archives.forEach(function (archive) {
            var material = materialForArchive(archive);
            var button = document.createElement("button");
            button.className = "material-option";
            button.type = "button";
            button.dataset.id = archive.id;
            button.dataset.kind = material.kind;
            button.setAttribute("role", "tab");
            button.setAttribute("aria-selected", "false");
            button.style.setProperty("--option-accent", material.accent);
            button.innerHTML =
                "<i aria-hidden=\"true\"></i>" +
                "<span><small>ARC-" + String(material.id).padStart(3, "0") + "</small>" +
                "<strong>" + material.name + "</strong><em>" + material.hint + "</em></span>";
            button.addEventListener("click", function () {
                selectMaterial(archive);
            });
            host.appendChild(button);
        });
    }

    function sourceLabel(source) {
        switch (source) {
        case "mysql":
            return "MYSQL · DIRECT";
        case "redis-hit":
            return "REDIS · CACHE HIT";
        case "redis-miss":
            return "MYSQL · CACHE MISS";
        case "redis-fallback":
            return "MYSQL · REDIS FALLBACK";
        default:
            return source || "UNKNOWN";
        }
    }

    function readModelSource(source) {
        switch (source) {
        case "mysql":
            return { kind: "direct", label: "MYSQL DIRECT" };
        case "redis-hit":
            return { kind: "hit", label: "REDIS CACHE HIT" };
        case "redis-miss":
            return { kind: "miss", label: "MYSQL / CACHE FILLED" };
        case "redis-fallback":
            return { kind: "fallback", label: "MYSQL / REDIS FALLBACK" };
        default:
            return { kind: "fallback", label: "UNKNOWN" };
        }
    }

    function prepareTerminalRecord(archive, source, latency) {
        var material = materialForArchive(archive);
        var sourceInfo = readModelSource(source);
        var terminal = byId("material-terminal");

        state.readModelArchive = archive;
        terminal.dataset.sourceKind = sourceInfo.kind;
        terminal.dataset.kind = material.kind;
        byId("terminal-record-name").textContent = material.name;
        byId("terminal-record-rarity").textContent = material.rarity;
        byId("terminal-record-origin").textContent = material.origin;
        byId("terminal-record-attribute").textContent = material.attribute;
        byId("terminal-record-usage").textContent = material.usage;
        byId("terminal-record-risk").textContent = material.risk;
        byId("terminal-record-source").textContent = sourceInfo.label;
        byId("terminal-record-latency").textContent = latency.toFixed(1) + " ms";
        setSceneActualLatency(latency, false);
    }

    function animateTerminalRequestPulse() {
        var pulse = byId("terminal-request-pulse");
        pulse.classList.remove("is-active");
        if (state.reducedMotion) {
            return;
        }
        void pulse.offsetWidth;
        pulse.classList.add("is-active");
        window.setTimeout(function () {
            pulse.classList.remove("is-active");
        }, 380);
    }

    function animateTerminalResponseCapsule(onComplete) {
        var capsule = byId("terminal-response-capsule");
        capsule.classList.remove("is-active");
        window.clearTimeout(state.terminalCapsuleTimer);
        if (state.reducedMotion) {
            onComplete();
            return;
        }
        void capsule.offsetWidth;
        capsule.classList.add("is-active");
        state.terminalCapsuleTimer = window.setTimeout(function () {
            capsule.classList.remove("is-active");
            state.terminalCapsuleTimer = null;
            onComplete();
        }, 440);
    }

    function setMode(mode) {
        if (state.isQuerying || state.isReplaying) {
            showToast("本次查询回放完成后可切换路径。", "danger");
            return;
        }
        state.mode = mode === "cached" ? "cached" : "direct";
        document.body.dataset.labMode = state.mode;

        var cached = state.mode === "cached";
        byId("route-mode-badge").textContent = cached ? "REDIS CACHE-ASIDE" : "MYSQL DIRECT";
        byId("route-mode-badge").className = "surface-badge " + (cached ? "mode-cached" : "mode-direct");
        byId("control-mode").textContent = cached ? "CACHE-ASIDE" : "DIRECT";
        byId("control-mode").className = "surface-badge " + (cached ? "mode-cached" : "mode-direct");
        byId("command-mode-label").textContent = cached ? "REDIS CACHE-ASIDE COMMAND" : "MYSQL DIRECT COMMAND";

        byId("node-redis").classList.toggle("is-disabled", !cached);
        byId("redis-node-state").textContent = cached ? "已进入读取路径" : "当前路径跳过";
        byId("direct-metrics-row").classList.toggle("is-active", !cached);
        byId("cached-metrics-row").classList.toggle("is-active", cached);
        byId("start-direct").classList.toggle("is-selected", !cached);
        byId("start-cached").classList.toggle("is-selected", cached);

        updateActiveCommand();
        resetRouteVisual();
        if (state.terminalState !== "record-visible") {
            showSelectionState(selectedArchive());
        }
    }

    function updateCommands() {
        var id = state.selectedId;
        var copyButton = byId("copy-command");
        if (!id) {
            state.directCommand = "选择材料后生成真实压测命令";
            state.cachedCommand = "选择材料后生成真实压测命令";
            copyButton.disabled = true;
            updateActiveCommand();
            return;
        }
        copyButton.disabled = false;
        var prefix = "docker compose --profile loadtest run --rm --no-deps";
        var common = " -e RATE=" + state.rate +
            " -e DURATION=" + state.duration +
            " -e CONNECTIONS=" + state.connections +
            " -e SCRIPT=/opt/wrk2/scripts/read.lua wrk2";
        state.directCommand = prefix +
            " -e TARGET_URL=http://app:5678/api/archives/" + id + "/direct" + common;
        state.cachedCommand = prefix +
            " -e TARGET_URL=http://app:5678/api/archives/" + id + "/cached" + common;
        updateActiveCommand();
    }

    function updateActiveCommand() {
        var command = state.mode === "cached" ? state.cachedCommand : state.directCommand;
        byId("active-command").textContent = command || "";
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            var area = document.createElement("textarea");
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            area.remove();
        }
    }

    async function copyActiveCommand() {
        if (!state.selectedId) {
            showToast("请先选择要查询的材料档案。", "danger");
            return;
        }
        var command = state.mode === "cached" ? state.cachedCommand : state.directCommand;
        await copyText(command);
        state.waitingMode = state.mode;
        state.sceneWaitingForTraffic = true;
        if (state.sceneState === "idle") {
            setLabSceneState("idle", { mode: state.mode });
        }
        var loadState = byId("loadtest-state");
        loadState.className = "loadtest-state is-armed";
        loadState.querySelector("strong").textContent = "命令已复制，等待终端流量";
        loadState.querySelector("p").textContent = "运行命令后，SSE 检测到请求增长才会驱动链路动画。";
        showToast("真实压测命令已复制，请在项目终端运行。", "success");
    }

    function updateParameters() {
        state.rate = Number(byId("rate-range").value);
        state.connections = Number(byId("connections-range").value);
        byId("rate-value").textContent = formatNumber(state.rate) + " req/s";
        byId("connections-value").textContent = formatNumber(state.connections);
        byId("parameter-feedback").textContent =
            "命令已同步：" + formatNumber(state.rate) + " req/s · " +
            formatNumber(state.connections) + " connections";
        updateCommands();
        byId("parameter-feedback").classList.remove("is-updated");
        void byId("parameter-feedback").offsetWidth;
        byId("parameter-feedback").classList.add("is-updated");
    }

    async function readSelectedArchive(explicitMode) {
        if (!state.selectedId || state.isQuerying || state.isReplaying) {
            if (!state.selectedId) {
                showToast("请先从材料情报目录选择一份档案。", "danger");
            }
            return;
        }
        var mode = explicitMode || state.mode;
        var path = mode === "cached" ? "cached" : "direct";
        var queryButton = byId("read-again");
        var repeatButton = byId("terminal-read-again");
        var directButton = byId("start-direct");
        var cachedButton = byId("start-cached");
        var startedAt = window.performance && window.performance.now ? window.performance.now() : Date.now();
        state.isQuerying = true;
        clearTerminalTimers();
        queryButton.disabled = true;
        repeatButton.disabled = true;
        directButton.disabled = true;
        cachedButton.disabled = true;
        document.body.dataset.selectionState = "querying";
        setTerminalState("requesting", selectedArchive(), null);
        animateTerminalRequestPulse();
        byId("route-status").textContent = "真实 HTTP 请求进行中";
        byId("route-source").textContent = "等待 X-Archive-Source";

        try {
            var result = await requestJSON("/api/archives/" + state.selectedId + "/" + path);
            var receivedAt = window.performance && window.performance.now ? window.performance.now() : Date.now();
            var latency = Math.max(0, receivedAt - startedAt);
            // 单次读取只相信协议头；缺失时明确显示 UNKNOWN，不根据当前按钮猜测来源。
            var source = result.response.headers.get("X-Archive-Source") || "unknown";
            var fetchedAt = new Date();
            state.lastRead = {
                archive: result.body,
                source: source,
                latency: latency,
                fetchedAt: fetchedAt
            };

            // 真实响应立即记录；完整档案在教学路径回放结束并进入终端后再展开。
            prepareTerminalRecord(result.body, source, latency);
            setTerminalState("response-received", result.body, state.lastRead);
            state.isReplaying = true;
            state.manualReplayGuard = {
                mode: mode,
                expiresAt: Date.now() + 5000
            };
            window.requestAnimationFrame(function () {
                playRoute(source, 0, function () {
                    animateTerminalResponseCapsule(function () {
                        document.body.dataset.selectionState = "loaded";
                        state.isReplaying = false;
                        setTerminalState("record-visible", result.body, state.lastRead);
                        repeatButton.disabled = false;
                        directButton.disabled = false;
                        cachedButton.disabled = false;
                    });
                });
            });
        } catch (error) {
            state.isReplaying = false;
            byId("route-status").textContent = "请求失败";
            showSelectionState(selectedArchive());
            showToast(error.message, "danger");
        } finally {
            state.isQuerying = false;
            queryButton.disabled = !state.selectedId;
            repeatButton.disabled = !state.selectedId;
            directButton.disabled = state.isReplaying;
            cachedButton.disabled = state.isReplaying;
        }
    }

    function clearRouteClasses() {
        Array.prototype.forEach.call(document.querySelectorAll(".architecture-node"), function (node) {
            node.classList.remove("is-active", "is-hit", "is-miss", "is-error");
        });
        Array.prototype.forEach.call(document.querySelectorAll(".route-edge"), function (edge) {
            edge.classList.remove("is-active", "is-direct", "is-hit", "is-miss", "is-refill", "is-error");
        });
        Array.prototype.forEach.call(document.querySelectorAll(".request-pulse"), function (pulse) {
            pulse.classList.remove("is-visible");
        });
        byId("machine-alert").classList.remove("is-error");
        byId("machine-alert").style.opacity = "0";
    }

    function resetMechanicalTransforms() {
        ["request-pulse-1", "request-pulse-2", "request-pulse-3", "redis-data-capsule",
            "mysql-data-capsule", "refill-capsule"].forEach(function (id) {
            var element = byId(id);
            element.style.opacity = "0";
            element.removeAttribute("transform");
        });

        if (window.gsap) {
            window.gsap.set("#routing-valve-pointer, #redis-rotor, #mysql-spindle, #mysql-read-arm", {
                clearProps: "transform"
            });
        }
    }

    // 新状态直接终止旧 Timeline，避免高频 SSE 把已经过时的路径排队播放。
    function killRouteAnimation() {
        if (state.routeTimeline) {
            state.routeTimeline.kill();
            state.routeTimeline = null;
        }
        if (window.gsap) {
            window.gsap.killTweensOf([
                "#routing-valve-pointer", "#redis-rotor", "#mysql-spindle", "#mysql-read-arm",
                "#request-pulse-1", "#request-pulse-2", "#request-pulse-3",
                "#redis-data-capsule", "#mysql-data-capsule", "#refill-capsule", "#machine-alert"
            ]);
        }
        clearRouteClasses();
        resetMechanicalTransforms();
    }

    function resetRouteVisual() {
        killRouteAnimation();
        document.body.dataset.routeState = "idle";
        byId("route-status").textContent = "等待真实请求";
        byId("route-source").textContent = "—";
        byId("redis-node-state").textContent =
            state.mode === "cached" ? "CACHE PATH READY" : "CACHE PATH CLOSED";
        byId("valve-route-label").textContent = state.mode === "cached" ? "CACHE PATH" : "DIRECT BYPASS";
        if (window.gsap) {
            window.gsap.set("#routing-valve-pointer", {
                rotation: state.mode === "cached" ? 58 : 123,
                svgOrigin: "334 268"
            });
        }
        renderMachineMetrics();
    }

    var segmentConfig = {
        "client-api": { edge: "path-client-api", nodes: ["node-client", "node-api"] },
        "api-redis": { edge: "path-api-redis", nodes: ["node-api", "node-redis"] },
        "api-mysql": { edge: "path-api-mysql", nodes: ["node-api", "node-mysql"] },
        "redis-mysql": { edge: "path-redis-mysql", nodes: ["node-redis", "node-api", "node-mysql"] },
        "mysql-redis": { edge: "path-mysql-redis", nodes: ["node-mysql", "node-redis"] },
        "redis-response": { edge: "path-redis-response", nodes: ["node-redis", "node-api"] },
        "mysql-response": { edge: "path-mysql-response", nodes: ["node-mysql", "node-api"] }
    };

    function setSegmentActive(name, tone) {
        var config = segmentConfig[name];
        if (!config) {
            return;
        }
        byId(config.edge).classList.add("is-active", tone);
        config.nodes.forEach(function (id) {
            byId(id).classList.add("is-active");
        });
    }

    function routeDefinition(source) {
        switch (source) {
        case "mysql":
            return {
                state: "direct",
                status: "教学回放 · MySQL Direct",
                source: source,
                valve: 123
            };
        case "redis-hit":
            return {
                state: "hit",
                status: "教学回放 · Redis Hit · MySQL 未参与",
                source: source,
                valve: 58
            };
        case "redis-miss":
            return {
                state: "miss",
                status: "教学回放 · Redis Miss → MySQL → SET EX",
                source: source,
                valve: 58
            };
        case "redis-fallback":
            return {
                state: "fallback",
                status: "教学回放 · Redis Fallback → MySQL",
                source: source,
                valve: 58
            };
        default:
            return null;
        }
    }

    function placeCarrierOnPath(element, path, progress) {
        var length = path.getTotalLength();
        var distance = clamp(progress, 0, 1) * length;
        var point = path.getPointAtLength(distance);
        var next = path.getPointAtLength(Math.min(length, distance + 1));
        var angle = Math.atan2(next.y - point.y, next.x - point.x) * 180 / Math.PI;
        element.setAttribute("transform", "translate(" + point.x + " " + point.y + ") rotate(" + angle + ")");
    }

    // 固定复用三个脉冲和三个胶囊；QPS 只改变时长与复用密度，不逐请求创建 DOM。
    function addPathCarrier(timeline, carrierId, pathId, at, duration, ease) {
        var carrier = byId(carrierId);
        var path = byId(pathId);
        var progress = { value: 0 };
        timeline.set(carrier, { opacity: 1 }, at);
        timeline.to(progress, {
            value: 1,
            duration: duration,
            ease: ease || "power1.inOut",
            onStart: function () { placeCarrierOnPath(carrier, path, 0); },
            onUpdate: function () { placeCarrierOnPath(carrier, path, progress.value); }
        }, at);
        timeline.set(carrier, { opacity: 0 }, at + duration);
        return at + duration;
    }

    function addRequestBurst(timeline, segment, tone, at, qps) {
        var duration = clamp(.48 - Number(qps || 0) * .00045, .2, .48);
        var density = clamp(Math.ceil(Number(qps || 1) / 180), 1, 3);
        timeline.call(function () { setSegmentActive(segment, tone); }, null, at);
        for (var i = 0; i < density; i++) {
            addPathCarrier(timeline, "request-pulse-" + (i + 1), segmentConfig[segment].edge,
                at + i * .08, duration, "power1.inOut");
        }
        return at + duration + (density - 1) * .08;
    }

    function showMachineAlert(text, isError) {
        byId("machine-alert-text").textContent = text;
        byId("machine-alert").classList.toggle("is-error", Boolean(isError));
    }

    function startTTLDecay() {
        var chapter = state.snapshot && state.snapshot.archiveRead;
        var ttl = Number(chapter && chapter.cacheTTLSeconds || 0);
        var ring = byId("redis-ttl-ring");
        ring.style.setProperty("--ttl-remaining", 100);
        if (state.ttlTween) {
            state.ttlTween.kill();
            state.ttlTween = null;
        }
        if (!window.gsap || state.reducedMotion || ttl <= 0) {
            return;
        }
        var remaining = { value: 100 };
        state.ttlTween = window.gsap.to(remaining, {
            value: 0,
            duration: ttl,
            ease: "none",
            onUpdate: function () {
                ring.style.setProperty("--ttl-remaining", remaining.value.toFixed(2));
            }
        });
    }

    function applyStaticRoute(route) {
        var tone = route.state === "hit" ? "is-hit" :
            (route.state === "fallback" ? "is-error" :
                (route.state === "miss" ? "is-miss" : "is-direct"));
        var segments = route.state === "direct" ? ["client-api", "api-mysql", "mysql-response"] :
            (route.state === "hit" ? ["client-api", "api-redis", "redis-response"] :
                ["client-api", "api-redis", "redis-mysql", "mysql-response"]);
        segments.forEach(function (segment) { setSegmentActive(segment, tone); });
        if (window.gsap) {
            window.gsap.set("#routing-valve-pointer", {
                rotation: route.state === "hit" ? 58 : 123,
                svgOrigin: "334 268"
            });
        }

        if (route.state === "direct") {
            byId("node-mysql").classList.add("is-active");
            byId("valve-route-label").textContent = "DIRECT BYPASS";
        } else if (route.state === "hit") {
            byId("node-redis").classList.add("is-hit");
            byId("redis-slot-active").classList.add("is-filled");
            byId("redis-node-state").textContent = "CACHE HIT";
            byId("valve-route-label").textContent = "CACHE PATH";
        } else if (route.state === "miss") {
            setSegmentActive("mysql-redis", "is-refill");
            byId("node-redis").classList.add("is-miss");
            byId("node-mysql").classList.add("is-miss");
            byId("redis-slot-active").classList.add("is-filled");
            byId("redis-node-state").textContent = "CACHE FILLED";
            byId("valve-route-label").textContent = "CACHE → DB → REFILL";
            showMachineAlert("CACHE FILLED", false);
            byId("machine-alert").style.opacity = "1";
            startTTLDecay();
        } else {
            byId("node-redis").classList.add("is-error");
            byId("node-mysql").classList.add("is-active");
            byId("redis-node-state").textContent = "REDIS FALLBACK";
            byId("valve-route-label").textContent = "SAFETY BYPASS";
            showMachineAlert("REDIS FALLBACK", true);
            byId("machine-alert").style.opacity = "1";
        }
    }

    function buildDirectTimeline(timeline, route, qps) {
        var cursor = addRequestBurst(timeline, "client-api", "is-direct", 0, qps);
        timeline.to("#routing-valve-pointer", { rotation: 123, svgOrigin: "334 268", duration: .34, ease: "power2.inOut" }, .08);
        timeline.call(function () { byId("valve-route-label").textContent = "DIRECT BYPASS"; }, null, .2);
        cursor = addRequestBurst(timeline, "api-mysql", "is-direct", cursor + .02, qps);
        timeline.call(function () { byId("node-mysql").classList.add("is-active"); }, null, cursor - .08);
        timeline.to("#mysql-spindle", { rotation: 150, svgOrigin: "576 388", duration: .62, ease: "power2.inOut" }, cursor - .04);
        timeline.to("#mysql-read-arm", { rotation: -16, svgOrigin: "650 365", duration: .28, ease: "power2.inOut", yoyo: true, repeat: 1 }, cursor + .08);
        timeline.call(function () { setSegmentActive("mysql-response", "is-direct"); }, null, cursor + .48);
        addPathCarrier(timeline, "mysql-data-capsule", "path-mysql-response", cursor + .48, .62, "power1.inOut");
    }

    function buildHitTimeline(timeline, route, qps) {
        var cursor = addRequestBurst(timeline, "client-api", "is-hit", 0, qps);
        timeline.to("#routing-valve-pointer", { rotation: 58, svgOrigin: "334 268", duration: .34, ease: "power2.inOut" }, .08);
        timeline.call(function () { byId("valve-route-label").textContent = "CACHE PATH"; }, null, .2);
        cursor = addRequestBurst(timeline, "api-redis", "is-hit", cursor + .02, qps);
        timeline.to("#redis-rotor", { rotation: 45, svgOrigin: "572 148", duration: .42, ease: "power2.inOut" }, cursor - .26);
        timeline.call(function () {
            byId("node-redis").classList.add("is-hit");
            byId("redis-slot-active").classList.add("is-filled");
            byId("redis-node-state").textContent = "CACHE HIT";
            setSegmentActive("redis-response", "is-hit");
        }, null, cursor);
        addPathCarrier(timeline, "redis-data-capsule", "path-redis-response", cursor, .56, "power1.inOut");
    }

    function buildMissTimeline(timeline, route, qps) {
        var cursor = addRequestBurst(timeline, "client-api", "is-miss", 0, qps);
        timeline.to("#routing-valve-pointer", { rotation: 58, svgOrigin: "334 268", duration: .34, ease: "power2.inOut" }, .08);
        cursor = addRequestBurst(timeline, "api-redis", "is-miss", cursor + .02, qps);
        timeline.to("#redis-rotor", { rotation: 45, svgOrigin: "572 148", duration: .42, ease: "power2.inOut" }, cursor - .28);
        timeline.call(function () {
            byId("node-redis").classList.add("is-miss");
            byId("redis-slot-active").classList.remove("is-filled");
            byId("redis-node-state").textContent = "CACHE MISS";
            byId("valve-route-label").textContent = "MISS → PRIMARY STORE";
            showMachineAlert("CACHE MISS", false);
        }, null, cursor - .02);
        timeline.to("#machine-alert", { opacity: 1, duration: .18 }, cursor - .02);
        timeline.to("#routing-valve-pointer", { rotation: 123, svgOrigin: "334 268", duration: .38, ease: "power2.inOut" }, cursor + .18);
        cursor = addRequestBurst(timeline, "redis-mysql", "is-miss", cursor + .26, qps);
        timeline.call(function () { byId("node-mysql").classList.add("is-miss"); }, null, cursor - .08);
        timeline.to("#mysql-spindle", { rotation: 150, svgOrigin: "576 388", duration: .64, ease: "power2.inOut" }, cursor - .04);
        timeline.to("#mysql-read-arm", { rotation: -16, svgOrigin: "650 365", duration: .28, ease: "power2.inOut", yoyo: true, repeat: 1 }, cursor + .08);

        // 后端真实顺序是 read MySQL -> SET EX Redis -> HTTP return，回填先于响应胶囊。
        timeline.call(function () { setSegmentActive("mysql-redis", "is-refill"); }, null, cursor + .48);
        addPathCarrier(timeline, "refill-capsule", "path-mysql-redis", cursor + .48, .76, "power1.inOut");
        timeline.call(function () {
            byId("redis-slot-active").classList.add("is-filled");
            byId("redis-node-state").textContent = "CACHE FILLED";
            byId("valve-route-label").textContent = "CACHE → DB → REFILL";
            showMachineAlert("CACHE FILLED", false);
            startTTLDecay();
        }, null, cursor + 1.24);
        timeline.call(function () { setSegmentActive("mysql-response", "is-miss"); }, null, cursor + 1.34);
        addPathCarrier(timeline, "mysql-data-capsule", "path-mysql-response", cursor + 1.34, .64, "power1.inOut");
        timeline.to("#machine-alert", { opacity: 0, duration: .25 }, cursor + 1.82);
    }

    function buildFallbackTimeline(timeline, route, qps) {
        var cursor = addRequestBurst(timeline, "client-api", "is-error", 0, qps);
        timeline.to("#routing-valve-pointer", { rotation: 58, svgOrigin: "334 268", duration: .34, ease: "power2.inOut" }, .08);
        cursor = addRequestBurst(timeline, "api-redis", "is-error", cursor + .02, qps);
        timeline.call(function () {
            byId("node-redis").classList.add("is-error");
            byId("redis-node-state").textContent = "REDIS FALLBACK";
            byId("valve-route-label").textContent = "SAFETY BYPASS";
            showMachineAlert("REDIS FALLBACK", true);
        }, null, cursor - .02);
        timeline.to("#machine-alert", { opacity: 1, duration: .18 }, cursor - .02);
        timeline.to("#routing-valve-pointer", { rotation: 123, svgOrigin: "334 268", duration: .38, ease: "power2.inOut" }, cursor + .12);
        cursor = addRequestBurst(timeline, "redis-mysql", "is-error", cursor + .2, qps);
        timeline.call(function () { byId("node-mysql").classList.add("is-active"); }, null, cursor - .08);
        timeline.to("#mysql-spindle", { rotation: 150, svgOrigin: "576 388", duration: .64, ease: "power2.inOut" }, cursor - .04);
        timeline.to("#mysql-read-arm", { rotation: -16, svgOrigin: "650 365", duration: .28, ease: "power2.inOut", yoyo: true, repeat: 1 }, cursor + .08);
        timeline.call(function () { setSegmentActive("mysql-response", "is-error"); }, null, cursor + .5);
        addPathCarrier(timeline, "mysql-data-capsule", "path-mysql-response", cursor + .5, .64, "power1.inOut");
    }

    function playRoute(source, qps, onReplayComplete) {
        var route = routeDefinition(source);
        killRouteAnimation();

        if (!route) {
            document.body.dataset.routeState = "unknown";
            byId("route-status").textContent = "未知响应来源 · 未推断链路";
            byId("route-source").textContent = sourceLabel(source);
            if (onReplayComplete) {
                onReplayComplete();
            }
            return 0;
        }

        document.body.dataset.routeState = route.state;
        byId("route-status").textContent = route.status;
        byId("route-source").textContent = sourceLabel(source);
        byId("scene-visual-status").textContent = "VISUALIZING REQUEST PATH";

        if (state.reducedMotion || !window.gsap) {
            applyStaticRoute(route);
            byId("route-status").textContent = route.status.replace("教学回放", "静态回放完成");
            byId("scene-visual-status").textContent = "STATIC REQUEST PATH";
            if (onReplayComplete) {
                window.requestAnimationFrame(onReplayComplete);
            }
            return 0;
        }

        var replayStatus = route.status;
        state.routeTimeline = window.gsap.timeline({
            defaults: { ease: "power2.inOut" },
            onComplete: function () {
                state.routeTimeline = null;
                byId("route-status").textContent = replayStatus.replace("教学回放", "回放完成");
                byId("scene-visual-status").textContent = state.sceneState === "lab_running" ?
                    "LAB VIEW FIXED" : "REQUEST PATH COMPLETE";
                if (onReplayComplete) {
                    onReplayComplete();
                }
            }
        });
        if (route.state === "direct") {
            buildDirectTimeline(state.routeTimeline, route, qps);
        } else if (route.state === "hit") {
            buildHitTimeline(state.routeTimeline, route, qps);
        } else if (route.state === "miss") {
            buildMissTimeline(state.routeTimeline, route, qps);
        } else {
            buildFallbackTimeline(state.routeTimeline, route, qps);
        }
        var naturalDuration = state.routeTimeline.duration();
        var replayDuration = route.state === "miss" || route.state === "fallback" ? 1.8 : 1.35;
        if (naturalDuration > 0) {
            state.routeTimeline.timeScale(naturalDuration / replayDuration);
        }
        return replayDuration;
    }

    function animateMetric(id, value, suffix) {
        var element = byId(id);
        if (!element) {
            return;
        }
        var target = Number(value || 0);
        var previous = Number(element.dataset.metricValue || 0);
        element.dataset.metricValue = target;
        suffix = suffix || "";

        if (state.reducedMotion || previous === target) {
            element.textContent = formatNumber(target) + suffix;
            return;
        }

        if (state.numberFrames[id]) {
            window.cancelAnimationFrame(state.numberFrames[id]);
        }
        var started = window.performance.now();
        var duration = 260;

        function frame(now) {
            var progress = clamp((now - started) / duration, 0, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            var current = Math.round(previous + (target - previous) * eased);
            element.textContent = formatNumber(current) + suffix;
            if (progress < 1) {
                state.numberFrames[id] = window.requestAnimationFrame(frame);
            } else {
                element.textContent = formatNumber(target) + suffix;
                delete state.numberFrames[id];
            }
        }
        state.numberFrames[id] = window.requestAnimationFrame(frame);
    }

    function renderPath(prefix, path) {
        animateMetric(prefix + "-total", path.totalRequests);
        animateMetric(prefix + "-qps", path.qps);
        animateMetric(prefix + "-p99", path.p99, " ms");
        animateMetric(prefix + "-db-reads", path.dbReads);

        if (prefix === "direct") {
            animateMetric("direct-errors", path.errors);
            byId("direct-pool").textContent =
                formatNumber(path.poolPeak) + " / " + formatNumber(path.poolCapacity);
            return;
        }

        animateMetric("cached-hits", path.cacheHits);
        animateMetric("cached-misses", path.cacheMisses);
        animateMetric("cached-hit-rate", path.cacheHitRate, "%");
        animateMetric("cached-errors", path.errors);
        byId("cached-pool").textContent =
            formatNumber(path.poolPeak) + " / " + formatNumber(path.poolCapacity);
    }

    function perThousand(path) {
        if (!path.totalRequests) {
            return null;
        }
        return Math.round(path.dbReads * 1000 / path.totalRequests);
    }

    function renderComparison(direct, cached) {
        var directRate = perThousand(direct);
        var cachedRate = perThousand(cached);
        if (directRate === null || cachedRate === null) {
            byId("comparison-summary").textContent = "等待两条路径产生真实请求";
            return;
        }
        var reduction = directRate > 0 ?
            Math.max(0, Math.round((directRate - cachedRate) * 100 / directRate)) : 0;
        byId("comparison-summary").textContent =
            "每千次请求：MySQL Reads " + formatNumber(directRate) +
            " → " + formatNumber(cachedRate) + "，减少 " + reduction + "%";
    }

    function snapshotValues(chapter) {
        return {
            direct: {
                totalRequests: Number(chapter.direct.totalRequests || 0),
                qps: Number(chapter.direct.qps || 0),
                p99: Number(chapter.direct.p99 || 0)
            },
            cached: {
                totalRequests: Number(chapter.cached.totalRequests || 0),
                qps: Number(chapter.cached.qps || 0),
                p99: Number(chapter.cached.p99 || 0),
                cacheHits: Number(chapter.cached.cacheHits || 0),
                cacheMisses: Number(chapter.cached.cacheMisses || 0),
                cacheErrors: Number(chapter.cached.cacheErrors || 0),
                dbReads: Number(chapter.cached.dbReads || 0)
            }
        };
    }

    function showDetectedTraffic(mode, delta, qps) {
        var loadState = byId("loadtest-state");
        loadState.className = "loadtest-state is-running";
        loadState.querySelector("strong").textContent =
            mode === "cached" ? "检测到 Cache-Aside 流量" : "检测到 MySQL Direct 流量";
        loadState.querySelector("p").textContent =
            "SSE 本轮新增 " + formatNumber(delta) + " requests · 当前 " + formatNumber(qps) + " req/s";
        if (state.waitingMode === mode) {
            state.waitingMode = null;
        }
    }

    function detectRealActivity(chapter) {
        var current = snapshotValues(chapter);
        var previous = state.previousArchiveRead;
        state.previousArchiveRead = current;

        var directDelta = previous ? current.direct.totalRequests - previous.direct.totalRequests : 0;
        var cachedDelta = previous ? current.cached.totalRequests - previous.cached.totalRequests : 0;
        var hitDelta = previous ? current.cached.cacheHits - previous.cached.cacheHits : 0;
        var missDelta = previous ? current.cached.cacheMisses - previous.cached.cacheMisses : 0;
        var errorDelta = previous ? current.cached.cacheErrors - previous.cached.cacheErrors : 0;
        var dbDelta = previous ? current.cached.dbReads - previous.cached.dbReads : 0;
        var directTraffic = directDelta > 0 || current.direct.qps > 0;
        var cachedTraffic = cachedDelta > 0 || current.cached.qps > 0;

        if (!directTraffic && !cachedTraffic) {
            byId("architecture-canvas").dataset.trafficActive = "false";
            if (state.sceneState === "lab_running") {
                var restingPath = state.mode === "cached" ? current.cached : current.direct;
                byId("scene-state-title").textContent =
                    (state.mode === "cached" ? "Redis Cache-Aside" : "MySQL Direct") + " · 0 req/s";
                if (restingPath.p99 > 0) {
                    setSceneActualLatency(restingPath.p99, true);
                }
            }
            return;
        }

        if (state.isReplaying) {
            return;
        }

        if (state.manualReplayGuard) {
            if (Date.now() >= state.manualReplayGuard.expiresAt) {
                state.manualReplayGuard = null;
            } else {
                var guardedCached = state.manualReplayGuard.mode === "cached";
                var guardedDelta = guardedCached ? cachedDelta : directDelta;
                var guardedQPS = guardedCached ? current.cached.qps : current.direct.qps;
                var otherTraffic = guardedCached ? directTraffic : cachedTraffic;
                if (!otherTraffic && guardedDelta <= 1 && guardedQPS <= 2) {
                    return;
                }
            }
        }

        var mode = cachedTraffic && (!directTraffic || state.mode === "cached" || cachedDelta > directDelta) ?
            "cached" : "direct";
        var delta = mode === "cached" ? Math.max(0, cachedDelta) : Math.max(0, directDelta);
        var qps = mode === "cached" ? current.cached.qps : current.direct.qps;
        var p99 = mode === "cached" ? current.cached.p99 : current.direct.p99;
        var source = "mysql";

        if (mode === "cached") {
            source = errorDelta > 0 ? "redis-fallback" :
                (missDelta > 0 || dbDelta > 0 ? "redis-miss" : "redis-hit");
        }

        if (state.mode !== mode) {
            setMode(mode);
            renderMachineMetrics();
        }
        showDetectedTraffic(mode, delta, qps);
        state.sceneWaitingForTraffic = false;
        var payload = {
            mode: mode,
            delta: delta,
            qps: qps,
            p99: p99,
            source: source
        };

        if (state.sceneState === "idle" && !state.sceneIntroPlayed) {
            startSceneIntro(payload);
            return;
        }

        state.sceneLastTraffic = payload;
        if (sceneIntroIsRunning()) {
            state.pendingSceneRoute = { source: source, qps: qps };
            setLabSceneState(state.sceneState, payload);
            return;
        }

        if (state.sceneState === "lab_running") {
            setLabSceneState("lab_running", payload);
            if (directDelta > 0 || cachedDelta > 0) {
                playRoute(source, qps);
            }
        }
    }

    function renderMachineMetrics() {
        var chapter = state.snapshot && state.snapshot.archiveRead;
        if (!chapter) {
            byId("route-qps").textContent = "0";
            byId("route-db-reads").textContent = "0";
            byId("route-hit-rate").textContent = "0";
            byId("mysql-pool-state").textContent = "POOL 0 / 0";
            byId("mysql-pressure-ring").style.setProperty("--pool-usage", 0);
            return;
        }

        var activePath = state.mode === "cached" ? chapter.cached : chapter.direct;
        var ttl = Number(chapter.cacheTTLSeconds || 0);
        var usage = activePath.poolCapacity > 0 ?
            clamp(activePath.poolPeak * 100 / activePath.poolCapacity, 0, 100) : 0;

        // 中央锚点数字直接取 SSE snapshot，不对 QPS、DB Reads 或命中率做视觉插值。
        byId("route-qps").textContent = formatNumber(activePath.qps);
        byId("route-db-reads").textContent = formatNumber(activePath.dbReads);
        byId("route-hit-rate").textContent = formatNumber(activePath.cacheHitRate);
        byId("mysql-pool-state").textContent =
            "POOL " + formatNumber(activePath.poolPeak) + " / " + formatNumber(activePath.poolCapacity);
        byId("mysql-pressure-ring").style.setProperty("--pool-usage", usage.toFixed(2));
        byId("redis-ttl-value").textContent = "TTL " + formatNumber(ttl) + "s";
    }

    function renderSnapshot(snapshot) {
        if (!snapshot || !snapshot.archiveRead) {
            return;
        }
        state.snapshot = snapshot;
        var chapter = snapshot.archiveRead;
        byId("ttl-seconds").textContent = formatNumber(chapter.cacheTTLSeconds);
        renderPath("direct", chapter.direct);
        renderPath("cached", chapter.cached);
        renderComparison(chapter.direct, chapter.cached);
        renderMachineMetrics();
        detectRealActivity(chapter);
    }

    async function fetchSnapshot() {
        try {
            var result = await requestJSON("/api/metrics/snapshot");
            renderSnapshot(result.body);
            setConnection(true);
        } catch (_) {
            setConnection(false);
        }
    }

    function setConnection(connected) {
        var badge = byId("connection-state");
        badge.classList.toggle("is-live", connected);
        badge.innerHTML = "<i></i>" +
            (connected ? "实验服务在线 · LIVE" : "实验服务连接失败");
    }

    function connectMetrics() {
        if (!window.EventSource) {
            state.pollTimer = window.setInterval(fetchSnapshot, 1500);
            return;
        }
        state.stream = new EventSource("/api/metrics/stream");
        state.stream.addEventListener("metrics", function (event) {
            try {
                renderSnapshot(JSON.parse(event.data));
                setConnection(true);
            } catch (_) {
                setConnection(false);
            }
        });
        state.stream.onerror = function () {
            setConnection(false);
        };
    }

    async function resetChapter() {
        var buttons = [byId("reset-chapter"), byId("reset-story-top")];
        var retainedArchive = selectedArchive();
        buttons.forEach(function (button) {
            button.disabled = true;
        });
        try {
            var result = await requestJSON("/api/chapters/cache-aside/reset", { method: "POST" });
            state.previousArchiveRead = null;
            state.manualReplayGuard = null;
            state.waitingMode = null;
            state.isQuerying = false;
            state.isReplaying = false;
            resetLabScene();
            byId("redis-slot-active").classList.remove("is-filled");
            byId("redis-ttl-ring").style.setProperty("--ttl-remaining", 0);
            if (state.ttlTween) {
                state.ttlTween.kill();
                state.ttlTween = null;
            }
            renderSnapshot({
                archiveRead: result.body.snapshot || {
                    cacheTTLSeconds: 300,
                    direct: {},
                    cached: {}
                }
            });
            setMode("direct");
            if (retainedArchive) {
                selectMaterial(retainedArchive);
            } else {
                clearMaterialSelection();
                showMissingMaterialPrompt();
            }
            resetRouteVisual();
            var loadState = byId("loadtest-state");
            loadState.className = "loadtest-state";
            loadState.querySelector("strong").textContent = "等待终端流量";
            loadState.querySelector("p").textContent =
                "运行上方命令后，SSE 检测到请求增长才会驱动链路动画。";
            showToast("Redis 缓存和本实验指标已经清空。", "success");
        } catch (error) {
            showToast(error.message, "danger");
        } finally {
            buttons.forEach(function (button) {
                button.disabled = false;
            });
            syncSceneControls();
        }
    }

    async function loadArchives() {
        var result = await requestJSON("/api/archives");
        state.archives = result.body || [];
        renderMaterialTabs();
        var materialId = incomingMaterialId();
        var archive = state.archives.find(function (item) { return item.id === materialId; });
        if (archive) {
            selectMaterial(archive);
        } else {
            clearMaterialSelection();
            showMissingMaterialPrompt();
        }
    }

    function closeDrawers(restoreFocus) {
        var materialPanel = byId("material-panel");
        var controlPanel = byId("control-panel");
        var backdrop = byId("drawer-backdrop");
        var materialButton = byId("open-material-panel");
        var controlButton = byId("open-control-panel");
        var wasSelectingMaterial = state.terminalState === "material-selecting";

        materialPanel.classList.remove("is-drawer-open");
        controlPanel.classList.remove("is-drawer-open");
        backdrop.classList.remove("is-visible");
        document.body.classList.remove("has-drawer-open");
        materialButton.setAttribute("aria-expanded", "false");
        controlButton.setAttribute("aria-expanded", "false");

        if (restoreFocus && state.drawerTrigger) {
            state.drawerTrigger.focus();
        }
        state.drawerTrigger = null;

        if (wasSelectingMaterial) {
            if (state.terminalBeforeSelecting === "record-visible" && state.lastRead) {
                setTerminalState("record-visible", state.lastRead.archive, state.lastRead);
            } else {
                showSelectionState(selectedArchive());
            }
        }
    }

    function openDrawer(name, trigger) {
        if (name === "material" && (state.isQuerying || state.isReplaying)) {
            showToast("本次查询完成后可更换材料。", "danger");
            return;
        }
        var panel = byId(name === "control" ? "control-panel" : "material-panel");
        var button = byId(name === "control" ? "open-control-panel" : "open-material-panel");

        closeDrawers(false);
        state.drawerTrigger = trigger;
        panel.classList.add("is-drawer-open");
        byId("drawer-backdrop").classList.add("is-visible");
        document.body.classList.add("has-drawer-open");
        button.setAttribute("aria-expanded", "true");
        panel.setAttribute("tabindex", "-1");
        panel.focus({ preventScroll: true });
        if (name === "material") {
            state.terminalBeforeSelecting = state.terminalState;
            setTerminalState("material-selecting", selectedArchive(), state.lastRead);
        }
    }

    function fitStage(announce) {
        var canvas = byId("architecture-canvas");
        var svg = canvas.querySelector(".route-svg");
        svg.setAttribute("viewBox", "0 0 1000 540");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.removeProperty("width");
        svg.style.removeProperty("height");
        canvas.classList.remove("is-fit-confirmed");
        void canvas.offsetWidth;
        canvas.classList.add("is-fit-confirmed");
        window.setTimeout(function () {
            canvas.classList.remove("is-fit-confirmed");
        }, 500);
        if (announce !== false) {
            showToast("中央舞台已适应当前窗口。", "success");
        }
    }

    function setFocusMode(active) {
        var button = byId("focus-stage");
        document.body.classList.toggle("is-focus-mode", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.textContent = active ? "退出聚焦" : "全屏聚焦";
        if (active) {
            closeDrawers(false);
        }
        window.requestAnimationFrame(function () {
            fitStage(false);
        });
    }

    async function toggleFocusMode() {
        var active = document.body.classList.contains("is-focus-mode");
        var routePanel = document.querySelector(".route-panel");

        if (active) {
            setFocusMode(false);
            if (document.fullscreenElement && document.exitFullscreen) {
                try {
                    await document.exitFullscreen();
                } catch (_) {
                    // CSS Focus Mode 已退出；原生全屏退出失败时保留可用界面。
                }
            }
            return;
        }

        setFocusMode(true);
        if (routePanel.requestFullscreen) {
            try {
                await routePanel.requestFullscreen();
            } catch (_) {
                // 浏览器拒绝原生全屏时，继续使用等价的页面内 Focus Mode。
            }
        }
    }

    function enterPurchaseExperiment() {
        var archive = state.readModelArchive;
        document.dispatchEvent(new CustomEvent("purchase-experiment:enter", {
            detail: { materialId: archive && archive.id }
        }));
        showToast("已进入购买实验入口；当前只读查看没有占用材料，提交购买时会重新校验库存。", "success");
    }

    function bindEvents() {
        byId("rate-range").addEventListener("input", updateParameters);
        byId("connections-range").addEventListener("input", updateParameters);
        byId("read-again").addEventListener("click", function () {
            readSelectedArchive();
        });
        byId("terminal-read-again").addEventListener("click", function () {
            readSelectedArchive();
        });
        byId("start-direct").addEventListener("click", function () {
            setMode("direct");
        });
        byId("start-cached").addEventListener("click", function () {
            setMode("cached");
        });
        byId("copy-command").addEventListener("click", copyActiveCommand);
        byId("reset-chapter").addEventListener("click", resetChapter);
        byId("reset-story-top").addEventListener("click", resetChapter);
        byId("fit-stage").addEventListener("click", function () {
            fitStage(true);
        });
        byId("focus-stage").addEventListener("click", toggleFocusMode);
        byId("camera-exterior").addEventListener("click", function () {
            setCameraView("exterior", true);
        });
        byId("camera-internal").addEventListener("click", function () {
            setCameraView("internal", true);
        });
        byId("scene-intro-control").addEventListener("click", function () {
            if (state.sceneState === "lab_running") {
                replaySceneIntro();
            } else {
                skipSceneIntro();
            }
        });
        byId("enter-purchase-experiment").addEventListener("click", enterPurchaseExperiment);
        byId("terminal-open-directory").addEventListener("click", function (event) {
            openDrawer("material", event.currentTarget);
        });
        byId("terminal-change-material").addEventListener("click", function (event) {
            openDrawer("material", event.currentTarget);
        });
        byId("open-material-panel").addEventListener("click", function (event) {
            openDrawer("material", event.currentTarget);
        });
        byId("open-control-panel").addEventListener("click", function (event) {
            openDrawer("control", event.currentTarget);
        });
        byId("drawer-backdrop").addEventListener("click", function () {
            closeDrawers(true);
        });
        document.querySelector(".material-drawer-close").addEventListener("click", function () {
            closeDrawers(true);
        });
        document.querySelector(".control-drawer-close").addEventListener("click", function () {
            closeDrawers(true);
        });
        document.addEventListener("keydown", function (event) {
            if (event.key !== "Escape") {
                return;
            }
            if (document.body.classList.contains("has-drawer-open")) {
                closeDrawers(true);
            } else if (document.body.classList.contains("is-focus-mode") && !document.fullscreenElement) {
                setFocusMode(false);
            }
        });
        document.addEventListener("fullscreenchange", function () {
            if (!document.fullscreenElement && document.body.classList.contains("is-focus-mode")) {
                setFocusMode(false);
            }
        });
        window.addEventListener("resize", function () {
            var materialDrawerNoLongerNeeded = window.innerWidth >= 1440 &&
                byId("material-panel").classList.contains("is-drawer-open");
            var controlDrawerNoLongerNeeded = window.innerWidth >= 1100 &&
                byId("control-panel").classList.contains("is-drawer-open");
            if (materialDrawerNoLongerNeeded || controlDrawerNoLongerNeeded) {
                closeDrawers(false);
            }
        });
    }

    async function start() {
        if (document.body.classList.contains("market-entry-page")) {
            await startMarketEntryPage();
            return;
        }
        document.documentElement.dataset.animationEngine = window.gsap ?
            "gsap-" + window.gsap.version : "static-fallback";
        bindEvents();
        setCameraView("internal", false);
        setMode("direct");
        updateParameters();
        resetLabScene();
        connectMetrics();
        await fetchSnapshot();
        try {
            await loadArchives();
        } catch (error) {
            showToast(error.message, "danger");
            byId("terminal-title").textContent = "材料目录暂时不可用";
            byId("terminal-primary-line").textContent = "无法载入材料索引";
            byId("terminal-secondary-line").textContent = "请确认服务端、MySQL 与 Redis 已经启动。";
        }
    }

    document.addEventListener("DOMContentLoaded", start);
    window.addEventListener("beforeunload", function () {
        if (document.body.classList.contains("market-entry-page")) {
            return;
        }
        if (state.stream) {
            state.stream.close();
        }
        if (state.pollTimer) {
            window.clearInterval(state.pollTimer);
        }
        killRouteAnimation();
        killSceneIntro();
        if (state.ttlTween) {
            state.ttlTween.kill();
        }
        clearTerminalTimers();
        Object.keys(state.numberFrames).forEach(function (id) {
            window.cancelAnimationFrame(state.numberFrames[id]);
        });
    });
}());
