(function () {
    "use strict";

    var state = {
        archives: [],
        selectedId: 4,
        mode: "direct",
        rate: 300,
        connections: 96,
        duration: "20s",
        snapshot: null,
        previousArchiveRead: null,
        trace: [],
        stream: null,
        pollTimer: null,
        waitingMode: null,
        routeTimeline: null,
        ttlTween: null,
        numberFrames: {},
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

    async function requestJSON(url, options) {
        var response = await fetch(url, options || {});
        var raw = await response.text();
        var body = raw ? JSON.parse(raw) : null;
        if (!response.ok) {
            throw new Error((body && body.message) || "请求失败（" + response.status + "）");
        }
        return { body: body, response: response };
    }

    function selectedArchive() {
        return state.archives.find(function (archive) {
            return archive.id === state.selectedId;
        }) || state.archives[0];
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
            summary: archive ? archive.summary : "服务端没有返回材料详情。",
            note: archive ? archive.oath : "MySQL 是权威数据源。"
        };
    }

    function renderMaterial(archive, source) {
        if (!archive) {
            return;
        }
        var material = materialForArchive(archive);
        state.selectedId = archive.id;

        document.body.dataset.materialKind = material.kind;
        document.body.style.setProperty("--material-accent", material.accent);
        document.body.style.setProperty("--material-rgb", material.rgb);

        byId("archive-number").textContent = String(material.id).padStart(3, "0");
        byId("archive-sigil").textContent = material.sigil;
        byId("archive-rarity").textContent = material.rarity;
        byId("archive-code").textContent = material.code;
        byId("archive-name").textContent = material.name;
        byId("archive-title").textContent = material.title;
        byId("archive-summary").textContent = material.summary;
        byId("archive-note").textContent = material.note;
        byId("redis-key-label").textContent = "archive:profession:" + material.id;
        if (source) {
            byId("detail-source").textContent = source;
        }

        Array.prototype.forEach.call(document.querySelectorAll(".material-option"), function (button) {
            var active = Number(button.dataset.id) === archive.id;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-selected", active ? "true" : "false");
        });
        updateCommands();
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
            button.setAttribute("role", "tab");
            button.style.setProperty("--option-accent", material.accent);
            button.innerHTML =
                "<i>" + material.sigil + "</i>" +
                "<span><strong>" + material.name + "</strong><small>" + material.rarity + "</small></span>";
            button.addEventListener("click", function () {
                state.selectedId = archive.id;
                renderMaterial(archive, "目录预览");
                readSelectedArchive();
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

    function addTrace(archive, source) {
        var material = materialForArchive(archive);
        state.trace.unshift({
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            name: material.name,
            source: source,
            label: sourceLabel(source)
        });
        state.trace = state.trace.slice(0, 4);

        var host = byId("read-trace");
        host.innerHTML = "";
        state.trace.forEach(function (trace) {
            var item = document.createElement("li");
            item.className = "trace-" + trace.source;
            item.innerHTML =
                "<time>" + trace.time + "</time>" +
                "<span>读取「" + trace.name + "」</span>" +
                "<strong>" + trace.label + "</strong>";
            host.appendChild(item);
        });
    }

    function setMode(mode) {
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
    }

    function updateCommands() {
        var id = state.selectedId || 4;
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
        var command = state.mode === "cached" ? state.cachedCommand : state.directCommand;
        await copyText(command);
        state.waitingMode = state.mode;
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
        var mode = explicitMode || state.mode;
        var path = mode === "cached" ? "cached" : "direct";
        var sheet = byId("archive-sheet");
        sheet.classList.add("is-loading");
        byId("route-status").textContent = "请求进行中";

        try {
            var result = await requestJSON("/api/archives/" + state.selectedId + "/" + path);
            // 单次读取只相信协议头；缺失时明确显示 UNKNOWN，不根据当前按钮猜测来源。
            var source = result.response.headers.get("X-Archive-Source") || "unknown";
            renderMaterial(result.body, sourceLabel(source));
            addTrace(result.body, source);
            playRoute(source, 0);
        } catch (error) {
            byId("route-status").textContent = "请求失败";
            showToast(error.message, "danger");
        } finally {
            window.setTimeout(function () {
                sheet.classList.remove("is-loading");
            }, 220);
        }
    }

    async function activateExperiment(mode) {
        setMode(mode);
        await readSelectedArchive(mode);
        await copyActiveCommand();
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
                status: "MySQL Direct · Direct Bypass",
                source: source,
                valve: 123
            };
        case "redis-hit":
            return {
                state: "hit",
                status: "Cache Hit · MySQL 未参与",
                source: source,
                valve: 58
            };
        case "redis-miss":
            return {
                state: "miss",
                status: "Cache Miss · MySQL → Redis SET EX → Response",
                source: source,
                valve: 58
            };
        case "redis-fallback":
            return {
                state: "fallback",
                status: "Redis Fallback · Safety Bypass → MySQL",
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

    function playRoute(source, qps) {
        var route = routeDefinition(source);
        killRouteAnimation();

        if (!route) {
            document.body.dataset.routeState = "unknown";
            byId("route-status").textContent = "未知响应来源 · 未推断链路";
            byId("route-source").textContent = sourceLabel(source);
            return;
        }

        document.body.dataset.routeState = route.state;
        byId("route-status").textContent = route.status;
        byId("route-source").textContent = sourceLabel(source);

        if (state.reducedMotion || !window.gsap) {
            applyStaticRoute(route);
            return;
        }

        state.routeTimeline = window.gsap.timeline({
            defaults: { ease: "power2.inOut" },
            onComplete: function () {
                state.routeTimeline = null;
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
                qps: Number(chapter.direct.qps || 0)
            },
            cached: {
                totalRequests: Number(chapter.cached.totalRequests || 0),
                qps: Number(chapter.cached.qps || 0),
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
        if (!previous) {
            return;
        }

        var directDelta = current.direct.totalRequests - previous.direct.totalRequests;
        var cachedDelta = current.cached.totalRequests - previous.cached.totalRequests;
        var hitDelta = current.cached.cacheHits - previous.cached.cacheHits;
        var missDelta = current.cached.cacheMisses - previous.cached.cacheMisses;
        var errorDelta = current.cached.cacheErrors - previous.cached.cacheErrors;
        var dbDelta = current.cached.dbReads - previous.cached.dbReads;

        if (directDelta > 0) {
            showDetectedTraffic("direct", directDelta, current.direct.qps);
        }
        if (cachedDelta > 0) {
            showDetectedTraffic("cached", cachedDelta, current.cached.qps);
        }

        if (cachedDelta > 0 && (state.mode === "cached" || directDelta === 0)) {
            if (errorDelta > 0) {
                playRoute("redis-fallback", current.cached.qps);
            } else if (missDelta > 0 || dbDelta > 0) {
                playRoute("redis-miss", current.cached.qps);
            } else if (hitDelta > 0) {
                playRoute("redis-hit", current.cached.qps);
            }
        } else if (directDelta > 0) {
            playRoute("mysql", current.direct.qps);
        } else if (cachedDelta > 0) {
            playRoute(
                errorDelta > 0 ? "redis-fallback" :
                    (missDelta > 0 || dbDelta > 0 ? "redis-miss" : "redis-hit"),
                current.cached.qps
            );
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
        buttons.forEach(function (button) {
            button.disabled = true;
        });
        try {
            var result = await requestJSON("/api/chapters/cache-aside/reset", { method: "POST" });
            state.trace = [];
            state.previousArchiveRead = null;
            byId("read-trace").innerHTML = "";
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
            renderMaterial(selectedArchive(), "目录预览");
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
        }
    }

    async function loadArchives() {
        var result = await requestJSON("/api/archives");
        state.archives = result.body || [];
        if (!state.archives.some(function (archive) {
            return archive.id === state.selectedId;
        })) {
            state.selectedId = state.archives.length ? state.archives[0].id : 1;
        }
        renderMaterialTabs();
        renderMaterial(selectedArchive(), "目录预览");
    }

    function bindEvents() {
        byId("rate-range").addEventListener("input", updateParameters);
        byId("connections-range").addEventListener("input", updateParameters);
        byId("read-again").addEventListener("click", function () {
            readSelectedArchive();
        });
        byId("start-direct").addEventListener("click", function () {
            activateExperiment("direct");
        });
        byId("start-cached").addEventListener("click", function () {
            activateExperiment("cached");
        });
        byId("copy-command").addEventListener("click", copyActiveCommand);
        byId("reset-chapter").addEventListener("click", resetChapter);
        byId("reset-story-top").addEventListener("click", resetChapter);
    }

    async function start() {
        document.documentElement.dataset.animationEngine = window.gsap ?
            "gsap-" + window.gsap.version : "static-fallback";
        bindEvents();
        setMode("direct");
        updateParameters();
        connectMetrics();
        await fetchSnapshot();
        try {
            await loadArchives();
        } catch (error) {
            showToast(error.message, "danger");
            byId("archive-name").textContent = "材料目录暂时不可用";
            byId("archive-summary").textContent = "请确认服务端、MySQL 与 Redis 已经启动。";
        }
    }

    document.addEventListener("DOMContentLoaded", start);
    window.addEventListener("beforeunload", function () {
        if (state.stream) {
            state.stream.close();
        }
        if (state.pollTimer) {
            window.clearInterval(state.pollTimer);
        }
        killRouteAnimation();
        if (state.ttlTween) {
            state.ttlTween.kill();
        }
        Object.keys(state.numberFrames).forEach(function (id) {
            window.cancelAnimationFrame(state.numberFrames[id]);
        });
    });
}());
