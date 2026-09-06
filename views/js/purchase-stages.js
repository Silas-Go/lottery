(function (root, factory) {
    "use strict";
    var api = factory();
    if (typeof module === "object" && module.exports) { module.exports = api; }
    else { root.SilasPurchaseStages = api; }
}(typeof window === "object" ? window : globalThis, function () {
    "use strict";

    var names = {
        request: "请求进入", transaction: "MySQL 事务提交", invalidate: "Redis 缓存失效",
        response: "返回响应", rebuild: "查询回源 / 缓存重建", result: "一致性结果"
    };
    function order(strategy) {
        return strategy === "outbox-mq-invalidate" ?
            ["request", "transaction", "response", "invalidate", "rebuild", "result"] :
            ["request", "transaction", "invalidate", "response", "rebuild", "result"];
    }
    function last(run, actions) {
        return (run.trace || []).filter(function (step) { return actions.indexOf(step.action) >= 0; }).slice(-1)[0];
    }
    function time(value) {
        var result = Date.parse(value);
        return Number.isFinite(result) ? result : null;
    }
    function valid(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)); }

    // 阶段是证据的投影，不是六个定时器。并发批次允许多个阶段同时已有证据。
    // DEL 证明旧键被删除；其后可能马上有并发回填，不能把 DEL 当作当前 Redis 快照。
    function inspect(record, live) {
        record = record || {};
        var run = record.run || {};
        var probe = record.probe || {};
        var strategy = record.strategy || run.strategy;
        var ids = order(strategy);
        var async = strategy === "outbox-mq-invalidate";
        var request = last(run, ["transaction_started"]);
        var transaction = last(run, ["transaction_committed", "update_mysql", "idempotent_order"]);
        var response = last(run, ["purchase_responded"]);
        var deletion = last(run, ["cache_invalidated", "delete_cache"]);
        var deleteFailure = last(run, ["cache_invalidation_failed", "delete_cache_failed"]);
        var events = run.outbox || [];
        var doneEvents = events.filter(function (event) { return event.status === "completed" && event.invalidatedAt; });
        var deletionDone = async ? events.length > 0 && doneEvents.length === events.length : !!deletion && !deleteFailure;
        var deletedAt = async ? doneEvents.reduce(function (latest, event) {
            return Math.max(latest || 0, time(event.invalidatedAt) || 0);
        }, null) : time(run.cacheInvalidatedAt);
        var samples = (probe.samples || []).slice();
        if (probe.lastMiss && samples.indexOf(probe.lastMiss) < 0) { samples.push(probe.lastMiss); }
        // 服务端开始时间必须在最后一次 DEL 之后；只看浏览器收到响应的时间会错配在途查询。
        var misses = samples.filter(function (sample) {
            return sample.source === "redis-miss" && deletedAt !== null &&
                time(sample.startedAt) !== null && time(sample.startedAt) >= deletedAt;
        }).sort(function (a, b) { return time(a.completedAt) - time(b.completedAt); });
        var rebuild = misses.filter(function (sample) { return sample.cacheRebuilt === true; }).slice(-1)[0];
        var miss = rebuild || misses.slice(-1)[0];
        var finalized = !live && !!run.status && !["running", "waiting_outbox", "waiting_consumer"].includes(run.status);
        var consistent = valid(run.finalMySQLStock) && valid(run.finalRedisStock) ?
            Number(run.finalMySQLStock) === Number(run.finalRedisStock) : null;
        var baseline = record.baseline || {};
        var stages = {};
        function put(id, status, evidence, summary) {
            stages[id] = { id: id, title: names[id], status: status, evidence: evidence || null, summary: summary,
                mysql: undefined, redis: undefined };
            return stages[id];
        }
        var item = put("request", request ? "completed" : "waiting", request,
            request ? request.detail : "等待后端接收购买任务。");
        item.mysql = request ? request.mysqlStock : baseline.mysqlStock;
        item.redis = request ? request.redisStock : baseline.redisStock;
        item = put("transaction", transaction ? "completed" : (Number(run.purchaseProcessed) > 0 ? "running" : "waiting"), transaction,
            transaction ? transaction.detail : "等待 MySQL 事务提交证据；并发请求可能处于不同阶段。");
        if (transaction) { item.mysql = transaction.mysqlStock; item.redis = transaction.redisStock; }
        item = put("response", response ? "completed" : "waiting", response,
            response ? response.detail : "等待购买响应收集完成。");
        if (response) { item.mysql = response.mysqlStock; item.redis = response.redisStock; }
        item = put("invalidate", deleteFailure ? "failed" : (deletionDone ? "completed" :
            (async && events.length && run.criticalPathCompleted ? "running" : "waiting")), deletion || deleteFailure,
            deleteFailure ? "DEL 失败：旧缓存未确认删除，不能标记重建成功。" :
                (deletionDone ? "Redis DEL 已确认：旧缓存被删除。这是删除事件，不是缓存回填或当前库存快照。" :
                    "等待 DEL 成功证据；Outbox 发布成功不等于缓存已经删除。"));
        item.deletedAt = deletedAt;
        item.mysql = deletion ? deletion.mysqlStock : (async && response ? response.mysqlStock : undefined);
        // null 仅代表 DEL 动作的语义后态，界面必须明确标为事件，不能冒充实时采样。
        item.redis = deletionDone ? null : (deleteFailure ? deleteFailure.redisStock : undefined);
        item = put("rebuild", !deletionDone ? "waiting" : (rebuild ? "completed" :
            (miss && miss.cacheRebuildFailed ? "failed" : (finalized ? "unobserved" : "waiting"))), miss,
            rebuild ? "后续查询 MISS → MySQL 回源 → Redis SET 成功；显示这次回填的库存，不提前宣判最终一致。" :
                (miss && miss.cacheRebuildFailed ? "查询已 MISS 并回源，但 Redis 写回失败。" :
                    "尚无最后一次 DEL 之后的 MISS + SET 成功证据；HIT、降级和最终数值相等都不能代替重建证据。"));
        if (rebuild) { item.mysql = rebuild.authoritativeStock; item.redis = rebuild.stock; }
        else if (miss) { item.mysql = miss.authoritativeStock; }
        item = put("result", finalized ? (run.status === "failed" ? "failed" : "completed") : "waiting", null,
            finalized ? "最终库存对照 · 旧读 " + Number(probe.oldReads || 0) + " 次 · 最长旧读窗口 " +
                Number(probe.maxStaleWindowMs || 0).toFixed(1) + " ms" : "等待购买、失效及最终查询检查结束。");
        if (finalized) { item.mysql = run.finalMySQLStock; item.redis = run.finalRedisStock; }
        item.consistent = consistent;
        // live 不为阅读效果补播已错过的微秒级阶段；回放才逐项展示保存的证据。
        var current = 0;
        ids.forEach(function (id, index) {
            if (["completed", "running", "failed"].includes(stages[id].status)) { current = index; }
        });
        return { ids: ids, stages: stages, current: current };
    }
    return { order: order, names: names, inspect: inspect };
}));
