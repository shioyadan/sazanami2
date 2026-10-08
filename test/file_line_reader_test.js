const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
// Workerはbrowserで検証し、ここでは通常のbyte streamの分割・終了・中断を検証する。
require.cache[require.resolve("../src/zstd_worker.ts")] = { exports: { default: null } };
const { FileLineReader } = require("../src/file_line_reader.ts");
const { Loader } = require("../src/loader.ts");

function readerFor(text, chunkSize = 8192) {
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream({ start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize));
        controller.close();
    } });
    return new FileLineReader({ stream, fileSize: bytes.length });
}

test("Chunked line reading preserves UTF-8, empty lines and the final line", async () => {
    for (const text of ["", "\n\n", "雪\r\n😀,text\nfinal", "first\nsecond\n", "x".repeat(100000) + "\nlast"]) {
        const reader = readerFor(text, text.length < 100 ? 1 : 8192), actual = [];
        let finished = 0;
        await reader.load(line => actual.push(line), () => finished++, error => { throw error; });
        const expected = text.split("\n");
        if (expected.at(-1) === "") expected.pop();
        assert.deepEqual(actual, expected);
        assert.equal(finished, 1);
        assert.equal(reader.getProgress(), 1);
        assert.equal(reader.getRowCountEstimate(), expected.length || null);
    }
});

test("Reading a large chunk yields to timers and can be cancelled", async () => {
    const reader = readerFor("row\n".repeat(100000), 400000);
    let lines = 0, finished = 0, ticks = 0;
    const timer = setTimeout(() => { ticks++; reader.cancel(); }, 1);
    try {
        await reader.load(() => {
            if ((++lines & 1023) === 0) {
                const end = performance.now() + 1;
                while (performance.now() < end) {}
            }
        }, () => finished++, error => { throw error; });
        assert.equal(ticks, 1);
        assert.ok(lines > 0 && lines < 100000);
        assert.equal(finished, 0);
    } finally { clearTimeout(timer); }
});

test("Cancellation before initialization or from a callback prevents further rows", async () => {
    for (const cancelBeforeStart of [true, false]) {
        const reader = readerFor("one\ntwo\nthree"), actual = [];
        if (cancelBeforeStart) reader.cancel();
        await reader.load(line => { actual.push(line); reader.cancel(); }, () => { throw new Error("Cancelled input must not finish"); }, error => { throw error; });
        assert.deepEqual(actual, cancelBeforeStart ? [] : ["one"]);
    }
});

test("Stream errors are reported once without completing the input", async () => {
    const failure = new Error("Read failed"), errors = [];
    const reader = new FileLineReader({ stream: new ReadableStream({ start(controller) { controller.error(failure); } }) });
    await reader.load(() => { throw new Error("No rows are available"); }, () => { throw new Error("Failed input must not finish"); }, error => errors.push(error));
    assert.deepEqual(errors, [failure]);
});

test("CSV and TSV loading retain strings and exact integer folding", async () => {
    const numbers = ["2147483647", "2147483648", "4294967295", "9007199254740991", "9007199254740993", "-2147483648", "-2147483649", "-9007199254740991", "-9007199254740993"];
    for (const separator of [",", "\t"]) {
        const rows = numbers.map((number, i) => [number, "0x" + (BigInt(number) < 0 ? -BigInt(number) : BigInt(number)).toString(16), i % 2 ? "雪" : "sun"].join(separator));
        const text = ["number" + separator + "hex" + separator + "label", ...rows].join("\n");
        const loader = new Loader();
        await new Promise((resolve, reject) => loader.load(readerFor(text, 7), resolve, () => {}, () => {}, reject, () => {}));
        assert.equal(loader.numRows, numbers.length);
        for (let i = 0; i < numbers.length; i++) {
            const value = BigInt(numbers[i]);
            const folded = value > 2147483647n ? BigInt.asUintN(31, value) : BigInt.asIntN(32, value);
            assert.equal(loader.columnFromName("number").getNumber(i), Number(folded));
            assert.equal(loader.columnFromName("hex").getNumber(i), Number(BigInt.asUintN(31, value < 0 ? -value : value)));
            assert.equal(loader.columnFromName("label").getString(i), i % 2 ? "雪" : "sun");
        }
    }
});

test("An underestimated input size does not truncate reserved columns", async () => {
    const rows = 3000, reader = readerFor("x,label\n" + Array.from({ length: rows }, (_, i) => `${i},label${i % 3}`).join("\n"));
    reader.getRowCountEstimate = () => 1200;
    const loader = new Loader();
    await new Promise((resolve, reject) => loader.load(reader, resolve, () => {}, () => {}, reject, () => {}));
    assert.equal(loader.numRows, rows);
    for (let i = 0; i < rows; i++) {
        assert.equal(loader.columnFromName("x").getNumber(i), i);
        assert.equal(loader.columnFromName("label").getString(i), `label${i % 3}`);
    }
    assert.deepEqual({ ...loader.columnFromName("x").stat }, { min: 0, max: rows - 1, deviationFromMax: 0 });
});

test("Malformed overflowing values still fail after column type detection", async () => {
    for (const value of ["2147483648", "0xffffffff"]) {
        const loader = new Loader(), reader = readerFor("value\n" + (value + "\n").repeat(100000) + value + "invalid");
        await assert.rejects(new Promise((resolve, reject) => loader.load(reader, resolve, () => {}, () => {}, reject, () => {})), SyntaxError);
    }
});
