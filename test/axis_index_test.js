const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
const { AxisIndexCache } = require("../src/axis_index.ts");
const { Loader } = require("../src/loader.ts");

function column(rows, multiplier) {
    const values = Int32Array.from({ length: rows }, (_, i) => i * multiplier % 257);
    return { stat: { min: 0, max: 256, deviationFromMax: 256 }, codeToValueList: null,
        getNumber(i) { return values[i]; }, getString(i) { return String(values[i]); } };
}

test("Index generation yields, respects its memory budget and retains every source row", async () => {
    const rows = 32769, x = column(rows, 31), y = column(rows, 17);
    const cache = new AxisIndexCache(rows * 12);
    let ticks = 0, peak = 0, ready = 0;
    const timer = setInterval(() => { ticks++; peak = Math.max(peak, cache.memoryBytes); }, 1);
    try {
        cache.prepare([x, y], rows, () => ready++);
        assert.equal(cache.get(x), undefined, "Preparation must not synchronously sort the column");
        await cache.waitForIdle();
        assert.ok(ticks > 0, "Timers must run while the index is being generated");
        assert.equal(ready, 2);
        assert.ok(peak <= cache.budgetBytes);
        assert.equal(cache.memoryBytes, rows * 8);
        for (const col of [x, y]) {
            const order = cache.get(col);
            assert.equal(new Set(order).size, rows);
            assert.equal(order.length, rows);
            for (let i = 1; i < rows; i++) {
                assert.ok(col.getNumber(order[i - 1]) <= col.getNumber(order[i]));
                if (col.getNumber(order[i - 1]) === col.getNumber(order[i])) assert.ok(order[i - 1] < order[i]);
            }
        }
        const previous = cache.get(x);
        cache.prepare([y, x], rows, () => { throw new Error("Reused axes must not rebuild"); });
        await cache.waitForIdle();
        assert.equal(cache.get(x), previous);
    } finally { clearInterval(timer); cache.clear(); }
});

test("The budget includes the merge buffer and can limit the cache to one axis", async () => {
    const rows = 18000, x = column(rows, 31), y = column(rows, 17);
    const cache = new AxisIndexCache(rows * 8);
    cache.prepare([x, y], rows, () => assert.equal(cache.progress, 1, "Skipped axes must not count towards progress"));
    await cache.waitForIdle();
    assert.ok(cache.get(x));
    assert.equal(cache.get(y), undefined);
    assert.equal(cache.memoryBytes, rows * 4);
    cache.prepare([y], rows, () => {});
    await cache.waitForIdle();
    assert.equal(cache.get(x), undefined);
    assert.ok(cache.get(y));
    cache.clear();
    const tiny = new AxisIndexCache(rows * 8 - 1);
    const progress = [];
    tiny.onProgress = value => progress.push(value);
    tiny.prepare([x], rows, () => {});
    await tiny.waitForIdle();
    assert.equal(tiny.get(x), undefined);
    assert.equal(tiny.memoryBytes, 0);
    assert.equal(tiny.progress, null);
    assert.deepEqual(progress, [], "Skipping every axis must not show a progress bar");
});

test("Changing axes cancels an unfinished index before publishing stale results", async () => {
    const rows = 100000, x = column(rows, 31), y = column(rows, 17), ready = [];
    const cache = new AxisIndexCache(rows * 8);
    const progress = [];
    cache.onProgress = value => progress.push(value);
    cache.prepare([x], rows, () => ready.push("x"));
    await new Promise(resolve => setTimeout(resolve, 3));
    cache.prepare([y], rows, () => ready.push("y"));
    await cache.waitForIdle();
    assert.deepEqual(ready, ["y"]);
    assert.equal(cache.get(x), undefined);
    assert.ok(cache.get(y));
    assert.equal(progress.filter(value => value === null).length, 1, "Cancelled work must not hide the replacement progress bar");
    cache.clear();
    assert.equal(cache.memoryBytes, 0);
});

test("Index progress covers all planned axes and resets after completion", async () => {
    const rows = 32769, x = column(rows, 31), y = column(rows, 17);
    const cache = new AxisIndexCache(rows * 12), progress = [], completed = [];
    cache.onProgress = value => progress.push(value);
    cache.prepare([x, y], rows, () => completed.push(cache.progress));
    assert.equal(cache.progress, 0);
    await cache.waitForIdle();
    assert.deepEqual(completed, [0.5, 1]);
    assert.equal(progress[0], 0);
    assert.equal(progress.at(-1), null);
    const values = progress.filter(value => value !== null);
    assert.ok(values.every((value, i) => value >= 0 && value <= 1 && (i === 0 || value >= values[i - 1])));
    assert.equal(cache.progress, null);
    const notifications = progress.length;
    cache.prepare([y, x], rows, () => { throw new Error("Reused indexes must not rebuild"); });
    await cache.waitForIdle();
    assert.equal(progress.length, notifications, "Reusing indexes must not restart progress");
    cache.clear();
});

test("Clearing an unfinished index hides progress without stale notifications", async () => {
    const rows = 100000, cache = new AxisIndexCache(rows * 8), progress = [];
    cache.onProgress = value => progress.push(value);
    cache.prepare([column(rows, 31)], rows, () => { throw new Error("Cancelled work must not complete"); });
    await new Promise(resolve => setTimeout(resolve, 3));
    assert.notEqual(cache.progress, null);
    cache.clear();
    assert.equal(cache.progress, null);
    assert.equal(progress.at(-1), null);
    const notifications = progress.length;
    await cache.waitForIdle();
    assert.equal(progress.length, notifications);
    assert.equal(cache.memoryBytes, 0);
});

test("Sorted axes use the existing row order without allocating an index", async () => {
    const sorted = { ...column(100, 1), stat: { min: 0, max: 99, deviationFromMax: 0 } };
    const cache = new AxisIndexCache(0);
    cache.prepare([sorted, sorted], 100, () => { throw new Error("No index is needed"); });
    await cache.waitForIdle();
    assert.equal(cache.memoryBytes, 0);
});

test("Indexed viewport queries match a full scan before and after swapping axes", async () => {
    const loader = new Loader(), rows = 20000;
    const reader = { load(line, done) {
        line("x,y,color");
        for (let i = 0; i < rows; i++) line(`${i * 31 % 257},${i * 17 % 257},${i % 3}`);
        done();
    }, getProgress() { return 1; }, cancel() {} };
    loader.load(reader, () => {}, () => {}, () => {}, error => { throw error; }, () => {});
    for (const swapped of [false, true]) {
        const view = loader.GetDataView({ view: { axisXField: swapped ? "y" : "x", axisYField: swapped ? "x" : "y", colorField: "color" }, columns: {} });
        await loader.axisIndexes.waitForIdle();
        const selection = view.getVisibleRows(25, 10, 31, 100), actual = [], expected = [];
        assert.ok(selection.end - selection.start < rows);
        for (let i = selection.start; i < selection.end; i++) {
            const row = selection.order ? selection.order[i] : i;
            if (view.getX(row) >= 25 && view.getX(row) <= 31 && view.getY(row) >= 10 && view.getY(row) <= 100) actual.push(row);
        }
        for (let row = 0; row < rows; row++) if (view.getX(row) >= 25 && view.getX(row) <= 31 && view.getY(row) >= 10 && view.getY(row) <= 100) expected.push(row);
        assert.deepEqual(actual.sort((a, b) => a - b), expected);
    }
    loader.reset();
    await loader.axisIndexes.waitForIdle();
    assert.equal(loader.axisIndexes.memoryBytes, 0);
});
