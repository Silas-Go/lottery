// 隔离网络和绘图，执行页面真实重置入口；不连接开发数据库。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const stages = require('../views/js/purchase-stages.js');

function harness() {
    const calls = [], removed = [], notices = [], elements = new Map();
    const storage = new Map([['silas.cache-aside.experiment-results.v2', '["query-result"]']]);
    let resolve, reject;
    const pending = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const source = fs.readFileSync(require.resolve('../views/js/purchase-lab.js'), 'utf8');
    const context = {
        URL,
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        window: { SilasPurchaseStages: stages, clearTimeout() {}, clearInterval() {},
            location: { href: 'http://localhost/purchase-lab' }, history: { replaceState() {} },
            dispatchEvent() {},
            sessionStorage: {
                getItem(key) { return storage.get(key) || null; },
                setItem(key, value) { storage.set(key, value); },
                removeItem(key) { removed.push(key); storage.delete(key); }
            } },
        document: { querySelectorAll() { return []; }, getElementById(id) {
            if (!elements.has(id)) elements.set(id, { textContent: '', open: false, dataset: {},
                replaceChildren() { this.textContent = ''; } });
            return elements.get(id);
        } },
        request: (url, options) => { calls.push({ url, options }); return pending; },
        notice: message => notices.push(message)
    };
    const storeSource = fs.readFileSync(require.resolve('../views/js/experiment-state.js'), 'utf8');
    vm.runInNewContext(storeSource, context);
    vm.runInNewContext(source.replace('    init();', `
        requestJSON = request;
        showToast = notice;
        renderHeaderAndControls = renderTimeline = renderInventoryMonitor =
            renderSceneBaseline = renderIdleStepExplanation = renderProbeStream = function () {};
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
    const store = context.window.SilasPurchaseLabResults;
    store.save({ strategy: 'sync-invalidate', run: { requestId: 'old-a' } });
    store.save({ strategy: 'outbox-mq-invalidate', run: { requestId: 'old-b' } });
    for (const id of ['results-table-head', 'results-table-body', 'evidence-strategies', 'technical-trace']) {
        context.document.getElementById(id).textContent = 'old evidence';
    }
    return { api, calls, removed, notices, resolve, reject, store, storage, elements,
        reloadStore() { vm.runInNewContext(storeSource, context); return context.window.SilasPurchaseLabResults; } };
}

for (const strategy of ['sync-invalidate', 'outbox-mq-invalidate']) {
    test(strategy + '：重置清空 A/B、证据和探针，刷新不恢复且不自动购买', async () => {
        const h = harness();
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
        assert.equal(Object.keys(h.api.recentResults).length, 0);
        assert.equal(Object.keys(h.store.list()).length, 0);
        assert.equal(Object.keys(h.reloadStore().list()).length, 0);
        assert.equal(h.storage.get('silas.cache-aside.experiment-results.v2'), '["query-result"]');
        assert.equal(h.elements.get('purchase-results').hidden, true);
        assert.equal(h.elements.get('results-table-body').textContent, '');
        assert.equal(h.elements.get('technical-trace').textContent, '');
        assert.deepEqual(h.removed, ['silas.cache-aside.purchase-replay-position.v3', 'silas.cache-aside.purchase-results.v2']);
        h.store.save({ strategy, run: { requestId: 'new-run' } });
        assert.deepEqual(Object.keys(h.store.list()), [strategy]);
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
    assert.equal(Object.keys(h.store.list()).length, 2);
    assert.equal(h.api.recentResults['sync-invalidate'], old);
    assert.equal(h.removed.length, 0);
    assert.match(h.notices[0], /重置失败/);
    await h.api.reset();
    assert.equal(h.calls.length, 2);
});
