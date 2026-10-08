import type { ColumnInterface } from "./loader";

// 読み込み・索引生成・表示準備で共有し、連続setTimeoutの最低待機時間を避ける。
const channel = typeof window !== "undefined" && typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const pending: Array<() => void> = [];
if (channel) channel.port1.onmessage = () => pending.shift()?.();

export function yieldToUI(): Promise<void> {
    if (!channel) return new Promise(resolve => setTimeout(resolve, 0));
    return new Promise(resolve => {
        pending.push(resolve);
        channel.port2.postMessage(null);
    });
}

export const AXIS_INDEX_BUDGET = 128 * 1024 * 1024;
const RUN_SIZE = 8192;
const RADIX_HISTOGRAM_BYTES = 1024 * Uint32Array.BYTES_PER_ELEMENT;

export type OverviewIndex = {
    columns: readonly ColumnInterface[];
    next: Uint32Array;
    levels: { width: number; height: number; heads: Uint32Array; boundsX: Float64Array | null; boundsY: Float64Array | null }[];
    // cellsは領域番号と先頭行(+1)の組。細分後はnextもこの領域ごとのリンクになる。
    fine: { cells: Uint32Array; width: number; height: number; factorX: number; factorY: number } | null;
    exactX: boolean;
    exactY: boolean;
    meanSpanX: number;
    meanSpanY: number;
    memoryBytes: number;
};

function planOverview(columns: ColumnInterface[], rows: number, budget: number) {
    if (columns.length !== 2 || rows <= 100000 || rows > 0xffffffff) return null;
    const [x, y] = columns, spanX = x.stat.max - x.stat.min, spanY = y.stat.max - y.stat.min;
    if (![x.stat.min, y.stat.min, spanX, spanY].every(Number.isFinite) || spanX < 0 || spanY < 0) return null;
    const integerX = spanX === 0 || x.buffer instanceof Int32Array, integerY = spanY === 0 || y.buffer instanceof Int32Array;
    const powerOfTwo = (value: number) => 2 ** Math.ceil(Math.log2(Math.max(1, value)));
    let width = integerX ? Math.min(2048, powerOfTwo(spanX + 1)) : 2048;
    let height = integerY ? Math.min(2048, powerOfTwo(spanY + 1)) : 2048;
    if (width < 2048) height = integerY ? Math.min(65536, powerOfTwo(spanY + 1)) : 65536;
    else if (height < 2048) width = integerX ? Math.min(65536, powerOfTwo(spanX + 1)) : 65536;
    // warp/SM番号のような少数の整数座標は混ぜず、もう片方の軸だけを階層化する。
    const fixedX = integerX && spanX < 64 && spanY >= 64, fixedY = integerY && spanY < 64 && spanX >= 64;
    for (;;) {
        const shapes: { width: number; height: number }[] = [];
        let cells = 0, w = width, h = height;
        for (;;) {
            shapes.push({ width: w, height: h }); cells += w * h;
            if ((w === 1 || fixedX) && (h === 1 || fixedY)) break;
            w = fixedX ? w : Math.max(1, w / 2); h = fixedY ? h : Math.max(1, h / 2);
        }
        const exactX = integerX && width >= spanX + 1, exactY = integerY && height >= spanY + 1;
        const boundBytes = shapes.reduce((sum, shape) => sum + (exactX ? 0 : shape.width * 16) + (exactY ? 0 : shape.height * 16), 0);
        const memoryBytes = (rows + cells) * Uint32Array.BYTES_PER_ELEMENT + boundBytes;
        if (width * height <= 4 * 1024 * 1024 && memoryBytes <= budget) {
            return { shapes, memoryBytes, exactX, exactY, budget };
        }
        if (width === 1 && height === 1) return null;
        if (width >= height) width /= 2; else height /= 2;
    }
}

// 最細層は全行へのリンクを残す。上位層は最後の行だけを持ち、画素境界では下位層へ降りる。
async function buildOverview(columns: ColumnInterface[], rows: number, plan: NonNullable<ReturnType<typeof planOverview>>, reusable: Uint32Array | null,
    cancelled: () => boolean, onProgress: (progress: number) => void): Promise<OverviewIndex | null> {
    const next = reusable ?? new Uint32Array(rows);
    const makeBounds = (size: number) => {
        const bounds = new Float64Array(size * 2);
        for (let i = 0; i < size; i++) { bounds[i * 2] = Infinity; bounds[i * 2 + 1] = -Infinity; }
        return bounds;
    };
    const levels = plan.shapes.map(shape => ({ ...shape, heads: new Uint32Array(shape.width * shape.height),
        boundsX: plan.exactX ? null : makeBounds(shape.width), boundsY: plan.exactY ? null : makeBounds(shape.height) }));
    const [x, y] = columns, base = levels[0], spanX = x.stat.max - x.stat.min, spanY = y.stat.max - y.stat.min;
    let deadline = performance.now() + 6;
    for (let row = 0; row < rows; row++) {
        const xv = x.getNumber(row), yv = y.getNumber(row);
        if (Number.isFinite(xv) && Number.isFinite(yv)) {
            const bx = plan.exactX ? xv - x.stat.min : spanX ? Math.min(base.width - 1, Math.floor((xv - x.stat.min) / spanX * base.width)) : 0;
            const by = plan.exactY ? yv - y.stat.min : spanY ? Math.min(base.height - 1, Math.floor((yv - y.stat.min) / spanY * base.height)) : 0;
            const cell = by * base.width + bx;
            next[row] = base.heads[cell]; base.heads[cell] = row + 1;
            if (base.boundsX) {
                base.boundsX[bx * 2] = Math.min(base.boundsX[bx * 2], xv);
                base.boundsX[bx * 2 + 1] = Math.max(base.boundsX[bx * 2 + 1], xv);
            }
            if (base.boundsY) {
                base.boundsY[by * 2] = Math.min(base.boundsY[by * 2], yv);
                base.boundsY[by * 2 + 1] = Math.max(base.boundsY[by * 2 + 1], yv);
            }
        }
        if ((row & 8191) === 0 && performance.now() >= deadline) {
            onProgress(0.4 * (row + 1) / rows);
            await yieldToUI(); if (cancelled()) return null;
            deadline = performance.now() + 6;
        }
    }
    let fine: OverviewIndex["fine"] = null;
    let extraBytes = 0;
    // 密集した格子だけ細分し、空の座標空間に巨大な配列を割り当てない。
    // 元のリンク配列を作り直すため、行数に比例する作業配列も増やさない。
    if (x.buffer instanceof Int32Array && y.buffer instanceof Int32Array && (!plan.exactX || !plan.exactY)) {
        let occupied = 0;
        for (let cell = 0; cell < base.heads.length; cell++) {
            if (base.heads[cell]) occupied++;
            if ((cell & 8191) === 0 && performance.now() >= deadline) {
                await yieldToUI(); if (cancelled()) return null;
                deadline = performance.now() + 6;
            }
        }
        // 共通予算の残りと4N byteの小さい方に制限する。hash表自体も最大8MiB。
        const available = Math.min(plan.budget - plan.memoryBytes, rows * 4);
        const capacity = 2 ** Math.floor(Math.log2(Math.min(available / 8, 1048576)));
        if (occupied && occupied < capacity * 0.7) {
            // keyと先頭行を組にした開番地法。空の細分格子には領域を確保しない。
            const storage = new Uint32Array(capacity * 2), mask = capacity - 1, hashShift = 32 - Math.log2(capacity);
            let width = plan.exactX ? base.width : Math.max(base.width, 32768);
            let height = plan.exactY ? base.height : Math.max(base.height, 32768);
            let count = 0, fits = false;
            const cellAt = (row: number) => {
                const bx = plan.exactX ? x.buffer![row] - x.stat.min : Math.min(width - 1, Math.floor((x.buffer![row] - x.stat.min) / spanX * width));
                const by = plan.exactY ? y.buffer![row] - y.stat.min : Math.min(height - 1, Math.floor((y.buffer![row] - y.stat.min) / spanY * height));
                return (by * width + bx) >>> 0;
            };
            // 収まらなければ解像度を下げる。見積り中は元の全行リンクを保持する。
            while (width > base.width || height > base.height) {
                storage.fill(0); count = 0; fits = true;
                for (let row = 0; row < rows; row++) {
                    const key = cellAt(row);
                    let slot = Math.imul(key ^ (key >>> 16), 0x9e3779b1) >>> hashShift;
                    while (storage[slot * 2 + 1] && storage[slot * 2] !== key) slot = (slot + 1) & mask;
                    if (!storage[slot * 2 + 1]) { storage[slot * 2] = key; count++; }
                    storage[slot * 2 + 1] = row + 1;
                    if (count >= capacity * 0.7) { fits = false; break; }
                    if ((row & 8191) === 0 && performance.now() >= deadline) {
                        await yieldToUI(); if (cancelled()) return null;
                        deadline = performance.now() + 6;
                    }
                }
                if (fits) break;
                if (!plan.exactX) width = Math.max(base.width, width / 2);
                if (!plan.exactY) height = Math.max(base.height, height / 2);
            }
            if (fits) {
                for (let slot = 0; slot < capacity; slot++) storage[slot * 2 + 1] = 0;
                for (let row = 0; row < rows; row++) {
                    const key = cellAt(row);
                    let slot = Math.imul(key ^ (key >>> 16), 0x9e3779b1) >>> hashShift;
                    while (storage[slot * 2] !== key) slot = (slot + 1) & mask;
                    next[row] = storage[slot * 2 + 1]; storage[slot * 2 + 1] = row + 1;
                    if ((row & 8191) === 0 && performance.now() >= deadline) {
                        onProgress(0.4 + 0.4 * (row + 1) / rows);
                        await yieldToUI(); if (cancelled()) return null;
                        deadline = performance.now() + 6;
                    }
                }
                for (let slot = 0, target = 0; slot < capacity; slot++) {
                    if (storage[slot * 2 + 1]) {
                        storage[target * 2] = storage[slot * 2]; storage[target * 2 + 1] = storage[slot * 2 + 1]; target++;
                    }
                }
                const cells = storage.subarray(0, count * 2), stack = [0, count - 1];
                let visits = 0;
                // keyと行番号を一緒にin-placeで並べ、検索用の別配列やmerge用の複製を作らない。
                while (stack.length) {
                    const end = stack.pop()!, start = stack.pop()!, pivot = cells[((start + end) >>> 1) * 2];
                    let lo = start, hi = end;
                    while (lo <= hi) {
                        while (cells[lo * 2] < pivot) lo++;
                        while (cells[hi * 2] > pivot) hi--;
                        if (lo <= hi) {
                            const key = cells[lo * 2], head = cells[lo * 2 + 1];
                            cells[lo * 2] = cells[hi * 2]; cells[lo * 2 + 1] = cells[hi * 2 + 1];
                            cells[hi * 2] = key; cells[hi * 2 + 1] = head; lo++; hi--;
                        }
                        if ((visits++ & 2047) === 0 && performance.now() >= deadline) {
                            await yieldToUI(); if (cancelled()) return null;
                            deadline = performance.now() + 6;
                        }
                    }
                    if (start < hi) stack.push(start, hi);
                    if (lo < end) stack.push(lo, end);
                }
                fine = { cells, width, height, factorX: width / base.width, factorY: height / base.height };
                extraBytes = storage.byteLength;
            }
        }
    }
    const upperCells = levels.slice(1).reduce((sum, level) => sum + level.heads.length, 0);
    let completed = 0;
    for (let level = 1; level < levels.length; level++) {
        const parent = levels[level], child = levels[level - 1];
        for (const [bounds, previous] of [[parent.boundsX, child.boundsX], [parent.boundsY, child.boundsY]]) {
            if (!bounds || !previous) continue;
            const stride = previous.length > bounds.length ? 2 : 1;
            for (let i = 0; i < bounds.length / 2; i++) {
                const first = i * stride * 2;
                bounds[i * 2] = stride === 2 ? Math.min(previous[first], previous[first + 2]) : previous[first];
                bounds[i * 2 + 1] = stride === 2 ? Math.max(previous[first + 1], previous[first + 3]) : previous[first + 1];
            }
        }
        for (let cell = 0; cell < parent.heads.length; cell++) {
            const cx = (cell % parent.width) * (child.width > parent.width ? 2 : 1);
            const cy = Math.floor(cell / parent.width) * (child.height > parent.height ? 2 : 1);
            const first = cy * child.width + cx;
            let last = child.heads[first];
            if (child.width > parent.width) last = Math.max(last, child.heads[first + 1]);
            if (child.height > parent.height) {
                last = Math.max(last, child.heads[first + child.width]);
                if (child.width > parent.width) last = Math.max(last, child.heads[first + child.width + 1]);
            }
            parent.heads[cell] = last;
            completed++;
            if ((cell & 8191) === 0 && performance.now() >= deadline) {
                onProgress(0.8 + 0.2 * completed / upperCells);
                await yieldToUI(); if (cancelled()) return null;
                deadline = performance.now() + 6;
            }
        }
    }
    const meanSpan = (bounds: Float64Array | null) => {
        if (!bounds) return 0;
        let span = 0, count = 0;
        for (let i = 0; i < bounds.length; i += 2) if (Number.isFinite(bounds[i])) { span += bounds[i + 1] - bounds[i]; count++; }
        return count ? span / count : 0;
    };
    return { columns, next, levels, fine, exactX: plan.exactX, exactY: plan.exactY,
        meanSpanX: meanSpan(base.boundsX), meanSpanY: meanSpan(base.boundsY), memoryBytes: plan.memoryBytes + extraBytes };
}

function canRadixSort(column: ColumnInterface, rows: number): boolean {
    return column.buffer instanceof Int32Array && column.buffer.length >= rows && rows >= RUN_SIZE * 8;
}

// 整数列は比較を繰り返さず、各byteの計数と安定な振り分けで行番号を並べる。
async function buildIntegerIndex(column: ColumnInterface, rows: number, cancelled: () => boolean, reusable: Uint32Array | null, onProgress: (progress: number) => void): Promise<{ order: Uint32Array; scratch: Uint32Array } | null> {
    const values = column.buffer!;
    const histogram = new Uint32Array(1024);
    let order = reusable ?? new Uint32Array(rows), scratch = new Uint32Array(rows);
    let deadline = performance.now() + 6;
    for (let row = 0; row < rows; row++) {
        const value = values[row];
        histogram[value & 255]++;
        histogram[256 + ((value >>> 8) & 255)]++;
        histogram[512 + ((value >>> 16) & 255)]++;
        histogram[768 + ((value >>> 24) ^ 128)]++;
        if ((row & 8191) === 0 && performance.now() >= deadline) {
            onProgress((row + 1) / (rows * 5));
            await yieldToUI();
            if (cancelled()) return null;
            deadline = performance.now() + 6;
        }
    }
    onProgress(0.2);
    await yieldToUI();
    if (cancelled()) return null;
    for (let pass = 0; pass < 4; pass++) {
        const base = pass * 256, shift = pass * 8, sign = pass === 3 ? 128 : 0;
        let start = 0;
        for (let bucket = 0; bucket < 256; bucket++) {
            const count = histogram[base + bucket];
            histogram[base + bucket] = start;
            start += count;
        }
        deadline = performance.now() + 6;
        for (let position = 0; position < rows; position++) {
            const row = pass === 0 ? position : order[position];
            const bucket = ((values[row] >>> shift) & 255) ^ sign;
            scratch[histogram[base + bucket]++] = row;
            if ((position & 8191) === 0 && performance.now() >= deadline) {
                onProgress((pass + 1 + (position + 1) / rows) / 5);
                await yieldToUI();
                if (cancelled()) return null;
                deadline = performance.now() + 6;
            }
        }
        [order, scratch] = [scratch, order];
        onProgress((pass + 2) / 5);
        await yieldToUI();
        if (cancelled()) return null;
    }
    return { order, scratch };
}

function sortableValue(column: ColumnInterface, row: number): number {
    const value = column.getNumber(row);
    return Number.isNaN(value) ? Infinity : value;
}

// 元の列を参照したまま行番号だけを並べる。大きな値配列の複製は作らない。
async function buildIndex(column: ColumnInterface, rows: number, cancelled: () => boolean, reusable: Uint32Array | null, onProgress: (progress: number) => void): Promise<{ order: Uint32Array; scratch: Uint32Array } | null> {
    if (canRadixSort(column, rows)) return buildIntegerIndex(column, rows, cancelled, reusable, onProgress);
    let order = reusable ?? new Uint32Array(rows), scratch = new Uint32Array(rows);
    const passes = 1 + Math.max(0, Math.ceil(Math.log2(rows / RUN_SIZE)));
    let completedPasses = 0;
    const compare = (a: number, b: number) => {
        const av = sortableValue(column, a), bv = sortableValue(column, b);
        return av < bv ? -1 : av > bv ? 1 : a - b;
    };
    for (let start = 0; start < rows; start += RUN_SIZE) {
        if (cancelled()) return null;
        const end = Math.min(rows, start + RUN_SIZE);
        for (let i = start; i < end; i++) order[i] = i;
        order.subarray(start, end).sort(compare);
        onProgress(end / (rows * passes));
        await yieldToUI();
    }
    completedPasses++;
    for (let width = RUN_SIZE; width < rows; width *= 2) {
        let deadline = performance.now() + 6;
        for (let start = 0; start < rows; start += width * 2) {
            const mid = Math.min(rows, start + width), end = Math.min(rows, start + width * 2);
            let left = start, right = mid;
            for (let out = start; out < end; out++) {
                if (left < mid && (right >= end || compare(order[left], order[right]) <= 0)) scratch[out] = order[left++];
                else scratch[out] = order[right++];
                if ((out & 2047) === 0 && performance.now() >= deadline) {
                    onProgress((completedPasses + (out + 1) / rows) / passes);
                    await yieldToUI();
                    if (cancelled()) return null;
                    deadline = performance.now() + 6;
                }
            }
        }
        [order, scratch] = [scratch, order];
        onProgress(++completedPasses / passes);
        await yieldToUI();
        if (cancelled()) return null;
    }
    return { order, scratch };
}

export class AxisIndexCache {
    private entries = new Map<ColumnInterface, Uint32Array>();
    private columns: ColumnInterface[] = [];
    private axes: ColumnInterface[] = [];
    private overview_: OverviewIndex | null = null;
    private rows = 0;
    private generation = 0;
    private workingBytes = 0;
    private pending: Promise<void> = Promise.resolve();
    private progress_: number | null = null;
    private lastProgressTime = -Infinity;
    onProgress: ((progress: number | null) => void) | null = null;

    constructor(readonly budgetBytes = AXIS_INDEX_BUDGET) {}

    get memoryBytes(): number {
        let bytes = this.workingBytes + (this.overview_?.memoryBytes ?? 0);
        for (const order of this.entries.values()) bytes += order.byteLength;
        return bytes;
    }

    get(column: ColumnInterface): Uint32Array | undefined { return this.entries.get(column); }
    getOverview(columns: readonly ColumnInterface[]): OverviewIndex | null {
        const axes = this.overview_?.columns;
        return axes && columns.length === 2 && ((columns[0] === axes[0] && columns[1] === axes[1]) ||
            (columns[0] === axes[1] && columns[1] === axes[0])) ? this.overview_ : null;
    }
    waitForIdle(): Promise<void> { return this.pending; }
    get progress(): number | null { return this.progress_; }

    private reportProgress(progress: number | null, force = false): void {
        if (progress === this.progress_ && !force) return;
        this.progress_ = progress;
        const now = performance.now();
        // 進捗の通知だけでReactを頻繁に更新しない。開始・列の完了・中断は即時に伝える。
        if (force || progress === null || progress === 0 || progress === 1 || now - this.lastProgressTime >= 50) {
            this.lastProgressTime = now;
            this.onProgress?.(progress);
        }
    }

    clear(): void {
        this.generation++;
        this.entries.clear();
        this.columns = [];
        this.axes = [];
        this.overview_ = null;
        this.rows = 0;
        this.reportProgress(null);
    }

    prepare(columns: ColumnInterface[], rows: number, onReady: () => void): void {
        const selected = [...new Set(columns)].filter(c => c.stat.deviationFromMax !== 0);
        const sameAxes = columns.length === this.axes.length && (columns.every((c, i) => c === this.axes[i]) ||
            (columns.length === 2 && columns[0] === this.axes[1] && columns[1] === this.axes[0]));
        if (rows === this.rows && sameAxes && selected.length === this.columns.length && selected.every(c => this.columns.includes(c))) return;
        const generation = ++this.generation;
        if (rows !== this.rows) this.entries.clear();
        if (rows !== this.rows || !sameAxes) this.overview_ = null;
        this.rows = rows;
        this.columns = selected;
        this.axes = columns.slice();
        for (const column of this.entries.keys()) if (!selected.includes(column)) this.entries.delete(column);

        // 予算内で作る列と領域索引を全体進捗の分母に含める。
        const toBuild: ColumnInterface[] = [];
        const indexBytes = rows * Uint32Array.BYTES_PER_ELEMENT;
        let retainedBytes = this.memoryBytes - this.workingBytes;
        if (rows > 0 && rows <= 0xffffffff) {
            for (const column of selected) {
                const histogramBytes = canRadixSort(column, rows) ? RADIX_HISTOGRAM_BYTES : 0;
                if (this.entries.has(column) || retainedBytes + indexBytes * 2 + histogramBytes > this.budgetBytes) continue;
                toBuild.push(column);
                retainedBytes += indexBytes;
            }
        }
        const overviewPlan = this.overview_ ? null : planOverview(columns, rows, this.budgetBytes - retainedBytes);
        const tasks = toBuild.length + (overviewPlan ? 1 : 0);
        this.reportProgress(tasks ? 0 : null);

        // 中断した生成が配列を解放してから、次の生成へ進む。
        this.pending = this.pending.then(async () => {
            await yieldToUI();
            let reusable: Uint32Array | null = null;
            let completed = 0;
            try {
                for (const column of toBuild) {
                    if (generation !== this.generation) return;
                    this.workingBytes = indexBytes * 2 + (canRadixSort(column, rows) ? RADIX_HISTOGRAM_BYTES : 0);
                    let result: Awaited<ReturnType<typeof buildIndex>> = null;
                    try {
                        result = await buildIndex(column, rows, () => generation !== this.generation, reusable, progress => {
                            if (generation === this.generation) this.reportProgress((completed + progress) / tasks);
                        });
                    } catch (error) {
                        console.warn("Axis index generation failed:", error);
                    }
                    if (generation !== this.generation) return;
                    if (result) {
                        this.entries.set(column, result.order);
                        // 次の列でも同じ作業配列を使い、GC待ちの大きな配列を増やさない。
                        reusable = result.scratch;
                        this.workingBytes = reusable.byteLength;
                    } else {
                        reusable = null;
                        this.workingBytes = 0;
                    }
                    this.reportProgress(++completed / tasks, true);
                    if (result) onReady();
                }
                if (overviewPlan && generation === this.generation) {
                    this.workingBytes = overviewPlan.budget;
                    const overview = await buildOverview(columns, rows, overviewPlan, reusable, () => generation !== this.generation, progress => {
                        if (generation === this.generation) this.reportProgress((completed + progress) / tasks);
                    });
                    if (generation !== this.generation) return;
                    this.overview_ = overview;
                    reusable = null;
                    this.workingBytes = 0;
                    this.reportProgress(++completed / tasks, true);
                    if (overview) onReady();
                }
            } finally {
                this.workingBytes = 0;
                if (generation === this.generation) this.reportProgress(null);
            }
        }).catch(error => {
            console.warn("Axis index preparation failed:", error);
            if (generation === this.generation) this.reportProgress(null);
        });
    }
}
