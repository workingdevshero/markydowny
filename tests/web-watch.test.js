const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/core.js');

// A file handle whose file can be changed, deleted and restored.
function fakeHandle(initial) {
    let file = { ...initial };
    let gone = false;
    let reads = 0;
    return {
        getFile() {
            reads++;
            return gone ? Promise.reject(new DOMException('gone', 'NotFoundError')) : Promise.resolve({ ...file });
        },
        write(changes) {
            file = { ...file, ...changes };
        },
        remove() {
            gone = true;
        },
        restore() {
            gone = false;
        },
        get reads() {
            return reads;
        },
    };
}

// Manual timers: run() fires whatever is scheduled.
function fakeTimers() {
    let next = 1;
    const pending = new Map();
    return {
        setTimer(fn) {
            const id = next++;
            pending.set(id, fn);
            return id;
        },
        clearTimer(id) {
            pending.delete(id);
        },
        get count() {
            return pending.size;
        },
        async run() {
            const due = [...pending.values()];
            pending.clear();
            for (const fn of due) fn();
            await flush();
        },
    };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ observe = false } = {}) {
    const handle = fakeHandle({ lastModified: 1, size: 10 });
    const timers = fakeTimers();
    const events = [];
    const poller = core.createFilePoller({
        getFile: () => handle.getFile(),
        onChange: file => events.push(['change', file.lastModified]),
        onUnavailable: () => events.push(['unavailable']),
        observe,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
    });
    poller.start({ lastModified: 1, size: 10 });
    return { handle, timers, events, poller };
}

test('pollDecision: changed, unchanged, unavailable', () => {
    const prev = { lastModified: 5, size: 3 };
    assert.equal(core.pollDecision(prev, { ok: true, lastModified: 6, size: 3 }), 'changed');
    assert.equal(core.pollDecision(prev, { ok: true, lastModified: 5, size: 4 }), 'changed');
    assert.equal(core.pollDecision(prev, { ok: true, lastModified: 5, size: 3 }), 'unchanged');
    assert.equal(core.pollDecision(prev, { ok: false }), 'unavailable');
    assert.equal(core.pollDecision(null, { ok: true, lastModified: 1, size: 1 }), 'changed');
});

test('poller: a changed lastModified triggers a reload', async () => {
    const { handle, timers, events } = setup();
    handle.write({ lastModified: 2 });
    await timers.run();
    assert.deepEqual(events, [['change', 2]]);
});

test('poller: the same values trigger nothing', async () => {
    const { timers, events, handle } = setup();
    await timers.run();
    await timers.run();
    assert.deepEqual(events, []);
    assert.equal(handle.reads, 2);
    assert.equal(timers.count, 1, 'keeps polling');
});

test('poller: a rejected getFile reports unavailable once, then a return reloads', async () => {
    const { handle, timers, events } = setup();
    handle.remove();
    await timers.run();
    await timers.run();
    await timers.run();
    assert.deepEqual(events, [['unavailable']], 'reported once, not on every poll');
    handle.restore();
    await timers.run();
    assert.deepEqual(events, [['unavailable'], ['change', 1]], 'coming back reloads even if unchanged');
});

test('poller: hidden pauses polling; visible checks once and resumes', async () => {
    const { handle, timers, events, poller } = setup();
    poller.setVisible(false);
    assert.equal(timers.count, 0, 'no timer while hidden');
    handle.write({ lastModified: 9, size: 11 });
    await poller.check(); // e.g. an observer record while hidden
    assert.deepEqual(events, []);
    assert.equal(handle.reads, 0);

    poller.setVisible(true);
    await flush();
    assert.deepEqual(events, [['change', 9]], 'one check on becoming visible');
    assert.equal(handle.reads, 1);
    assert.equal(timers.count, 1, 'polling again');
});

test('poller: with an observer it polls only while the file is unavailable', async () => {
    const { handle, timers, events, poller } = setup({ observe: true });
    assert.equal(timers.count, 0);
    handle.write({ lastModified: 3 });
    await poller.check();
    assert.deepEqual(events, [['change', 3]]);
    handle.remove();
    await poller.check();
    assert.equal(timers.count, 1, 'polls to notice the file coming back');
    handle.restore();
    await timers.run();
    assert.deepEqual(events, [['change', 3], ['unavailable'], ['change', 3]]);
    assert.equal(timers.count, 0, 'observer takes over again');
});

test('poller: stop cancels everything', async () => {
    const { handle, timers, events, poller } = setup();
    poller.stop();
    assert.equal(timers.count, 0);
    handle.write({ lastModified: 7 });
    await poller.check();
    poller.setVisible(false);
    poller.setVisible(true);
    await flush();
    assert.deepEqual(events, []);
});

test('fileWatchSupport: without the API nothing is available', () => {
    assert.deepEqual(core.fileWatchSupport({}), { picker: false, dropHandles: false, observer: false });
    assert.deepEqual(core.fileWatchSupport(undefined), { picker: false, dropHandles: false, observer: false });
    // Safari / Firefox: DataTransferItem without getAsFileSystemHandle.
    assert.deepEqual(core.fileWatchSupport({ DataTransferItem: function () {} }), { picker: false, dropHandles: false, observer: false });
});

test('fileWatchSupport: detects each Chromium API', () => {
    function Item() {}
    Item.prototype.getAsFileSystemHandle = function () {};
    const win = { showOpenFilePicker() {}, DataTransferItem: Item, FileSystemObserver: function () {} };
    assert.deepEqual(core.fileWatchSupport(win), { picker: true, dropHandles: true, observer: true });
});
