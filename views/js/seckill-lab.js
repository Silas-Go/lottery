(function () {
    "use strict";

    var state = {
        archives: [],
        selectedId: 3,
        rate: 300,
        connections: 96,
        duration: "20s",
        crystalAwake: false,
        hasReadArchive: false,
        unlocked: { prologue: true },
        currentStage: "prologue",
        stageObserver: null,
        snapshot: null,
        trace: [],
        stream: null,
        pollTimer: null
    };

    function byId(id) { return document.getElementById(id); }
    function number(value) { return Number(value || 0).toLocaleString("zh-CN"); }
    function ms(value) { return number(value) + " ms"; }

    var stageOrder = ["prologue", "the-ledger", "the-crowd", "the-crystal", "comparison", "epilogue"];

    function stageUnlocked(id) {
        return id === "prologue" || Boolean(state.unlocked[id]);
    }

    function setCurrentStage(id) {
        if (!stageUnlocked(id)) { return; }
        state.currentStage = id;
        var index = Math.max(0, stageOrder.indexOf(id));
        byId("compass-fill").style.height = (index * 100 / (stageOrder.length - 1)) + "%";

        Array.prototype.forEach.call(document.querySelectorAll(".story-compass li"), function (item) {
            item.classList.toggle("is-current", item.dataset.stage === id);
        });

        var topStage = id === "the-crowd" ? "the-crowd" :
            id === "the-crystal" || id === "comparison" ? "the-crystal" :
            id === "epilogue" ? "epilogue" : "prologue";
        Array.prototype.forEach.call(document.querySelectorAll(".chapter-rail a"), function (link) {
            link.classList.toggle("is-current", link.dataset.storyTarget === topStage);
        });
    }

    function refreshProgressControls() {
        Array.prototype.forEach.call(document.querySelectorAll("[data-story-target]"), function (control) {
            var target = control.dataset.storyTarget;
            var unlocked = stageUnlocked(target);
            control.classList.toggle("is-locked", !unlocked);
            if (control.tagName === "A") {
                control.setAttribute("aria-disabled", unlocked ? "false" : "true");
            }
            var compassItem = control.closest(".story-compass li");
            if (compassItem) { compassItem.classList.toggle("is-locked", !unlocked); }
        });
    }

    function unlockStage(id, shouldScroll) {
        var section = byId(id);
        if (!section) { return; }
        var firstReveal = !stageUnlocked(id);
        state.unlocked[id] = true;
        section.classList.remove("is-concealed");
        if (firstReveal) {
            section.classList.add("is-revealing");
            window.setTimeout(function () { section.classList.remove("is-revealing"); }, 1150);
        }
        refreshProgressControls();
        setCurrentStage(id);
        if (shouldScroll !== false) {
            window.setTimeout(function () {
                section.scrollIntoView({ behavior: "smooth", block: "start" });
            }, firstReveal ? 180 : 0);
        }
    }

    function lockProgression() {
        state.unlocked = { prologue: true };
        state.currentStage = "prologue";
        state.crystalAwake = false;
        state.hasReadArchive = false;
        stageOrder.slice(1).forEach(function (id) {
            var section = byId(id);
            if (section) {
                section.classList.add("is-concealed");
                section.classList.remove("is-revealing");
            }
        });
        byId("the-crystal").classList.add("is-dormant");
        byId("archive-footer").classList.add("is-concealed");
        byId("enter-crowd").disabled = true;
        byId("ledger-passage-copy").textContent = "先亲手翻开任意一页。故事只承认真正发生过的读取。";
        byId("read-again").textContent = "请档案员再翻一次";
        refreshProgressControls();
        setCurrentStage("prologue");
    }

    function scrollToStoryStage(id) {
        if (!stageUnlocked(id)) {
            showToast("这一幕还没有发生。先完成眼前的选择。", "");
            return;
        }
        byId(id).scrollIntoView({ behavior: "smooth", block: "start" });
        setCurrentStage(id);
    }

    function observeVisibleStages() {
        if (!window.IntersectionObserver) { return; }
        state.stageObserver = new IntersectionObserver(function (entries) {
            var visible = entries.filter(function (entry) {
                return entry.isIntersecting && stageUnlocked(entry.target.id);
            }).sort(function (a, b) { return b.intersectionRatio - a.intersectionRatio; });
            if (visible.length) { setCurrentStage(visible[0].target.id); }
        }, { root: document.querySelector("main"), rootMargin: "-20% 0px -50% 0px", threshold: [0.08, 0.25, 0.5] });
        stageOrder.forEach(function (id) {
            var section = byId(id);
            if (section) { state.stageObserver.observe(section); }
        });
    }

    function showToast(message, tone) {
        var toast = byId("story-toast");
        toast.textContent = message;
        toast.className = "story-toast is-visible " + (tone || "");
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
        return state.archives.find(function (archive) { return archive.id === state.selectedId; }) || state.archives[0];
    }

    function renderArchive(archive, source) {
        if (!archive) { return; }
        state.selectedId = archive.id;
        byId("archive-number").textContent = String(archive.id).padStart(3, "0");
        byId("archive-sigil").textContent = archive.sigil;
        byId("archive-sigil").style.setProperty("--archive-accent", archive.accent);
        byId("archive-code").textContent = archive.code.replace(/-/g, " ").toUpperCase();
        byId("archive-name").textContent = archive.name;
        byId("archive-title").textContent = archive.title;
        byId("archive-summary").textContent = archive.summary;
        byId("archive-oath").textContent = "“" + archive.oath + "”";
        byId("crowd-profession").textContent = archive.name;
        if (source) { byId("detail-source").textContent = source; }

        Array.prototype.forEach.call(document.querySelectorAll(".profession-tab"), function (tab) {
            var active = Number(tab.dataset.id) === archive.id;
            tab.classList.toggle("is-active", active);
            tab.setAttribute("aria-selected", active ? "true" : "false");
        });
        updateCommands();
    }

    function renderProfessionTabs() {
        var host = byId("profession-tabs");
        host.innerHTML = "";
        state.archives.forEach(function (archive) {
            var button = document.createElement("button");
            button.className = "profession-tab";
            button.type = "button";
            button.dataset.id = archive.id;
            button.setAttribute("role", "tab");
            button.innerHTML = "<span>" + archive.sigil + "</span><div><strong>" + archive.name + "</strong><small>" + archive.code.toUpperCase() + "</small></div>";
            button.addEventListener("click", function () {
                state.selectedId = archive.id;
                readSelectedArchive();
            });
            host.appendChild(button);
        });
    }

    function sourceLabel(source) {
        switch (source) {
        case "mysql": return "MySQL 真本 · BYPASS";
        case "redis-hit": return "记忆水晶 · CACHE HIT";
        case "redis-miss": return "真本回源 · CACHE MISS";
        case "redis-fallback": return "水晶失联 · MYSQL FALLBACK";
        default: return source || "未知";
        }
    }

    function addTrace(archive, source) {
        var item = {
            time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            name: archive.name,
            source: source,
            label: sourceLabel(source)
        };
        state.trace.unshift(item);
        state.trace = state.trace.slice(0, 5);
        var host = byId("read-trace");
        host.innerHTML = "";
        state.trace.forEach(function (trace) {
            var li = document.createElement("li");
            li.className = "trace-" + trace.source;
            li.innerHTML = "<time>" + trace.time + "</time><span>查阅「" + trace.name + "」</span><strong>" + trace.label + "</strong>";
            host.appendChild(li);
        });
    }

    async function readSelectedArchive() {
        var path = state.crystalAwake ? "cached" : "direct";
        var sheet = byId("archive-sheet");
        sheet.classList.add("is-turning");
        try {
            var result = await requestJSON("/api/archives/" + state.selectedId + "/" + path);
            var source = result.response.headers.get("X-Archive-Source") || "mysql";
            renderArchive(result.body, sourceLabel(source));
            addTrace(result.body, source);
            if (path === "direct") {
                state.hasReadArchive = true;
                byId("enter-crowd").disabled = false;
                byId("ledger-passage-copy").textContent = "「" + result.body.name + "」已经被真正翻阅。城门外，第一批询问者正在靠近。";
            }
        } catch (error) {
            showToast(error.message, "danger");
        } finally {
            window.setTimeout(function () { sheet.classList.remove("is-turning"); }, 360);
        }
    }

    function updateCommands() {
        var id = state.selectedId || 3;
        // 页面已经由完整环境提供；--no-deps 避免每轮只读压测重复启动与本章无关的 RocketMQ 初始化容器。
        var prefix = "docker compose --profile loadtest run --rm --no-deps";
        var common = " -e RATE=" + state.rate + " -e DURATION=" + state.duration +
            " -e CONNECTIONS=" + state.connections + " -e SCRIPT=/opt/wrk2/scripts/read.lua wrk2";
        byId("direct-command").textContent = prefix + " -e TARGET_URL=http://app:5678/api/archives/" + id + "/direct" + common;
        byId("cached-command").textContent = prefix + " -e TARGET_URL=http://app:5678/api/archives/" + id + "/cached" + common;
    }

    async function copyCommand(id, button) {
        var command = byId(id).textContent;
        try {
            await navigator.clipboard.writeText(command);
        } catch (_) {
            var area = document.createElement("textarea");
            area.value = command;
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            area.remove();
        }
        var original = button.textContent;
        button.textContent = "已复制";
        showToast("指令已抄好。现在，让来访者从终端出发。", "success");
        window.setTimeout(function () { button.textContent = original; }, 1600);
    }

    function renderPath(prefix, path) {
        byId(prefix + "-total").textContent = number(path.totalRequests);
        if (prefix === "direct") {
            byId("direct-db-reads").textContent = number(path.dbReads);
            byId("direct-qps").textContent = number(path.qps);
            byId("direct-p99").textContent = ms(path.p99);
            byId("direct-errors").textContent = number(path.errors);
            byId("direct-pool").textContent = number(path.poolPeak) + " / " + number(path.poolCapacity);
        } else {
            byId("cached-hits").textContent = number(path.cacheHits);
            byId("cached-misses").textContent = number(path.cacheMisses);
            byId("cached-db-reads").textContent = number(path.dbReads);
            byId("cached-hit-rate").textContent = number(path.cacheHitRate) + "%";
            byId("cached-p99").textContent = ms(path.p99);
        }
    }

    function renderDamage(direct) {
        var reads = direct.dbReads || 0;
        var percent = Math.min(100, Math.round(reads / 30));
        var label = "尚未开始";
        var prose = "终端中的第一位来访者抵达后，书页才会开始留下痕迹。";
        var stateName = "quiet";
        if (reads > 0 && reads < 300) {
            label = "页角发热";
            prose = "档案员仍能回答，但每一个请求都让他重新走完长廊。";
            stateName = "warm";
        } else if (reads < 1200 && reads >= 300) {
            label = "装订松动";
            prose = "重复的问题没有带来新知识，只带来了 " + number(reads) + " 次真本翻阅。";
            stateName = "worn";
        } else if (reads >= 1200 && reads < 3000) {
            label = "书脊开裂";
            prose = "档案员开始跟不上人群。真本没有错，错的是所有读请求都必须惊动它。";
            stateName = "cracked";
        } else if (reads >= 3000) {
            label = "不该再翻了";
            prose = "这本书正被同一个问题翻烂。现在，我们终于有理由改变那条旧规矩。";
            stateName = "broken";
        }
        byId("damage-label").textContent = label;
        byId("damage-prose").textContent = prose;
        byId("damage-fill").style.width = percent + "%";
        byId("book-cover").dataset.damage = stateName;
        byId("book-cover").style.setProperty("--damage", percent + "%");
        byId("book-whisper").textContent = prose;
        var reveal = byId("awaken-crystal");
        reveal.disabled = reads < 20;
        reveal.querySelector("span").textContent = reads < 20 ? "至少留下 20 次真实翻阅作为证据" : "真本已经被翻阅 " + number(reads) + " 次";
    }

    function perThousand(path) {
        if (!path.totalRequests) { return null; }
        return Math.round(path.dbReads * 1000 / path.totalRequests);
    }

    function renderComparison(direct, cached) {
        var directRate = perThousand(direct);
        var cachedRate = perThousand(cached);
        byId("direct-per-thousand").textContent = directRate === null ? "—" : number(directRate);
        byId("cached-per-thousand").textContent = cachedRate === null ? "—" : number(cachedRate);
        byId("direct-compare-p99").textContent = direct.totalRequests ? ms(direct.p99) : "—";
        byId("cached-compare-p99").textContent = cached.totalRequests ? ms(cached.p99) : "—";

        if (directRate === null || cachedRate === null) {
            byId("read-reduction").textContent = "等待两轮实验";
            byId("verdict-copy").textContent = "完成旧规矩与记忆水晶的两轮来访后，这里才会给出结论。";
            byId("next-chapter").classList.add("is-locked");
            byId("next-chapter").querySelector("span").textContent = "NEXT CHAPTER · LOCKED";
            return;
        }
        var reduction = directRate > 0 ? Math.max(0, (directRate - cachedRate) * 100 / directRate) : 0;
        var reductionText = reduction.toFixed(1).replace(".0", "");
        byId("read-reduction").textContent = reductionText + "%";
        byId("verdict-copy").textContent = "每千次相同问询，MySQL 从 " + number(directRate) + " 次翻阅降到 " + number(cachedRate) + " 次。水晶没有改变答案，只改变了答案走过的路。";
        byId("next-chapter").classList.remove("is-locked");
        byId("next-chapter").querySelector("span").textContent = "NEXT CHAPTER · UNLOCKED";
    }

    function renderSnapshot(snapshot) {
        if (!snapshot || !snapshot.archiveRead) { return; }
        state.snapshot = snapshot;
        var chapter = snapshot.archiveRead;
        byId("ttl-seconds").textContent = number(chapter.cacheTTLSeconds);
        renderPath("direct", chapter.direct);
        renderPath("cached", chapter.cached);
        renderDamage(chapter.direct);
        renderComparison(chapter.direct, chapter.cached);
        var cachedCount = chapter.cached.totalRequests || 0;
        var revealComparison = byId("reveal-comparison");
        revealComparison.disabled = !state.crystalAwake || cachedCount < 20;
        revealComparison.querySelector("span").textContent = cachedCount < 20
            ? "还差 " + number(20 - cachedCount) + " 次真实回答，才足以形成答卷"
            : "水晶已经留下 " + number(cachedCount) + " 次真实回答";
        byId("enter-epilogue").disabled = !(chapter.direct.totalRequests > 0 && chapter.cached.totalRequests > 0);
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
        badge.innerHTML = "<i></i>" + (connected ? "档案员在线 · LIVE" : "与档案馆失去联系");
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
            } catch (_) { setConnection(false); }
        });
        state.stream.onerror = function () { setConnection(false); };
    }

    async function awakenCrystal() {
        state.crystalAwake = true;
        byId("the-crystal").classList.remove("is-dormant");
        unlockStage("the-crystal", true);
        byId("read-again").textContent = "向记忆水晶再问一次";
        showToast("水晶醒了。它的第一次回答，仍需要翻阅真本。", "success");
        await readSelectedArchive();
    }

    function openLedger() {
        unlockStage("the-ledger", true);
        showToast("请亲手选择一页。第一次翻阅必须惊动真本。", "");
    }

    function enterCrowd() {
        if (!state.hasReadArchive) {
            showToast("故事还缺少一次真正的翻阅。", "");
            return;
        }
        unlockStage("the-crowd", true);
    }

    function revealComparison() {
        var cached = state.snapshot && state.snapshot.archiveRead && state.snapshot.archiveRead.cached;
        if (!cached || cached.totalRequests < 20) {
            showToast("让水晶再多回答一些，数字才有资格成为答卷。", "");
            return;
        }
        unlockStage("comparison", true);
    }

    function enterEpilogue() {
        unlockStage("epilogue", true);
        byId("archive-footer").classList.remove("is-concealed");
    }

    async function resetChapter(trigger) {
        var buttons = [byId("reset-chapter"), byId("reset-story-top")];
        buttons.forEach(function (button) { button.disabled = true; });
        try {
            await requestJSON("/api/chapters/cache-aside/reset", { method: "POST" });
            state.trace = [];
            byId("read-trace").innerHTML = "";
            lockProgression();
            renderSnapshot({ archiveRead: {
                cacheTTLSeconds: 300,
                direct: {},
                cached: {}
            } });
            renderArchive(selectedArchive(), "目录预览");
            document.querySelector("main").scrollTo({ top: 0, behavior: "smooth" });
            showToast("书本已经合拢。故事可以重新开始。", "success");
        } catch (error) {
            showToast(error.message, "danger");
        } finally {
            buttons.forEach(function (button) { button.disabled = false; });
        }
    }

    async function loadArchives() {
        var result = await requestJSON("/api/archives");
        state.archives = result.body || [];
        if (!state.archives.some(function (archive) { return archive.id === state.selectedId; })) {
            state.selectedId = state.archives.length ? state.archives[0].id : 1;
        }
        renderProfessionTabs();
        renderArchive(selectedArchive(), "目录预览");
    }

    function bindEvents() {
        byId("open-ledger").addEventListener("click", openLedger);
        byId("read-again").addEventListener("click", readSelectedArchive);
        byId("enter-crowd").addEventListener("click", enterCrowd);
        byId("copy-direct").addEventListener("click", function () { copyCommand("direct-command", this); });
        byId("copy-cached").addEventListener("click", function () { copyCommand("cached-command", this); });
        byId("awaken-crystal").addEventListener("click", awakenCrystal);
        byId("reveal-comparison").addEventListener("click", revealComparison);
        byId("enter-epilogue").addEventListener("click", enterEpilogue);
        byId("reset-chapter").addEventListener("click", function () { resetChapter(this); });
        byId("reset-story-top").addEventListener("click", function () { resetChapter(this); });
        Array.prototype.forEach.call(document.querySelectorAll("[data-story-target]"), function (control) {
            control.addEventListener("click", function (event) {
                event.preventDefault();
                scrollToStoryStage(control.dataset.storyTarget);
            });
        });
        Array.prototype.forEach.call(document.querySelectorAll(".pressure-picker button"), function (button) {
            button.addEventListener("click", function () {
                Array.prototype.forEach.call(document.querySelectorAll(".pressure-picker button"), function (peer) { peer.classList.remove("is-active"); });
                button.classList.add("is-active");
                state.rate = Number(button.dataset.rate);
                state.connections = Number(button.dataset.connections);
                updateCommands();
            });
        });
    }

    async function start() {
        lockProgression();
        bindEvents();
        observeVisibleStages();
        updateCommands();
        connectMetrics();
        await fetchSnapshot();
        try {
            await loadArchives();
        } catch (error) {
            showToast(error.message, "danger");
            byId("archive-name").textContent = "档案馆暂时没有回应";
            byId("archive-summary").textContent = "请确认服务端、MySQL 与 Redis 已经启动。";
        }
    }

    document.addEventListener("DOMContentLoaded", start);
    window.addEventListener("beforeunload", function () {
        if (state.stream) { state.stream.close(); }
        if (state.pollTimer) { window.clearInterval(state.pollTimer); }
    });
}());
