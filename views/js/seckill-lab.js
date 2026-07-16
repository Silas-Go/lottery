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
        routeBusy: false,
        queuedRoute: null,
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
            var source = result.response.headers.get("X-Archive-Source") || "mysql";
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
            edge.classList.remove("is-active", "is-hit", "is-miss", "is-error");
        });
        Array.prototype.forEach.call(document.querySelectorAll(".request-pulse"), function (pulse) {
            pulse.classList.remove("is-visible");
        });
    }

    function resetRouteVisual() {
        clearRouteClasses();
        document.body.dataset.routeState = "idle";
        byId("route-status").textContent = "等待真实请求";
        byId("route-source").textContent = "—";
        byId("route-qps").textContent = "0";
        byId("redis-node-state").textContent =
            state.mode === "cached" ? "已进入读取路径" : "当前路径跳过";
    }

    var segmentConfig = {
        "client-api": { edge: "path-client-api", motion: "motion-client-api", nodes: ["node-client", "node-api"] },
        "api-redis": { edge: "path-api-redis", motion: "motion-api-redis", nodes: ["node-api", "node-redis"] },
        "api-mysql": { edge: "path-api-mysql", motion: "motion-api-mysql", nodes: ["node-api", "node-mysql"] },
        "redis-mysql": { edge: "path-redis-mysql", motion: "motion-redis-mysql", nodes: ["node-redis", "node-mysql"] },
        "mysql-redis": { edge: "path-mysql-redis", motion: "motion-mysql-redis", nodes: ["node-mysql", "node-redis"] }
    };

    async function animateSegment(name, tone, qps) {
        var config = segmentConfig[name];
        if (!config) {
            return;
        }
        var edge = byId(config.edge);
        var motion = byId(config.motion);
        var pulse = motion && motion.parentNode;
        var duration = clamp(420 - Number(qps || 0) * 0.22, 190, 380);

        edge.classList.add("is-active", tone);
        config.nodes.forEach(function (id) {
            byId(id).classList.add("is-active", tone);
        });

        if (!state.reducedMotion && motion && typeof motion.beginElement === "function") {
            motion.setAttribute("dur", (duration / 1000).toFixed(2) + "s");
            pulse.classList.add("is-visible");
            motion.beginElement();
        }
        await wait(state.reducedMotion ? 90 : duration);
        if (pulse) {
            pulse.classList.remove("is-visible");
        }
    }

    function routeDefinition(source) {
        switch (source) {
        case "redis-hit":
            return {
                state: "hit",
                status: "Redis Cache Hit · 请求未访问 MySQL",
                segments: ["client-api", "api-redis"],
                tone: "is-hit"
            };
        case "redis-miss":
            return {
                state: "miss",
                status: "Cache Miss · 回源 MySQL 并回填 Redis",
                segments: ["client-api", "api-redis", "redis-mysql", "mysql-redis"],
                tone: "is-miss"
            };
        case "redis-fallback":
            return {
                state: "fallback",
                status: "Redis 异常 · 降级回源 MySQL",
                segments: ["client-api", "api-redis", "redis-mysql"],
                tone: "is-error"
            };
        default:
            return {
                state: "direct",
                status: "MySQL Direct · 每次请求读取数据库",
                segments: ["client-api", "api-mysql"],
                tone: "is-direct"
            };
        }
    }

    async function runRoute(source, qps) {
        state.routeBusy = true;
        clearRouteClasses();

        var route = routeDefinition(source);
        document.body.dataset.routeState = route.state;
        byId("route-status").textContent = route.status;
        byId("route-source").textContent = sourceLabel(source);
        byId("route-qps").textContent = formatNumber(qps);

        if (source === "redis-hit") {
            byId("redis-node-state").textContent = "CACHE HIT";
        } else if (source === "redis-miss") {
            byId("redis-node-state").textContent = "MISS → 已回填";
        } else if (source === "redis-fallback") {
            byId("redis-node-state").textContent = "REDIS ERROR";
        }

        for (var i = 0; i < route.segments.length; i++) {
            await animateSegment(route.segments[i], route.tone, qps);
        }

        if (source === "redis-hit") {
            byId("node-redis").classList.add("is-hit");
        } else if (source === "redis-miss") {
            byId("node-redis").classList.add("is-miss");
            byId("node-mysql").classList.add("is-miss");
        } else if (source === "redis-fallback") {
            byId("node-redis").classList.add("is-error");
            byId("node-mysql").classList.add("is-active");
        } else {
            byId("node-mysql").classList.add("is-active");
        }

        await wait(state.reducedMotion ? 40 : 260);
        state.routeBusy = false;
        if (state.queuedRoute) {
            var queued = state.queuedRoute;
            state.queuedRoute = null;
            runRoute(queued.source, queued.qps);
        }
    }

    function playRoute(source, qps) {
        if (state.routeBusy) {
            state.queuedRoute = { source: source, qps: qps };
            return;
        }
        runRoute(source, qps);
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
        detectRealActivity(chapter);

        var activePath = state.mode === "cached" ? chapter.cached : chapter.direct;
        byId("mysql-pool-state").textContent =
            "Pool " + formatNumber(activePath.poolPeak) + " / " + formatNumber(activePath.poolCapacity);
        var usage = activePath.poolCapacity > 0 ?
            clamp(activePath.poolPeak * 100 / activePath.poolCapacity, 0, 100) : 0;
        byId("mysql-pressure-ring").style.setProperty("--pool-usage", usage + "%");
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
        Object.keys(state.numberFrames).forEach(function (id) {
            window.cancelAnimationFrame(state.numberFrames[id]);
        });
    });
}());
