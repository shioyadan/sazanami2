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
const { TiledCanvasRenderer } = require("../src/tiled_canvas_renderer.ts");
const { RectRendererSoft, RectRendererWebGL, pixelEdge } = require("../src/rect_renderer.ts");
const { Settings } = require("../src/settings.ts");
// 設定のStore testではWorkerを起動しない。圧縮読み込みは実browserで確認する。
require.cache[require.resolve("../src/zstd_worker.ts")] = { exports: { default: null } };
const { default: Store, ACTION, CHANGE } = require("../src/store.ts");

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
const wideGridCSV = "cycle,unit\n" + Array.from({ length: 6 }, (_, y) =>
    Array.from({ length: 6 }, (_, x) => `${y * 10000},${x * 10000}`).join("\n")
).join("\n");

test("Drag zoom stays strictly monotonic across the starting position on either axis", () => {
    const { renderer } = makeRenderer();
    const initial = { ...INITIAL_RENDERER_CONTEXT, width: 1000, height: 600,
        scaleXLog: Math.log(2.5), scaleYLog: Math.log(3.5), offsetX: 123.25, offsetY: 245.75 };
    for (const axis of ["x", "y"]) {
        let previous = -Infinity;
        for (let displacement = -20; displacement <= 20; displacement += 0.25) {
            const next = renderer.zoomDrag(initial, 180.5, 210.5,
                axis === "x" ? displacement : 0, axis === "y" ? displacement : 0);
            const active = axis === "x" ? next.scaleXLog : next.scaleYLog;
            assert.ok(active > previous, "Every nonzero movement must change the zoom, including around its starting scale");
            previous = active;
            assert.equal(axis === "x" ? next.scaleYLog : next.scaleXLog,
                axis === "x" ? initial.scaleYLog : initial.scaleXLog);
        }
    }
});

test("Drag zoom preserves its canvas anchor and returns exactly to the initial viewport", () => {
    const { renderer } = makeRenderer();
    const initial = { ...INITIAL_RENDERER_CONTEXT, width: 1000, height: 600,
        scaleXLog: Math.log(2.5), scaleYLog: Math.log(3.5), offsetX: 123.25, offsetY: 245.75 };
    const mouseX = 180.5, mouseY = 210.5;
    const anchor = ctx => [(mouseX - renderer.MARGIN_LEFT_ + ctx.offsetX) / Math.exp(ctx.scaleXLog),
        (mouseY + ctx.offsetY) / Math.exp(ctx.scaleYLog)];
    for (const [dx, dy] of [[0.25, -0.25], [500, 300], [-500, -300], [0, 0]]) {
        const next = renderer.zoomDrag(initial, mouseX, mouseY, dx, dy);
        anchor(next).forEach((value, axis) => assert.ok(Math.abs(value - anchor(initial)[axis]) < 1e-10));
    }
    assert.deepEqual(renderer.zoomDrag(initial, mouseX, mouseY, 0, 0), initial);
});

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

test("Image-only rendering keeps points and colors without a hover grid", () => {
    const { loader, view } = load(gridCSV);
    const { renderer, rectangles, canvas } = makeRenderer();
    const context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 500, height: 340 });
    const grid = new GridMap();
    const rows = renderer.draw(canvas, grid, view, context);
    const expected = rectangles.slice();
    assert.ok(grid.drawnIndex.some(row => row >= 0));
    assert.deepEqual(renderer.draw(canvas, null, view, context), rows);
    assert.deepEqual(rectangles, expected);
    loader.reset();
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

test("Monotonic and indexed ranges keep duplicate boundary values and all matching rows", () => {
    const { loader, view } = load("x,y\n0,3\n1,0\n1,2\n2,1\n3,2\n4,3", {
        view: { axisXField: "x", axisYField: "y" }, columns: {}
    });
    const [, column] = view.getAxisColumns();
    const order = Uint32Array.from([1, 3, 2, 4, 0, 5]);
    loader.axisIndexes.get = candidate => candidate === column ? order : null;
    for (const [xmin, ymin, xmax, ymax] of [[1, 1, 3, 2], [0, 2, 4, 2], [1, 0, 1, 3], [0, 4, 4, 4]]) {
        const selection = view.getVisibleRows(xmin, ymin, xmax, ymax);
        const candidates = Array.from({ length: Math.max(0, selection.end - selection.start) }, (_, i) =>
            selection.order ? selection.order[selection.start + i] : selection.start + i);
        const matches = row => view.getX(row) >= xmin && view.getX(row) <= xmax && view.getY(row) >= ymin && view.getY(row) <= ymax;
        assert.deepEqual(candidates.filter(matches).sort((a, b) => a - b),
            Array.from({ length: loader.numRows }, (_, row) => row).filter(matches));
    }
    loader.reset();
});

test("A sparse two-axis view avoids scanning large axis candidates without changing selected rows", async () => {
    const n = 240003, rare = 257;
    const csv = "x,y,color\n" + Array.from({ length: n }, (_, i) => {
        const low = i % 64 - 1, high = 100000 + i % 128;
        const [x, y] = i >= n - rare ? [low, low] : i % 2 ? [low, high] : [high, low];
        return `${x},${y},${i % 3}`;
    }).join("\n");
    const { loader } = load(csv, { view: { axisXField: "x", axisYField: "y", colorField: "color" }, columns: {} });
    for (const swapped of [false, true]) {
        const view = loader.GetDataView({ view: { axisXField: swapped ? "y" : "x", axisYField: swapped ? "x" : "y", colorField: "color" }, columns: {} });
        await loader.axisIndexes.waitForIdle();
        for (const ratio of [1, 1.25]) {
            const { renderer, canvas } = makeRenderer();
            canvas.clientWidth = 114; canvas.width = Math.round(114 * ratio);
            canvas.clientHeight = 84; canvas.height = Math.round(84 * ratio);
            const context = { ...INITIAL_RENDERER_CONTEXT, width: 114, height: 84, scaleXLog: 0, scaleYLog: 0,
                offsetX: 0.25, offsetY: 0.75, minPlotWidth: 2.5, minPlotHeight: 3 };
            assert.ok(view.getVisibleRows(-3, -3, 64, 64).end - view.getVisibleRows(-3, -3, 64, 64).start > 100000);
            let reads = 0;
            const original = view.getX;
            view.getX = row => { reads++; return original.call(view, row); };
            renderer.draw(canvas, new GridMap(), view, context);
            const indexed = renderer.rowCache_.rows;
            view.getX = original;
            assert.ok(reads < 1000, "Only the sparse two-axis matches should reach the rendering loop");
            assert.equal(renderer.pixelRows_, null, "Sparse views must avoid clearing a viewport-sized aggregation array");
            const getOverview = view.getOverviewIndex;
            view.getOverviewIndex = () => null;
            renderer.cancelPendingRows();
            renderer.draw(canvas, new GridMap(), view, context);
            assert.deepEqual(indexed, renderer.rowCache_.rows, "Clipping, last-row colors and input order must match the previous path");
            view.getOverviewIndex = getOverview;

            const soft = new CanvasRenderer(new RectRendererSoft());
            const query = soft.selectRows(view, context, { x: ratio, y: ratio }, view.getVisibleRows(-3, -3, 64, 64));
            let result;
            do { result = query.next(); } while (!result.done);
            assert.equal(result.value.length, rare, "Software compositing must retain every overlapping input row");
            assert.ok(Array.from(result.value).every((row, i) => row === n - rare + i));
        }
    }
    loader.reset();
});

test("Small axis bounds bypass overview work during tiled selection", async () => {
    const n = 100003, csv = "x,y\n" + Array.from({ length: n }, (_, i) => `${i * 7919 % 10000019},${i}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "x", axisYField: "y" }, columns: {} });
    await loader.axisIndexes.waitForIdle();
    assert.ok(view.getOverviewIndex());
    const { renderer, canvas } = makeRenderer();
    renderer.MARGIN_LEFT_ = renderer.MARGIN_BOTTOM_ = 0;
    renderer.exactOverview = () => { throw new Error("Small bounds must skip overview queries"); };
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 256, height: 256, scaleXLog: Math.log(0.000001), scaleYLog: 0,
        offsetY: n / 2 + 0.25 };
    renderer.draw(canvas, new GridMap(), view, context, undefined, { axes: false, aggregateSmallViews: true });
    assert.ok(renderer.rowCache_.rows.length > 200 && renderer.rowCache_.rows.length <= 258);
    assert.equal(renderer.pixelRows_, null);
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

test("Refined tile queries restrict sorted cells to the visible band without changing rows", async () => {
    const n = 120003, csv = "x,y,color\n" + Array.from({ length: n }, (_, i) => {
        const value = i * 7919 % 60001;
        return `${value * 10},${value},${i % 3}`;
    }).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "x", axisYField: "y", colorField: "color" }, columns: {} });
    await loader.axisIndexes.waitForIdle();
    const fine = view.getOverviewIndex().index.fine;
    assert.ok(fine);
    const cells = fine.cells;
    let reads = 0;
    fine.cells = new Proxy(cells, { get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, target);
    } });
    const { renderer, canvas } = makeRenderer();
    renderer.MARGIN_LEFT_ = renderer.MARGIN_BOTTOM_ = 0;
    canvas.width = canvas.clientWidth = canvas.height = canvas.clientHeight = 16;
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 16, height: 16,
        scaleXLog: Math.log(0.0008), scaleYLog: Math.log(0.0008), offsetX: 12.37, offsetY: 1.53 };
    try {
        renderer.draw(canvas, new GridMap(), view, context, undefined, { axes: false, aggregateSmallViews: true });
        const actual = renderer.rowCache_.rows;
        assert.ok(actual.length);
        assert.ok(reads < cells.length * 0.6, "Offscreen bands must not require scanning the entire refined index");
        view.getOverviewIndex = () => null;
        renderer.cancelPendingRows();
        renderer.draw(canvas, new GridMap(), view, context, undefined, { axes: false, aggregateSmallViews: true });
        assert.deepEqual(actual, renderer.rowCache_.rows, "Clipped points and last-row colors must match a scan of the axis candidates");
    } finally { fine.cells = cells; loader.reset(); }
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

test("Overview smoothing keeps alternating colors stable across a pixel boundary", async () => {
    const n = 120000, csv = "category,time,color\n" + Array.from({ length: n }, (_, i) => `${0},${i % 32},${i % 2}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "category", axisYField: "time", colorField: "color" }, columns: {} });
    await loader.axisIndexes.waitForIdle();
    view.getPalette = () => new Uint32Array([0xff0000ff, 0xffff0000]);
    const { renderer, canvas } = makeRenderer(), backend = new RectRendererWebGL();
    renderer.rectRenderer = backend;
    canvas.clientWidth = canvas.width = 60; canvas.clientHeight = canvas.height = 36;
    let displayed;
    const ctx = canvas.getContext("2d");
    ctx.createImageData = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
    ctx.putImageData = image => displayed = new Uint32Array(image.data.buffer).slice();
    const base = { ...INITIAL_RENDERER_CONTEXT, width: 60, height: 36, scaleXLog: Math.log(4), scaleYLog: Math.log(0.5) };
    function pixel(offsetY, smoothOverview) {
        renderer.draw(canvas, new GridMap(), view, { ...base, offsetY }, undefined, { axes: false, smoothOverview });
        return displayed[5 * 60 + 52];
    }
    try {
        assert.notEqual(pixel(-0.01, false), pixel(0.01, false), "A single sample changes the entire alternating pattern");
        assert.equal(pixel(-0.01, true), 0xff800080);
        assert.equal(pixel(0.01, true), 0xff800080, "Subpixel averaging must keep the same mixed color on both sides");
        assert.equal(backend.rasterImage_.data.byteLength, 60 * 36 * 16);
        assert.equal(backend.rasterOutput_.data.byteLength, 60 * 36 * 4);
    } finally { loader.reset(); }
});

test("Subpixel raster averages coverage with background and reuses its output", () => {
    const backend = new RectRendererWebGL(), canvas = { width: 2, height: 1, clientWidth: 2, clientHeight: 1 };
    let image;
    canvas.getContext = () => ({
        createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
        putImageData(value) { image = value; }
    });
    backend.beginRasterMode(canvas, 0xff231e1c, 2, 1, 2);
    backend.fillRect(0, 0, 0.5, 0.5, 0xff0000ff);
    backend.fillRect(1, 0, 1, 1, 0xffffffff);
    backend.endRawMode();
    assert.deepEqual(Array.from(image.data), [85, 23, 26, 255, 255, 255, 255, 255]);
    const previous = image;
    backend.beginRasterMode(canvas, 0xff231e1c, 2, 1, 2); backend.endRawMode();
    assert.equal(image, previous);
    assert.deepEqual(Array.from(image.data), [28, 30, 35, 255, 28, 30, 35, 255]);
});

test("Opaque thin points avoid GPU transfer without an exact overview on either axis", () => {
    const { loader, view } = load("x,y,color\n100,100,0\n100,100,1\n200000,200000,0", {
        view: { axisXField: "x", axisYField: "y", colorField: "color" }, columns: {}
    });
    const { renderer, canvas } = makeRenderer(), backend = new RectRendererWebGL();
    renderer.rectRenderer = backend;
    assert.equal(renderer.exactOverview(view), null);
    view.getPalette = () => new Uint32Array([0xff0000ff, 0xffff0000]);
    backend.beginRawMode = () => { throw new Error("Thin opaque points must not require GPU transfer"); };
    canvas.width = canvas.clientWidth = 90; canvas.height = canvas.clientHeight = 60;
    const ctx = canvas.getContext("2d");
    let displayed;
    ctx.createImageData = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
    ctx.putImageData = image => displayed = new Uint32Array(image.data.buffer);
    try {
        renderer.draw(canvas, new GridMap(), view, { ...INITIAL_RENDERER_CONTEXT, width: 90, height: 60,
            scaleXLog: Math.log(0.001), scaleYLog: Math.log(0.001), offsetX: 0.37, offsetY: 0.53 }, undefined,
            { axes: false, smoothOverview: true });
        assert.equal(displayed[50], 0xffff0000, "The clipped duplicate must retain the last input row's color");
        assert.equal(backend.rasterSamples_, 1, "Wide axes must preserve their existing single-sample colors");
    } finally { loader.reset(); }
});

test("Direct raster is limited to small opaque points and bounded image memory", async () => {
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

function tileEnvironment() {
    const { renderer } = makeRenderer(), previousWindow = global.window, previousDocument = global.document;
    const tiledRenderer = new TiledCanvasRenderer(renderer);
    const frames = new Map(), timers = new Map(), canvases = [];
    let nextId = 0, fills = 0;
    function makeCanvas(width = 0, height = 0, clientWidth = 0, clientHeight = 0) {
        const canvas = { width, height, clientWidth, clientHeight };
        const ctx = { canvas, save() {}, restore() {}, resetTransform() {}, setTransform() {}, drawImage() {},
            fillRect() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {} };
        canvas.getContext = () => ctx;
        canvases.push(canvas);
        return canvas;
    }
    global.document = { createElement: () => makeCanvas() };
    global.window = {
        requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    renderer.rectRenderer.fillRect = () => fills++;
    return {
        renderer, tiledRenderer, canvas: makeCanvas(690, 340, 690, 340), frames, timers, canvases, get fills() { return fills; },
        drain() {
            let iterations = 0;
            while (frames.size || timers.size) {
                assert.ok(iterations++ < 500, "Tile generation must finish without a busy loop");
                const queue = frames.size ? frames : timers, [id, fn] = queue.entries().next().value;
                queue.delete(id); fn();
            }
        },
        restore() {
            tiledRenderer.clear();
            renderer.cancelPendingRows();
            global.window = previousWindow; global.document = previousDocument;
        }
    };
}

test("Pixel boundaries remain stable under tile translation and floating-point roundoff", () => {
    for (const edge of [-1, 0, 608]) for (const shift of [-256, 0, 256, 512]) for (const error of [-2e-12, 0, 2e-12]) {
        assert.equal(pixelEdge(edge + 0.5 + error - shift) + shift, edge);
    }
    assert.equal(pixelEdge(608.50001), 609);
    assert.equal(pixelEdge(608.49999), 608);
});

test("Software rendering retains direct compositing when tiles are enabled", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
    Object.setPrototypeOf(renderer.rectRenderer, RectRendererSoft.prototype);
    try {
        tiledRenderer.draw(canvas, new GridMap(), view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 },
            () => { throw new Error("Software rendering must not queue tile updates"); }, { tiled: true });
        assert.ok(env.fills);
        assert.equal(tiledRenderer.tiles_.size, 0);
        assert.equal(env.frames.size, 0);
    } finally { env.restore(); loader.reset(); }
});

test("A tile working set above the memory budget falls back without regenerating forever", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 };
    let builds = 0;
    tiledRenderer.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    // 実際に巨大配列を確保せず、予算超過のpayloadを与えてfallbackを確認する。
    tiledRenderer.tileBuilder_.draw = () => {
        builds++;
        return { length: 1, byteLength: 64 * 1024 * 1024 + 4 };
    };
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        assert.ok(tiledRenderer.tileBypass_);
        assert.equal(tiledRenderer.tiles_.size, 0);
        assert.equal(tiledRenderer.tileBytes_, 0);
        paint(); env.drain();
        assert.equal(builds, 1, "The same oversized working set must use direct rendering thereafter");
        canvas.width = canvas.clientWidth = 900;
        tiledRenderer.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
        tiledRenderer.tileBuilder_.draw = () => new Uint32Array(0);
        tiledRenderer.draw(canvas, new GridMap(), view, { ...context, width: 900 }, () => {}, { tiled: true });
        env.drain();
        assert.ok(tiledRenderer.tiles_.size, "Resizing must retry the cache even after a previous budget fallback");
    } finally { env.restore(); loader.reset(); }
});

test("Tiles reuse integer pans and previous zoom levels without rerunning row selection", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), grid = new GridMap();
    const { renderer, tiledRenderer, canvas } = env;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: Math.log(10), scaleYLog: Math.log(10) };
    const paint = () => tiledRenderer.draw(canvas, grid, view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        assert.ok(tiledRenderer.tiles_.size > 0);
        assert.equal(tiledRenderer.tileBuilder_.rectRenderer, renderer.rectRenderer, "Tiles must share the existing backend");
        assert.ok(grid.drawnIndex.some(row => row >= 0), "Completed tiles must keep hover records");
        const fills = env.fills, select = renderer.selectRows, childSelect = tiledRenderer.tileBuilder_.selectRows;
        renderer.selectRows = tiledRenderer.tileBuilder_.selectRows = () => { throw new Error("Cached tiles must avoid selection"); };
        context = { ...context, offsetX: 8, offsetY: 4 };
        paint(); env.drain();
        assert.equal(env.fills, fills, "A prefetched pan must only blit existing images");
        tiledRenderer.tileBuilder_.selectRows = childSelect;
        const original = context;
        context = { ...context, scaleXLog: Math.log(20), scaleYLog: Math.log(20) };
        paint();
        assert.equal(env.timers.size, 1, "Zoom must defer the exact final scale while preparing stable scales");
        assert.equal(grid.drawnIndex, null, "Provisional images must not expose stale hover records");
        env.drain();
        const zoomFills = env.fills;
        tiledRenderer.tileBuilder_.selectRows = () => { throw new Error("Returning to a cached scale must reuse tiles"); };
        context = original;
        paint(); env.drain();
        assert.equal(env.fills, zoomFills);
        renderer.selectRows = select;
        let selections = 0;
        renderer.selectRows = function*(...args) { selections++; return yield* select.apply(this, args); };
        context = { ...context, offsetX: 40000, offsetY: 40000 };
        paint();
        assert.ok(selections > 0, "A distant jump must use direct rendering instead of a blank provisional image");
    } finally { env.restore(); loader.reset(); }
});

test("Tile updates cap visible and prefetched batches and defer prefetch during zoom", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { renderer, tiledRenderer: tiled, canvas } = env;
    const previousPerformance = global.performance;
    global.performance = { now: () => 1000 };
    canvas.width = canvas.clientWidth = 1280; canvas.height = canvas.clientHeight = 768;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 1280, height: 768, scaleXLog: 0, scaleYLog: 0 };
    tiled.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    let draws = 0;
    tiled.tileBuilder_.draw = () => { draws++; return Uint32Array.of(0); };
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    const tick = () => {
        const [id, fn] = env.frames.entries().next().value;
        const visible = tiled.tileJobs_[0]?.visible, candidates = tiled.tileJobs_.filter(job => job.visible === visible).length;
        const limit = tiled.tileSettled_ ? (visible ? 8 : 4) : 2;
        env.frames.delete(id); const before = draws; fn();
        assert.equal(draws - before, Math.min(limit, candidates), "A frame must cap tiles and yield before switching to prefetch");
    };
    try {
        paint();
        while (tiled.tileJobs_.some(job => job.visible)) tick();
        paint();
        const image = document.createElement("canvas"); image.width = image.height = 256;
        tiled.tilePending_ = { job: tiled.tileJobs_[0], canvas: image, context };
        tiled.tileBuilder_.pendingRows_ = { view, context, pixelRatio: { x: 1, y: 1 } };
        context = { ...context, scaleXLog: 0.01, scaleYLog: 0.01 };
        paint();
        assert.equal(tiled.tileSettled_, false);
        assert.equal(tiled.tilePending_, null, "Zoom must cancel an unfinished outer tile");
        assert.equal(tiled.tileBuilder_.isPreparingRows, false);
        assert.equal(image.width, 1);
        assert.ok(tiled.tileJobs_.length && tiled.tileJobs_.every(job => !job.visible));
        const before = draws;
        for (const [id, fn] of Array.from(env.frames)) { env.frames.delete(id); fn(); }
        assert.equal(draws, before, "A queued prefetch must yield when zoom starts");
        assert.equal(env.frames.size, 0, "Paused prefetch must not spin animation frames");
        const [id, fn] = env.timers.entries().next().value; env.timers.delete(id); fn();
        paint();
        while (env.frames.size) tick();
        assert.ok(draws > before, "Idle must resume the pending tiles");
        assert.equal(tiled.tileJobs_.length, 0);
    } finally { env.restore(); loader.reset(); global.performance = previousPerformance; }
});

test("Tile generation yields on time budgets before starting another image", () => {
    const { loader, view } = load(gridCSV), previousPerformance = global.performance;
    try {
        for (const [settled, visible, cost, expected] of [
            [false, true, 0, 2], [false, true, 2, 1],
            [true, true, 3, 2], [true, true, 7, 1],
            [true, false, 0, 4], [true, false, 1.5, 2], [true, false, 4, 1]
        ]) {
            const env = tileEnvironment(), { renderer, tiledRenderer: tiled, canvas } = env;
            let now = 1000, draws = 0;
            global.performance = { now: () => now };
            canvas.width = canvas.clientWidth = 1280; canvas.height = canvas.clientHeight = 768;
            tiled.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
            tiled.tileBuilder_.draw = () => { now += cost; draws++; return Uint32Array.of(0); };
            try {
                tiled.draw(canvas, new GridMap(), view, { ...INITIAL_RENDERER_CONTEXT, width: 1280, height: 768 }, () => {}, { tiled: true });
                tiled.tileSettled_ = settled;
                tiled.tileJobs_ = tiled.tileJobs_.filter(job => job.visible === visible);
                const [id, fn] = env.frames.entries().next().value; env.frames.delete(id); fn();
                assert.equal(draws, expected, `Unexpected image count for settled=${settled}, visible=${visible}, cost=${cost}`);
                assert.ok(tiled.tileJobs_.length, "Remaining work must resume on a later frame");
                assert.equal(env.frames.size, 1);
            } finally { env.restore(); }
        }
    } finally { global.performance = previousPerformance; loader.reset(); }
});

test("Rapid zooms keep the last complete layer instead of an incomplete intermediate layer", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { tiledRenderer, canvas } = env;
    canvas.width = canvas.clientWidth = 1280; canvas.height = canvas.clientHeight = 768;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 1280, height: 768, scaleXLog: Math.log(10), scaleYLog: Math.log(10) };
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    try {
        // 完成通知後の再描画を挟まずzoomし、直前frameで未確認の完成tileも引き継ぐ。
        paint(); env.drain();
        const completeLayer = tiledRenderer.tileLayer_;
        context = { ...context, scaleXLog: Math.log(11), scaleYLog: Math.log(11) };
        paint();
        const [timerId, timer] = env.timers.entries().next().value;
        env.timers.delete(timerId); timer();
        paint();
        const [frameId, frame] = env.frames.entries().next().value;
        env.frames.delete(frameId); frame();
        const intermediate = tiledRenderer.tileLayer_;
        assert.ok(Array.from(tiledRenderer.tiles_.values()).some(tile => tile.layer === intermediate));
        assert.ok(tiledRenderer.tileJobs_.some(job => job.visible), "The intermediate scale must still be incomplete");
        context = { ...context, scaleXLog: Math.log(12), scaleYLog: Math.log(12) };
        paint();
        assert.equal(tiledRenderer.tileFallback_, completeLayer, "An incomplete scale must not replace a complete fallback");
    } finally { env.restore(); loader.reset(); }
});

test("Prefetched tiles cover a centered half-scale zoom and an edge wheel step at fractional DPR", () => {
    const { loader, view } = load(gridCSV);
    try {
        for (const dpr of [1, 1.25, 2]) {
            const env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
            canvas.clientWidth = 1280; canvas.clientHeight = 768;
            canvas.width = 1280 * dpr; canvas.height = 768 * dpr;
            let context = { ...INITIAL_RENDERER_CONTEXT, width: 1280, height: 768,
                offsetX: 2048.37, offsetY: 2048.53 };
            const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
            try {
                paint(); env.drain(); paint();
                const original = context, layer = tiledRenderer.tileLayer_, before = env.fills;
                const centerX = (renderer.MARGIN_LEFT_ + context.width) / 2;
                const centerY = (context.height - renderer.MARGIN_BOTTOM_) / 2;
                for (const [factorX, factorY, x, y] of [
                    [0.5, 0.5, centerX, centerY], [0.5, 1, centerX, centerY],
                    [1 / 1.3, 1 / 1.3, renderer.MARGIN_LEFT_, 0],
                    [1 / 1.3, 1 / 1.3, context.width, context.height - renderer.MARGIN_BOTTOM_]
                ]) {
                    context = renderer.applyZoom(original, x, y, {
                        x: original.scaleXLog + Math.log(factorX), y: original.scaleYLog + Math.log(factorY)
                    });
                    paint();
                    const request = tiledRenderer.tileRequest_, bounds = Array.from(tiledRenderer.tiles_.values())
                        .filter(tile => tile.layer === layer).map(tile => tiledRenderer.tileBounds(tile, request));
                    assert.ok(Math.min(...bounds.map(b => b[0])) <= renderer.MARGIN_LEFT_ * dpr);
                    assert.ok(Math.min(...bounds.map(b => b[1])) <= 0);
                    assert.ok(Math.max(...bounds.map(b => b[2])) >= canvas.width,
                        "Old tiles must already cover the newly exposed right edge");
                    assert.ok(Math.max(...bounds.map(b => b[3])) >= (context.height - renderer.MARGIN_BOTTOM_) * dpr);
                    assert.equal(env.fills, before, "Zoom must reuse completed outer tiles before new generation starts");
                    assert.ok(env.timers.size, "The new scale must still wait until zoom settles");
                }
            } finally { env.restore(); }
        }
    } finally { loader.reset(); }
});

test("Missing visible tiles preempt pending outer preparation and reuse promoted jobs", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 };
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    try {
        paint();
        const outer = tiledRenderer.tileJobs_.find(job => !job.visible && job.x === 3 && job.y === 0);
        const image = document.createElement("canvas"); image.width = image.height = 256;
        tiledRenderer.tilePending_ = { job: outer, canvas: image, context };
        tiledRenderer.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
        let cancellations = 0;
        tiledRenderer.tileBuilder_.cancelPendingRows = () => cancellations++;
        paint();
        assert.equal(tiledRenderer.tilePending_, null, "Offscreen preparation must yield to missing visible tiles");
        assert.equal(image.width, 1);
        assert.equal(cancellations, 1);
        const promoted = document.createElement("canvas"); promoted.width = promoted.height = 256;
        tiledRenderer.tilePending_ = { job: outer, canvas: promoted, context };
        context = { ...context, offsetX: 256 };
        paint();
        assert.equal(tiledRenderer.tilePending_.canvas, promoted, "A tile that became visible must keep its preparation");
        assert.equal(tiledRenderer.tilePending_.job.visible, true);
        assert.equal(cancellations, 1);
    } finally { env.restore(); loader.reset(); }
});

test("Expanded prefetch stops at its budget while keeping every visible tile", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 };
    tiledRenderer.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    tiledRenderer.tileBuilder_.draw = () => {
        const rows = Uint32Array.of(0);
        Object.defineProperty(rows, "byteLength", { value: 6 * 1024 * 1024 });
        return rows;
    };
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        assert.equal(tiledRenderer.tileBypass_, null);
        assert.equal(tiledRenderer.tilePrefetchDisabled_, true);
        assert.ok(tiledRenderer.tileBytes_ <= 64 * 1024 * 1024);
        assert.ok(tiledRenderer.tilePositions(tiledRenderer.tileRequest_).filter(job => job.visible)
            .every(job => tiledRenderer.tiles_.has(job.key)));
        assert.equal(tiledRenderer.tileJobs_.length, 0);
        paint();
        assert.equal(tiledRenderer.tileJobs_.length, 0, "An unchanged range must not restart budget-limited prefetch");
        context.offsetX = 256;
        paint();
        assert.equal(tiledRenderer.tilePrefetchDisabled_, false, "Moving into a different tile range must retry prefetch");
        env.drain();
        assert.ok(tiledRenderer.tileBytes_ <= 64 * 1024 * 1024);
    } finally { env.restore(); loader.reset(); }
});

test("Expanded prefetch evicts obsolete tiles before dropping the current outer range", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
    canvas.clientWidth = canvas.width = 1280; canvas.clientHeight = canvas.height = 768;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 1280, height: 768 };
    tiledRenderer.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    tiledRenderer.tileBuilder_.draw = () => Uint32Array.of(0);
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        for (let i = 0; i < 5; i++) {
            context = { ...context, offsetX: i * 4096 };
            paint(); env.drain();
            assert.equal(tiledRenderer.tilePrefetchDisabled_, false);
            assert.ok(tiledRenderer.tilePositions(tiledRenderer.tileRequest_).every(job => tiledRenderer.tiles_.has(job.key)),
                "A fitting outer range must finish even after older positions fill the cache");
            assert.ok(tiledRenderer.tileBytes_ <= 64 * 1024 * 1024);
            assert.ok(tiledRenderer.tiles_.size <= 256);
        }
    } finally { env.restore(); loader.reset(); }
});

test("The global LRU evicts an older overview before a recently displayed zoom", () => {
    const env = solidTileEnvironment(), { tiledRenderer: tiled, context: fit, view, create, layer, add } = env;
    const canvas = create([0, 0, 255]), grid = new GridMap();
    const overview = tiled.tiles_.values().next().value;
    try {
        tiled.draw(canvas, grid, view, fit, () => {}, { tiled: true });
        const recentLayer = layer(1.1), recent = add(recentLayer, [255, 0, 0]);
        const context = { ...fit, scaleXLog: Math.log(1.1), scaleYLog: Math.log(1.1) };
        tiled.draw(canvas, grid, view, context, () => {}, { tiled: true });
        env.advance(120); tiled.draw(canvas, grid, view, context, () => {}, { tiled: true });
        const newestLayer = layer(2), newest = add(newestLayer, [0, 255, 0]);
        const newestKey = `${newestLayer.key}|0,0`;
        tiled.cacheLimits_.bytes = recent.bytes + newest.bytes;
        tiled.trimCache(new Set([newestKey]), new Set([newestKey]));
        assert.ok(!tiled.tiles_.has(`${overview.layer.key}|0,0`), "An old overview must not have a separate reservation");
        assert.equal(overview.canvas.width, 1);
        assert.equal(tiled.tiles_.get(`${recentLayer.key}|0,0`), recent);
        assert.equal(tiled.tiles_.get(newestKey), newest);
        assert.equal(tiled.tileBytes_, tiled.cacheLimits_.bytes);
    } finally { env.restore(); }
});

test("A sufficient shared cache reuses several complete 4K zooms at different device pixel ratios", () => {
    for (const ratio of [1, 1.5, 2]) {
        const { loader, view } = load(wideGridCSV), env = tileEnvironment();
        const { renderer, tiledRenderer: tiled, canvas } = env;
        canvas.width = 3840; canvas.height = 2160;
        canvas.clientWidth = 3840 / ratio; canvas.clientHeight = 2160 / ratio;
        let context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT,
            width: canvas.clientWidth, height: canvas.clientHeight });
        tiled.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
        tiled.tileBuilder_.draw = () => Uint32Array.of(0);
        const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
        try {
            const fit = context, span = Math.max(Math.log(4) - fit.scaleXLog, Math.log(4) - fit.scaleYLog);
            const overviews = [];
            for (const progress of [0, 0.375, 0.625, 0.875]) {
                context = { ...fit, scaleXLog: fit.scaleXLog + span * progress,
                    scaleYLog: fit.scaleYLog + span * progress };
                // 各倍率の可視画像の合計が容量内に収まる条件を作る。
                // 中間倍率と外周先読みは他のtestで確認する。
                tiled.tileZoomKey_ = tiled.zoomKey(context.scaleXLog, context.scaleYLog);
                paint(); tiled.tilePrefetchDisabled_ = true; paint(); env.drain();
                const visible = tiled.tilePositions(tiled.tileRequest_).filter(job => job.visible).map(job => job.key);
                assert.ok(visible.length > 64);
                overviews.push(visible);
                assert.ok(overviews.every(keys => keys.every(key => tiled.tiles_.has(key))));
                assert.ok(tiled.tileBytes_ <= 256 * 1024 * 1024);
            }
            for (const progress of [0.375, 0, 0.875, 0.625, 0]) {
                context = { ...fit, scaleXLog: fit.scaleXLog + span * progress,
                    scaleYLog: fit.scaleYLog + span * progress };
                paint();
                assert.ok(tiled.tileJobs_.every(job => !job.visible), "Every cached zoom must reuse the whole saved screen");
                assert.ok(tiled.layerCovers(tiled.tileRequest_, tiled.tileLayer_));
            }
            // 縮小したwindowでも、以前の大きい予算が残り続けないことを確認する。
            canvas.width = canvas.clientWidth = 690; canvas.height = canvas.clientHeight = 340;
            context = renderer.fitScaleToData(view, { ...fit, width: 690, height: 340 });
            paint(); env.drain();
            assert.ok(tiled.tileBytes_ <= 64 * 1024 * 1024);
            if (tiled.previousPlot_) assert.ok(tiled.previousPlot_.canvas.width * tiled.previousPlot_.canvas.height * 4 <= 16 * 1024 * 1024);
        } finally { env.restore(); loader.reset(); }
    }
});

test("Empty 4K tiles share the global cache without occupying image slots", () => {
    const { loader, view } = load(wideGridCSV), env = tileEnvironment();
    const { renderer, tiledRenderer: tiled, canvas } = env;
    canvas.width = canvas.clientWidth = 3840; canvas.height = canvas.clientHeight = 2160;
    let context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 3840, height: 2160 });
    tiled.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    let selections = 0;
    tiled.tileBuilder_.draw = () => { selections++; return new Uint32Array(0); };
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        const fit = context, span = Math.max(Math.log(4) - fit.scaleXLog, Math.log(4) - fit.scaleYLog);
        for (const progress of [0, 0.375, 0.625, 0.875]) {
            context = { ...fit, scaleXLog: fit.scaleXLog + span * progress, scaleYLog: fit.scaleYLog + span * progress };
            paint(); env.drain();
        }
        assert.ok(tiled.tiles_.size > 256, "Empty results must not exhaust the old image count limit");
        assert.ok(Array.from(tiled.tiles_.values()).every(tile => tile.canvas === null));
        assert.equal(tiled.tileBytes_, tiled.tiles_.size * 128);
        context = fit; paint(); env.drain();
        const completed = selections; paint(); env.drain();
        assert.equal(selections, completed, "A cached empty area must not rerun row selection");
        for (let i = 1; i <= 4; i++) {
            context = { ...fit, offsetX: i * 3840 }; paint(); env.drain();
            assert.equal(tiled.emptyTileCount_, tiled.tiles_.size);
            assert.ok(tiled.emptyTileCount_ <= tiled.cacheLimits_.emptyTiles);
        }
        tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: false });
        assert.equal(tiled.emptyTileCount_, 0);
        assert.equal(tiled.tiles_.size, 0);
    } finally { env.restore(); loader.reset(); }
});

test("An empty-result count overflow preserves existing image tiles", () => {
    const { loader, view } = load(wideGridCSV), env = tileEnvironment();
    const { renderer, tiledRenderer: tiled, canvas } = env;
    canvas.width = canvas.clientWidth = 3840; canvas.height = canvas.clientHeight = 2160;
    let context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 3840, height: 2160 });
    tiled.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    tiled.tileBuilder_.draw = () => Uint32Array.of(0);
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        const images = Array.from(tiled.tiles_.keys()), fit = context;
        tiled.tileBuilder_.draw = () => new Uint32Array(0);
        const span = Math.max(Math.log(4) - fit.scaleXLog, Math.log(4) - fit.scaleYLog);
        for (let i = 0; i <= 4; i++) {
            context = { ...fit, scaleXLog: fit.scaleXLog + span * 0.375,
                scaleYLog: fit.scaleYLog + span * 0.375, offsetX: i * 3840 };
            paint(); env.drain();
            assert.ok(tiled.emptyTileCount_ <= tiled.cacheLimits_.emptyTiles);
            assert.ok(images.every(key => tiled.tiles_.has(key)), "Dropping empty results must not evict images to satisfy a count limit");
        }
        assert.equal(tiled.emptyTileCount_, tiled.cacheLimits_.emptyTiles);
    } finally { env.restore(); loader.reset(); }
});

test("Large viewports preserve the latest direct plot and release it on resize", () => {
    const { loader, view } = load(wideGridCSV), env = tileEnvironment();
    const { renderer, tiledRenderer: tiled, canvas } = env;
    // 4Kから少し広いwindowも、従来の32MiB判定で直接描画へ固定されない。
    canvas.width = 4096; canvas.height = 2160; canvas.clientWidth = 2048; canvas.clientHeight = 1080;
    let context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 2048, height: 1080 });
    tiled.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    tiled.tileBuilder_.draw = () => new Uint32Array(0);
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        assert.ok(tiled.tileRequest_, "A viewport above 32 MiB must still use tiles");
        Object.setPrototypeOf(renderer.rectRenderer, RectRendererWebGL.prototype);
        context = { ...context, scaleXLog: Math.log(8), scaleYLog: Math.log(8) }; paint();
        assert.equal(tiled.tileRequest_, null);
        const previous = tiled.previousPlot_.canvas;
        assert.equal(previous.width, 4096);
        assert.equal(previous.height, 2160);
        assert.equal(tiled.previousPlot_.context, context);
        canvas.width = canvas.clientWidth = 690; canvas.height = canvas.clientHeight = 340;
        context = { ...context, width: 690, height: 340 }; paint();
        assert.equal(previous.width, 1, "The old large snapshot must be released when the viewport shrinks");
        assert.equal(tiled.previousPlot_.canvas.width, 690);
        tiled.clear();
        assert.equal(tiled.previousPlot_, null);
    } finally { env.restore(); loader.reset(); }
});

test("Sparse enlarged views draw directly while retaining the Fit cache for zoom-out", () => {
    const { loader, view } = load(wideGridCSV), env = tileEnvironment(), { renderer, tiledRenderer: tiled, canvas } = env;
    let context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
    const grid = new GridMap(), paint = () => tiled.draw(canvas, grid, view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        const fit = context, overview = tiled.tilePositions(tiled.tileRequest_).filter(job => job.visible).map(job => job.key);
        const tiles = tiled.tiles_.size, bytes = tiled.tileBytes_;
        assert.ok(tiles > 0);
        Object.setPrototypeOf(renderer.rectRenderer, RectRendererWebGL.prototype);
        context = { ...fit, scaleXLog: Math.log(8), scaleYLog: Math.log(8) };
        paint(); env.drain();
        assert.equal(tiled.tileRequest_, null);
        assert.equal(tiled.tileLayer_, null);
        assert.equal(tiled.tileJobs_.length, 0);
        assert.equal(env.frames.size + env.timers.size, 0);
        assert.equal(tiled.tiles_.size, tiles);
        assert.equal(tiled.tileBytes_, bytes);
        assert.equal(tiled.previousPlot_.context, context);
        assert.ok(grid.drawnIndex.some(row => row >= 0), "Direct rendering must keep native hover targets");
        context = { ...context, offsetX: 0.37, offsetY: 0.53 }; paint();
        assert.equal(tiled.tiles_.size, tiles);
        assert.equal(tiled.previousPlot_.context, context, "Zoom-out must inherit the latest direct pan");
        context = fit; paint();
        assert.ok(overview.every(key => tiled.tiles_.has(key)));
        assert.ok(tiled.tileJobs_.every(job => !job.visible));
    } finally { env.restore(); loader.reset(); }
});

test("Large overlapping row counts retain tiled rendering even at a high zoom", () => {
    const { loader, view } = load("cycle,unit\n" + "0,0\n".repeat(3000)), env = tileEnvironment();
    const { renderer, tiledRenderer: tiled, canvas } = env;
    Object.setPrototypeOf(renderer.rectRenderer, RectRendererWebGL.prototype);
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: Math.log(8), scaleYLog: Math.log(8) };
    try {
        tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
        assert.ok(tiled.tileRequest_, "A large zoom does not prove that a dense overlapping dataset is cheap");
        assert.ok(tiled.tileJobs_.some(job => job.visible));
    } finally { env.restore(); loader.reset(); }
});

test("Sparse enlarged views use direct rendering even with a complete tile cache", () => {
    const env = solidTileEnvironment(), { renderer, tiledRenderer: tiled, context, view, layer, add, create } = env;
    const enlarged = layer(Math.exp(Math.log(8))), canvas = create([0, 0, 255]);
    const zoom = { ...context, scaleXLog: Math.log(8), scaleYLog: Math.log(8) };
    const cached = add(enlarged, [255, 0, 0]);
    view.getVisibleRows = () => ({ order: null, start: 0, end: 1 });
    let directDraws = 0;
    renderer.draw = (target, _grid, _view, _context, _notify, options) => {
        assert.equal(target, canvas);
        assert.equal(options.aggregateSmallViews, true);
        directDraws++; target.rgb = [255, 0, 0]; return Uint32Array.of(0);
    };
    try {
        tiled.draw(canvas, new GridMap(), view, zoom, () => {}, { tiled: true });
        assert.equal(directDraws, 1);
        assert.equal(tiled.tileLayer_, null);
        assert.equal(tiled.tileRequest_, null);
        assert.equal(tiled.tileJobs_.length, 0, "Cheap views must not generate new tiles");
        env.advance(120);
        tiled.draw(canvas, new GridMap(), view, zoom, () => {}, { tiled: true });
        assert.equal(directDraws, 2);
        assert.deepEqual(canvas.rgb, [255, 0, 0]);
        assert.equal(tiled.tiles_.get(`${enlarged.key}|0,0`), cached);
        assert.equal(env.frames.size + env.timers.size, 0);
    } finally { env.restore(); }
});

test("A large visible tile payload can evict older zooms without exceeding the shared budget", () => {
    const { loader, view } = load(wideGridCSV), env = tileEnvironment(), { renderer, tiledRenderer: tiled, canvas } = env;
    renderer.MARGIN_LEFT_ = renderer.MARGIN_BOTTOM_ = 0;
    canvas.width = canvas.height = canvas.clientWidth = canvas.clientHeight = 256;
    let context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 256, height: 256 });
    tiled.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    tiled.tileBuilder_.draw = () => Uint32Array.of(0);
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        const overview = Array.from(tiled.tiles_.keys());
        tiled.tileBuilder_.draw = () => {
            const rows = Uint32Array.of(0);
            Object.defineProperty(rows, "byteLength", { value: 64 * 1024 * 1024 - 256 * 256 * 4 });
            return rows;
        };
        context = { ...context, scaleXLog: context.scaleXLog + Math.log(4), scaleYLog: context.scaleYLog + Math.log(4) };
        paint(); env.drain();
        assert.equal(tiled.tileBypass_, null);
        assert.ok(overview.every(key => !tiled.tiles_.has(key)), "The current view takes priority over older zooms");
        assert.equal(tiled.tileBytes_, 64 * 1024 * 1024);
        assert.ok(tiled.tilePositions(tiled.tileRequest_).filter(job => job.visible).every(job => tiled.tiles_.has(job.key)));
    } finally { env.restore(); loader.reset(); }
});

test("Zoom reuses the latest complete pan with smoothing and keeps final tiles sharp", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { tiledRenderer, canvas } = env;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: Math.log(10), scaleYLog: Math.log(10) };
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    const copies = [], ctx = canvas.getContext("2d");
    ctx.drawImage = image => copies.push({ image, smooth: ctx.imageSmoothingEnabled });
    try {
        paint(); env.drain();
        context = { ...context, offsetX: 8, offsetY: 4 };
        paint(); env.drain(); paint();
        const pan = context;
        context = { ...context, scaleXLog: Math.log(5), scaleYLog: Math.log(5) };
        copies.length = 0; paint();
        assert.equal(tiledRenderer.previousPlot_.context.offsetX, pan.offsetX);
        assert.equal(tiledRenderer.previousPlot_.context.offsetY, pan.offsetY);
        assert.equal(tiledRenderer.previousPlot_.context.scaleXLog, pan.scaleXLog);
        assert.ok(copies.some(copy => copy.image === tiledRenderer.previousPlot_.canvas && copy.smooth),
            "Thin source pixels must survive provisional downscaling");
        assert.equal(copies.at(-1).image, tiledRenderer.previousPlot_.canvas,
            "Resampled tile edges must not overwrite the complete viewport image");
        env.drain(); paint(); env.drain(); copies.length = 0; paint();
        assert.ok(copies.length);
        assert.ok(copies.every(copy => !copy.smooth), "Completed tiles must use sharp integer blits");
    } finally { env.restore(); loader.reset(); }
});

test("A direct image after a large zoom jump stays above tiles from the old scale", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { tiledRenderer, canvas } = env;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: Math.log(10), scaleYLog: Math.log(10) };
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    const copies = [], ctx = canvas.getContext("2d");
    ctx.drawImage = image => copies.push(image);
    try {
        paint(); env.drain(); paint();
        context = { ...context, scaleXLog: Math.log(0.5), scaleYLog: Math.log(0.5) };
        paint();
        assert.equal(tiledRenderer.previousPlot_.context.scaleXLog, context.scaleXLog, "The large jump must first draw a complete direct image");
        copies.length = 0; paint();
        assert.equal(copies.at(-1), tiledRenderer.previousPlot_.canvas, "Old zoom tiles must not overwrite the newly completed image");
    } finally { env.restore(); loader.reset(); }
});

test("Zoom tiles fade over the complete image and cancel the transition when disabled", () => {
    const { loader, view } = load("cycle,unit\n" + "0,0\n".repeat(3000)), env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
    const previousPerformance = global.performance;
    let now = 1000, context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: Math.log(10), scaleYLog: Math.log(10) };
    global.performance = { now: () => now };
    Object.setPrototypeOf(renderer.rectRenderer, RectRendererWebGL.prototype);
    const grid = new GridMap(), copies = [], ctx = canvas.getContext("2d");
    ctx.drawImage = image => copies.push({ image, alpha: ctx.globalAlpha });
    const paint = () => tiledRenderer.draw(canvas, grid, view, context, () => {}, { tiled: true });
    try {
        paint(); env.drain(); paint();
        context = { ...context, scaleXLog: Math.log(11), scaleYLog: Math.log(11) };
        paint(); env.drain(); paint(); env.drain(); copies.length = 0; paint();
        const completed = tiledRenderer.tileFallback_;
        const images = new Set(Array.from(tiledRenderer.tiles_.values()).filter(tile => tile.layer === tiledRenderer.tileLayer_).map(tile => tile.canvas));
        assert.ok(copies.some(copy => images.has(copy.image) && copy.alpha === 0));
        assert.notEqual(completed, tiledRenderer.tileLayer_);
        assert.equal(grid.drawnIndex, null);
        now += 60; copies.length = 0; paint();
        assert.ok(copies.some(copy => images.has(copy.image) && copy.alpha === 0.5));
        // 切替途中の再zoomでも未表示の完成画像へ飛ばず、最後の完成倍率を保つ。
        const zoom = context;
        context = { ...context, scaleXLog: Math.log(12) }; paint();
        assert.equal(tiledRenderer.tileFallback_, completed);
        context = zoom; paint();
        now += 120; copies.length = 0; paint();
        assert.ok(copies.some(copy => images.has(copy.image) && copy.alpha === 1));
        assert.equal(tiledRenderer.tileFallback_, tiledRenderer.tileLayer_);
        assert.ok(grid.drawnIndex);
        context = { ...context, scaleXLog: Math.log(13) }; paint(); env.drain(); paint(); env.drain(); paint();
        assert.equal(tiledRenderer.tileFading_, true);
        tiledRenderer.draw(canvas, grid, view, context, () => {}, { tiled: false });
        assert.equal(env.frames.size, 0);
        assert.equal(tiledRenderer.tileFading_, false);
    } finally { global.performance = previousPerformance; env.restore(); loader.reset(); }
});

// 一様な色のCanvasで画像の継承と合成を確認する。データのrasterは他のtestで検証する。
function solidTileEnvironment() {
    const env = tileEnvironment(), previousPerformance = global.performance;
    let now = 1000;
    global.performance = { now: () => now };
    Object.setPrototypeOf(env.renderer.rectRenderer, RectRendererWebGL.prototype);
    env.renderer.MARGIN_LEFT_ = env.renderer.MARGIN_BOTTOM_ = 0;
    env.renderer.drawAxes = () => {};
    const create = rgb => {
        const canvas = { width: 256, height: 256, clientWidth: 256, clientHeight: 256, rgb: [...rgb] };
        const stack = [], ctx = { canvas, globalAlpha: 1,
            save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop(); },
            resetTransform() {}, setTransform() {}, beginPath() {}, rect() {}, clip() {},
            fillRect() { const s = this.fillStyle.slice(1); this.blend([0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16))); },
            drawImage(image) { this.blend(image.rgb); },
            blend(rgb) { canvas.rgb = rgb.map((value, i) => value * this.globalAlpha + canvas.rgb[i] * (1 - this.globalAlpha)); }
        };
        canvas.getContext = () => ctx;
        return canvas;
    };
    global.document = { createElement: () => create([0, 0, 0]) };
    const context = { ...INITIAL_RENDERER_CONTEXT, width: 256, height: 256, scaleXLog: 0, scaleYLog: 0 };
    const layer = (x, y = x) => ({ key: env.tiledRenderer.zoomKey(Math.log(x), Math.log(y)), sx: x, sy: y, phaseX: 0, phaseY: 0 });
    const add = (layer, rgb, x = 0) => {
        const tile = { layer, x, y: 0, canvas: create(rgb), rows: Uint32Array.of(0), bytes: 256 * 256 * 4 + 4 };
        env.tiledRenderer.tiles_.set(`${layer.key}|${x},0`, tile); env.tiledRenderer.tileBytes_ += tile.bytes;
        return tile;
    };
    const view = { getX: () => 0, getY: () => 0,
        getVisibleRows: () => ({ order: null, start: 0, end: 100000 }) };
    env.tiledRenderer.tileView_ = view; env.tiledRenderer.tileContentKey_ = "1,1,1,1";
    const blue = layer(1);
    env.tiledRenderer.tileFallback_ = blue;
    env.tiledRenderer.previousPlot_ = { canvas: create([0, 0, 255]), context, complete: true };
    add(blue, [0, 0, 255]);
    return { ...env, context, view, create, layer, add, advance(ms) { now += ms; },
        restore() { env.restore(); global.performance = previousPerformance; } };
}

test("A zoom during a fade continues from the displayed composite", () => {
    const env = solidTileEnvironment(), { tiledRenderer: tiled, context: fit, view, create, layer, add } = env;
    const canvas = create([0, 0, 255]), grid = new GridMap(), red = layer(1.1);
    let context = { ...fit, scaleXLog: Math.log(1.1), scaleYLog: Math.log(1.1) };
    const paint = () => tiled.draw(canvas, grid, view, context, () => {}, { tiled: true });
    tiled.tileLayer_ = red; tiled.tileZoomKey_ = red.key; add(red, [255, 0, 0]);
    try {
        paint(); env.advance(60); paint();
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5]);
        canvas.width = canvas.clientWidth = 512; context = { ...context, width: 512 }; paint();
        assert.ok(tiled.tileJobs_.some(job => job.visible));
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5], "Newly visible missing tiles must not withdraw an image that is already fading");
        context = { ...context, scaleXLog: Math.log(1.12), scaleYLog: Math.log(1.12) }; paint();
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5], "Changing the zoom must not restore the older blue image");
        context = { ...context, scaleXLog: Math.log(1.3), scaleYLog: Math.log(1.3) }; paint();
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5]);
        assert.deepEqual(tiled.previousPlot_.canvas.rgb, [127.5, 0, 127.5]);
        assert.equal(grid.drawnIndex, null);
    } finally { env.restore(); }
});

test("Zoom snapshots preserve the plot without the axis overlay", () => {
    const env = solidTileEnvironment(), { renderer, tiledRenderer: tiled, context: fit, view, create, layer, add } = env;
    const canvas = create([0, 0, 255]), red = layer(1.1);
    let context = { ...fit, scaleXLog: Math.log(1.1), scaleYLog: Math.log(1.1) };
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    tiled.tileLayer_ = red; tiled.tileZoomKey_ = red.key; add(red, [255, 0, 0]);
    renderer.drawAxes = ctx => { ctx.fillStyle = "#444444"; ctx.fillRect(0, 0, 256, 256); };
    try {
        paint(); env.advance(60); paint();
        assert.deepEqual(canvas.rgb, [68, 68, 68], "The main canvas includes the axis overlay");
        context = { ...context, scaleXLog: Math.log(1.3), scaleYLog: Math.log(1.3) }; paint();
        assert.deepEqual(tiled.previousPlot_.canvas.rgb, [127.5, 0, 127.5],
            "Grid lines must not enter the snapshot and grow over the data on the next zoom");
    } finally { env.restore(); }
});

test("Snapshot sources survive eviction until their plot has been captured", () => {
    const env = solidTileEnvironment(), { tiledRenderer: tiled, context: fit, view, create, layer, add } = env;
    const canvas = create([0, 0, 255]), red = layer(1.1);
    let context = { ...fit, scaleXLog: Math.log(1.1), scaleYLog: Math.log(1.1) };
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    const blue = tiled.tiles_.values().next().value;
    tiled.tileLayer_ = red; tiled.tileZoomKey_ = red.key; add(red, [255, 0, 0]);
    tiled.tileBuilder_ = { isPreparingRows: false, draw: () => Uint32Array.of(0), releasePreparedRows() {}, cancelPendingRows() {} };
    try {
        paint(); env.advance(60); paint();
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5]);
        assert.ok(tiled.displayedPlot_.sources.has(blue.canvas));
        const job = tiled.tilePositions(tiled.tileRequest_).find(job => !job.visible);
        tiled.tileJobs_ = [job]; tiled.tileBytes_ = 64 * 1024 * 1024;
        tiled.renderTileBatch();
        assert.equal(blue.canvas.width, 1, "The source tile should actually be evicted");
        assert.deepEqual(tiled.previousPlot_.canvas.rgb, [127.5, 0, 127.5],
            "Capture must complete before a source image is released");
        context = { ...context, scaleXLog: Math.log(1.3), scaleYLog: Math.log(1.3) }; paint();
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5]);
    } finally { env.restore(); }
});

test("Partially cached layers wait for full coverage and fade from their first display", () => {
    const env = solidTileEnvironment(), { tiledRenderer: tiled, context: fit, view, create, layer, add } = env;
    const canvas = create([0, 0, 255]); canvas.width = canvas.clientWidth = 512;
    const context = { ...fit, width: 512, scaleXLog: Math.log(1.1), scaleYLog: Math.log(1.1) }, red = layer(1.1);
    tiled.tileLayer_ = red; tiled.tileZoomKey_ = red.key;
    tiled.previousPlot_.canvas.width = 512; tiled.previousPlot_.context = { ...fit, width: 512 };
    add(tiled.tileFallback_, [0, 0, 255], 1); add(red, [255, 0, 0]);
    const copies = [], ctx = canvas.getContext("2d"), draw = ctx.drawImage;
    ctx.drawImage = function(image, ...args) { copies.push({ image, alpha: this.globalAlpha }); draw.call(this, image, ...args); };
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    try {
        env.advance(10000); paint();
        assert.deepEqual(canvas.rgb, [0, 0, 255], "An old isolated red tile must not pop into view");
        const tile = add(red, [255, 0, 0], 1);
        copies.length = 0; paint();
        assert.ok(copies.some(copy => copy.image === tile.canvas && copy.alpha === 0));
        env.advance(60); copies.length = 0; paint();
        assert.ok(copies.filter(copy => copy.image.rgb[0] === 255).every(copy => copy.alpha === 0.5));
        env.advance(60); paint();
        assert.equal(tiled.tileFading_, false);
        assert.equal(tiled.tileFallback_, red);
        assert.deepEqual(canvas.rgb, [255, 0, 0]);
    } finally { env.restore(); }
});

test("Direct fallback and its replacement preserve an interrupted fade", () => {
    const env = solidTileEnvironment(), { renderer, tiledRenderer: tiled, context: fit, view, create, add } = env;
    const canvas = create([0, 0, 255]), grid = new GridMap();
    let context = { ...fit, scaleXLog: Math.log(0.01), scaleYLog: Math.log(0.01) }, ready = false;
    renderer.draw = (target, _grid, _view, _context, _notify, options) => {
        assert.notEqual(target, canvas, "The direct fallback must prepare offscreen");
        assert.equal(options.smoothOverview, true);
        if (!ready) return null;
        target.rgb = [255, 0, 0]; return Uint32Array.of(0);
    };
    const paint = () => tiled.draw(canvas, grid, view, context, () => {}, { tiled: true });
    try {
        tiled.tileZoomKey_ = tiled.zoomKey(0, 0);
        paint(); assert.deepEqual(canvas.rgb, [0, 0, 255]);
        assert.equal(tiled.directPlot_.ready, false);
        tiled.tileSettled_ = true; paint();
        assert.equal(tiled.tileLayer_.sx, Math.exp(context.scaleXLog));
        ready = true; paint(); assert.deepEqual(canvas.rgb, [0, 0, 255]);
        env.advance(60); paint(); assert.deepEqual(canvas.rgb, [127.5, 0, 127.5]);
        for (const job of tiled.tilePositions(tiled.tileRequest_).filter(job => job.visible)) add(tiled.tileLayer_, [0, 255, 0], job.x);
        paint(); assert.deepEqual(canvas.rgb, [127.5, 0, 127.5], "Ready tiles must continue the direct fade instead of rolling it back");
        context = { ...context, scaleXLog: Math.log(0.012), scaleYLog: Math.log(0.012) }; paint();
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5]);
        const saved = tiled.previousPlot_.canvas, scratch = tiled.directCanvas_;
        tiled.clear(); assert.equal(saved.width, 1); assert.equal(scratch.width, 1);
    } finally { env.restore(); }
});

test("Large zoom jump previews bound raster work and scale back to the viewport", () => {
    const env = solidTileEnvironment(), { renderer, tiledRenderer: tiled, context: fit, view, create } = env;
    renderer.MARGIN_LEFT_ = 50; renderer.MARGIN_BOTTOM_ = 20;
    const canvas = create([0, 0, 255]);
    canvas.clientWidth = 1024; canvas.clientHeight = 512; canvas.width = 1280; canvas.height = 640;
    tiled.tileContentKey_ = "1.25,1.25,1,1";
    const context = { ...fit, width: 1024, height: 512, scaleXLog: Math.log(0.01), scaleYLog: Math.log(0.01) };
    const copies = [], ctx = canvas.getContext("2d"), draw = ctx.drawImage;
    ctx.drawImage = function(image, ...args) { copies.push({ image, args, smooth: this.imageSmoothingEnabled }); draw.call(this, image, ...args); };
    renderer.draw = (target, _grid, _view, c, _notify, options) => {
        assert.ok(target.width * target.height <= 256 * 256, "Preview raster work must stay within one tile of pixels");
        assert.equal(c.width, 1024); assert.equal(c.height, 512);
        assert.equal(options.smoothOverview, true);
        target.rgb = [255, 0, 0]; return Uint32Array.of(0);
    };
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    try {
        tiled.tileZoomKey_ = tiled.zoomKey(0, 0); paint();
        const preview = tiled.directPlot_.canvas;
        assert.ok(preview.width < canvas.width && preview.height < canvas.height);
        assert.deepEqual(canvas.rgb, [0, 0, 255]);
        env.advance(60); copies.length = 0; paint();
        const copy = copies.find(copy => copy.image === preview);
        const sourceLeft = 50 * (preview.width / context.width);
        assert.deepEqual(copy.args, [sourceLeft, 0, preview.width - sourceLeft, 492 * (preview.height / context.height),
            62.5, 0, 1217.5, 615], "Preview cropping must use its own resolution and retain the display margins at fractional DPR");
        assert.equal(copy.smooth, true, "The smaller preview must be interpolated even at the same zoom");
        assert.deepEqual(canvas.rgb, [127.5, 0, 127.5]);
        env.advance(60); paint();
        assert.deepEqual(canvas.rgb, [255, 0, 0]);
        assert.equal(tiled.displayedPlot_.complete, false, "The preview must still fade into full-resolution tiles");
    } finally { env.restore(); }
});

test("Animated zoom shares tile scales and settles at the exact requested scale", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { tiledRenderer: tiled, canvas } = env;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: Math.log(10), scaleYLog: Math.log(10) };
    const paint = () => tiled.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        const keys = new Set();
        for (let i = 1; i <= 30; i++) {
            context = { ...context, scaleXLog: Math.log(10) + 0.14 + i * 0.003, scaleYLog: Math.log(10) + 0.14 + i * 0.003 };
            paint(); keys.add(tiled.tileLayer_.key);
        }
        assert.equal(keys.size, 1, "Small animation steps must not create separate generations");
        assert.ok(env.frames.size, "Stable scales must build during animation without waiting for the idle timer");
        env.drain();
        assert.equal(tiled.tileLayer_.sx, Math.exp(context.scaleXLog));
        assert.equal(tiled.tileLayer_.sy, Math.exp(context.scaleYLog));
        const cached = tiled.tileLayer_, fills = env.fills;
        context = { ...context, scaleXLog: context.scaleXLog + 1e-15, scaleYLog: context.scaleYLog - 1e-15 };
        paint(); env.drain();
        assert.equal(tiled.tileLayer_, cached);
        assert.equal(env.fills, fills, "Floating-point noise must reuse the existing layer");
        assert.equal(tiled.layerCovers({ ...tiled.tileRequest_, context: { ...context, scaleXLog: -50, scaleYLog: -50 } }, cached), false);
    } finally { env.restore(); loader.reset(); }
});

test("Uniform zoom keeps both axes in the same generation at half-step boundaries", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment(), { renderer, tiledRenderer: tiled, canvas } = env;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: 0, scaleYLog: -4.51853764292955 };
    const start = context, paint = () => tiled.draw(canvas, new GridMap(), view, context, () => {}, { tiled: true });
    try {
        paint(); env.drain();
        for (let i = 0; i < 5; i++) { context = renderer.zoomUniform(context, 200, 120, true, 10); paint(); }
        const dx = Math.log(tiled.tileLayer_.sx) - start.scaleXLog, dy = Math.log(tiled.tileLayer_.sy) - start.scaleYLog;
        assert.ok(Math.abs(dx - dy) < 1e-12, "Rounding noise at half a step must not split a uniform zoom into two layers");
    } finally { env.restore(); loader.reset(); }
});

test("Disabling tiles cancels queued work, releases images and restores direct drawing", () => {
    const { loader, view } = load(gridCSV), env = tileEnvironment();
    const { renderer, tiledRenderer, canvas } = env, context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 };
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), view, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        paint(); env.drain();
        const retained = Array.from(tiledRenderer.tiles_.values()).flatMap(tile => tile.canvas ? [tile.canvas] : []);
        assert.ok(retained.length);
        paint();
        tiledRenderer.draw(canvas, new GridMap(), view, context, () => { throw new Error("Disabled tiles must not schedule updates"); }, { tiled: false });
        assert.equal(tiledRenderer.tileBytes_, 0);
        assert.equal(tiledRenderer.tiles_.size, 0);
        assert.equal(env.frames.size, 0); assert.equal(env.timers.size, 0);
        assert.ok(retained.every(image => image.width === 1));
        assert.ok(renderer.rowCache_);
        paint();
        assert.ok(env.frames.size, "Enabling tiles must start a fresh generation");
        tiledRenderer.draw(canvas, new GridMap(), view, context, undefined, { tiled: false });
        assert.equal(env.frames.size, 0);
    } finally { env.restore(); loader.reset(); }
});

test("Disabling tiles cancels asynchronous preparation without publishing stale images", async () => {
    const csv = "category,time\n" + Array.from({ length: 120003 }, (_, i) => `${i % 3},${i % 60001}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "category", axisYField: "time" }, columns: {} });
    await loader.axisIndexes.waitForIdle();
    const env = tileEnvironment(), { renderer, tiledRenderer, canvas } = env;
    const context = renderer.fitScaleToData(view, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
    tiledRenderer.tileBuilder_ = new CanvasRenderer(renderer.rectRenderer);
    tiledRenderer.tileBuilder_.exactOverview = () => null;
    let updates = 0;
    try {
        tiledRenderer.draw(canvas, new GridMap(), view, context, () => updates++, { tiled: true });
        const [id, frame] = env.frames.entries().next().value;
        env.frames.delete(id); frame();
        assert.ok(tiledRenderer.tileBuilder_.pendingRows_, "Large tile preparation must yield");
        const image = tiledRenderer.tilePending_.canvas;
        tiledRenderer.draw(canvas, new GridMap(), view, context, undefined, { tiled: false });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(updates, 0);
        assert.equal(tiledRenderer.tileBuilder_.pendingRows_, null);
        assert.equal(tiledRenderer.tiles_.size, 0);
        assert.equal(image.width, 1);
        assert.equal(env.frames.size, 0);
    } finally { env.restore(); loader.reset(); }
});

test("Tile LRU bounds memory and invalidates data, point size and display scale changes", () => {
    const csv = "x,y\n" + Array.from({ length: 1024 }, (_, i) => `${i % 32 * 256 + 30},${Math.floor(i / 32) * 256 + 30}`).join("\n");
    const { loader, view } = load(csv, { view: { axisXField: "x", axisYField: "y" }, columns: {} }), env = tileEnvironment();
    const { renderer, tiledRenderer, canvas } = env;
    let context = { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340, scaleXLog: 0, scaleYLog: 0 }, currentView = view;
    const paint = () => tiledRenderer.draw(canvas, new GridMap(), currentView, context, () => window.requestAnimationFrame(paint), { tiled: true });
    try {
        for (let i = 0; i < 40; i++) {
            context = { ...context, offsetX: i % 8 * 1024, offsetY: Math.floor(i / 8) * 1024 };
            paint(); env.drain();
            assert.ok(tiledRenderer.tileBytes_ <= 64 * 1024 * 1024);
            const empty = Array.from(tiledRenderer.tiles_.values()).filter(tile => tile.canvas === null).length;
            assert.equal(tiledRenderer.emptyTileCount_, empty);
            assert.ok(empty <= tiledRenderer.cacheLimits_.emptyTiles);
            assert.ok(tiledRenderer.tiles_.size - empty <= 256, "The image budget still bounds nonempty tiles");
        }
        assert.ok(env.canvases.some(image => image.width === 1), "Evicted canvas backing stores must be released");
        for (const change of [
            () => { context = { ...context, minPlotWidth: 3 }; },
            () => { canvas.width *= 2; canvas.height *= 2; },
            () => { currentView = loader.GetDataView({ view: { axisXField: "y", axisYField: "x" }, columns: {} }); }
        ]) {
            const old = Array.from(tiledRenderer.tiles_.values());
            change(); paint();
            assert.equal(tiledRenderer.tiles_.size, 0, "A changed rendering definition must discard completed tiles");
            assert.ok(old.every(tile => !tile.canvas || tile.canvas.width === 1));
            env.drain();
        }
    } finally { env.restore(); loader.reset(); }
});

test("Axis edits fit the new ranges once while color edits retain the viewport", () => {
    const previous = global.localStorage;
    global.localStorage = { getItem() { return null; }, setItem() {} };
    const store = new Store(), { renderer } = makeRenderer();
    let fits = 0;
    const fit = () => {
        fits++;
        const view = store.loader.GetDataView(store.state.viewDef);
        store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, renderer.fitScaleToData(view, store.state.renderCtx));
    };
    store.on(CHANGE.FILE_FORMAT_DETECTED, fit);
    store.on(CHANGE.CANVAS_FIT, fit);
    try {
        store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, { ...INITIAL_RENDERER_CONTEXT, width: 690, height: 340 });
        store.trigger(ACTION.FILE_LOAD_FROM_FILE_LINE_READER, {
            load(onLine, onFinish) { sample.trimEnd().split("\n").forEach(onLine); onFinish(); },
            getProgress() { return 1; }, cancel() {}
        });
        assert.equal(fits, 1, "Initial file detection must fit only once");

        // 両軸の入替、Xだけの変更、Yだけの変更で、それぞれ新しい範囲へ戻す。
        for (const [axisXField, axisYField] of [["cycle", "unit"], ["unit", "unit"], ["unit", "cycle"]]) {
            const previousFits = fits;
            store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, { ...store.state.renderCtx,
                scaleXLog: 3, scaleYLog: -3, offsetX: 12345, offsetY: -98765 });
            const definition = { ...store.state.viewDef, view: { ...store.state.viewDef.view, axisXField, axisYField } };
            store.trigger(ACTION.VIEW_DEF_APPLY, definition);
            assert.equal(fits, previousFits + 1);
            const view = store.loader.GetDataView(definition);
            assert.deepEqual(store.state.renderCtx, renderer.fitScaleToData(view, store.state.renderCtx));
        }

        const panned = { ...store.state.renderCtx, offsetX: 27.25, offsetY: 91.75 }, previousFits = fits;
        store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, panned);
        for (const definition of [store.state.viewDef,
            { ...store.state.viewDef, view: { ...store.state.viewDef.view, colorField: "unit" } },
            { ...store.state.viewDef, view: { ...store.state.viewDef.view, colorMap: "viridis" } },
            { ...store.state.viewDef, columns: { unused: "cycle * 2" } }]) {
            store.trigger(ACTION.VIEW_DEF_APPLY, definition);
            assert.equal(fits, previousFits);
            assert.equal(store.state.renderCtx, panned);
        }

        store.trigger(ACTION.VIEW_DEF_APPLY, { ...store.state.viewDef,
            view: { ...store.state.viewDef.view, axisXField: "cycle", axisYField: "unit" } });
        store.trigger(ACTION.VIEW_DEF_INFER_REQUEST);
        assert.equal(fits, previousFits + 2, "Resetting inferred axes must also fit");
        assert.deepEqual(store.state.renderCtx,
            renderer.fitScaleToData(store.loader.GetDataView(store.state.viewDef), store.state.renderCtx));
    } finally { store.loader.reset(); global.localStorage = previous; }
});

test("Tiled rendering defaults on and restores only valid persisted booleans", () => {
    const previous = global.localStorage;
    try {
        for (const stored of [null, {}, { tiledRenderingEnabled: false }, { tiledRenderingEnabled: true }, { tiledRenderingEnabled: "false" }]) {
            global.localStorage = { getItem() { return stored === null ? null : JSON.stringify(stored); } };
            const settings = new Settings(); settings.load();
            assert.equal(settings.tiledRenderingEnabled, stored?.tiledRenderingEnabled === false ? false : true);
        }
        let saved = JSON.stringify({ tiledRenderingEnabled: false });
        global.localStorage = { getItem() { return saved; }, setItem(_key, value) { saved = value; } };
        const store = new Store();
        assert.equal(store.state.tiledRenderingEnabled, false);
        let changes = 0, redraws = 0;
        store.on(CHANGE.COMPATIBILITY_CHANGED, () => changes++);
        store.on(CHANGE.CONTENT_UPDATED, () => redraws++);
        store.trigger(ACTION.SET_TILED_RENDERING, true);
        assert.equal(store.state.tiledRenderingEnabled, true);
        assert.equal(JSON.parse(saved).tiledRenderingEnabled, true);
        store.trigger(ACTION.SET_TILED_RENDERING, true);
        store.trigger(ACTION.SET_TILED_RENDERING, "false");
        assert.equal(changes, 1); assert.equal(redraws, 1);
        assert.equal(new Store().state.tiledRenderingEnabled, true);
    } finally { global.localStorage = previous; }
});
