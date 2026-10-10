// canvas_renderer.ts
import { Loader, DataView } from "./loader";
import { RectRendererSoft, RectRendererWebGL, pixelEdge } from "./rect_renderer";
import { queryOverviewRows, yieldToUI } from "./axis_index";
import type { OverviewIndex } from "./axis_index";

/**
 * Context holding canvas rendering state and loaded data
 */
type RendererContext = Readonly<{
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    scaleXLog: number;
    scaleYLog: number;
    numRows: number;
    minPlotWidth: number;
    minPlotHeight: number;
}>;

// 既定値
const INITIAL_RENDERER_CONTEXT: RendererContext = {
    width: 0,
    height: 0,
    offsetX: 0,
    offsetY: 0,
    scaleXLog: Math.log(20),
    scaleYLog: 0,
    numRows: 0,
    minPlotWidth: 1,
    minPlotHeight: 1,
};

// ヘルパ
const scaleX = (scaleXLog: number) => Math.exp(scaleXLog);
const scaleY = (scaleYLog: number) => Math.exp(scaleYLog);


class GridMap {
    // 描画されたピクセルのインデックスを保持
    // マウスオーバー時に使用
    drawnIndex: Int32Array | null = null; 
}

type PixelScale = { x: number; y: number };
type ProjectionLookup = { table: Uint32Array; min: number; shift: number };
type PreparedRows = { view: DataView; context: RendererContext; pixelRatio: PixelScale; rows: Uint32Array };

class CanvasRenderer {
    MARGIN_LEFT_ = 50;
    MARGIN_BOTTOM_ = 20;
    BASE_HEIGHT_ = 1000;
    ZOOM_STEP_LOG_ = Math.log(1.3); // 対数ズーム量

    rectRenderer: RectRendererSoft|RectRendererWebGL;
    private rowCache_: PreparedRows | null = null;
    private fitRows_: PreparedRows | null = null;
    private pendingRows_: { view: DataView; context: RendererContext; pixelRatio: PixelScale } | null = null;
    private rowGeneration_ = 0;
    private pixelRows_: Uint32Array | null = null;
    private projectionTables_: Uint32Array[] = [];
    private refinementTables_: Uint32Array[] = [];
    private aggregateSmallViews_ = false;

    private sameViewport(a: RendererContext, b: RendererContext): boolean {
        return a.width === b.width && a.height === b.height && a.offsetX === b.offsetX && a.offsetY === b.offsetY &&
            a.scaleXLog === b.scaleXLog && a.scaleYLog === b.scaleYLog &&
            a.minPlotWidth === b.minPlotWidth && a.minPlotHeight === b.minPlotHeight;
    }

    get isPreparingRows(): boolean { return this.pendingRows_ !== null; }

    // 完成済みのviewportは残し、未完了の準備だけを中断する。
    cancelRowPreparation(): void {
        this.rowGeneration_++;
        this.pendingRows_ = null;
    }

    // 呼出側が完成行を保持する場合、こちらの参照だけを解放して作業配列は再利用する。
    releasePreparedRows(): void {
        this.rowCache_ = this.fitRows_ = null;
    }

    cancelPendingRows(): void {
        this.cancelRowPreparation();
        this.rowCache_ = null;
        this.fitRows_ = null;
        this.pixelRows_ = null;
        this.projectionTables_ = [];
        this.refinementTables_ = [];
    }

    private exactOverview(view: DataView): { index: OverviewIndex; swapped: boolean; fixedX: boolean } | null {
        const overview = view.getOverviewIndex();
        if (!overview || !overview.index.exactX || !overview.index.exactY) return null;
        const levels = overview.index.levels, base = levels[0];
        if (base.width <= 64 && levels.every(level => level.width === base.width)) return { ...overview, fixedX: true };
        if (base.height <= 64 && levels.every(level => level.height === base.height)) return { ...overview, fixedX: false };
        return null;
    }

    private *selectExactRows(overview: NonNullable<ReturnType<CanvasRenderer["exactOverview"]>>, context: RendererContext,
        pixelRatio: PixelScale): Generator<void, Uint32Array> {
        const { index, swapped, fixedX } = overview, base = index.levels[0];
        const category = index.columns[fixedX ? 0 : 1], stream = index.columns[fixedX ? 1 : 0];
        const horizontal = fixedX !== swapped, sx = scaleX(context.scaleXLog), sy = scaleY(context.scaleYLog);
        const rows: number[] = [], groups = new Map<number, number[]>();
        const position = (value: number, x: boolean) => (x ? this.MARGIN_LEFT_ : 0) + value * (x ? sx : sy) - (x ? context.offsetX : context.offsetY);
        const point = (x: boolean) => Math.max(x ? sx : sy, x ? context.minPlotWidth : context.minPlotHeight);
        const ratio = (x: boolean) => x ? pixelRatio.x : pixelRatio.y;
        const pixelEnd = (x: boolean) => Math.ceil((x ? context.width : context.height) * ratio(x));
        const clipEnd = (x: boolean) => x ? context.width : context.height - this.MARGIN_BOTTOM_;
        const footprint = (value: number, x: boolean) => {
            const p = position(value, x), first = Math.max(0, pixelEdge(p * ratio(x)));
            const last = Math.min(pixelEnd(x), pixelEdge((p + point(x)) * ratio(x)));
            return first * (pixelEnd(x) + 1) + last;
        };
        for (let bin = 0; bin <= category.stat.max - category.stat.min; bin++) {
            const value = category.stat.min + bin, p = position(value, horizontal);
            if (p + point(horizontal) < (horizontal ? this.MARGIN_LEFT_ : 0) || p >= clipEnd(horizontal)) continue;
            const key = footprint(value, horizontal), first = Math.floor(key / (pixelEnd(horizontal) + 1)), last = key % (pixelEnd(horizontal) + 1);
            if (first >= last) continue;
            const group = groups.get(key);
            if (group) group.push(bin); else groups.set(key, [bin]);
        }
        const streamHorizontal = !horizontal, domainEnd = stream.stat.max + 1;
        const lowerBound = (predicate: (value: number) => boolean) => {
            let lo = stream.stat.min, hi = domainEnd;
            while (lo < hi) { const mid = lo + Math.floor((hi - lo) / 2); if (predicate(mid)) hi = mid; else lo = mid + 1; }
            return lo;
        };
        let value = lowerBound(v => position(v, streamHorizontal) + point(streamHorizontal) >= (streamHorizontal ? this.MARGIN_LEFT_ : 0));
        const end = lowerBound(v => position(v, streamHorizontal) >= clipEnd(streamHorizontal));
        let visits = 0;
        // SM/warp番号を固定した各時間区間の最大行を、既存の階層から直接求める。
        // 区間の全整数が同じ画素被覆を持つ場合だけまとめ、座標のサンプリングはしない。
        while (value < end && groups.size) {
            if ((visits++ & 31) === 0) yield;
            const key = footprint(value, streamHorizontal);
            let lo = value + 1, hi = end;
            while (lo < hi) { const mid = lo + Math.floor((hi - lo) / 2); if (footprint(mid, streamHorizontal) === key) lo = mid + 1; else hi = mid; }
            const next = lo, first = Math.floor(key / (pixelEnd(streamHorizontal) + 1)), last = key % (pixelEnd(streamHorizontal) + 1);
            if (first < last) for (const group of groups.values()) {
                let head = 0;
                for (const bin of group) {
                    let start = value - stream.stat.min;
                    const stop = next - stream.stat.min;
                    while (start < stop) {
                        const alignment = start ? 31 - Math.clz32(start & -start) : 31;
                        const levelNumber = Math.min(alignment, 31 - Math.clz32(stop - start));
                        const level = index.levels[levelNumber], block = start >>> levelNumber;
                        head = Math.max(head, level.heads[fixedX ? block * base.width + bin : bin * level.width + block]);
                        start += 2 ** levelNumber;
                    }
                }
                if (head) rows.push(head - 1);
            }
            value = next;
        }
        return Uint32Array.from(rows).sort();
    }

    private *overviewGroups(index: OverviewIndex, swapped: boolean, context: RendererContext, pixelRatio: PixelScale): Generator<number | undefined> {
        const sx = scaleX(context.scaleXLog), sy = scaleY(context.scaleYLog);
        const pointWidth = Math.max(sx, context.minPlotWidth), pointHeight = Math.max(sy, context.minPlotHeight);
        const pixelWidth = Math.ceil(context.width * pixelRatio.x), pixelHeight = Math.ceil(context.height * pixelRatio.y);
        const base = index.levels[0], [xc, yc] = index.columns;
        const stack: number[] = [];
        const rootLevel = index.levels.length - 1, root = index.levels[rootLevel];
        for (let cell = 0; cell < root.heads.length; cell++) if (root.heads[cell]) stack.push(rootLevel, cell);
        let visits = 0;
        while (stack.length) {
            if ((visits++ & 1023) === 0) yield;
            const cell = stack.pop()!, levelNumber = stack.pop()!, level = index.levels[levelNumber];
            const head = level.heads[cell];
            if (!head) continue;
            const extentX = base.width / level.width, extentY = base.height / level.height;
            const bx = cell % level.width, by = Math.floor(cell / level.width);
            // 格子の理論境界ではなく実値の範囲を使い、疎なアドレス列の空白と丸め誤差を避ける。
            const xmin = level.boundsX ? level.boundsX[bx * 2] : xc.stat.min + bx * extentX;
            const xmax = level.boundsX ? level.boundsX[bx * 2 + 1] : Math.min(xc.stat.max, xc.stat.min + (bx + 1) * extentX - 1);
            const ymin = level.boundsY ? level.boundsY[by * 2] : yc.stat.min + by * extentY;
            const ymax = level.boundsY ? level.boundsY[by * 2 + 1] : Math.min(yc.stat.max, yc.stat.min + (by + 1) * extentY - 1);
            const x0 = this.MARGIN_LEFT_ + (swapped ? ymin : xmin) * sx - context.offsetX;
            const x1 = this.MARGIN_LEFT_ + (swapped ? ymax : xmax) * sx - context.offsetX;
            const y0 = (swapped ? xmin : ymin) * sy - context.offsetY;
            const y1 = (swapped ? xmax : ymax) * sy - context.offsetY;
            if (x1 + pointWidth < this.MARGIN_LEFT_ || x0 >= context.width || y1 + pointHeight < 0 || y0 >= context.height - this.MARGIN_BOTTOM_) continue;
            // 全点が描画範囲内で同じ画素矩形を覆うと確認できた領域だけ、最後の行へまとめる。
            if (x0 + pointWidth >= this.MARGIN_LEFT_ && x1 < context.width && y0 + pointHeight >= 0 && y1 < context.height - this.MARGIN_BOTTOM_ &&
                Math.max(0, pixelEdge(x0 * pixelRatio.x)) === Math.max(0, pixelEdge(x1 * pixelRatio.x)) &&
                Math.min(pixelWidth, pixelEdge((x0 + pointWidth) * pixelRatio.x)) === Math.min(pixelWidth, pixelEdge((x1 + pointWidth) * pixelRatio.x)) &&
                Math.max(0, pixelEdge(y0 * pixelRatio.y)) === Math.max(0, pixelEdge(y1 * pixelRatio.y)) &&
                Math.min(pixelHeight, pixelEdge((y0 + pointHeight) * pixelRatio.y)) === Math.min(pixelHeight, pixelEdge((y1 + pointHeight) * pixelRatio.y))) {
                yield head;
            } else if (levelNumber > 0) {
                const child = index.levels[levelNumber - 1];
                const cx = bx * (child.width > level.width ? 2 : 1), cy = by * (child.height > level.height ? 2 : 1);
                for (let dy = 0; dy < (child.height > level.height ? 2 : 1); dy++) {
                    for (let dx = 0; dx < (child.width > level.width ? 2 : 1); dx++) {
                        const childCell = (cy + dy) * child.width + cx + dx;
                        if (child.heads[childCell]) stack.push(levelNumber - 1, childCell);
                    }
                }
            } else {
                // 負値は全行をたどる領域を示す。候補行の巨大な一時配列は作らない。
                if (index.fine) {
                    const fine = index.fine;
                    for (let dy = 0; dy < fine.factorY; dy++) {
                        const first = (by * fine.factorY + dy) * fine.width + bx * fine.factorX, last = first + fine.factorX;
                        let lo = 0, hi = fine.cells.length / 2;
                        while (lo < hi) { const mid = (lo + hi) >>> 1; if (fine.cells[mid * 2] < first) lo = mid + 1; else hi = mid; }
                        for (let slot = lo; slot < fine.cells.length / 2 && fine.cells[slot * 2] < last; slot++) yield -fine.cells[slot * 2 + 1];
                    }
                } else yield -head;
            }
        }
    }

    // 整数bufferの連続走査を独立させ、細かい領域探索の分岐を数百万回通らないようにする。
    private *selectIntegerRows(columns: ReturnType<DataView["getAxisColumns"]>, lookup: ProjectionLookup[], context: RendererContext,
        pixelRatio: PixelScale, selection: ReturnType<DataView["getVisibleRows"]>, pixelRows: Uint32Array, pixels: Map<number, number>): Generator<void> {
        const [xc, yc] = columns, [xl, yl] = lookup, xValues = xc.buffer!, yValues = yc.buffer!;
        const xTable = xl.table, yTable = yl.table, xMin = xl.min, yMin = yl.min, xShift = xl.shift, yShift = yl.shift;
        const sx = scaleX(context.scaleXLog), sy = scaleY(context.scaleYLog);
        const pw = Math.max(sx, context.minPlotWidth), ph = Math.max(sy, context.minPlotHeight);
        const pixelWidth = Math.ceil(context.width * pixelRatio.x), pixelHeight = Math.ceil(context.height * pixelRatio.y);
        const xBase = pixelWidth + 1, yBase = pixelHeight + 1, order = selection.order;
        for (let position = selection.start; position < selection.end; position++) {
            if ((position & 16383) === 0) yield;
            const row = order ? order[position] : position, xv = xValues[row], yv = yValues[row];
            const px = xTable[(xv - xMin) >>> xShift], py = yTable[(yv - yMin) >>> yShift];
            if (px === 0 || py === 0) continue;
            let key: number, direct = true;
            if (px !== 0xffffffff && py !== 0xffffffff) key = px + py - 2;
            else {
                const x = this.MARGIN_LEFT_ + xv * sx - context.offsetX, y = yv * sy - context.offsetY;
                if (x + pw < this.MARGIN_LEFT_ || x >= context.width || y + ph < 0 || y >= context.height - this.MARGIN_BOTTOM_) continue;
                const x0 = Math.max(0, pixelEdge(x * pixelRatio.x)), x1 = Math.min(pixelWidth, pixelEdge((x + pw) * pixelRatio.x));
                const y0 = Math.max(0, pixelEdge(y * pixelRatio.y)), y1 = Math.min(pixelHeight, pixelEdge((y + ph) * pixelRatio.y));
                if (x0 >= x1 || y0 >= y1) continue;
                direct = x1 - x0 <= 2 && y1 - y0 <= 2;
                key = direct ? (y0 * pixelWidth + x0) * 4 + (x1 - x0 - 1) * 2 + y1 - y0 - 1 : ((y0 * xBase + x0) * yBase + y1) * xBase + x1;
            }
            if (direct) {
                if (!order || row + 1 > pixelRows[key]) pixelRows[key] = row + 1;
            } else {
                const previous = pixels.get(key);
                if (previous === undefined || row > previous) pixels.set(key, row);
            }
        }
    }

    private *selectRefinedRows(index: OverviewIndex, swapped: boolean, columns: ReturnType<DataView["getAxisColumns"]>, lookup: ProjectionLookup[],
        context: RendererContext, pixelRatio: PixelScale, pixelRows: Uint32Array, pixels: Map<number, number>): Generator<void> {
        const fine = index.fine!, base = index.levels[0], sx = scaleX(context.scaleXLog), sy = scaleY(context.scaleYLog);
        const pw = Math.max(sx, context.minPlotWidth), ph = Math.max(sy, context.minPlotHeight);
        const pixelWidth = Math.ceil(context.width * pixelRatio.x), pixelHeight = Math.ceil(context.height * pixelRatio.y);
        const codes: Uint32Array[] = [];
        // 疎な細分格子の各軸を一度だけ投影し、領域ごとの乗算・ceilを避ける。
        for (let axis = 0; axis < 2; axis++) {
            const column = index.columns[axis], horizontal = (axis === 0) !== swapped;
            const size = axis === 0 ? base.width * fine.factorX : base.height * fine.factorY;
            const exact = axis === 0 ? index.exactX : index.exactY;
            let table = this.refinementTables_[axis];
            if (!table || table.length < size) this.refinementTables_[axis] = table = new Uint32Array(size);
            const scale = horizontal ? sx : sy, point = horizontal ? pw : ph, ratio = horizontal ? pixelRatio.x : pixelRatio.y;
            const margin = horizontal ? this.MARGIN_LEFT_ : 0, offset = horizontal ? context.offsetX : context.offsetY;
            const clipEnd = horizontal ? context.width : context.height - this.MARGIN_BOTTOM_, pixelEnd = horizontal ? pixelWidth : pixelHeight;
            for (let bin = 0; bin < size; bin++) {
                if ((bin & 8191) === 0) yield;
                // 整数境界を外側へ1だけ広げ、格子計算の浮動小数点誤差でも行を落とさない。
                const min = exact ? column.stat.min + bin : Math.max(column.stat.min, Math.floor(column.stat.min + bin / size * (column.stat.max - column.stat.min)) - 1);
                const max = exact ? min : Math.min(column.stat.max, Math.ceil(column.stat.min + (bin + 1) / size * (column.stat.max - column.stat.min)) + 1);
                const lo = margin + min * scale - offset, hi = margin + max * scale - offset;
                let code = 0xffffffff;
                if (min > column.stat.max || hi + point < margin || lo >= clipEnd) code = 0;
                else if (lo + point >= margin && hi < clipEnd) {
                    const first = Math.max(0, pixelEdge(lo * ratio)), last = Math.min(pixelEnd, pixelEdge((lo + point) * ratio));
                    if (first === Math.max(0, pixelEdge(hi * ratio)) && last === Math.min(pixelEnd, pixelEdge((hi + point) * ratio))) {
                        const covered = last - first;
                        if (covered <= 0) code = 0;
                        else if (covered <= 2) code = first * (horizontal ? 4 : pixelWidth * 4) + (covered - 1) * (horizontal ? 2 : 1) + 1;
                    }
                }
                table[bin] = code;
            }
            codes.push(table);
        }
        const [xl, yl] = lookup, xValues = columns[0].buffer!, yValues = columns[1].buffer!;
        const xBase = pixelWidth + 1, yBase = pixelHeight + 1;
        let visits = 0;
        for (let slot = 0; slot < fine.cells.length; slot += 2) {
            if ((slot & 2047) === 0) yield;
            const cell = fine.cells[slot];
            let head = fine.cells[slot + 1];
            const a = codes[0][cell % fine.width], b = codes[1][Math.floor(cell / fine.width)];
            if (!a || !b) continue;
            if (a !== 0xffffffff && b !== 0xffffffff) {
                const key = a + b - 2;
                if (head > pixelRows[key]) pixelRows[key] = head;
                continue;
            }
            // 境界の領域だけ元の整数bufferへ戻り、全行を正確に比較する。
            while (head) {
                if ((visits++ & 2047) === 0) yield;
                const row = head - 1; head = index.next[row];
                const xv = xValues[row], yv = yValues[row];
                const px = xl.table[(xv - xl.min) >>> xl.shift], py = yl.table[(yv - yl.min) >>> yl.shift];
                if (!px || !py) continue;
                let key: number, direct = true;
                if (px !== 0xffffffff && py !== 0xffffffff) key = px + py - 2;
                else {
                    const x = this.MARGIN_LEFT_ + xv * sx - context.offsetX, y = yv * sy - context.offsetY;
                    if (x + pw < this.MARGIN_LEFT_ || x >= context.width || y + ph < 0 || y >= context.height - this.MARGIN_BOTTOM_) continue;
                    const x0 = Math.max(0, pixelEdge(x * pixelRatio.x)), x1 = Math.min(pixelWidth, pixelEdge((x + pw) * pixelRatio.x));
                    const y0 = Math.max(0, pixelEdge(y * pixelRatio.y)), y1 = Math.min(pixelHeight, pixelEdge((y + ph) * pixelRatio.y));
                    if (x0 >= x1 || y0 >= y1) continue;
                    direct = x1 - x0 <= 2 && y1 - y0 <= 2;
                    key = direct ? (y0 * pixelWidth + x0) * 4 + (x1 - x0 - 1) * 2 + y1 - y0 - 1 : ((y0 * xBase + x0) * yBase + y1) * xBase + x1;
                }
                if (direct) { if (row + 1 > pixelRows[key]) pixelRows[key] = row + 1; }
                else { const previous = pixels.get(key); if (previous === undefined || row > previous) pixels.set(key, row); }
            }
        }
    }

    private *selectRows(view: DataView, context: RendererContext, pixelRatio: PixelScale, selection: ReturnType<DataView["getVisibleRows"]>): Generator<void, Uint32Array> {
        if (selection.start >= selection.end) return new Uint32Array(0);
        const sx = scaleX(context.scaleXLog), sy = scaleY(context.scaleYLog);
        const width = context.width - this.MARGIN_LEFT_, height = context.height - this.MARGIN_BOTTOM_;
        const pointWidth = Math.max(sx, context.minPlotWidth), pointHeight = Math.max(sy, context.minPlotHeight);
        const pixelWidth = Math.ceil(context.width * pixelRatio.x), pixelHeight = Math.ceil(context.height * pixelRatio.y);
        const xBase = pixelWidth + 1, yBase = pixelHeight + 1;
        // 同じ画素範囲へ重なる点は、元の入力順で最後の行を残す。
        const aggregate = !(this.rectRenderer instanceof RectRendererSoft) && (this.aggregateSmallViews_ || selection.end - selection.start > 100000) &&
            xBase * xBase * yBase * yBase < Number.MAX_SAFE_INTEGER;
        const overview = view.getOverviewIndex();
        // 候補件数は片軸だけの上限。両軸で実際に少数なら、領域索引から全対象行を取り出す。
        // 画面の物理画素数と点の大きさに応じて列挙の上限を決め、判定にも作業量の上限を設ける。
        const fullRowLimit = Math.max(512, Math.min(32768, Math.floor(width * height * pixelRatio.x * pixelRatio.y /
            (2 * Math.max(1, pointWidth * pixelRatio.x) * Math.max(1, pointHeight * pixelRatio.y)))));
        const candidates = selection.end - selection.start;
        let sparseRows: Uint32Array | null = null;
        if (overview && overview.index.levels[overview.index.levels.length - 1].counts &&
            candidates > Math.max(this.aggregateSmallViews_ ? 8192 : 100000, fullRowLimit * 2)) {
            const xmin = (context.offsetX - pointWidth) / sx, xmax = (context.offsetX + width) / sx;
            const ymin = (context.offsetY - pointHeight) / sy, ymax = (context.offsetY + height) / sy;
            sparseRows = yield* queryOverviewRows(overview.index, overview.swapped ? ymin : xmin, overview.swapped ? xmin : ymin,
                overview.swapped ? ymax : xmax, overview.swapped ? xmax : ymax, fullRowLimit, Math.min(65536, Math.floor(candidates / 4)));
            if (sparseRows) {
                if (!sparseRows.length) return sparseRows;
                selection = { order: sparseRows, start: 0, end: sparseRows.length };
            }
        }
        // 片軸の候補だけで少数と分かる場合も直接確認し、広い格子探索と画素配列の初期化を省く。
        // 集約する条件と最後の入力行を残す規則は維持し、少数時は小さなMapへまとめる。
        const scanRows = candidates <= fullRowLimit || sparseRows !== null;
        const exact = aggregate && !scanRows ? this.exactOverview(view) : null;
        if (exact) return yield* this.selectExactRows(exact, context, pixelRatio);
        const gridSlots = pixelWidth * pixelHeight * 4;
        let pixelRows: Uint32Array | null = null;
        // 縮小表示の1〜2画素の点はハッシュを使わず、画素と縦横の被覆サイズで直接引く。
        // 作業配列はviewport間で再利用し、高解像度では32MiBを超えたらMapへ戻る。
        if (aggregate && !scanRows && pointWidth * pixelRatio.x <= 2 && pointHeight * pixelRatio.y <= 2 && gridSlots * 4 <= 32 * 1024 * 1024) {
            if (!this.pixelRows_ || this.pixelRows_.length < gridSlots) this.pixelRows_ = new Uint32Array(gridSlots);
            pixelRows = this.pixelRows_.subarray(0, gridSlots);
            pixelRows.fill(0);
        }
        const columns = view.getAxisColumns();
        const indexed = aggregate && !scanRows ? overview : null;
        const fine = indexed?.index.fine;
        const fineX = indexed?.swapped ? fine?.factorY : fine?.factorX, fineY = indexed?.swapped ? fine?.factorX : fine?.factorY;
        const coarseX = indexed ? (indexed.swapped ? indexed.index.meanSpanY : indexed.index.meanSpanX) * sx * pixelRatio.x : 0;
        const coarseY = indexed ? (indexed.swapped ? indexed.index.meanSpanX : indexed.index.meanSpanY) * sy * pixelRatio.y : 0;
        // 極端な縮小では上位層だけをたどり、Fit付近では細分格子の境界だけを走査する。
        const useRefined = !!(pixelRows && fine && (coarseX > 0.02 || coarseY > 0.02) && (indexed!.swapped ? indexed!.index.meanSpanY : indexed!.index.meanSpanX) / fineX! * sx * pixelRatio.x <= 0.2 &&
            (indexed!.swapped ? indexed!.index.meanSpanX : indexed!.index.meanSpanY) / fineY! * sy * pixelRatio.y <= 0.2);
        // Fit付近は多数の行を連続走査する方が速い。整数座標の小区間を先に投影し、
        // 同じ被覆を持つ区間では行ごとの乗算・ceilを省く。画素境界だけ従来計算へ戻す。
        let lookup: ProjectionLookup[] | null = null;
        if (pixelRows && columns.every(c => c.buffer instanceof Int32Array && c.buffer.length >= (selection.order?.length ?? selection.end)) &&
            (useRefined || (columns[0].stat.max - columns[0].stat.min) * sx >= width * 0.9 ||
             (columns[1].stat.max - columns[1].stat.min) * sy >= height * 0.9)) {
            lookup = [];
            for (let axis = 0; axis < 2; axis++) {
                const column = columns[axis];
                const horizontal = axis === 0, scale = horizontal ? sx : sy;
                const ratio = horizontal ? pixelRatio.x : pixelRatio.y, pointSize = horizontal ? pointWidth : pointHeight;
                const offset = horizontal ? context.offsetX : context.offsetY, margin = horizontal ? this.MARGIN_LEFT_ : 0;
                const clipEnd = horizontal ? context.width : height, pixelEnd = horizontal ? pixelWidth : pixelHeight;
                const min = column.stat.min, span = column.stat.max - min;
                const shift = Math.max(0, Math.ceil(Math.log2(Math.max(1, (span + 1) / 65536))));
                const bucketSize = 2 ** shift, count = Math.floor(span / bucketSize) + 1;
                let table = this.projectionTables_[axis];
                if (!table || table.length < count) this.projectionTables_[axis] = table = new Uint32Array(count);
                for (let bin = 0; bin < count; bin++) {
                    if ((bin & 8191) === 0) yield;
                    const lo = margin + (min + bin * bucketSize) * scale - offset;
                    const hi = margin + Math.min(column.stat.max, min + (bin + 1) * bucketSize - 1) * scale - offset;
                    let code = 0xffffffff;
                    if (hi + pointSize < margin || lo >= clipEnd) code = 0;
                    else if (lo + pointSize >= margin && hi < clipEnd) {
                        const first = Math.max(0, pixelEdge(lo * ratio));
                        const last = Math.min(pixelEnd, pixelEdge((lo + pointSize) * ratio));
                        if (first === Math.max(0, pixelEdge(hi * ratio)) && last === Math.min(pixelEnd, pixelEdge((hi + pointSize) * ratio))) {
                            const size = last - first;
                            if (size <= 0) code = 0;
                            else if (size <= 2) code = first * (horizontal ? 4 : pixelWidth * 4) + (size - 1) * (horizontal ? 2 : 1) + 1;
                        }
                    }
                    table[bin] = code;
                }
                lookup.push({ table, min, shift });
            }
        }
        let overviewGroups: Generator<number | undefined> | null = null;
        if (indexed && !lookup) {
            const { index: overview, swapped } = indexed;
            const dx = overview.meanSpanX, dy = overview.meanSpanY;
            // 最細層でも画素境界をまたぐ領域が多い倍率では、連続した従来走査の方が速い。
            if ((swapped ? dy : dx) * sx * pixelRatio.x <= 0.2 && (swapped ? dx : dy) * sy * pixelRatio.y <= 0.2) {
                overviewGroups = this.overviewGroups(overview, swapped, context, pixelRatio);
            }
        }
        const pixels = aggregate ? new Map<number, number>() : null;
        const rows: number[] = [];
        if (lookup && useRefined) yield* this.selectRefinedRows(indexed!.index, indexed!.swapped, columns, lookup, context, pixelRatio, pixelRows!, pixels!);
        else if (lookup) yield* this.selectIntegerRows(columns, lookup, context, pixelRatio, selection, pixelRows!, pixels!);
        else {
            let link = 0;
            for (let position = selection.start; overviewGroups || position < selection.end; position++) {
                if ((position & 2047) === 0) yield;
                let row: number;
                if (overviewGroups) {
                    if (link) { row = link - 1; link = indexed!.index.next[row]; }
                    else {
                        const group = overviewGroups.next();
                        if (group.done) break;
                        if (group.value === undefined) { yield; continue; }
                        if (group.value < 0) { link = -group.value; continue; }
                        row = group.value - 1;
                    }
                } else {
                    row = selection.order ? selection.order[position] : position;
                }
                // 軸索引で選んだ候補には、もう一方の軸で範囲外の行も含まれることがある。
                // 両軸の点矩形と表示範囲の重なりを確認し、端に一部だけ見える点も残す。
                const y = view.getY(row) * sy - context.offsetY;
                if (!Number.isFinite(y) || y + pointHeight < 0 || y >= height) continue;
                const x = this.MARGIN_LEFT_ + view.getX(row) * sx - context.offsetX;
                if (!Number.isFinite(x) || x + pointWidth < this.MARGIN_LEFT_ || x >= context.width) continue;
                if (pixels) {
                    const x0 = Math.max(0, pixelEdge(x * pixelRatio.x));
                    const x1 = Math.min(pixelWidth, pixelEdge((x + pointWidth) * pixelRatio.x));
                    const y0 = Math.max(0, pixelEdge(y * pixelRatio.y));
                    const y1 = Math.min(pixelHeight, pixelEdge((y + pointHeight) * pixelRatio.y));
                    if (x0 >= x1 || y0 >= y1) continue;
                    const dx = x1 - x0, dy = y1 - y0;
                    if (pixelRows && dx <= 2 && dy <= 2) {
                        const key = (y0 * pixelWidth + x0) * 4 + (dx - 1) * 2 + dy - 1;
                        if (row + 1 > pixelRows[key]) pixelRows[key] = row + 1;
                        continue;
                    }
                    const key = ((y0 * xBase + x0) * yBase + y1) * xBase + x1;
                    const previous = pixels.get(key);
                    if (previous === undefined || row > previous) pixels.set(key, row);
                } else rows.push(row);
            }
        }
        if (pixels) for (const row of pixels.values()) rows.push(row);
        if (pixelRows) for (let pixel = 0; pixel < pixelRows.length; pixel++) if (pixelRows[pixel]) rows.push(pixelRows[pixel] - 1);
        const result = Uint32Array.from(rows);
        // 索引の値順ではなく元の行順で描き、重なりの色を変えない。
        if (aggregate || selection.order) result.sort();
        return result;
    }

    private prepareRows(view: DataView, context: RendererContext, pixelRatio: PixelScale, requestDraw?: () => void): Uint32Array | null {
        if (this.fitRows_?.view === view && this.fitRows_.pixelRatio.x === pixelRatio.x && this.fitRows_.pixelRatio.y === pixelRatio.y && this.sameViewport(this.fitRows_.context, context)) {
            this.rowCache_ = this.fitRows_;
        }
        if (this.rowCache_?.view === view && this.rowCache_.pixelRatio.x === pixelRatio.x && this.rowCache_.pixelRatio.y === pixelRatio.y && this.sameViewport(this.rowCache_.context, context)) {
            if (this.pendingRows_) this.cancelRowPreparation();
            return this.rowCache_.rows;
        }
        if (this.pendingRows_?.view === view && this.pendingRows_.pixelRatio.x === pixelRatio.x && this.pendingRows_.pixelRatio.y === pixelRatio.y && this.sameViewport(this.pendingRows_.context, context)) return null;
        const generation = ++this.rowGeneration_;
        this.pendingRows_ = null;
        const sx = scaleX(context.scaleXLog), sy = scaleY(context.scaleYLog);
        const range = view.getVisibleRows((context.offsetX - Math.max(sx, context.minPlotWidth)) / sx,
            (context.offsetY - Math.max(sy, context.minPlotHeight)) / sy,
            (context.offsetX + context.width - this.MARGIN_LEFT_) / sx,
            (context.offsetY + context.height - this.MARGIN_BOTTOM_) / sy);
        const selection = this.selectRows(view, context, pixelRatio, range);
        if (requestDraw && range.end - range.start > (this.aggregateSmallViews_ ? 8192 : 100000)) {
            // 少数の整数カテゴリの区間照会は短時間で終わる。最初のsliceで完成すれば
            // 同じフレームで描き、MessageChannelと次のRAFを余分に待たない。
            if (!(this.rectRenderer instanceof RectRendererSoft) && this.exactOverview(view)) {
                const deadline = performance.now() + 6;
                let next;
                do { next = selection.next(); } while (!next.done && performance.now() < deadline);
                if (next.done) { this.cacheRows({ view, context, pixelRatio, rows: next.value }); return next.value; }
            }
            this.pendingRows_ = { view, context, pixelRatio };
            const advance = () => {
                if (generation !== this.rowGeneration_) return;
                const deadline = performance.now() + 6;
                let next;
                do { next = selection.next(); } while (!next.done && performance.now() < deadline);
                if (next.done) {
                    this.cacheRows({ view, context, pixelRatio, rows: next.value });
                    this.pendingRows_ = null;
                    requestDraw();
                } else void yieldToUI().then(advance);
            };
            void yieldToUI().then(advance);
            return null;
        }
        let next;
        do { next = selection.next(); } while (!next.done);
        this.cacheRows({ view, context, pixelRatio, rows: next.value });
        return next.value;
    }

    private cacheRows(prepared: PreparedRows): void {
        this.rowCache_ = prepared;
        // 拡大後にFitへ戻っても再走査しない。保持する全体表示は1つ、行番号2MiBまで。
        if (prepared.rows.byteLength <= 2 * 1024 * 1024 && this.sameViewport(prepared.context, this.fitScaleToData(prepared.view, prepared.context))) {
            this.fitRows_ = prepared;
        }
    }

    constructor(backend?: RectRendererSoft | RectRendererWebGL) {
        if (backend) { this.rectRenderer = backend; return; }
        let rendererGL = new RectRendererWebGL();
        if (rendererGL.init()) {
            this.rectRenderer = rendererGL;
        }
        else { // GL が初期化できなかった場合はソフト描画にフォールバック
            this.rectRenderer = new RectRendererSoft();
            this.rectRenderer.init();
        }
    }

    // 共通ヘルパー：対数スケールでのズーム＆オフセット更新
    applyZoom(
        renderCtx: RendererContext,
        mouseX: number,
        mouseY: number,
        axes: { x: number; y: number }  // どの軸をズームするか
    ): RendererContext {
        // 変更前スケール（オフセット更新で使用）
        const prevX = scaleX(renderCtx.scaleXLog);
        const prevY = scaleY(renderCtx.scaleYLog);

        // 変更後スケール
        const newX = scaleX(axes.x);
        const newY = scaleY(axes.y);

        // 2) マウス位置を基準にオフセット調整
        let nextOffsetX = renderCtx.offsetX;
        let nextOffsetY = renderCtx.offsetY;

        const relX = mouseX - this.MARGIN_LEFT_ + renderCtx.offsetX;
        // prevX が 0 に極端に近い場合のガード（念のため）
        const safePrevX = Math.abs(prevX) < 1e-12 ? 1e-12 : prevX;
        nextOffsetX = relX * (newX / safePrevX) - (mouseX - this.MARGIN_LEFT_);

        const relY = mouseY + renderCtx.offsetY;
        const safePrevY = Math.abs(prevY) < 1e-12 ? 1e-12 : prevY;
        nextOffsetY = relY * (newY / safePrevY) - mouseY;

        // 新しいコンテキストを返す（イミュータブル）
        return {
            ...renderCtx,
            scaleXLog: axes.x,
            scaleYLog: axes.y,
            offsetX: nextOffsetX,
            offsetY: nextOffsetY,
        };
    }

    zoomDrag(initial: RendererContext, mouseX: number, mouseY: number, dx: number, dy: number): RendererContext {
        // 開始位置の前後にも停止区間を作らない。asinhは原点で滑らかに符号が変わり、
        // 遠くでは従来の符号付きlogに近づくので、大きいドラッグの操作感を保つ。
        // 移動量も表示寸法もCSS pxで扱い、DPRによって感度が変わることを避ける。
        return this.applyZoom(initial, mouseX, mouseY, {
            x: initial.scaleXLog + Math.asinh(dx / Math.max(1, initial.width) * 50),
            y: initial.scaleYLog + Math.asinh(dy / Math.max(1, initial.height) * 50)
        });
    }

    private applyZoomDiv(
        renderCtx: RendererContext,
        mouseX: number,
        mouseY: number,
        zoomIn: boolean,
        divisions: number,
        axes: { x?: boolean | null; y?: boolean | null }  // どの軸をズームするか
    ): RendererContext {
        const base = this.ZOOM_STEP_LOG_;
        const step = base / Math.max(1, Math.floor(divisions));
        const dir = zoomIn ? 1 : -1;

        return this.applyZoom(renderCtx, mouseX, mouseY, {
            x: axes.x ? renderCtx.scaleXLog + dir * step : renderCtx.scaleXLog,
            y: axes.y ? renderCtx.scaleYLog + dir * step : renderCtx.scaleYLog
        });
    }

    // ===== ラッパー関数（既存API互換） =====

    // uniform zoom（縦横両方：対数スケール）
    zoomUniform(renderCtx: RendererContext, mouseX: number, mouseY: number, zoomIn: boolean, divs: number = 1): RendererContext {
        return this.applyZoomDiv(renderCtx, mouseX, mouseY, zoomIn, divs, { x: true, y: true });
    }

    // horizontal-only zoom（対数スケール）
    zoomHorizontal(renderCtx: RendererContext, mouseX: number, mouseY: number, zoomIn: boolean, divs: number = 1): RendererContext {
        return this.applyZoomDiv(renderCtx, mouseX, mouseY, zoomIn, divs, { x: true });
    }

    // vertical-only zoom（対数スケール）
    zoomVertical(renderCtx: RendererContext, mouseX: number, mouseY: number, zoomIn: boolean, divs: number = 1): RendererContext {
        return this.applyZoomDiv(renderCtx, mouseX, mouseY, zoomIn, divs, { y: true });
    }

    // 10進で上位2桁を 1, 2, 5, 10 のいずれかに丸めて「見やすい数値」を返す
    niceNum_(x: number): number {
        const exponent = Math.floor(Math.log10(x)); // 10 で対数を取って切り捨て
        const base = Math.pow(10, exponent);    // 10 のべき乗
        const fraction = x / base;  // 基数で割って10進数で上位二桁を取り出す
        let niceFraction: number;
        // 1, 2, 5 のいずれかに丸める
        if (fraction <= 1) niceFraction = 1;
        else if (fraction <= 2) niceFraction = 2;
        else if (fraction <= 5) niceFraction = 5;
        else niceFraction = 10;
        return niceFraction * base;
    };

    // 背景クリア
    clear(canvasCtx: CanvasRenderingContext2D, renderCtx: RendererContext) {
        if (!canvasCtx) return;
        const { width, height } = renderCtx;
        canvasCtx.fillStyle = '#1c1e23';
        canvasCtx.fillRect(0, 0, width, height);
    }


    // 完成した描画対象を返す。準備が非同期で未完了ならnullを返し、完了時にrequestDrawを呼ぶ。
    draw(canvas: HTMLCanvasElement, gridMap: GridMap, dataView: DataView | null, renderCtx: RendererContext,
        requestDraw?: () => void, options?: { axes?: boolean; aggregateSmallViews?: boolean; smoothOverview?: boolean }): Uint32Array | null {
        const aggregateSmallViews = options?.aggregateSmallViews ?? false;
        if (aggregateSmallViews !== this.aggregateSmallViews_) {
            this.cancelPendingRows();
            this.aggregateSmallViews_ = aggregateSmallViews;
        }
        let canvasCtx = canvas.getContext("2d")!;
        if (!canvasCtx) return null;

        // let startTime = (new Date()).getTime();

        const { width, height, offsetX, offsetY } = renderCtx;
        const scaleXVal = scaleX(renderCtx.scaleXLog);
        const scaleYVal = scaleY(renderCtx.scaleYLog);

        if (!dataView) {
            this.cancelPendingRows();
            this.clear(canvasCtx, renderCtx);
            return null;
        }

        // プロット領域がサイズ０となると色々壊れるのでリターン
        const plotHeight = Math.max(height - this.MARGIN_BOTTOM_, 0);
        const plotWidth = Math.max(width - this.MARGIN_LEFT_, 0);
        if (plotHeight <= 0 || plotWidth <= 0) { this.cancelPendingRows(); return null; }

        // データ座標での表示範囲。端数のスクロール位置でも端のセルを含める。
        const xMin = offsetX / scaleXVal;
        const yMin = offsetY / scaleYVal;
        const xMax = (offsetX + plotWidth) / scaleXVal;
        const yMax = (offsetY + plotHeight) / scaleYVal;
        const xStart = Math.floor(xMin);
        const yStart = Math.floor(yMin);
        const visibleCols = Math.ceil(xMax) - xStart;
        const visibleRows = Math.ceil(yMax) - yStart;

        // グリッドの上限を設定
        const MAX_RES = 128;
        const gridCols = Math.min(visibleCols, MAX_RES);
        const gridRows = Math.min(visibleRows, MAX_RES);

        // データ描画用ピクセルサイズ
        const pxW = Math.max(scaleXVal, renderCtx.minPlotWidth);
        const pxH = Math.max(scaleYVal, renderCtx.minPlotHeight);

        // 左・上には、最小描画サイズによって画面内へ重なる点も含める。
        // 終端を整数へ丸めず、部分表示のセルや派生列の小数座標も描画対象にする。
        // DOM外のCanvasではclient寸法が0なので、明示した論理寸法を使う。
        const logicalWidth = canvas.clientWidth || renderCtx.width, logicalHeight = canvas.clientHeight || renderCtx.height;
        const displayRatio = {
            x: canvas.width && logicalWidth ? canvas.width / logicalWidth : 1,
            y: canvas.height && logicalHeight ? canvas.height / logicalHeight : 1
        };
        const colorPalette = dataView.getPalette();
        // 縮小された整数カテゴリ＋時間軸は1画素の最後の色が倍率で入れ替わる。
        // 2×2の被覆を既存索引で求めて平均し、周期的な色や疎な点のちらつきを抑える。
        // 高DPRは既に細かい画素を持つ。互換描画・半透明・大きな点は従来どおり。
        const samples = options?.smoothOverview && this.rectRenderer instanceof RectRendererWebGL && this.exactOverview(dataView) &&
            renderCtx.minPlotWidth <= 1 && renderCtx.minPlotHeight <= 1 && Math.max(displayRatio.x, displayRatio.y) < 2 &&
            Math.min(pxW * displayRatio.x, pxH * displayRatio.y) <= 2 &&
            canvas.width > 0 && canvas.height > 0 && canvas.width * canvas.height * 16 <= 16 * 1024 * 1024 &&
            colorPalette.every(color => (color >>> 24) === 255) ? 2 : 1;
        const pixelRatio = { x: displayRatio.x * samples, y: displayRatio.y * samples };
        const rows = this.prepareRows(dataView, renderCtx, pixelRatio, requestDraw);
        if (!rows) {
            gridMap.drawnIndex = null;
            return null;
        }
        this.clear(canvasCtx, renderCtx);

        // drawnIndex を gridCols × gridRows で初期化
        if (gridMap.drawnIndex?.length != gridCols * gridRows) {
            gridMap.drawnIndex = new Int32Array(gridCols * gridRows).fill(-1);
        }
        else {
            gridMap.drawnIndex.fill(-1);
        }

        const gridColRatio = gridCols / visibleCols;
        const gridRowRatio = gridRows / visibleRows;

        // データ描画＆インデックス記録
        const raster = this.rectRenderer instanceof RectRendererWebGL && this.exactOverview(dataView) &&
            canvas.width > 0 && canvas.height > 0 && canvas.width * canvas.height * samples * samples * 4 <= 16 * 1024 * 1024 &&
            Math.min(pxW * pixelRatio.x, pxH * pixelRatio.y) <= 2 * samples && colorPalette.every(color => (color >>> 24) === 255) &&
            (samples === 2 || rows.length * Math.ceil(pxW * pixelRatio.x) * Math.ceil(pxH * pixelRatio.y) <= canvas.width * canvas.height * 4);
        if (raster && this.rectRenderer instanceof RectRendererWebGL) this.rectRenderer.beginRasterMode(canvas, 0xff231e1c, logicalWidth, logicalHeight, samples);
        else this.rectRenderer.beginRawMode(canvas, scaleYVal, logicalWidth, logicalHeight);

        for (const i of rows) {
            const yVal = dataView.getY(i);
            const y = yVal * scaleYVal - offsetY;
            if (y + pxH < 0) continue;
            if (y >= plotHeight) continue;

            const xVal = dataView.getX(i);
            const x = this.MARGIN_LEFT_ + xVal * scaleXVal - offsetX;
            if (x + pxW < this.MARGIN_LEFT_) continue;
            if (x >= width) continue;

            const c = colorPalette[dataView.getColorIndex(i)];

            this.rectRenderer.fillRect(x, y, pxW, pxH, c);

            // visible 範囲内なら、grid 上のセルに記録
            const col = xVal - xStart;
            const row = yVal - yStart;

            if (col >= 0 && col < visibleCols && row >= 0 && row < visibleRows) {
                // 大きい解像度を小さい grid にマップ
                const gridCol = Math.floor(col * gridColRatio);
                const gridRow = Math.floor(row * gridRowRatio);
                const cellIndex = gridRow * gridCols + gridCol;
                gridMap.drawnIndex[cellIndex] = i;
            }
        }
        this.rectRenderer.endRawMode();

        if (options?.axes !== false) this.drawAxes(canvasCtx, dataView, renderCtx);
        return rows;
    }

    drawAxes(canvasCtx: CanvasRenderingContext2D, dataView: DataView, renderCtx: RendererContext): void {
        const { width, height, offsetX, offsetY } = renderCtx;
        const plotWidth = Math.max(0, width - this.MARGIN_LEFT_), plotHeight = Math.max(0, height - this.MARGIN_BOTTOM_);
        const scaleXVal = scaleX(renderCtx.scaleXLog), scaleYVal = scaleY(renderCtx.scaleYLog);
        // Axes
        canvasCtx.strokeStyle = '#eee';
        canvasCtx.lineWidth = 1;
        canvasCtx.beginPath();
        canvasCtx.moveTo(this.MARGIN_LEFT_, 0);
        canvasCtx.lineTo(this.MARGIN_LEFT_, plotHeight);
        canvasCtx.moveTo(this.MARGIN_LEFT_, plotHeight);
        canvasCtx.lineTo(width, plotHeight);
        canvasCtx.stroke();

        // 余白部分を塗りつぶして、プロット要素を隠す
        canvasCtx.fillStyle = 'rgb(35,38,45)';
        canvasCtx.fillRect(0, 0, this.MARGIN_LEFT_, height);
        canvasCtx.fillRect(0, plotHeight, width, this.MARGIN_BOTTOM_);

        // Y-axis ticks and grid
        canvasCtx.fillStyle = '#eee';
        canvasCtx.textAlign = 'right';
        canvasCtx.textBaseline = 'middle';
        const pixelMinSpacingY = 40;
        const rawDataSpacingY = pixelMinSpacingY / scaleYVal;
        let tickSpacingY = this.niceNum_(rawDataSpacingY);
        tickSpacingY = tickSpacingY < 1 ? 1 : tickSpacingY; // 最小値を 1 に設定

        for (let val = Math.ceil(Math.max(offsetY / scaleYVal, dataView.getMinY()) / tickSpacingY) * tickSpacingY;
             val <= dataView.getMaxY();
             val += tickSpacingY) {
            const y = val * scaleYVal - offsetY;
            if (y > plotHeight) break;
            canvasCtx.strokeStyle = '#444';
            canvasCtx.lineWidth = 1;
            canvasCtx.beginPath();
            canvasCtx.moveTo(this.MARGIN_LEFT_, y);
            canvasCtx.lineTo(width, y);
            canvasCtx.stroke();
            canvasCtx.fillText(dataView.yToString(val), this.MARGIN_LEFT_ - 5, y);
        }

        // X-axis ticks
        canvasCtx.textAlign = 'center';
        canvasCtx.textBaseline = 'top';
        const pixelMinSpacingX = dataView.getMaxX() < 16 ? 10 : 40; // 数字が小さい場合は最小間隔を 10 に設定
        const rawDataSpacingX = pixelMinSpacingX / scaleXVal;
        let tickSpacingX = this.niceNum_(rawDataSpacingX);
        tickSpacingX = tickSpacingX < 1 ? 1 : tickSpacingX; // 最小値を 1 に設定
        const tickOffsetX = offsetX - this.MARGIN_LEFT_ - (scaleXVal / 2);
        for (let i = Math.ceil(Math.max(tickOffsetX / scaleXVal, dataView.getMinX()) / tickSpacingX) * tickSpacingX;
             i < dataView.getMaxX();
             i += tickSpacingX) {
            const val = i;
            const x = val * scaleXVal - tickOffsetX;
            if (x > plotWidth) break;
            canvasCtx.fillText(dataView.xToString(val), x, plotHeight + 3);
        }

        // let elapsedTime = (new Date()).getTime() - startTime;
        // console.log(`draw() done: ${elapsedTime} ms`);
    };

    // マウス位置（CSSピクセル）に対応するデータの文字列を取得
    getText(mouseX: number, mouseY: number, gridMap: GridMap, dataView: DataView, renderCtx: RendererContext, loader: Loader): string {

        if (!dataView || !gridMap.drawnIndex) {
            return "";
        }

        // 共通パラメータ
        const plotHeight = renderCtx.height - this.MARGIN_BOTTOM_;

        // 可視セル数（カラム数・行数）
        const scaleXVal = scaleX(renderCtx.scaleXLog);
        const scaleYVal = scaleY(renderCtx.scaleYLog);
        const xStart = Math.floor(renderCtx.offsetX / scaleXVal);
        const yStart = Math.floor(renderCtx.offsetY / scaleYVal);
        const visibleCols = Math.ceil((renderCtx.offsetX + renderCtx.width - this.MARGIN_LEFT_) / scaleXVal) - xStart;
        const visibleRows = Math.ceil((renderCtx.offsetY + plotHeight) / scaleYVal) - yStart;

        // 最大解像度制限
        const MAX_RES = 128;
        const gridCols = Math.min(visibleCols, MAX_RES);
        const gridRows = Math.min(visibleRows, MAX_RES);

        const xVal = Math.floor((mouseX - this.MARGIN_LEFT_ + renderCtx.offsetX) / scaleXVal);
        const yVal = Math.floor((mouseY + renderCtx.offsetY) / scaleYVal);
        const col = xVal - xStart;
        const row = yVal - yStart;

        let recordIndex = -1;
        if (col >= 0 && col < visibleCols && row >= 0 && row < visibleRows) {
            const gridCol = Math.floor(col * gridCols / visibleCols);
            const gridRow = Math.floor(row * gridRows / visibleRows);
            const cellIndex = gridRow * gridCols + gridCol;
            recordIndex = gridMap.drawnIndex[cellIndex] ?? -1;
        }

        // 全 columns を走査して "列名: 値, " の文字列を組み立て
        let payload = "";
        if (recordIndex >= 0) {
            const cols = loader.headers;    // ParsedColumns 型
            const types = loader.types;     // 各列の型情報
            payload = cols.map((colName) => {
                const arr = loader.columnFromName(colName);
                let value = arr.getString(recordIndex);
                return `${colName}: ${value}`;
            }).join(", ") + ", ";
        }

        return payload;
    }

    /**
     * データ全体（X: minX..maxX, Y: minY..maxY）がプロット領域に収まるように
     * scaleXLog / scaleYLog を設定し、オフセットもリセットする。
     */
    fitScaleToData(dataView: DataView | null, renderCtx: RendererContext, paddingRatio = 1.0): RendererContext {
        if (!dataView) return renderCtx;

        const { width, height } = renderCtx;
        const plotWidth  = Math.max(1, width  - this.MARGIN_LEFT_);
        const plotHeight = Math.max(1, height - this.MARGIN_BOTTOM_);

        const maxX = dataView.getMaxX();
        const minX = dataView.getMinX();
        const maxY = dataView.getMaxY();
        const minY = dataView.getMinY ? dataView.getMinY() : 0;

        // X方向は minX..maxX のセル幅
        const dataPixelWidth  = Math.max(1, maxX - minX + 1) * paddingRatio;

        // Y方向は minY..maxY の範囲を収める
        const baseScaleY = 1;
        const dataPixelHeight = Math.max(1, (maxY - minY + 1) * baseScaleY) * paddingRatio;

        // 必要スケール
        let fitScaleX = plotWidth  / dataPixelWidth;
        let fitScaleY = plotHeight / dataPixelHeight;

        // 横が長すぎるは横スケールを落とす
        const MAX_SCALE_X = 20;
        let clamped = false;
        if (fitScaleX > MAX_SCALE_X) {
            fitScaleX = MAX_SCALE_X;
            clamped = true;
        }

        const SAFE_MIN = Number.MIN_VALUE;
        const nextScaleXLog = Math.log(Math.max(fitScaleX, SAFE_MIN));
        const nextScaleYLog = Math.log(Math.max(fitScaleY, SAFE_MIN));

        // 左下に minY が来るようにオフセット調整
        const nextOffsetY = minY * baseScaleY * Math.exp(nextScaleYLog);

        // 横方向オフセット
        let nextOffsetX = minX * Math.exp(nextScaleXLog);
        if (clamped) {
            // 実際のデータ幅（px換算後）
            const usedWidth = dataPixelWidth * Math.exp(nextScaleXLog);
            // プロット領域中央に配置
            nextOffsetX -= (plotWidth - usedWidth) / 2;
        }

        return {
            ...renderCtx,
            scaleXLog: nextScaleXLog,
            scaleYLog: nextScaleYLog,
            offsetX: nextOffsetX,
            offsetY: nextOffsetY,
        };
    }
}

export { CanvasRenderer, RendererContext, GridMap, INITIAL_RENDERER_CONTEXT, scaleX, scaleY };
