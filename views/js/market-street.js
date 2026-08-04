(function () {
    "use strict";

    var sceneConfig = window.SilasMarketSceneConfig;
    var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var body = document.body;
    var WORLD_TRANSITION_KEY = "silas.world-transition.v1";

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

    // 两家店使用相同的离场规则，但写入不同标记，目标页可据此决定入场动画。
    // sessionStorage 失败只会损失动画，不得阻断真实实验入口。
    function enterShop(kind) {
        var seckill = kind === "seckill";
        var departingClass = seckill ? "is-entering-seckill" : "is-entering-archive";
        var marker = seckill ? "street-to-seckill-lab" : "street-to-material-shop";
        var target = seckill ? "/seckill-lab" : "/material-shop";
        if (body.classList.contains("is-entering-seckill") || body.classList.contains("is-entering-archive")) {
            return;
        }
        try {
            window.sessionStorage.setItem(WORLD_TRANSITION_KEY, marker);
        } catch (_) {
            // 动画标记不是业务状态；浏览器禁用存储时仍然直接进入实验。
        }
        body.classList.add(departingClass);
        byId("market-announcer").textContent = seckill ? "正在进入限量材料申领所" : "正在进入材料情报店";
        window.setTimeout(function () {
            window.location.assign(target);
        }, reducedMotion ? 0 : 420);
    }

    document.addEventListener("DOMContentLoaded", function () {
        applySceneLayout();
        createAmbientParticles();
        byId("seckill-shop-hitbox").addEventListener("click", function () { enterShop("seckill"); });
        byId("archive-shop-hitbox").addEventListener("click", function () { enterShop("archive"); });
        byId("dialogue-seckill").addEventListener("click", function () { enterShop("seckill"); });
        byId("dialogue-archive").addEventListener("click", function () { enterShop("archive"); });
    });
}());
