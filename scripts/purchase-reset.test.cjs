// 隔离网络和绘图，执行页面真实重置入口；不连接开发数据库。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const stages = require('../views/js/purchase-stages.js');

function harness() {
    const calls = [], removed = [], notices = [], elements = new Map();
    let resolve, reject;
    const pending = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const source = fs.readFileSync(require.resolve('../views/js/purchase-lab.js'), 'utf8');
    const context = {
        URL,
        window: { SilasPurchaseStages: stages, clearTimeout() {}, clearInterval() {},
            location: { href: 'http://localhost/purchase-lab' }, history: { replaceState() {} },
            sessionStorage: { removeItem(key) { removed.push(key); } } },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { textContent: '', open: false });
            return elements.get(id);
        } },
        request: (url, options) => { calls.push({ url, options }); return pending; },
        notice: message => notices.push(message)
    };
    vm.runInNewContext(source.replace('    init();', `
        requestJSON = request;
        showToast = notice;
        renderHeaderAndControls = renderTimeline = renderInventoryMonitor =
            renderSceneBaseline = renderIdleStepExplanation = renderSavedResults = renderProbeStream = function () {};
        window.testAPI = { state: state, recentResults: recentResults,
            reset: resetToPreparation, start: startExperiment, choose: chooseStrategy,
            play: playReplay, step: stepReplay, timeline: chooseTimelineStep,
            other: runOtherStrategy, rerun: rerunCurrentStrategy, view: viewFullProcess };
    `), context);
    const api = context.window.testAPI;
    Object.assign(api.state, { materialId: 4, strategy: 'sync-invalidate',
        stock: { initialStock: 100, mysqlStock: 0, redisStock: 0 }, executionMode: 'result',
        record: { run: { requestId: 'previous' } }, liveRun: { status: 'completed' } });
    api.recentResults['sync-invalidate'] = api.state.record;
    return { api, calls, removed, notices, resolve, reject };
}

for (const strategy of ['sync-invalidate', 'outbox-mq-invalidate']) {
    test(strategy + '：等待真实重置，保留对比且不自动购买', async () => {
        const h = harness(), old = h.api.state.record;
        h.api.state.strategy = strategy;
        const reset = h.api.reset();
        assert.equal(h.api.state.executionMode, 'resetting');
        assert.equal(h.api.state.stock.mysqlStock, 0);
        await h.api.reset();
        await h.api.start();
        h.api.choose('outbox-mq-invalidate');
        h.api.play(); h.api.step(1); h.api.timeline(0);
        h.api.other(); h.api.rerun(); h.api.view();
        assert.equal(h.api.state.executionMode, 'resetting');
        assert.equal(h.api.state.strategy, strategy);
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].url, '/api/purchase-lab/4/reset');
        assert.equal(h.calls[0].options.method, 'POST');
        const stock = { initialStock: 100, mysqlStock: 100, redisStock: 100 };
        h.resolve({ state: stock });
        await reset;
        assert.equal(h.api.state.stock, stock);
        assert.equal(h.api.state.executionMode, 'idle');
        assert.equal(h.api.state.record, null);
        assert.equal(h.api.state.liveRun, null);
        assert.equal(h.api.state.replay.furthest, -1);
        assert.equal(h.api.state.probe.oldReads, 0);
        assert.equal(h.api.recentResults['sync-invalidate'], old);
        assert.deepEqual(h.removed, ['silas.cache-aside.purchase-replay-position.v3']);
    });
}

test('运行中不可重置', async () => {
    const h = harness();
    h.api.state.executionMode = 'executing';
    await h.api.reset();
    assert.equal(h.calls.length, 0);
});

test('重置失败保留原记录和库存，暂停旧回放并允许重试', async () => {
    const h = harness(), old = h.api.state.record;
    h.api.state.executionMode = 'replaying';
    h.api.state.replay.playing = true;
    const reset = h.api.reset();
    h.reject(new Error('network failure'));
    await reset;
    assert.equal(h.api.state.executionMode, 'paused');
    assert.equal(h.api.state.replay.playing, false);
    assert.equal(h.api.state.record, old);
    assert.equal(h.api.state.stock.mysqlStock, 0);
    assert.equal(h.removed.length, 0);
    assert.match(h.notices[0], /重置失败/);
    await h.api.reset();
    assert.equal(h.calls.length, 2);
});
