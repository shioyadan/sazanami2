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
    private rows = 0;
    private generation = 0;
    private workingBytes = 0;
    private pending: Promise<void> = Promise.resolve();
    private progress_: number | null = null;
    private lastProgressTime = -Infinity;
    onProgress: ((progress: number | null) => void) | null = null;

    constructor(readonly budgetBytes = AXIS_INDEX_BUDGET) {}

    get memoryBytes(): number {
        let bytes = this.workingBytes;
        for (const order of this.entries.values()) bytes += order.byteLength;
        return bytes;
    }

    get(column: ColumnInterface): Uint32Array | undefined { return this.entries.get(column); }
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
        this.rows = 0;
        this.reportProgress(null);
    }

    prepare(columns: ColumnInterface[], rows: number, onReady: () => void): void {
        const selected = [...new Set(columns)].filter(c => c.stat.deviationFromMax !== 0);
        if (rows === this.rows && selected.length === this.columns.length && selected.every(c => this.columns.includes(c))) return;
        const generation = ++this.generation;
        if (rows !== this.rows) this.entries.clear();
        this.rows = rows;
        this.columns = selected;
        for (const column of this.entries.keys()) if (!selected.includes(column)) this.entries.delete(column);

        // 予算内で実際に作る列だけを全体進捗の分母に含める。
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
        this.reportProgress(toBuild.length ? 0 : null);

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
                            if (generation === this.generation) this.reportProgress((completed + progress) / toBuild.length);
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
                    this.reportProgress(++completed / toBuild.length, true);
                    if (result) onReady();
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
