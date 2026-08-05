(function () {
    "use strict";

    var body = document.body;
    var deck = document.getElementById("experiment-deck");
    var tiles = Array.prototype.slice.call(document.querySelectorAll("[data-experiment]"));
    var summaries = Array.prototype.slice.call(document.querySelectorAll(".experiment-summary"));
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var finePointer = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    var lockedExperiment = "";
    var activeExperiment = "";
    var departing = false;
    var WORLD_TRANSITION_KEY = "silas.world-transition.v1";

    function experimentTile(key) {
        return tiles.find(function (tile) { return tile.dataset.experiment === key; }) || null;
    }

    function renderDeck() {
        deck.classList.toggle("has-active", Boolean(activeExperiment));
        deck.dataset.activeExperiment = activeExperiment;
        deck.dataset.lockedExperiment = lockedExperiment;
        tiles.forEach(function (tile) {
            var key = tile.dataset.experiment;
            var active = key === activeExperiment;
            var locked = key === lockedExperiment;
            var summary = tile.querySelector(".experiment-summary");
            var details = tile.querySelector(".experiment-details");
            tile.classList.toggle("is-active", active);
            tile.classList.toggle("is-locked", locked);
            summary.setAttribute("aria-expanded", String(active));
            summary.setAttribute("aria-pressed", String(locked));
            details.setAttribute("aria-hidden", String(!active));
        });
    }

    function previewExperiment(key) {
        if (lockedExperiment) {
            return;
        }
        activeExperiment = key;
        renderDeck();
    }

    function toggleLock(key) {
        if (lockedExperiment === key) {
            lockedExperiment = "";
            activeExperiment = finePointer && experimentTile(key).matches(":hover") ? key : "";
        } else {
            lockedExperiment = key;
            activeExperiment = key;
        }
        renderDeck();
    }

    function unlockDeck() {
        if (!lockedExperiment) {
            return;
        }
        lockedExperiment = "";
        activeExperiment = "";
        renderDeck();
    }

    function enterExperiment(link) {
        var key = link.dataset.enterExperiment;
        var target = link.getAttribute("href");
        if (departing || !target) {
            return;
        }
        departing = true;
        try {
            window.sessionStorage.setItem(
                WORLD_TRANSITION_KEY,
                key === "seckill" ? "street-to-seckill-lab" : "street-to-material-shop");
        } catch (_) {
            // 该标记只控制页面转场；浏览器禁用存储时仍必须允许进入实验。
        }
        body.classList.add("is-departing");
        document.getElementById("market-announcer").textContent =
            "正在进入" + ({ query: "旁路缓存查询", purchase: "库存一致性购买", seckill: "秒杀交易" }[key] || "实验");
        window.setTimeout(function () {
            window.location.assign(target);
        }, reducedMotion ? 0 : 390);
    }

    tiles.forEach(function (tile) {
        var key = tile.dataset.experiment;
        tile.addEventListener("mouseenter", function () {
            if (finePointer) {
                previewExperiment(key);
            }
        });
        tile.addEventListener("focusin", function () {
            if (!lockedExperiment) {
                activeExperiment = key;
                renderDeck();
            }
        });
        tile.addEventListener("focusout", function () {
            window.setTimeout(function () {
                if (!lockedExperiment && !tile.contains(document.activeElement) &&
                    (!finePointer || !tile.matches(":hover"))) {
                    activeExperiment = "";
                    renderDeck();
                }
            }, 0);
        });
    });

    deck.addEventListener("mouseleave", function () {
        if (finePointer && !lockedExperiment) {
            activeExperiment = "";
            renderDeck();
        }
    });

    summaries.forEach(function (summary) {
        summary.addEventListener("click", function () {
            toggleLock(summary.closest("[data-experiment]").dataset.experiment);
        });
    });

    document.querySelectorAll("[data-enter-experiment]").forEach(function (link) {
        link.addEventListener("click", function (event) {
            event.preventDefault();
            enterExperiment(link);
        });
    });

    document.addEventListener("pointerdown", function (event) {
        if (lockedExperiment && !deck.contains(event.target)) {
            unlockDeck();
        }
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
            unlockDeck();
        }
    });

    window.addEventListener("pageshow", function () {
        departing = false;
        body.classList.remove("is-departing");
    });

    renderDeck();
}());
