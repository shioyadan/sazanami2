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
    const csv = "x,y,color\n" + Array.from({ length: n }, (_, i) => `${i % 17},${i * 3 % 19},${i % 3}`).join("\n");
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
    const full = Array.from({ length: n }, (_, i) => ({ x: 50 + view.getX(i) * Math.exp(context.scaleXLog) - 0.25, y: view.getY(i) * Math.exp(context.scaleYLog) - 0.75,
        width: 3, height: 2, color: view.getPalette()[view.getColorIndex(i)] }));
    for (const [rx, ry] of [[1, 1], [2, 2], [87 / 70, 1.25]]) {
        canvas.clientWidth = 70; canvas.width = Math.round(70 * rx);
        canvas.clientHeight = 40; canvas.height = Math.round(40 * ry);
        renderer.draw(canvas, new GridMap(), view, context);
        assert.ok(rectangles.length < 1000);
        assert.deepEqual(paint(rectangles, rx, ry), paint(full, rx, ry));
    }
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
