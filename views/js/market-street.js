(function () {
    "use strict";

    var sceneConfig = window.SilasMarketSceneConfig;
    var mockFactory = window.SilasSeckillMock;
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var mock = mockFactory.create(reducedMotion ? {
        countdownSeconds: 1,
        countdownStepMs: 120,
        runningDurationMs: 1150,
        spawnMinMs: 160,
        spawnMaxMs: 220,
        requestMinMs: 130,
        requestMaxMs: 180,
        processingMinMs: 70,
        processingMaxMs: 100
    } : {});
    var cardElements = new Map();
    var body = document.body;

    function byId(id) {
        return document.getElementById(id);
    }

    function applySceneLayout() {
        Array.prototype.forEach.call(document.querySelectorAll("[data-scene-key]"), function (element) {
            var position = sceneConfig.elements[element.dataset.sceneKey];
            if (!position) {
                throw new Error("missing market scene position: " + element.dataset.sceneKey);
            }
            element.style.setProperty("--scene-x", position.x + "%");
            element.style.setProperty("--scene-y", position.y + "%");
            element.style.setProperty("--scene-width", position.width + "%");
            element.style.setProperty("--scene-height", position.height + "%");
        });
    }

    function createAmbientParticles() {
        var field = byId("ambient-particles");
        var fragment = document.createDocumentFragment();

        sceneConfig.particles.forEach(function (definition) {
            var particle = document.createElement("i");
            particle.style.setProperty("--scene-x", definition.x + "%");
            particle.style.setProperty("--scene-y", definition.y + "%");
            particle.style.setProperty("--particle-size", definition.size + "px");
            particle.style.setProperty("--particle-opacity", String(definition.opacity));
            particle.style.setProperty("--particle-duration", definition.duration + "s");
            particle.style.setProperty("--particle-delay", definition.delay + "s");
            fragment.appendChild(particle);
        });
        field.appendChild(fragment);
    }

    function setDialogue(mode) {
        var seckill = mode === "seckill";
        body.dataset.dialogue = seckill ? "seckill" : "street";
        byId("street-dialogue").hidden = seckill;
        byId("seckill-dialogue").hidden = !seckill;
    }

    function openSeckillPreview() {
        setDialogue("seckill");
        var state = mock.getSnapshot().state;
        if (state === mockFactory.LabState.IDLE || state === mockFactory.LabState.SOLD_OUT) {
            window.setTimeout(function () { mock.start(); }, reducedMotion ? 0 : 90);
        }
        byId("preview-close").focus({ preventScroll: true });
    }

    function closeSeckillPreview() {
        mock.reset();
        setDialogue("street");
        byId("dialogue-seckill").focus({ preventScroll: true });
    }

    function enterArchiveShop() {
        if (body.classList.contains("is-entering-archive")) {
            return;
        }
        body.classList.add("is-entering-archive");
        byId("market-announcer").textContent = "正在进入材料情报店";
        window.setTimeout(function () {
            window.location.assign("/material-shop");
        }, reducedMotion ? 0 : 260);
    }

    function stateContent(snapshot) {
        var content = {
            idle: {
                title: "秒杀尚未开始",
                copy: "提交口仍暗着。门前只有几位访客在等待限时委托。",
                shop: "秒杀尚未开始",
                announce: "秒杀预览等待开始"
            },
            countdown: {
                title: "魔法潮汐正在接近",
                copy: "暖灯亮起，等待者逐渐靠近提交口。倒计时结束后请求卡片将连续进入。",
                shop: "倒计时 · " + snapshot.remaining,
                announce: "秒杀预览倒计时 " + snapshot.remaining
            },
            running: {
                title: "秒杀进行中",
                copy: "发光卡片以不同速度进入提交口，结果口正返回成功、限流与重复请求标记。",
                shop: "提交口开放",
                announce: "秒杀预览进行中"
            },
            sold_out: {
                title: "本轮凭证已发完",
                copy: "铁门落下，最后一张卡片带着售罄标记返回。门前的等待者开始散去。",
                shop: "已售罄",
                announce: "秒杀预览已售罄"
            }
        };
        return content[snapshot.state] || content.idle;
    }

    function renderLabState(snapshot) {
        var content = stateContent(snapshot);
        body.dataset.seckillState = snapshot.state;
        byId("shop-status-text").textContent = content.shop;
        byId("preview-status-title").textContent = content.title;
        byId("preview-status-copy").textContent = content.copy;
        byId("preview-countdown").textContent = snapshot.state === mockFactory.LabState.COUNTDOWN ?
            String(snapshot.remaining).padStart(2, "0") : "";
        byId("preview-replay").hidden = snapshot.state !== mockFactory.LabState.SOLD_OUT;
        byId("market-announcer").textContent = content.announce;

        var order = ["idle", "countdown", "running", "sold_out"];
        var current = order.indexOf(snapshot.state);
        Array.prototype.forEach.call(document.querySelectorAll("[data-preview-step]"), function (step, index) {
            step.classList.toggle("is-active", index === current);
            step.classList.toggle("is-complete", index < current);
        });
    }

    function centerOf(rect, containerRect) {
        return {
            x: rect.left - containerRect.left + rect.width / 2,
            y: rect.top - containerRect.top + rect.height / 2
        };
    }

    function requestOrigin(card) {
        var figures = document.querySelectorAll("#seckill-crowd .queue-figure");
        var figure = figures[card.originIndex % figures.length];
        var ticket = figure && figure.querySelector("i");
        return (ticket || figure).getBoundingClientRect();
    }

    function makeCardElement(card) {
        var flow = byId("request-flow");
        var flowRect = flow.getBoundingClientRect();
        var originRect = requestOrigin(card);
        var origin = centerOf(originRect, flowRect);
        var element = document.createElement("span");
        element.className = "request-card";
        element.dataset.cardId = String(card.id);
        element.dataset.cardState = card.state;
        element.style.left = (origin.x - 17) + "px";
        element.style.top = (origin.y - 11) + "px";
        element._requestOrigin = origin;
        flow.appendChild(element);
        cardElements.set(card.id, element);
        return element;
    }

    function moveCardToSubmit(element, card) {
        var flowRect = byId("request-flow").getBoundingClientRect();
        var slotRect = byId("submit-slot").querySelector("i").getBoundingClientRect();
        var target = centerOf(slotRect, flowRect);
        var origin = element._requestOrigin;
        element._submitTarget = target;
        element.style.setProperty("--travel-x", (target.x - origin.x) + "px");
        element.style.setProperty("--travel-y", (target.y - origin.y) + "px");
        element.style.setProperty("--travel-x-mid", ((target.x - origin.x) * .67) + "px");
        element.style.setProperty("--travel-y-mid", ((target.y - origin.y) * .67 - 16) + "px");
        element.style.setProperty("--request-duration", card.duration + "ms");
        element.dataset.cardState = card.state;
    }

    function processCard(element, card) {
        var target = element._submitTarget;
        if (target) {
            element.style.left = (target.x - 17) + "px";
            element.style.top = (target.y - 11) + "px";
        }
        element.dataset.cardState = card.state;
    }

    function resultLabel(state) {
        var labels = {
            success: { mark: "✓", text: "凭证" },
            rate_limited: { mark: "!", text: "限流" },
            duplicate: { mark: "↩", text: "重复" },
            sold_out: { mark: "×", text: "售罄" }
        };
        return labels[state] || labels.sold_out;
    }

    function returnCard(element, card) {
        var flow = byId("request-flow");
        var flowRect = flow.getBoundingClientRect();
        var resultRect = byId("result-slot").querySelector("i").getBoundingClientRect();
        var start = centerOf(resultRect, flowRect);
        var origin = element._requestOrigin;
        var label = resultLabel(card.state);
        var spread = ((card.id % 3) - 1) * 18;
        element.style.left = (start.x - 21) + "px";
        element.style.top = (start.y - 12) + "px";
        element.style.setProperty("--return-x", (origin.x - start.x + spread) + "px");
        element.style.setProperty("--return-y", (origin.y - start.y + 18) + "px");
        element.style.setProperty("--return-x-mid", ((origin.x - start.x + spread) * .72) + "px");
        element.style.setProperty("--return-y-mid", ((origin.y - start.y + 18) * .72 - 10) + "px");
        element.style.setProperty("--return-duration", Math.max(420, card.duration * .78) + "ms");
        element.innerHTML = "<b>" + label.mark + "</b><small>" + label.text + "</small>";
        element.dataset.cardState = card.state;

        window.setTimeout(function () {
            cardElements.delete(card.id);
            element.remove();
        }, reducedMotion ? 30 : Math.max(900, card.duration + 340));
    }

    function clearCards() {
        cardElements.forEach(function (element) { element.remove(); });
        cardElements.clear();
    }

    function renderCardEvent(event) {
        if (event.type === "reset") {
            clearCards();
            return;
        }
        var card = event.card;
        var element = cardElements.get(card.id);
        if (event.type === "created") {
            makeCardElement(card);
            return;
        }
        if (!element) {
            return;
        }

        if (card.state === mockFactory.CardState.MOVING_TO_SLOT) {
            moveCardToSubmit(element, card);
        } else if (card.state === mockFactory.CardState.PROCESSING) {
            processCard(element, card);
        } else {
            returnCard(element, card);
        }
    }

    function bindEvents() {
        byId("seckill-shop-hitbox").addEventListener("click", openSeckillPreview);
        byId("archive-shop-hitbox").addEventListener("click", enterArchiveShop);
        byId("dialogue-seckill").addEventListener("click", openSeckillPreview);
        byId("dialogue-archive").addEventListener("click", enterArchiveShop);
        byId("preview-close").addEventListener("click", closeSeckillPreview);
        byId("preview-replay").addEventListener("click", function () { mock.start(); });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && body.dataset.dialogue === "seckill") {
                closeSeckillPreview();
            }
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        applySceneLayout();
        createAmbientParticles();
        bindEvents();
        mock.subscribe(renderLabState);
        mock.subscribeCards(renderCardEvent);
        renderLabState(mock.getSnapshot());
    });
}());
