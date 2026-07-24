(function (global) {
    "use strict";

    var STORAGE_KEY = "silas.cache-aside.experiment-state.v1";
    // v2 使用“最终 DTO + 实际 SQL 条数”口径，不能与旧版单表 DB Read 结果混合比较。
    var RESULTS_KEY = "silas.cache-aside.experiment-results.v2";
    var PENDING_RUN_KEY = "silas.cache-aside.pending-run.v2";
    // v2 为每个购买方案保存完整 run trace、Outbox 证据和查询探针快照；
    // 旧版只含最终指标，不能满足逐步回看，因此不与新结构混读。
    var PURCHASE_RESULTS_KEY = "silas.cache-aside.purchase-results.v2";
    var EVENT_NAME = "silas:experiment-state-change";
    var RESULTS_EVENT_NAME = "silas:experiment-results-change";
    var DEFAULT_STATE = {
        mode: "direct",
        cacheTemperature: "cold"
    };

    function normalize(candidate) {
        candidate = candidate || {};
        return {
            mode: candidate.mode === "cached" ? "cached" : "direct",
            cacheTemperature: candidate.cacheTemperature === "hot" ? "hot" : "cold"
        };
    }

    function readStoredState() {
        try {
            return normalize(JSON.parse(global.sessionStorage.getItem(STORAGE_KEY) || "null"));
        } catch (_) {
            return normalize(DEFAULT_STATE);
        }
    }

    function writeStoredState(next) {
        try {
            global.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (_) {
            // 当前页面仍使用已规范化的内存值；URL 不再保存另一份模式配置。
        }
    }

    var current = readStoredState();

    function get() {
        return { mode: current.mode, cacheTemperature: current.cacheTemperature };
    }

    function set(patch) {
        current = normalize(Object.assign({}, current, patch || {}));
        writeStoredState(current);
        global.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: get() }));
        return get();
    }

    function subscribe(listener) {
        function handle(event) {
            listener(event.detail || get());
        }
        global.addEventListener(EVENT_NAME, handle);
        return function () { global.removeEventListener(EVENT_NAME, handle); };
    }

    global.SilasExperimentState = Object.freeze({
        get: get,
        set: set,
        subscribe: subscribe
    });

    function safeParse(key, fallback) {
        try {
            return JSON.parse(global.sessionStorage.getItem(key) || "null") || fallback;
        } catch (_) {
            return fallback;
        }
    }

    function safeWrite(key, value) {
        try {
            global.sessionStorage.setItem(key, JSON.stringify(value));
        } catch (_) {
            // 结果仍会在当前页面呈现，禁用存储只影响跨页面恢复。
        }
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function readResults() {
        var results = safeParse(RESULTS_KEY, []);
        return Array.isArray(results) ? results : [];
    }

    function listResults() {
        return clone(readResults());
    }

    function latestResult(mode) {
        var results = readResults();
        for (var index = results.length - 1; index >= 0; index -= 1) {
            if (results[index].mode === mode) {
                return clone(results[index]);
            }
        }
        return null;
    }

    function completeRun(candidate) {
        var result = Object.assign({}, clone(candidate || {}), {
            id: "run-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8),
            frozenAt: new Date().toISOString()
        });
        var results = readResults();
        results.push(result);
        safeWrite(RESULTS_KEY, results.slice(-16));
        global.dispatchEvent(new CustomEvent(RESULTS_EVENT_NAME, { detail: clone(result) }));
        return Object.freeze(clone(result));
    }

    function armRun(candidate) {
        safeWrite(PENDING_RUN_KEY, clone(candidate || {}));
    }

    function pendingRun() {
        var pending = safeParse(PENDING_RUN_KEY, null);
        return pending ? clone(pending) : null;
    }

    function clearPendingRun() {
        try {
            global.sessionStorage.removeItem(PENDING_RUN_KEY);
        } catch (_) {
            // 没有可恢复的存储时无需额外处理。
        }
    }

    function clearResults() {
        try {
            global.sessionStorage.removeItem(RESULTS_KEY);
            global.sessionStorage.removeItem(PENDING_RUN_KEY);
        } catch (_) {
            // 页面仍会立即收到清空事件；禁用存储只影响跨页面恢复。
        }
        global.dispatchEvent(new CustomEvent(RESULTS_EVENT_NAME, { detail: null }));
    }

    function subscribeResults(listener) {
        function handle(event) { listener(event.detail || null); }
        global.addEventListener(RESULTS_EVENT_NAME, handle);
        return function () { global.removeEventListener(RESULTS_EVENT_NAME, handle); };
    }

    global.SilasExperimentResults = Object.freeze({
        list: listResults,
        latest: latestResult,
        complete: completeRun,
        arm: armRun,
        pending: pendingRun,
        clearPending: clearPendingRun,
        clear: clearResults,
        subscribe: subscribeResults
    });

    function readPurchaseResults() {
        var stored = safeParse(PURCHASE_RESULTS_KEY, {});
        return stored && typeof stored === "object" ? stored : {};
    }

    function listPurchaseResults() {
        return clone(readPurchaseResults());
    }

    function savePurchaseResult(candidate) {
        var result = Object.assign({}, clone(candidate || {}), {
            frozenAt: new Date().toISOString()
        });
        var results = readPurchaseResults();
        results[result.strategy] = result;
        safeWrite(PURCHASE_RESULTS_KEY, results);
        global.dispatchEvent(new CustomEvent("silas:purchase-results-change", { detail: clone(result) }));
        return Object.freeze(clone(result));
    }

    global.SilasPurchaseLabResults = Object.freeze({
        list: listPurchaseResults,
        save: savePurchaseResult
    });
}(window));
