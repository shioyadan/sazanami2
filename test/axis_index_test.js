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

test("Integer indexes preserve signed values and stable ties within the working budget", async () => {
    const rows = 65537;
    const buffer = Int32Array.from({ length: rows }, (_, i) => i % 17 === 0 ? -2147483648 : i % 31 === 0 ? 2147483647 : i * 1234567);
    const x = { buffer, stat: { deviationFromMax: Infinity }, getNumber(i) { return buffer[i]; } };
    const y = { ...x, buffer: Int32Array.from(buffer, value => ~value), getNumber(i) { return this.buffer[i]; } };
    const cache = new AxisIndexCache(rows * 12 + 4096);
    let ticks = 0, peak = 0;
    const timer = setInterval(() => { ticks++; peak = Math.max(peak, cache.memoryBytes); }, 1);
    try {
        cache.prepare([x, y], rows, () => {});
        await cache.waitForIdle();
        assert.ok(ticks > 0);
        assert.ok(peak <= cache.budgetBytes);
        assert.equal(cache.memoryBytes, rows * 8);
        for (const col of [x, y]) {
            const expected = Array.from({ length: rows }, (_, row) => row).sort((a, b) => col.getNumber(a) - col.getNumber(b) || a - b);
            assert.deepEqual(Array.from(cache.get(col)), expected);
        }
    } finally { clearInterval(timer); cache.clear(); }
    const tiny = new AxisIndexCache(rows * 8 + 4095);
    tiny.prepare([x], rows, () => { throw new Error("The histogram must fit in the budget"); });
    await tiny.waitForIdle();
    assert.equal(tiny.get(x), undefined);
    assert.equal(tiny.progress, null);
});

test("Overview levels retain all source rows within the shared index budget", async () => {
    const rows = 100003;
    const makeColumn = formula => {
        const buffer = Int32Array.from({ length: rows }, (_, i) => formula(i));
        return { buffer, stat: { min: 0, max: 126, deviationFromMax: 126 }, getNumber(i) { return buffer[i]; } };
    };
    const x = makeColumn(i => i % 127), y = makeColumn(i => Math.floor(i / 127) % 127);
    const cache = new AxisIndexCache(rows * 12 + 100000);
    let peak = 0;
    cache.onProgress = () => { peak = Math.max(peak, cache.memoryBytes); };
    cache.prepare([x, y], rows, () => {});
    await cache.waitForIdle();
    const index = cache.getOverview([x, y]);
    assert.ok(index);
    assert.ok(peak <= cache.budgetBytes && cache.memoryBytes <= cache.budgetBytes);
    const seen = new Uint8Array(rows);
    for (const head of index.levels[0].heads) {
        for (let link = head; link; link = index.next[link - 1]) {
            assert.equal(seen[link - 1]++, 0);
            assert.ok(index.next[link - 1] < link);
        }
    }
    assert.ok(seen.every(value => value === 1));
    assert.equal(index.levels.at(-1).heads[0], rows);
    assert.equal(cache.getOverview([x, x]), null);
    cache.prepare([y, x], rows, () => { throw new Error("Swapped axes must reuse the overview"); });
    await cache.waitForIdle();
    assert.equal(cache.getOverview([y, x]), index);
    cache.clear();
    assert.equal(cache.getOverview([x, y]), null);
    assert.equal(cache.memoryBytes, 0);
});

test("A replaced overview cannot publish stale data or progress", async () => {
    const rows = 100003, buffer = Int32Array.from({ length: rows }, (_, i) => i);
    const x = { buffer, stat: { min: 0, max: rows - 1, deviationFromMax: 0 }, getNumber(i) { return buffer[i]; } };
    const y = { ...x }, replacement = { ...x };
    const cache = new AxisIndexCache(rows * 12), ready = [];
    cache.prepare([x, y], rows, () => ready.push("old"));
    await new Promise(resolve => setTimeout(resolve, 1));
    cache.prepare([x, replacement], rows, () => ready.push("new"));
    await cache.waitForIdle();
    assert.deepEqual(ready, ["new"]);
    assert.equal(cache.getOverview([x, y]), null);
    assert.ok(cache.getOverview([x, replacement]));
    assert.equal(cache.progress, null);
    cache.clear();
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


test("Sparse refinement retains every row and respects a limited shared budget", async () => {
    const rows = 120003;
    const makeColumn = (max, stride, range) => {
        const buffer = Int32Array.from({ length: rows }, (_, i) => i === rows - 1 ? max : i * stride % range);
        return { buffer, stat: { min: 0, max, deviationFromMax: max }, getNumber(i) { return buffer[i]; } };
    };
    const x = makeColumn(11002192, 7919, 400000), y = makeColumn(25000174, 8191, 700000);
    const cache = new AxisIndexCache(8 * 1024 * 1024);
    let peak = 0;
    cache.onProgress = () => { peak = Math.max(peak, cache.memoryBytes); };
    cache.prepare([x, y], rows, () => {});
    await cache.waitForIdle();
    const index = cache.getOverview([x, y]), fine = index.fine;
    assert.ok(fine && fine.factorX * fine.factorY > 1);
    assert.ok(peak <= cache.budgetBytes && cache.memoryBytes <= cache.budgetBytes);
    const seen = new Uint8Array(rows), maxima = new Uint32Array(index.levels[0].heads.length);
    for (let slot = 0; slot < fine.cells.length; slot += 2) {
        const key = fine.cells[slot], head = fine.cells[slot + 1];
        if (slot) assert.ok(fine.cells[slot - 2] < key);
        const bx = key % fine.width, by = Math.floor(key / fine.width);
        const cell = Math.floor(by / fine.factorY) * index.levels[0].width + Math.floor(bx / fine.factorX);
        maxima[cell] = Math.max(maxima[cell], head);
        for (let link = head; link; link = index.next[link - 1]) {
            assert.equal(seen[link - 1]++, 0);
            assert.ok(index.next[link - 1] < link);
        }
    }
    assert.deepEqual(maxima, index.levels[0].heads);
    assert.ok(seen.every(value => value === 1));
    assert.equal(index.levels.at(-1).heads[0], rows);
    cache.clear();
});
