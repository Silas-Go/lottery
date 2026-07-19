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
        rememberMaterial(code);
        setState("record_selected");
        byId("insert-record").focus({ preventScroll: true });
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
                window.location.assign("/lab?material=" + encodeURIComponent(selectedCode));
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
            if (state !== "record_selected") {
                return;
            }
            selectedCode = null;
            setState("choosing");
            document.querySelector("[data-material]").focus({ preventScroll: true });
        });
        byId("insert-record").addEventListener("click", enterLab);
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
}());
