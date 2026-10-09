import { CanvasRenderer, GridMap, scaleX, scaleY } from "./canvas_renderer";
import type { RendererContext } from "./canvas_renderer";
import type { DataView } from "./loader";
import { RectRendererSoft, RectRendererWebGL } from "./rect_renderer";

type PixelScale = { x: number; y: number };
type TileLayer = { key: string; sx: number; sy: number; phaseX: number; phaseY: number };
type PlotTile = { layer: TileLayer; x: number; y: number; canvas: HTMLCanvasElement | null; rows: Uint32Array; bytes: number; readyAt?: number };
type TileJob = { key: string; x: number; y: number; visible: boolean; priority: number };
type TileRequest = { view: DataView; context: RendererContext; ratio: PixelScale; layer: TileLayer; requestDraw: () => void };

// 完成したplot画像の再利用と生成順だけを管理する。点・色・軸の描画はCanvasRendererへ任せる。
class TiledCanvasRenderer {
    private tiles_ = new Map<string, PlotTile>();
    private tileBytes_ = 0;
    private tileView_: DataView | null = null;
    private tileContentKey_ = "";
    private tileLayer_: TileLayer | null = null;
    private tileFallback_: TileLayer | null = null;
    private tileRequest_: TileRequest | null = null;
    private tileJobs_: TileJob[] = [];
    private tilePending_: { job: TileJob; canvas: HTMLCanvasElement; context: RendererContext } | null = null;
    private tileBuilder_: CanvasRenderer | null = null;
    private tileFrame_: number | null = null;
    private tileTimer_: number | null = null;
    private tileGeneration_ = 0;
    private tilePrefetchDisabled_ = false;
    private tileFading_ = false;
    private tileBypass_: { view: DataView; key: string } | null = null;
    private previousPlot_: { canvas: HTMLCanvasElement; context: RendererContext } | null = null;
    private static readonly TILE_SIZE = 256;
    private static readonly TILE_BUDGET = 64 * 1024 * 1024;
    private static readonly TILE_FADE_MS = 120;

    constructor(private readonly renderer_: CanvasRenderer) {}

    private cancelTileJobs(): void {
        this.tileGeneration_++;
        if (this.tileFrame_ !== null) window.cancelAnimationFrame(this.tileFrame_);
        if (this.tileTimer_ !== null) window.clearTimeout(this.tileTimer_);
        this.tileFrame_ = this.tileTimer_ = null;
        this.tileFading_ = false;
        this.tileJobs_ = [];
        if (this.tilePending_) this.tilePending_.canvas.width = 1;
        this.tilePending_ = null;
        this.tileBuilder_?.cancelPendingRows();
    }

    clear(): void {
        this.cancelTileJobs();
        for (const tile of this.tiles_.values()) if (tile.canvas) tile.canvas.width = 1;
        this.tiles_.clear(); this.tileBytes_ = 0;
        if (this.previousPlot_) this.previousPlot_.canvas.width = 1;
        this.previousPlot_ = null;
        this.tileView_ = null; this.tileContentKey_ = "";
        this.tileLayer_ = this.tileFallback_ = null;
        this.tileRequest_ = null;
        this.tilePrefetchDisabled_ = false; this.tileBypass_ = null;
    }

    draw(canvas: HTMLCanvasElement, gridMap: GridMap, dataView: DataView | null, context: RendererContext,
        requestDraw?: () => void, options?: { tiled?: boolean }): void {
        const ratio = { x: canvas.width / canvas.clientWidth, y: canvas.height / canvas.clientHeight };
        const cacheKey = `${ratio.x},${ratio.y},${context.minPlotWidth},${context.minPlotHeight}|${context.scaleXLog},${context.scaleYLog}`;
        if (options?.tiled && this.tileBypass_?.view === dataView && this.tileBypass_.key === cacheKey) {
            this.renderer_.draw(canvas, gridMap, dataView, context, requestDraw); return;
        }
        const safe = [context.offsetX * ratio.x, context.offsetY * ratio.y].every(value => Number.isFinite(value) && Math.abs(value) < 2 ** 48) &&
            [scaleX(context.scaleXLog), scaleY(context.scaleYLog)].every(value => value > 0 && Number.isFinite(value));
        // softwareのCanvas合成は端数位置とclipで色が変わるため、既存の直接描画を保つ。
        if (options?.tiled && !(this.renderer_.rectRenderer instanceof RectRendererSoft) && requestDraw && dataView && typeof window !== "undefined" && typeof document !== "undefined" &&
            canvas.width > 0 && canvas.height > 0 && canvas.width * canvas.height * 4 <= 32 * 1024 * 1024 && safe &&
            context.width > this.renderer_.MARGIN_LEFT_ && context.height > this.renderer_.MARGIN_BOTTOM_) {
            if (this.drawTiles(canvas, gridMap, dataView, context, ratio, requestDraw)) {
                if (this.renderer_.isPreparingRows) this.renderer_.cancelRowPreparation();
                return;
            }
            // 初回や遠いjumpは従来描画を見せ、完成画像を後続のtile生成中にも使う。
            const rows = this.renderer_.draw(canvas, gridMap, dataView, context, requestDraw, { axes: false, smoothOverview: true });
            if (rows !== null) {
                if (canvas.width * canvas.height * 4 <= 16 * 1024 * 1024) {
                    const previous = this.previousPlot_?.canvas ?? document.createElement("canvas");
                    previous.width = canvas.width; previous.height = canvas.height;
                    previous.getContext("2d")!.drawImage(canvas, 0, 0);
                    this.previousPlot_ = { canvas: previous, context };
                }
                this.renderer_.drawAxes(canvas.getContext("2d")!, dataView, context);
            }
        } else {
            this.clear();
            this.renderer_.draw(canvas, gridMap, dataView, context, requestDraw);
        }
    }

    private tilePositions(request: TileRequest): TileJob[] {
        const { context: c, ratio: r, layer } = request, size = TiledCanvasRenderer.TILE_SIZE;
        const left = Math.floor((c.offsetX * r.x - layer.phaseX) / size), top = Math.floor((c.offsetY * r.y - layer.phaseY) / size);
        const right = Math.ceil(((c.offsetX + c.width - this.renderer_.MARGIN_LEFT_) * r.x - layer.phaseX) / size) - 1;
        const bottom = Math.ceil(((c.offsetY + c.height - this.renderer_.MARGIN_BOTTOM_) * r.y - layer.phaseY) / size) - 1;
        const jobs: TileJob[] = [];
        for (let y = top - 1; y <= bottom + 1; y++) for (let x = left - 1; x <= right + 1; x++) {
            const visible = x >= left && x <= right && y >= top && y <= bottom;
            jobs.push({ key: `${layer.key}|${x},${y}`, x, y, visible,
                priority: (visible ? 0 : 1e6) + (x - (left + right) / 2) ** 2 + (y - (top + bottom) / 2) ** 2 });
        }
        return jobs;
    }

    private drawTiles(canvas: HTMLCanvasElement, gridMap: GridMap, view: DataView, context: RendererContext,
        ratio: PixelScale, requestDraw: () => void): boolean {
        const contentKey = `${ratio.x},${ratio.y},${context.minPlotWidth},${context.minPlotHeight}`;
        if (this.tileView_ !== view || this.tileContentKey_ !== contentKey) {
            this.clear(); this.tileView_ = view; this.tileContentKey_ = contentKey;
        }
        const key = `${context.scaleXLog},${context.scaleYLog}`;
        if (this.tileLayer_?.key !== key) {
            this.capturePreviousTiles();
            this.cancelTileJobs();
            this.tilePrefetchDisabled_ = false;
            // 同じ倍率へ戻る時は以前の画素位相も再利用する。端数panは物理pixelへ揃えて貼る。
            this.tileLayer_ = Array.from(this.tiles_.values()).find(tile => tile.layer.key === key)?.layer ?? {
                key, sx: scaleX(context.scaleXLog), sy: scaleY(context.scaleYLog),
                phaseX: (context.offsetX - this.renderer_.MARGIN_LEFT_) * ratio.x - Math.round((context.offsetX - this.renderer_.MARGIN_LEFT_) * ratio.x),
                phaseY: context.offsetY * ratio.y - Math.round(context.offsetY * ratio.y)
            };
            // zoom中の中間倍率を大量生成せず、直前画像を使いながら終点を待つ。
            if (this.previousPlot_ || this.tileFallback_) this.tileTimer_ = window.setTimeout(() => {
                this.tileTimer_ = null; this.scheduleTiles();
            }, 80);
        }
        const request: TileRequest = { view, context, ratio, layer: this.tileLayer_, requestDraw };
        this.tileRequest_ = request;
        const positions = this.tilePositions(request), visible = positions.filter(job => job.visible);
        this.tileJobs_ = positions.filter(job => (job.visible || !this.tilePrefetchDisabled_) && !this.tiles_.has(job.key)).sort((a, b) => a.priority - b.priority);
        if (this.tilePending_ && !this.tileJobs_.some(job => job.key === this.tilePending_!.job.key)) {
            this.tileBuilder_?.cancelPendingRows(); this.tilePending_.canvas.width = 1; this.tilePending_ = null;
        }
        const now = performance.now();
        this.tileFading_ = visible.some(job => {
            const readyAt = this.tiles_.get(job.key)?.readyAt;
            return readyAt !== undefined && now - readyAt < TiledCanvasRenderer.TILE_FADE_MS;
        });
        this.scheduleTiles();
        const complete = !this.tileFading_ && visible.every(job => this.tiles_.has(job.key));
        if (!complete && !this.previousPlot_ && !this.tileFallback_) return false;
        const previous = this.previousPlot_, psx = previous ? request.layer.sx / scaleX(previous.context.scaleXLog) : 1;
        const psy = previous ? request.layer.sy / scaleY(previous.context.scaleYLog) : 1;
        const px = previous ? (this.renderer_.MARGIN_LEFT_ * (1 - psx) + previous.context.offsetX * psx - context.offsetX) * ratio.x : 0;
        const py = previous ? (previous.context.offsetY * psy - context.offsetY) * ratio.y : 0;
        if (!complete && !visible.some(job => this.tiles_.has(job.key))) {
            const area = (x0: number, y0: number, x1: number, y1: number) =>
                Math.max(0, Math.min(canvas.width, x1) - Math.max(this.renderer_.MARGIN_LEFT_ * ratio.x, x0)) *
                Math.max(0, Math.min((context.height - this.renderer_.MARGIN_BOTTOM_) * ratio.y, y1) - Math.max(0, y0));
            let fallbackArea = 0;
            for (const tile of this.tiles_.values()) if (tile.layer === this.tileFallback_) fallbackArea += area(...this.tileBounds(tile, request));
            const previousArea = previous ? area(px, py, px + previous.canvas.width * psx, py + previous.canvas.height * psy) : 0;
            // Konata同様、再利用画像がほぼ画面外へ出る大きなjumpは従来描画へ戻す。
            if (Math.max(previousArea, fallbackArea) < (context.width - this.renderer_.MARGIN_LEFT_) * (context.height - this.renderer_.MARGIN_BOTTOM_) * ratio.x * ratio.y * 0.25) return false;
        }
        const ctx = canvas.getContext("2d")!;
        ctx.save(); ctx.resetTransform();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#1c1e23"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!complete) {
            const drawPrevious = () => {
                if (!previous) return;
                // 縮小中の1pxの点をnearest-neighborで落とさず、軸の余白で外周tileを隠さない。
                ctx.imageSmoothingEnabled = psx !== 1 || psy !== 1;
                const left = this.renderer_.MARGIN_LEFT_ * ratio.x;
                const width = previous.canvas.width - left;
                const height = (previous.context.height - this.renderer_.MARGIN_BOTTOM_) * ratio.y;
                ctx.drawImage(previous.canvas, left, 0, width, height, px + left * psx, py, width * psx, height * psy);
            };
            const snapshotOnTop = previous && ((this.tileFallback_?.sx === scaleX(previous.context.scaleXLog) &&
                this.tileFallback_.sy === scaleY(previous.context.scaleYLog)) ||
                (previous.context.scaleXLog === context.scaleXLog && previous.context.scaleYLog === context.scaleYLog));
            if (!snapshotOnTop) drawPrevious();
            if (this.tileFallback_ && this.tileFallback_ !== request.layer) {
                for (const tile of this.tiles_.values()) if (tile.layer === this.tileFallback_) this.blitTile(ctx, tile, request);
            }
            // 完成viewportを優先する。大きなjump後の直接描画も、古い倍率のtileで上書きしない。
            if (snapshotOnTop) drawPrevious();
        }
        const tiles: PlotTile[] = [];
        for (const job of visible) {
            const tile = this.tiles_.get(job.key);
            if (!tile) continue;
            this.tiles_.delete(job.key); this.tiles_.set(job.key, tile);
            // 拡縮した旧画像と最小1pxの新しい点の密度差を、短時間で徐々に切り替える。
            ctx.globalAlpha = tile.readyAt === undefined ? 1 : Math.max(0, Math.min(1, (now - tile.readyAt) / TiledCanvasRenderer.TILE_FADE_MS));
            this.blitTile(ctx, tile, request); tiles.push(tile);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
        if (complete) {
            // 途中倍率の数枚だけで完成済みのfallbackを置き換えると、残りが空白に戻る。
            this.tileFallback_ = request.layer;
            this.tileGrid(gridMap, tiles, view, context);
        } else gridMap.drawnIndex = null;
        this.renderer_.drawAxes(ctx, view, context);
        return true;
    }

    private capturePreviousTiles(): void {
        const request = this.tileRequest_;
        if (!request) return;
        const visible = this.tilePositions(request).filter(job => job.visible);
        const now = performance.now();
        if (!visible.every(job => {
            const tile = this.tiles_.get(job.key);
            return tile && (tile.readyAt === undefined || now - tile.readyAt >= TiledCanvasRenderer.TILE_FADE_MS);
        })) return;
        const { context: c, ratio: r, layer } = request;
        // 最後の生成完了から再描画までの間にzoomが来ても、完成した倍率を使う。
        this.tileFallback_ = layer;
        const width = Math.round(c.width * r.x), height = Math.round(c.height * r.y);
        if (width * height * 4 > 16 * 1024 * 1024) return;
        // pan中は毎frameコピーせず、倍率変更時だけ最新の完成viewportを軸なしで保存する。
        const canvas = this.previousPlot_?.canvas ?? document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#1c1e23"; ctx.fillRect(0, 0, width, height);
        ctx.save(); ctx.beginPath();
        ctx.rect(this.renderer_.MARGIN_LEFT_ * r.x, 0, width - this.renderer_.MARGIN_LEFT_ * r.x,
            (c.height - this.renderer_.MARGIN_BOTTOM_) * r.y);
        ctx.clip();
        for (const job of visible) this.blitTile(ctx, this.tiles_.get(job.key)!, request);
        ctx.restore();
        // 保存画像は整数blit後なので、元の小数offsetではなく実際の画素位置を記録する。
        this.previousPlot_ = { canvas, context: { ...c,
            offsetX: (this.renderer_.MARGIN_LEFT_ * r.x + layer.phaseX -
                Math.round(this.renderer_.MARGIN_LEFT_ * r.x + layer.phaseX - c.offsetX * r.x)) / r.x,
            offsetY: (layer.phaseY - Math.round(layer.phaseY - c.offsetY * r.y)) / r.y } };
    }

    private tileBounds(tile: PlotTile, request: TileRequest): [number, number, number, number] {
        const size = TiledCanvasRenderer.TILE_SIZE, { layer, context: c, ratio: r } = request;
        const sx = layer.sx / tile.layer.sx, sy = layer.sy / tile.layer.sy;
        // 隣接tileの辺を同じ式で求め、端数DPRでも間に空白や1pxの伸縮を作らない。
        const x0 = Math.round(this.renderer_.MARGIN_LEFT_ * r.x + (tile.x * size + tile.layer.phaseX) * sx - c.offsetX * r.x);
        const y0 = Math.round((tile.y * size + tile.layer.phaseY) * sy - c.offsetY * r.y);
        const x1 = Math.round(this.renderer_.MARGIN_LEFT_ * r.x + ((tile.x + 1) * size + tile.layer.phaseX) * sx - c.offsetX * r.x);
        const y1 = Math.round(((tile.y + 1) * size + tile.layer.phaseY) * sy - c.offsetY * r.y);
        return [x0, y0, x1, y1];
    }

    private blitTile(ctx: CanvasRenderingContext2D, tile: PlotTile, request: TileRequest): void {
        const [x0, y0, x1, y1] = this.tileBounds(tile, request);
        if (x1 <= 0 || y1 <= 0 || x0 >= ctx.canvas.width || y0 >= ctx.canvas.height) return;
        ctx.imageSmoothingEnabled = tile.layer.sx !== request.layer.sx || tile.layer.sy !== request.layer.sy;
        if (tile.canvas) ctx.drawImage(tile.canvas, x0, y0, x1 - x0, y1 - y0);
        else { ctx.fillStyle = "#1c1e23"; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
    }

    private tileGrid(grid: GridMap, tiles: PlotTile[], view: DataView, c: RendererContext): void {
        const sx = scaleX(c.scaleXLog), sy = scaleY(c.scaleYLog), xStart = Math.floor(c.offsetX / sx), yStart = Math.floor(c.offsetY / sy);
        const cols = Math.ceil((c.offsetX + c.width - this.renderer_.MARGIN_LEFT_) / sx) - xStart;
        const rows = Math.ceil((c.offsetY + c.height - this.renderer_.MARGIN_BOTTOM_) / sy) - yStart;
        const width = Math.min(128, cols), height = Math.min(128, rows);
        if (grid.drawnIndex?.length !== width * height) grid.drawnIndex = new Int32Array(width * height);
        grid.drawnIndex.fill(-1);
        for (const tile of tiles) for (const row of tile.rows) {
            const col = view.getX(row) - xStart, y = view.getY(row) - yStart;
            if (col < 0 || col >= cols || y < 0 || y >= rows) continue;
            const cell = Math.floor(y * height / rows) * width + Math.floor(col * width / cols);
            grid.drawnIndex[cell] = Math.max(grid.drawnIndex[cell], row);
        }
    }

    private scheduleTiles(): void {
        if (this.tileFrame_ !== null || this.tileTimer_ !== null || !this.tileRequest_) return;
        const build = this.tileJobs_.length && !this.tileBuilder_?.isPreparingRows;
        // 未完了の行準備だけなら通知を待つ。画像の切替中だけは再描画を続ける。
        if (!build && !this.tileFading_) return;
        this.tileFrame_ = window.requestAnimationFrame(() => {
            this.tileFrame_ = null;
            if (build) this.renderTileBatch();
            else this.tileRequest_?.requestDraw();
        });
    }

    private renderTileBatch(): void {
        const request = this.tileRequest_;
        if (!request) return;
        const start = performance.now(), generation = this.tileGeneration_, size = TiledCanvasRenderer.TILE_SIZE;
        const builder = this.tileBuilder_ ??= new CanvasRenderer(this.renderer_.rectRenderer);
        builder.MARGIN_LEFT_ = builder.MARGIN_BOTTOM_ = 0;
        const visibleBatch = this.tileJobs_[0]?.visible, budget = visibleBatch ? 6 : 3, limit = visibleBatch ? 4 : 2;
        let count = 0, changed = false;
        while (count < limit && this.tileJobs_.length) {
            const job = this.tilePending_?.job ?? this.tileJobs_[0];
            if (count && job.visible !== visibleBatch) break;
            if (!this.tilePending_) {
                const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
                canvas.getContext("2d")!.setTransform(request.ratio.x, 0, 0, request.ratio.y, 0, 0);
                this.tilePending_ = { job, canvas, context: { ...request.context,
                    width: size / request.ratio.x, height: size / request.ratio.y,
                    offsetX: (job.x * size + request.layer.phaseX) / request.ratio.x,
                    offsetY: (job.y * size + request.layer.phaseY) / request.ratio.y } };
            }
            const pending = this.tilePending_;
            // タイル内の候補数は画面全体より少ない。同じ画素への重複は小さい範囲でもまとめる。
            const rows = builder.draw(pending.canvas, new GridMap(), request.view, pending.context, () => {
                if (generation === this.tileGeneration_ && this.tilePending_ === pending) this.scheduleTiles();
            }, { axes: false, aggregateSmallViews: true, smoothOverview: true });
            if (rows === null) break;
            const canvas = rows.length ? pending.canvas : null;
            if (!canvas) pending.canvas.width = 1;
            const tile: PlotTile = { layer: request.layer, x: job.x, y: job.y, canvas, rows,
                bytes: (canvas ? size * size * 4 : 128) + rows.byteLength,
                readyAt: job.visible && this.tileFallback_ && this.tileFallback_ !== request.layer && this.renderer_.rectRenderer instanceof RectRendererWebGL ? performance.now() : undefined };
            const visibleKeys = new Set(this.tilePositions(request).filter(position => position.visible).map(position => position.key));
            let visibleBytes = 0;
            for (const [key, cached] of this.tiles_) if (visibleKeys.has(key)) visibleBytes += cached.bytes;
            if (visibleBytes + tile.bytes > TiledCanvasRenderer.TILE_BUDGET) {
                if (canvas) canvas.width = 1;
                if (visibleKeys.has(job.key)) {
                    // 可視領域さえ予算に入らない場合、生成と追い出しを繰り返さず従来描画へ戻す。
                    const key = `${this.tileContentKey_}|${request.layer.key}`;
                    this.clear(); this.tileBypass_ = { view: request.view, key };
                    request.requestDraw(); return;
                }
                this.tilePrefetchDisabled_ = true; this.tilePending_ = null;
                builder.releasePreparedRows();
                this.tileJobs_ = this.tileJobs_.filter(next => next.visible);
                break;
            }
            this.tiles_.set(job.key, tile); this.tileBytes_ += tile.bytes;
            this.tilePending_ = null; builder.releasePreparedRows();
            this.tileJobs_ = this.tileJobs_.filter(next => next.key !== job.key);
            while (this.tileBytes_ > TiledCanvasRenderer.TILE_BUDGET || this.tiles_.size > 256) {
                const oldest = Array.from(this.tiles_.entries()).find(([key]) => !visibleKeys.has(key)) ?? this.tiles_.entries().next().value!;
                if (!visibleKeys.has(job.key) && oldest[1].layer === request.layer) {
                    this.tilePrefetchDisabled_ = true;
                    this.tileJobs_ = this.tileJobs_.filter(next => next.visible);
                }
                this.tiles_.delete(oldest[0]); this.tileBytes_ -= oldest[1].bytes;
                if (oldest[1].canvas) oldest[1].canvas.width = 1;
            }
            changed ||= visibleKeys.has(job.key); count++;
            if (performance.now() - start >= budget) break;
        }
        if (changed || this.tileFading_) request.requestDraw();
        this.scheduleTiles();
    }
}

export { TiledCanvasRenderer };
