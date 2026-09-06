// 纯证据模型测试：合成记录只在测试进程使用，不写入实验页面、MySQL 或 Redis。
const test = require('node:test');
const assert = require('node:assert/strict');
const stages = require('../views/js/purchase-stages.js');
const at = ms => new Date(Date.UTC(2026, 8, 6) + ms).toISOString();
function record(strategy = 'sync-invalidate') {
    const async = strategy === 'outbox-mq-invalidate';
    return { strategy, baseline: { mysqlStock: 100, redisStock: 100 },
        run: { strategy, status: 'completed', initialStock: 100, finalMySQLStock: 0, finalRedisStock: 0,
            criticalPathCompleted: true, cacheInvalidatedAt: at(200),
            trace: ['transaction_started', 'transaction_committed', ...(async ? [] : ['cache_invalidated']), 'purchase_responded']
                .map(action => ({ action, mysqlStock: 0, redisStock: 100, detail: action })),
            outbox: async ? [{ status: 'completed', invalidatedAt: at(200) }] : [] },
        probe: { oldReads: 3, maxStaleWindowMs: 50, samples: [
            { source: 'redis-miss', startedAt: at(201), completedAt: at(210), stock: 0,
                authoritativeStock: 0, cacheRebuilt: true, cacheRebuildFailed: false }
        ] } };
}
test('A 的六阶段严格保持先 DEL 再 Response，删除与重建是不同证据', () => {
    const model = stages.inspect(record(), false);
    assert.deepEqual(model.ids, ['request', 'transaction', 'invalidate', 'response', 'rebuild', 'result']);
    assert.equal(model.ids.length, 6);
    assert.equal(model.stages.invalidate.redis, null);
    assert.equal(model.stages.rebuild.redis, 0);
    assert.equal(model.stages.rebuild.evidence.source, 'redis-miss');
    assert.equal(model.stages.result.consistent, true);
    assert.equal(model.current, 5);
});
test('B 同样六阶段，但 Response 必须先于异步 DEL', () => {
    const model = stages.inspect(record('outbox-mq-invalidate'), false);
    assert.deepEqual(model.ids, ['request', 'transaction', 'response', 'invalidate', 'rebuild', 'result']);
    assert.equal(model.stages.invalidate.status, 'completed');
    assert.equal(model.stages.rebuild.status, 'completed');
});
test('发布成功或部分消费不能冒充全部 DEL 完成', () => {
    const r = record('outbox-mq-invalidate');
    r.run.outbox.push({ status: 'published', publishedAt: at(180) });
    const model = stages.inspect(r, true);
    assert.equal(model.stages.invalidate.status, 'running');
    assert.equal(model.stages.rebuild.status, 'waiting');
    assert.equal(model.current, 3);
});
test('最后一次删除之前的 MISS 不能被认作删除之后的重建', () => {
    const r = record();
    r.probe.samples[0].startedAt = at(199);
    assert.equal(stages.inspect(r, false).stages.rebuild.status, 'unobserved');
});
test('MISS 但 SET 失败只显示失败，不能显示已重建', () => {
    const r = record();
    r.probe.samples[0].cacheRebuilt = false;
    r.probe.samples[0].cacheRebuildFailed = true;
    const stage = stages.inspect(r, false).stages.rebuild;
    assert.equal(stage.status, 'failed');
    assert.equal(stage.redis, undefined);
});
for (const source of ['redis-hit', 'redis-fallback']) {
    test(source + ' 不能代替 MISS 回填证据', () => {
        const r = record(); r.probe.samples[0].source = source;
        assert.equal(stages.inspect(r, false).stages.rebuild.status, 'unobserved');
    });
}
test('旧记录缺少回填成功或真实时钟时保留未观测', () => {
    const r = record(); delete r.run.cacheInvalidatedAt;
    assert.equal(stages.inspect(r, false).stages.rebuild.status, 'unobserved');
    const r2 = record(); delete r2.probe.samples[0].cacheRebuilt;
    assert.equal(stages.inspect(r2, false).stages.rebuild.status, 'unobserved');
});
test('DEL 失败不能点亮重建，即使存在无关 MISS', () => {
    const r = record(); r.run.trace.push({ action: 'cache_invalidation_failed' });
    r.run.status = 'failed';
    const model = stages.inspect(r, false);
    assert.equal(model.stages.invalidate.status, 'failed');
    assert.equal(model.stages.rebuild.status, 'waiting');
    assert.equal(model.stages.result.status, 'failed');
});
test('后端任务 completed 不会提前跳过前端最终检查进入第六步', () => {
    const model = stages.inspect(record(), true);
    assert.equal(model.stages.result.status, 'waiting');
    assert.equal(model.current, 4);
});
test('没有事务或响应证据不能伪造成功；回填也不代表最终一致', () => {
    const r = record(); r.run.trace = []; r.run.status = 'running';
    let model = stages.inspect(r, true);
    assert.equal(model.stages.transaction.status, 'waiting');
    assert.equal(model.stages.response.status, 'waiting');
    r.run.purchaseProcessed = 5;
    assert.equal(stages.inspect(r, true).stages.transaction.status, 'running');
    const mismatch = record(); mismatch.run.finalRedisStock = 1;
    model = stages.inspect(mismatch, false);
    assert.equal(model.stages.rebuild.status, 'completed');
    assert.equal(model.stages.result.consistent, false);
});
