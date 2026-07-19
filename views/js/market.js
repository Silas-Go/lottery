(function () {
    "use strict";

    var STORAGE_KEY = "silas.cache-aside.material-id";
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
    var crowdBaseline = null;
    var crowdArmed = false;
    var crowdTransitionStarted = false;

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
            crowd_armed: "召集人潮",
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
        return "docker compose --profile loadtest run --rm --no-deps " +
            "-e RATE=300 -e DURATION=20s -e CONNECTIONS=96 " +
            "-e TARGET_URL=http://app:5678/api/archives/" + materialNumericId() + "/cached " +
            "-e SCRIPT=/opt/wrk2/scripts/read.lua wrk2";
    }

    function updateCrowdTicketCodes() {
        Array.prototype.forEach.call(document.querySelectorAll("[data-crowd-ticket]"), function (ticket) {
            ticket.textContent = selectedCode || "ARC-???";
        });
    }

    function selectMaterial(code) {
        var material = materials[code];
        if (!material || state !== "choosing") {
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

    function stopCrowdMetrics() {
        if (crowdStream) {
            crowdStream.close();
            crowdStream = null;
        }
    }

    function readCrowdTotal(snapshot) {
        return Number(snapshot && snapshot.archiveRead && snapshot.archiveRead.cached &&
            snapshot.archiveRead.cached.totalRequests || 0);
    }

    async function primeCrowdBaseline() {
        try {
            var response = await fetch("/api/metrics/snapshot");
            if (!response.ok) {
                return;
            }
            var total = readCrowdTotal(await response.json());
            if (crowdBaseline === null || !crowdArmed) {
                crowdBaseline = total;
            } else if (total > crowdBaseline) {
                startCrowdSubmission();
            }
        } catch (_) {
            // SSE 连接成功后仍可建立基线。
        }
    }

    function startCrowdSubmission() {
        if (crowdTransitionStarted || !selectedCode) {
            return;
        }
        crowdTransitionStarted = true;
        crowdArmed = false;
        stopCrowdMetrics();
        setState("crowd_submitting");
        byId("crowd-status-title").textContent = "检测到外部请求，正在批量投递";
        byId("crowd-status-copy").textContent = "请求档案已经进入槽口，视角将跟随它们进入系统。";
        byId("market-announcer").textContent = "检测到真实外部请求，人群开始投递档案片";
        animateRecordIntoSlot();

        window.setTimeout(function () {
            setState("entering_lab");
            byId("accepted-stamp").setAttribute("aria-hidden", "false");
            byId("market-announcer").textContent = "正在跟随请求档案进入系统内部";
            window.setTimeout(function () {
                window.location.assign("/lab?material=" + encodeURIComponent(selectedCode) + "&mode=cached&entry=crowd");
            }, reducedMotion ? 80 : 760);
        }, reducedMotion ? 60 : 950);
    }

    function handleCrowdMetrics(snapshot) {
        var total = readCrowdTotal(snapshot);
        if (crowdBaseline === null) {
            crowdBaseline = total;
            return;
        }
        if (!crowdArmed) {
            crowdBaseline = total;
            return;
        }
        if (total > crowdBaseline) {
            startCrowdSubmission();
        }
    }

    function connectCrowdMetrics() {
        if (crowdStream || !window.EventSource) {
            return;
        }
        crowdStream = new EventSource("/api/metrics/stream");
        crowdStream.addEventListener("metrics", function (event) {
            try {
                handleCrowdMetrics(JSON.parse(event.data));
            } catch (_) {
                // 下一条真实指标仍可继续检测。
            }
        });
    }

    function openCrowdMode() {
        if (!selectedCode || state !== "record_selected") {
            return;
        }
        crowdArmed = false;
        crowdTransitionStarted = false;
        crowdBaseline = null;
        byId("market-load-command").textContent = crowdCommand();
        byId("crowd-status-title").textContent = "等待外部请求到达";
        byId("crowd-status-copy").textContent = "人群已在门口排队，但尚未开始投递。";
        setState("crowd_preparing");
        primeCrowdBaseline();
        connectCrowdMetrics();
        byId("copy-market-command").focus({ preventScroll: true });
    }

    async function copyCrowdCommand() {
        if (state !== "crowd_preparing" && state !== "crowd_armed") {
            return;
        }
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
        crowdArmed = true;
        setState("crowd_armed");
        byId("crowd-status-title").textContent = "已准备，等待你在终端执行";
        byId("crowd-status-copy").textContent = "队伍已经扩充；只有检测到真实请求后，他们才会开始投递。";
        showToast("压测命令已复制");
        byId("market-announcer").textContent = "压测命令已复制，队伍已准备，等待终端执行";
        if (crowdBaseline === null) {
            primeCrowdBaseline();
        }
        connectCrowdMetrics();
    }

    function leaveCrowdMode() {
        if (state !== "crowd_preparing" && state !== "crowd_armed") {
            return;
        }
        crowdArmed = false;
        crowdBaseline = null;
        stopCrowdMetrics();
        setState("record_selected");
        byId("crowd-test").focus({ preventScroll: true });
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
                window.location.assign("/lab?material=" + encodeURIComponent(selectedCode) + "&mode=direct&entry=single");
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
            if (state !== "record_selected" && state !== "crowd_preparing" && state !== "crowd_armed") {
                return;
            }
            crowdArmed = false;
            crowdBaseline = null;
            stopCrowdMetrics();
            selectedCode = null;
            setState("choosing");
            document.querySelector("[data-material]").focus({ preventScroll: true });
        });
        byId("single-request").addEventListener("click", enterLab);
        byId("crowd-test").addEventListener("click", openCrowdMode);
        byId("copy-market-command").addEventListener("click", copyCrowdCommand);
        byId("leave-crowd-mode").addEventListener("click", leaveCrowdMode);
    }

    document.addEventListener("DOMContentLoaded", function () {
        bindEvents();
        window.setTimeout(function () {
            if (state === "arrival") {
                setState("dialogue");
                byId("show-materials").focus({ preventScroll: true });
            }
        }, reducedMotion ? 80 : 480);
    });

    window.addEventListener("beforeunload", stopCrowdMetrics);
}());
