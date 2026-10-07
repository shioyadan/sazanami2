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
