const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

// Use the existing TypeScript compiler to load the rendering modules in Node.
require.extensions[".ts"] = (module, filename) => {
    const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    module._compile(source, filename);
};
const { Loader } = require("../src/loader.ts");
const { inferViewDefinition } = require("../src/data_view.ts");
const { CanvasRenderer, GridMap, INITIAL_RENDERER_CONTEXT } = require("../src/canvas_renderer.ts");
const { RectRendererWebGL } = require("../src/rect_renderer.ts");

function load(csv, definition) {
    const loader = new Loader();
    const reader = {
        load(onLine, onFinish) {
            csv.trimEnd().split("\n").forEach(onLine);
            onFinish();
        },
        getProgress() { return 1; },
        cancel() {}
    };
    loader.load(reader, () => {}, () => {}, () => {}, error => { throw error; }, () => {});
    const view = loader.GetDataView(definition || inferViewDefinition(loader));
    for (const method of ["getX", "getY"]) {
        const original = view[method].bind(view);
        view[method] = index => {
            assert.ok(index >= 0 && index < loader.numRows, `Read outside dataset: ${index}`);
            return original(index);
        };
    }
    return { loader, view };
}

function makeRenderer() {
    // The rectangle backend is the test boundary; exercise the real range/fit logic.
    const previousDocument = global.document;
    global.document = { createElement() { return { getContext() { return null; } }; } };
    let renderer;
    try {
        renderer = new CanvasRenderer();
    } finally {
        global.document = previousDocument;
    }
    const rectangles = [];
    renderer.rectRenderer = {
        beginRawMode() { rectangles.length = 0; },
        endRawMode() {},
        fillRect(x, y, width, height, color) { rectangles.push({ x, y, width, height, color }); }
    };
    const context = {
        fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}
    };
    return { renderer, rectangles, canvas: { getContext() { return context; } } };
}

const sample = fs.readFileSync(path.join(__dirname, "../docs/sample.csv"), "utf8");
const gridCSV = "cycle,unit\n" + Array.from({ length: 6 }, (_, y) =>
    Array.from({ length: 6 }, (_, x) => `${y},${x}`).join("\n")
).join("\n");

for (const [width, height] of [[500, 340], [500, 343], [900, 687], [300, 179]]) {
    test(`Fit renders all 128 sample points at ${width}x${height}`, () => {
        const { view } = load(sample);
        const { renderer, rectangles, canvas } = makeRenderer();
        const context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width, height });
        renderer.draw(canvas, new GridMap(), view, context);
        assert.equal(rectangles.length, 128);
        const lastRow = rectangles.filter(rect => Math.abs(rect.y - 31 * Math.exp(context.scaleYLog)) < 1e-8);
        assert.equal(lastRow.length, 4, "All four units in cycle 31 must be drawn");
    });
}

test("Fit includes the last column when the sorted cycle column is assigned to X", () => {
    const { view } = load(sample, {
        view: { axisXField: "cycle", axisYField: "unit", colorField: "state" }, columns: {}
    });
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
    renderer.draw(canvas, new GridMap(), view, context);
    assert.equal(rectangles.length, 128);
});

test("Fractional panning keeps partially visible cells at all four edges", () => {
    const { loader, view } = load(gridCSV);
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = {
        ...INITIAL_RENDERER_CONTEXT, width: 90, height: 60,
        scaleXLog: Math.log(10), scaleYLog: Math.log(10), offsetX: 5, offsetY: 5
    };
    const grid = new GridMap();
    renderer.draw(canvas, grid, view, context);
    assert.equal(rectangles.length, 25);
    assert.ok(renderer.getText(88, 38, grid, view, context, loader).includes("cycle: 4, unit: 4"));
});

test("Derived coordinates near the bottom edge are not rounded out of the view", () => {
    const { view } = load(gridCSV, {
        view: { axisXField: "halfUnit", axisYField: "halfCycle" },
        columns: { halfUnit: "unit / 2", halfCycle: "cycle / 2" }
    });
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = {
        ...INITIAL_RENDERER_CONTEXT, width: 73, height: 43,
        scaleXLog: Math.log(10), scaleYLog: Math.log(10)
    };
    renderer.draw(canvas, new GridMap(), view, context);
    assert.equal(rectangles.length, 25);
});

test("Minimum point size keeps cells overlapping the top and left edges", () => {
    const { view } = load(gridCSV);
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = {
        ...INITIAL_RENDERER_CONTEXT, width: 60, height: 30,
        scaleXLog: 0, scaleYLog: 0, offsetX: 3, offsetY: 3,
        minPlotWidth: 5, minPlotHeight: 5
    };
    renderer.draw(canvas, new GridMap(), view, context);
    assert.equal(rectangles.length, 36);
});

test("A viewport outside the data draws no points and never reads past the last row", () => {
    const { view } = load(sample);
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = {
        ...INITIAL_RENDERER_CONTEXT, width: 500, height: 340,
        scaleXLog: 0, scaleYLog: 0, offsetX: 100, offsetY: 100
    };
    renderer.draw(canvas, new GridMap(), view, context);
    assert.equal(rectangles.length, 0);
});

test("Unsorted axes scan every row without reading past the dataset", () => {
    const { view } = load("cycle,unit\n3,2\n0,1\n3,0\n1,2\n");
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 500, height: 340 });
    renderer.draw(canvas, new GridMap(), view, context);
    assert.equal(rectangles.length, 4);
});

test("An empty dataset draws no points", () => {
    const { view } = load("cycle,unit\n");
    const { renderer, rectangles, canvas } = makeRenderer();
    renderer.draw(canvas, new GridMap(), view, { ...INITIAL_RENDERER_CONTEXT, width: 500, height: 340 });
    assert.equal(rectangles.length, 0);
});

test("Derived axes use actual ranges and do not binary search descending or modulo values", () => {
    const csv = "cycle,unit\n" + Array.from({ length: 40 }, (_, i) => `${i},${i % 3}`).join("\n");
    for (const expression of ["-cycle", "cycle % 7", "unit"]) {
        const { loader, view } = load(csv, {
            view: { axisXField: "derived", axisYField: "unit" }, columns: { derived: expression }
        });
        const values = Array.from({ length: loader.numRows }, (_, i) => view.getX(i));
        assert.equal(view.getMinX(), Math.min(...values));
        assert.equal(view.getMaxX(), Math.max(...values));
        assert.ok(view.columnFromName("derived").stat.deviationFromMax > 0);
        const selection = view.getVisibleRows(view.getX(4) - 0.5, 0, view.getX(4) + 0.5, 2);
        assert.equal(selection.start, 0);
        assert.equal(selection.end, loader.numRows);
        loader.reset();
    }
});

test("Fit includes the full range of billion-scale axes", () => {
    const { view } = load("x,y\n0,0\n2100000000,1", { view: { axisXField: "x", axisYField: "y" }, columns: {} });
    const { renderer, canvas, rectangles } = makeRenderer();
    const context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 1010, height: 660 });
    renderer.draw(canvas, new GridMap(), view, context);
    assert.equal(rectangles.length, 2);
});

test("Continuous colors include the maximum and constant values", () => {
    for (const values of [[0, 1, 20], [5, 5, 5]]) {
        const { view } = load("x,y,color\n" + values.map((c, i) => `${i},${i},${c}`).join("\n"), {
            view: { axisXField: "x", axisYField: "y", colorField: "color", colorMap: "viridis" }, columns: {}
        });
        for (let i = 0; i < values.length; i++) assert.notEqual(view.getPalette()[view.getColorIndex(i)], undefined);
    }
});

test("Horizontal zoom keeps a rare point in a large interleaved dataset", () => {
    const n = 100001, csv = "cycle,unit\n" + Array.from({ length: n }, (_, i) => `${i},${i === 50001 ? 1 : 0}`).join("\n");
    const { loader, view } = load(csv);
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 60, height: 26,
        scaleXLog: Math.log(100), scaleYLog: Math.log(6 / n), offsetX: 100 };
    renderer.draw(canvas, new GridMap(), view, context);
    const visible = rectangles.filter(rect => rect.x >= 50);
    assert.equal(visible.length, 1);
    assert.ok(Math.abs(visible[0].y - 50001 * 6 / n) < 1e-8);
    loader.reset();
});

test("Pixel aggregation preserves the final color of overlapping rectangles", () => {
    const n = 100003;
    const csv = "x,y,color\n" + Array.from({ length: n }, (_, i) => `${Math.floor(i / 4) % 17},${Math.floor(i / 4) * 3 % 19},${i % 3}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "x", axisYField: "y", colorField: "color" }, columns: {} });
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 70, height: 40, offsetX: 0.25, offsetY: 0.75,
        scaleXLog: Math.log(0.7), scaleYLog: Math.log(0.8), minPlotWidth: 3, minPlotHeight: 2 };
    function paint(rects, rx, ry) {
        const pitch = Math.round(70 * rx), height = Math.round(40 * ry);
        const pixels = new Uint32Array(pitch * height);
        for (const r of rects) {
            const x0 = Math.max(0, Math.ceil(r.x * rx - 0.5));
            const x1 = Math.min(pitch, Math.ceil((r.x + r.width) * rx - 0.5));
            const y0 = Math.max(0, Math.ceil(r.y * ry - 0.5));
            const y1 = Math.min(height, Math.ceil((r.y + r.height) * ry - 0.5));
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixels[y * pitch + x] = r.color;
        }
        return pixels;
    }
    for (const [minPlotWidth, minPlotHeight] of [[1, 1], [3, 2]]) {
        const next = { ...context, minPlotWidth, minPlotHeight };
        const full = Array.from({ length: n }, (_, i) => ({ x: 50 + view.getX(i) * Math.exp(context.scaleXLog) - 0.25, y: view.getY(i) * Math.exp(context.scaleYLog) - 0.75,
            width: minPlotWidth, height: minPlotHeight, color: view.getPalette()[view.getColorIndex(i)] }));
        for (const [rx, ry] of [[1, 1], [2, 2], [87 / 70, 1.25]]) {
            canvas.clientWidth = 70; canvas.width = Math.round(70 * rx);
            canvas.clientHeight = 40; canvas.height = Math.round(40 * ry);
            renderer.draw(canvas, new GridMap(), view, next);
            assert.ok(rectangles.length < 1000);
            assert.deepEqual(paint(rectangles, rx, ry), paint(full, rx, ry));
        }
    }
    loader.reset();
});

test("Overview traversal preserves boundary rows, colors and swapped or fractional axes", async () => {
    const n = 160003, csv = "x,y,color\n" + Array.from({ length: n }, (_, i) => `${i % 17},${Math.floor(i / 17) % 19},${i % 3}`).join("\n");
    const original = { view: { axisXField: "x", axisYField: "y", colorField: "color" }, columns: {} };
    const { loader } = load(csv, original), { renderer, canvas } = makeRenderer();
    for (const definition of [original, { ...original, view: { ...original.view, axisXField: "y", axisYField: "x" } }, {
        view: { axisXField: "fractional", axisYField: "y", colorField: "color" }, columns: { fractional: "-x / 8" }
    }, {
        view: { axisXField: "x", axisYField: "time", colorField: "color" }, columns: { time: "y * 101" }
    }, {
        view: { axisXField: "time", axisYField: "x", colorField: "color" }, columns: { time: "y * 101" }
    }]) {
        const view = loader.GetDataView(definition);
        await loader.axisIndexes.waitForIdle();
        assert.ok(view.getOverviewIndex());
        for (const ratio of [1, 1.25]) {
            canvas.clientWidth = 70; canvas.width = Math.round(70 * ratio);
            canvas.clientHeight = 40; canvas.height = Math.round(40 * ratio);
            for (const [scale, offset, point] of [[0.0001, -0.25, 1], [0.7, 0.25, 1], [0.7, 0.25, 3]]) {
                const context = { ...INITIAL_RENDERER_CONTEXT, width: 70, height: 40,
                    scaleXLog: Math.log(scale), scaleYLog: Math.log(scale), offsetX: offset, offsetY: offset,
                    minPlotWidth: point, minPlotHeight: point };
                renderer.cancelPendingRows();
                renderer.draw(canvas, new GridMap(), view, context);
                const indexed = renderer.rowCache_.rows;
                const overview = view.getOverviewIndex;
                view.getOverviewIndex = () => null;
                try {
                    renderer.cancelPendingRows();
                    renderer.draw(canvas, new GridMap(), view, context);
                    assert.deepEqual(indexed, renderer.rowCache_.rows);
                } finally { view.getOverviewIndex = overview; }
            }
        }
    }
    const view = loader.GetDataView(original);
    await loader.axisIndexes.waitForIdle();
    let reads = 0;
    const getX = view.getX.bind(view);
    view.getX = row => { reads++; return getX(row); };
    renderer.cancelPendingRows();
    renderer.draw(canvas, new GridMap(), view, { ...INITIAL_RENDERER_CONTEXT, width: 70, height: 40,
        scaleXLog: Math.log(0.0001), scaleYLog: Math.log(0.0001), offsetX: -0.25, offsetY: -0.25 });
    assert.deepEqual(Array.from(renderer.rowCache_.rows), [n - 1]);
    assert.ok(reads < 50, "A collapsed overview must avoid reading all source coordinates");
    loader.reset();
});

test("Fit projection tables preserve signed coordinates, clipping and fractional pixel ratios", () => {
    const n = 120003, csv = "x,y,color\n" + Array.from({ length: n }, (_, i) =>
        `${i === 0 ? -2147483648 : i === 1 ? 2147483647 : (i * 7919) % 10000019},${i === 0 ? -2147483648 : i === 1 ? 2147483647 : (i * 8191) % 10000079},${i % 3}`
    ).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "x", axisYField: "y", colorField: "color" }, columns: {} });
    const { renderer, canvas } = makeRenderer(), columns = view.getAxisColumns.bind(view);
    assert.equal(view.getOverviewIndex(), null, "The lookup must also work before asynchronous indexes finish");
    let previousTables;
    for (const ratio of [1, 1.25, 2]) {
        canvas.clientWidth = 690; canvas.width = Math.round(690 * ratio);
        canvas.clientHeight = 340; canvas.height = Math.round(340 * ratio);
        const fit = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
        for (const [offset, point] of [[0, 1], [0.25, 1], [-0.75, 3]]) {
            const context = { ...fit, offsetX: fit.offsetX + offset, offsetY: fit.offsetY - offset, minPlotWidth: point, minPlotHeight: point };
            renderer.rowCache_ = null;
            renderer.fitRows_ = null;
            renderer.draw(canvas, new GridMap(), view, context);
            const actual = renderer.rowCache_.rows;
            assert.equal(renderer.projectionTables_.length, 2);
            assert.ok(renderer.projectionTables_.reduce((sum, table) => sum + table.byteLength, 0) <= 512 * 1024);
            if (previousTables) assert.ok(renderer.projectionTables_.every((table, i) => table === previousTables[i]));
            previousTables = renderer.projectionTables_.slice();
            view.getAxisColumns = () => columns().map(column => ({ ...column, buffer: undefined }));
            try {
                renderer.rowCache_ = null;
                renderer.fitRows_ = null;
                renderer.draw(canvas, new GridMap(), view, context);
                assert.deepEqual(actual, renderer.rowCache_.rows);
            } finally { view.getAxisColumns = columns; }
        }
    }
    loader.reset();
});

test("Returning to Fit reuses the overview and cancels a pending zoom", () => {
    const n = 120003, csv = "x,y\n" + Array.from({ length: n }, (_, i) => `${i % 101},${i % 103}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "x", axisYField: "y" }, columns: {} });
    const { renderer, canvas } = makeRenderer(), grid = new GridMap();
    const fit = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
    renderer.draw(canvas, grid, view, fit);
    const prepared = renderer.rowCache_;
    assert.equal(renderer.fitRows_, prepared);
    assert.ok(prepared.rows.byteLength <= 2 * 1024 * 1024);
    renderer.draw(canvas, grid, view, { ...fit, offsetX: fit.offsetX + 1 });
    assert.notEqual(renderer.rowCache_, prepared);
    renderer.draw(canvas, grid, view, { ...fit, offsetX: fit.offsetX + 2 }, () => { throw new Error("Cancelled zoom must not publish"); });
    assert.ok(renderer.pendingRows_);
    renderer.selectRows = () => { throw new Error("Returning to Fit must not prepare rows again"); };
    renderer.draw(canvas, grid, view, fit);
    assert.equal(renderer.rowCache_, prepared);
    assert.equal(renderer.pendingRows_, null);
    renderer.cancelPendingRows();
    assert.equal(renderer.fitRows_, null);
    loader.reset();
});

test("Large view preparation yields and discards a cancelled viewport", async () => {
    const n = 100001, csv = "cycle,unit\n" + Array.from({ length: n }, (_, i) => `${i},${i % 2}`).join("\n");
    const { loader, view } = load(csv);
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 100, height: 80 });
    let stale = 0;
    renderer.draw(canvas, new GridMap(), view, context, () => stale++);
    assert.equal(rectangles.length, 0);
    renderer.cancelPendingRows();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stale, 0);
    await new Promise(resolve => renderer.draw(canvas, new GridMap(), view, context, resolve));
    renderer.draw(canvas, new GridMap(), view, context);
    assert.ok(rectangles.length > 0);
    renderer.draw(canvas, new GridMap(), view, { ...context, offsetX: 1 }, () => stale++);
    renderer.draw(canvas, new GridMap(), view, context, () => stale++);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stale, 0, "Returning to a cached viewport must cancel the pending viewport");
    loader.reset();
});

test("Sorted axes restrict candidates to the intersection of their ranges", () => {
    const { loader, view } = load("x,y\n0,0\n1,0\n1,1\n2,1\n3,2\n4,3", {
        view: { axisXField: "x", axisYField: "y", colorField: "x" }, columns: {}
    });
    assert.deepEqual(view.getVisibleRows(1, 1, 3, 1), { order: null, start: 2, end: 4 });
    const disjoint = view.getVisibleRows(0, 2, 0, 3);
    assert.ok(disjoint.start >= disjoint.end);
    loader.reset();
});


test("Refined integer indexes preserve fresh Fit-scale pans and fractional raster boundaries", async () => {
    const n = 120003, csv = "x,y,color\n" + Array.from({ length: n }, (_, i) =>
        `${i === n - 1 ? 11002192 : i * 7919 % 400000},${i === n - 1 ? 25000174 : i * 8191 % 700000},${i % 3}`
    ).join("\n");
    const { loader } = load(csv, { view: { axisXField: "x", axisYField: "y", colorField: "color" }, columns: {} });
    const { renderer, canvas } = makeRenderer();
    let refined = 0;
    const select = renderer.selectRefinedRows;
    renderer.selectRefinedRows = function*(...args) { refined++; yield* select.apply(this, args); };
    for (const swapped of [false, true]) {
        const view = loader.GetDataView({ view: { axisXField: swapped ? "y" : "x", axisYField: swapped ? "x" : "y", colorField: "color" }, columns: {} });
        await loader.axisIndexes.waitForIdle();
        assert.ok(view.getOverviewIndex().index.fine);
        const fit = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
        for (const ratio of [1, 1.25, 2]) {
            canvas.clientWidth = 690; canvas.width = Math.round(690 * ratio);
            canvas.clientHeight = 340; canvas.height = Math.round(340 * ratio);
            for (const [offset, point] of [[0.37, 1], [-0.8, 1], [0.25, 3]]) {
                const context = { ...fit, offsetX: fit.offsetX + offset, offsetY: fit.offsetY - offset, minPlotWidth: point, minPlotHeight: point };
                renderer.cancelPendingRows();
                renderer.draw(canvas, new GridMap(), view, context);
                const actual = renderer.rowCache_.rows;
                const getOverview = view.getOverviewIndex;
                view.getOverviewIndex = () => null;
                try {
                    renderer.cancelPendingRows();
                    renderer.draw(canvas, new GridMap(), view, context);
                    assert.deepEqual(actual, renderer.rowCache_.rows);
                } finally { view.getOverviewIndex = getOverview; }
            }
        }
    }
    assert.ok(refined > 0, "Fresh viewports must use sparse refinement without relying on the Fit cache");
    loader.reset();
});

test("Exact interval queries preserve the last row across categories, swaps and pixel boundaries", async () => {
    const n = 120003, csv = "category,time,color\n" + Array.from({ length: n }, (_, i) =>
        `${i % 7 - 3},${i * 7919 % 60001 - 30000},${i % 3}`
    ).join("\n");
    const { loader } = load(csv, { view: { axisXField: "category", axisYField: "time", colorField: "color" }, columns: {} });
    const { renderer, canvas } = makeRenderer();
    for (const swapped of [false, true]) {
        const view = loader.GetDataView({ view: { axisXField: swapped ? "time" : "category", axisYField: swapped ? "category" : "time", colorField: "color" }, columns: {} });
        await loader.axisIndexes.waitForIdle();
        assert.ok(renderer.exactOverview(view));
        const fit = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
        for (const ratio of [1, 1.25, 2]) {
            canvas.clientWidth = 690; canvas.width = Math.round(690 * ratio);
            canvas.clientHeight = 340; canvas.height = Math.round(340 * ratio);
            for (const [zoom, offset, point] of [[1, 0.37, 1], [0.5, -0.8, 3], [0.0001, 0.25, 1], [3, 0.53, 1]]) {
                const context = { ...fit, scaleXLog: fit.scaleXLog + Math.log(zoom), scaleYLog: fit.scaleYLog + Math.log(zoom),
                    offsetX: fit.offsetX * zoom + offset, offsetY: fit.offsetY * zoom - offset, minPlotWidth: point, minPlotHeight: point };
                renderer.cancelPendingRows();
                renderer.draw(canvas, new GridMap(), view, context);
                const actual = renderer.rowCache_.rows;
                const getOverview = view.getOverviewIndex;
                view.getOverviewIndex = () => null;
                try {
                    renderer.cancelPendingRows();
                    renderer.draw(canvas, new GridMap(), view, context);
                    assert.deepEqual(actual, renderer.rowCache_.rows);
                } finally { view.getOverviewIndex = getOverview; }
            }
        }
    }
    loader.reset();
});

test("Fast indexed preparation draws in the input frame without another redraw request", async () => {
    const n = 120003, csv = "category,time\n" + Array.from({ length: n }, (_, i) => `${i % 3},${i % 60001}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "category", axisYField: "time" }, columns: {} });
    await loader.axisIndexes.waitForIdle();
    const { renderer, canvas, rectangles } = makeRenderer();
    const fit = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 100, height: 80 });
    assert.ok(renderer.exactOverview(view));
    let redraws = 0;
    // 実行機の負荷に左右されず、最初のsliceの完了と時間切れの両方を確認する。
    const clock = Object.getOwnPropertyDescriptor(globalThis, "performance");
    let exhausted = false, elapsed = 0;
    Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => exhausted ? elapsed += 7 : 0 } });
    try {
        renderer.draw(canvas, new GridMap(), view, fit, () => redraws++);
        assert.equal(renderer.pendingRows_, null);
        assert.ok(rectangles.length > 0);
        exhausted = true;
        renderer.draw(canvas, new GridMap(), view, { ...fit, offsetX: fit.offsetX + 0.37 }, () => redraws++);
        assert.ok(renderer.pendingRows_, "An exhausted initial slice must yield to the UI");
        renderer.cancelPendingRows();
    } finally { Object.defineProperty(globalThis, "performance", clock); }
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(redraws, 0);
    loader.reset();
});

test("Direct raster and GPU batches agree on clipped, overlapping and half-pixel rectangles", () => {
    const background = 0xff231e1c, red = 0xff0000ff, blue = 0xffff0000, green = 0xff00ff00;
    let displayed;
    const ctx = {
        createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
        putImageData(image, x, y) { assert.equal(x, 0); assert.equal(y, 0); displayed = image; }
    };
    const canvas = { width: 10, height: 6, clientWidth: 8, clientHeight: 3, getContext() { return ctx; } };
    const rects = [
        [0.4, 0.25, 1.6, 1, red], [1.2, 0.75, 1.6, 0.5, blue], [-2, -1, 2.8, 1.5, green],
        [8, 0, 1, 1, red], [0, 3, 1, 1, red], [0, 0, 0.1, 0.1, red]
    ];
    const raster = new RectRendererWebGL();
    raster.beginRasterMode(canvas, background);
    for (const args of rects) raster.fillRect(...args);
    raster.endRawMode();
    const expected = new Uint32Array(60).fill(background);
    expected[0] = green; expected[1] = red; expected[10] = red; expected[11] = blue; expected[12] = blue;
    assert.deepEqual(new Uint32Array(displayed.data.buffer), expected);
    const retained = displayed;
    raster.beginRasterMode(canvas, background);
    raster.endRawMode();
    assert.equal(displayed, retained, "The image allocation must be reused");
    assert.ok(new Uint32Array(displayed.data.buffer).every(color => color === background));

    // WebGL contextを作らず、実際のGPUバッチ生成だけを検証する。
    raster.rasterMode_ = false; raster.rawMode_ = true;
    for (const args of rects) raster.fillRect(...args);
    assert.equal(raster.count_, 3);
    const gpuPixels = new Uint32Array(60).fill(background);
    for (let i = 0; i < raster.count_; i++) {
        const x0 = raster.pos_[i * 2], y0 = raster.pos_[i * 2 + 1];
        const x1 = x0 + raster.size_[i * 2], y1 = y0 + raster.size_[i * 2 + 1];
        for (let y = y0; y < y1; y++) gpuPixels.fill(raster.color_[i], y * 10 + x0, y * 10 + x1);
    }
    assert.deepEqual(gpuPixels, expected);
});

test("Direct raster is limited to small opaque indexed points and bounded image memory", async () => {
    const n = 120003, csv = "category,time\n" + Array.from({ length: n }, (_, i) => `${i % 3},${i % 60001}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "category", axisYField: "time" }, columns: {} });
    await loader.axisIndexes.waitForIdle();
    const { renderer, canvas } = makeRenderer(), gl = new RectRendererWebGL();
    let raster = 0, batches = 0;
    gl.beginRasterMode = () => raster++;
    gl.beginRawMode = () => batches++;
    gl.fillRect = () => {};
    gl.endRawMode = () => {};
    renderer.rectRenderer = gl;
    canvas.clientWidth = canvas.width = 690;
    canvas.clientHeight = canvas.height = 340;
    const fit = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
    renderer.draw(canvas, new GridMap(), view, fit);
    assert.equal(raster, 1);
    const palette = view.getPalette.bind(view);
    view.getPalette = () => palette().map(color => (color & 0xffffff) | 0x80000000);
    renderer.draw(canvas, new GridMap(), view, fit);
    assert.equal(batches, 1, "Translucent points require blending");
    view.getPalette = palette;
    renderer.draw(canvas, new GridMap(), view, { ...fit, minPlotWidth: 3, minPlotHeight: 3 });
    assert.equal(batches, 2, "Larger points must retain the GPU backend");
    canvas.width = canvas.height = 4096;
    renderer.draw(canvas, new GridMap(), view, fit);
    assert.equal(batches, 3, "The raster image must stay within 16 MiB");
    assert.equal(raster, 1);
    loader.reset();
});
