import { CanvasRenderer, GridMap, scaleX, scaleY } from "./canvas_renderer";
import type { RendererContext } from "./canvas_renderer";
import type { DataView } from "./loader";
import { RectRendererSoft, RectRendererWebGL } from "./rect_renderer";

type PixelScale = { x: number; y: number };
type TileLayer = { key: string; sx: number; sy: number; phaseX: number; phaseY: number };
type PlotTile = { layer: TileLayer; x: number; y: number; canvas: HTMLCanvasElement | null; rows: Uint32Array; bytes: number };
type TileJob = { key: string; x: number; y: number; visible: boolean; priority: number };
type TileRequest = { view: DataView; context: RendererContext; ratio: PixelScale; layer: TileLayer; requestDraw: () => void };

// plot画像の生成・再利用・切替を管理する。点・色・軸の描画はCanvasRendererへ任せる。
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
    private tilePrefetchRange_ = "";
    private tileFading_ = false;
    private tileShownAt_: number | null = null;
    private tileZoomKey_ = "";
    private tileSettled_ = true;
    private tileZoomOrigin_: { x: number; y: number } | null = null;
    private tileBypass_: { view: DataView; key: string } | null = null;
    private previousPlot_: { canvas: HTMLCanvasElement; context: RendererContext; complete: boolean } | null = null;
    private displayedPlot_: { context: RendererContext; changed: boolean; complete: boolean;
        paint: (ctx: CanvasRenderingContext2D) => void; sources: Set<HTMLCanvasElement> } | null = null;
    private directCanvas_: HTMLCanvasElement | null = null;
    private directPlot_: { canvas: HTMLCanvasElement; context: RendererContext; ready: boolean; shownAt: number | null } | null = null;
    private static readonly TILE_SIZE = 256;
    private static readonly TILE_BUDGET = 64 * 1024 * 1024;
    private static readonly TILE_FADE_MS = 120;

    constructor(private readonly renderer_: CanvasRenderer) {}

    private cancelTileJobs(keepTimer = false): void {
        this.tileGeneration_++;
        if (this.tileFrame_ !== null) window.cancelAnimationFrame(this.tileFrame_);
        if (!keepTimer && this.tileTimer_ !== null) window.clearTimeout(this.tileTimer_);
        this.tileFrame_ = null;
        if (!keepTimer) this.tileTimer_ = null;
        this.tileFading_ = false;
        this.tileJobs_ = [];
        if (this.tilePending_) this.tilePending_.canvas.width = 1;
        this.tilePending_ = null;
        this.tileBuilder_?.cancelPendingRows();
    }

    clear(): void {
        this.cancelTileJobs();
        if (this.directPlot_ && !this.directPlot_.ready) this.renderer_.cancelRowPreparation();
        for (const tile of this.tiles_.values()) if (tile.canvas) tile.canvas.width = 1;
        this.tiles_.clear(); this.tileBytes_ = 0;
        if (this.previousPlot_) this.previousPlot_.canvas.width = 1;
        this.previousPlot_ = null;
        this.displayedPlot_ = null;
        if (this.directCanvas_) this.directCanvas_.width = 1;
        this.directCanvas_ = null; this.directPlot_ = null;
        this.tileView_ = null; this.tileContentKey_ = "";
        this.tileLayer_ = this.tileFallback_ = null;
        this.tileRequest_ = null;
        this.tileShownAt_ = null; this.tileZoomKey_ = ""; this.tileSettled_ = true;
        this.tileZoomOrigin_ = null;
        this.tilePrefetchDisabled_ = false; this.tilePrefetchRange_ = ""; this.tileBypass_ = null;
    }

    draw(canvas: HTMLCanvasElement, gridMap: GridMap, dataView: DataView | null, context: RendererContext,
        requestDraw?: () => void, options?: { tiled?: boolean }): void {
        const ratio = { x: canvas.width / canvas.clientWidth, y: canvas.height / canvas.clientHeight };
        const cacheKey = `${ratio.x},${ratio.y},${context.minPlotWidth},${context.minPlotHeight}|${this.zoomKey(context.scaleXLog, context.scaleYLog)}`;
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
                if (this.renderer_.isPreparingRows && (!this.directPlot_ || this.directPlot_.ready)) this.renderer_.cancelRowPreparation();
                return;
            }
            // 初回や保存上限を超えるcanvasは直接描画し、保存できる完成画像は後続にも使う。
            const rows = this.renderer_.draw(canvas, gridMap, dataView, context, requestDraw, { axes: false, smoothOverview: true });
            if (rows !== null) {
                if (canvas.width * canvas.height * 4 <= 16 * 1024 * 1024) {
                    const previous = this.previousPlot_?.canvas ?? document.createElement("canvas");
                    previous.width = canvas.width; previous.height = canvas.height;
                    previous.getContext("2d")!.drawImage(canvas, 0, 0);
                    this.previousPlot_ = { canvas: previous, context, complete: true };
                }
                this.renderer_.drawAxes(canvas.getContext("2d")!, dataView, context);
                this.displayedPlot_ = null;
            }
        } else {
            this.clear();
            this.renderer_.draw(canvas, gridMap, dataView, context, requestDraw);
        }
    }

    private zoomKey(x: number, y: number): string {
        // ホイールの往復で生じる丸め誤差だけを吸収し、同じ倍率のcacheを分断しない。
        return `${x.toFixed(9)},${y.toFixed(9)}`;
    }

    private tileRange(request: TileRequest, layer = request.layer) {
        const { context: c, ratio: r } = request, size = TiledCanvasRenderer.TILE_SIZE;
        const sx = layer.sx / scaleX(c.scaleXLog), sy = layer.sy / scaleY(c.scaleYLog);
        const left = Math.floor((c.offsetX * r.x * sx - layer.phaseX) / size), top = Math.floor((c.offsetY * r.y * sy - layer.phaseY) / size);
        const right = Math.ceil(((c.offsetX + c.width - this.renderer_.MARGIN_LEFT_) * r.x * sx - layer.phaseX) / size) - 1;
        const bottom = Math.ceil(((c.offsetY + c.height - this.renderer_.MARGIN_BOTTOM_) * r.y * sy - layer.phaseY) / size) - 1;
        return { left, top, right, bottom, sx, sy };
    }

    private layerCovers(request: TileRequest, layer: TileLayer): boolean {
        const { left, top, right, bottom } = this.tileRange(request, layer);
        // 深い拡大のlayerをFitへ投影すると数億枚にもなる。保持数を超える候補は列挙しない。
        if ((right - left + 1) * (bottom - top + 1) > this.tiles_.size) return false;
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (!this.tiles_.has(`${layer.key}|${x},${y}`)) return false;
        return true;
    }

    private tilePositions(request: TileRequest): TileJob[] {
        const { context: c, ratio: r, layer } = request, size = TiledCanvasRenderer.TILE_SIZE;
        const { left, top, right, bottom, sx, sy } = this.tileRange(request);
        // 外周1枚だけでは広い画面の縮小に足りない。各辺にplotの半幅・半高さを備え、
        // 中央で1/2へ縮小する時や端での1段階zoomに旧倍率の画像を再利用する。
        // 可視tileを先に作り、先読みの保持量は既存の64MiB・256項目で制限する。
        const marginX = Math.max(1, Math.ceil((c.width - this.renderer_.MARGIN_LEFT_) * r.x * sx / (2 * size)));
        const marginY = Math.max(1, Math.ceil((c.height - this.renderer_.MARGIN_BOTTOM_) * r.y * sy / (2 * size)));
        const jobs: TileJob[] = [];
        for (let y = top - marginY; y <= bottom + marginY; y++) for (let x = left - marginX; x <= right + marginX; x++) {
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
        const zoomKey = this.zoomKey(context.scaleXLog, context.scaleYLog);
        if (this.tileZoomKey_ && this.tileZoomKey_ !== zoomKey) {
            const previous = this.tileRequest_?.context ?? this.previousPlot_?.context ?? context;
            if (this.tileSettled_) this.tileZoomOrigin_ = { x: previous.scaleXLog, y: previous.scaleYLog };
            this.tileSettled_ = false;
            if (this.tileTimer_ !== null) window.clearTimeout(this.tileTimer_);
            // 操作中は1.3倍刻みの画像を生成し、表示自体は連続して拡縮する。
            // 各animation frameの倍率で生成を捨てず、停止後だけ正確な倍率へ仕上げる。
            this.tileTimer_ = window.setTimeout(() => {
                this.tileTimer_ = null; this.tileSettled_ = true; requestDraw();
            }, 140);
        }
        this.tileZoomKey_ = zoomKey;
        const step = this.renderer_.ZOOM_STEP_LOG_;
        const cached = Array.from(this.tiles_.values()).find(tile => tile.layer.key === zoomKey)?.layer;
        const cachedComplete = cached && this.layerCovers({ view, context, ratio, layer: cached, requestDraw }, cached);
        // 操作開始時の縦横倍率を基準にし、一様zoomで両軸の生成境界を揃える。
        // 半段の境界で片方だけ下へ丸まらないよう、logの微小な誤差も吸収する。
        const origin = this.tileZoomOrigin_;
        const level = (value: number, start: number) => start + Math.round((value - start) / step + 1e-10) * step;
        const xLog = this.tileSettled_ || cachedComplete ? context.scaleXLog : level(context.scaleXLog, origin!.x);
        const yLog = this.tileSettled_ || cachedComplete ? context.scaleYLog : level(context.scaleYLog, origin!.y);
        const key = this.zoomKey(xLog, yLog);
        if (this.tileLayer_?.key !== key) {
            this.capturePreviousTiles();
            this.cancelTileJobs(true);
            this.tileShownAt_ = null;
            this.directPlot_ = null;
            this.tilePrefetchDisabled_ = false;
            const px = (context.offsetX * Math.exp(xLog - context.scaleXLog) - this.renderer_.MARGIN_LEFT_) * ratio.x;
            const py = context.offsetY * Math.exp(yLog - context.scaleYLog) * ratio.y;
            // 同じ倍率へ戻る時は以前の画素位相も再利用する。端数panは物理pixelへ揃えて貼る。
            this.tileLayer_ = Array.from(this.tiles_.values()).find(tile => tile.layer.key === key)?.layer ?? {
                key, sx: scaleX(xLog), sy: scaleY(yLog),
                phaseX: px - Math.round(px), phaseY: py - Math.round(py)
            };
        }
        const request: TileRequest = { view, context, ratio, layer: this.tileLayer_, requestDraw };
        const positions = this.tilePositions(request), visible = positions.filter(job => job.visible);
        const ready = visible.every(job => this.tiles_.has(job.key));
        if (!ready && this.displayedPlot_?.complete && this.displayedPlot_.changed) this.capturePreviousTiles();
        this.tileRequest_ = request;
        const prefetchRange = `${positions[0].key}|${positions[positions.length - 1].key}`;
        // 同じ範囲での予算超過は再試行しない。pan・resizeで対象が変われば先読みを再開する。
        if (this.tilePrefetchRange_ !== prefetchRange) {
            this.tilePrefetchRange_ = prefetchRange; this.tilePrefetchDisabled_ = false;
        }
        this.tileJobs_ = positions.filter(job => (job.visible || !this.tilePrefetchDisabled_) && !this.tiles_.has(job.key)).sort((a, b) => a.priority - b.priority);
        if (this.tilePending_) {
            const next = this.tileJobs_.find(job => job.key === this.tilePending_!.job.key);
            // zoom中やpanで可視範囲が変わったら先読みの準備を中断して可視tileへ譲る。
            // 準備中のtile自体が可視になった場合は同じ座標の結果を引き継ぐ。
            if (!next || (!next.visible && (!this.tileSettled_ || this.tileJobs_.some(job => job.visible)))) {
                this.tileBuilder_?.cancelPendingRows(); this.tilePending_.canvas.width = 1; this.tilePending_ = null;
            } else this.tilePending_.job = next;
        }
        const now = performance.now();
        if (ready && this.tileShownAt_ === null) {
            if (this.directPlot_?.ready) {
                this.capturePreviousTiles(); this.directPlot_ = null;
            }
            const sameImage = this.previousPlot_?.complete && this.zoomKey(this.previousPlot_.context.scaleXLog, this.previousPlot_.context.scaleYLog) === key;
            this.tileShownAt_ = this.previousPlot_ && !sameImage &&
                this.renderer_.rectRenderer instanceof RectRendererWebGL ? now : -Infinity;
        }
        this.tileFading_ = this.tileShownAt_ !== null && now - this.tileShownAt_ < TiledCanvasRenderer.TILE_FADE_MS;
        this.scheduleTiles();
        const complete = ready && !this.tileFading_;
        if (!complete && !this.previousPlot_ && !this.tileFallback_) return false;
        const previous = this.previousPlot_, psx = previous ? scaleX(context.scaleXLog) / scaleX(previous.context.scaleXLog) : 1;
        const psy = previous ? scaleY(context.scaleYLog) / scaleY(previous.context.scaleYLog) : 1;
        const px = previous ? (this.renderer_.MARGIN_LEFT_ * (1 - psx) + previous.context.offsetX * psx - context.offsetX) * ratio.x : 0;
        const py = previous ? (previous.context.offsetY * psy - context.offsetY) * ratio.y : 0;
        if (!ready) {
            const area = (x0: number, y0: number, x1: number, y1: number) =>
                Math.max(0, Math.min(canvas.width, x1) - Math.max(this.renderer_.MARGIN_LEFT_ * ratio.x, x0)) *
                Math.max(0, Math.min((context.height - this.renderer_.MARGIN_BOTTOM_) * ratio.y, y1) - Math.max(0, y0));
            let fallbackArea = 0;
            for (const tile of this.tiles_.values()) if (tile.layer === this.tileFallback_) fallbackArea += area(...this.tileBounds(tile, request));
            const previousArea = previous ? area(px, py, px + previous.canvas.width * psx, py + previous.canvas.height * psy) : 0;
            if (Math.max(previousArea, fallbackArea) < (context.width - this.renderer_.MARGIN_LEFT_) * (context.height - this.renderer_.MARGIN_BOTTOM_) * ratio.x * ratio.y * 0.25) {
                if (!previous || !(this.renderer_.rectRenderer instanceof RectRendererWebGL) || canvas.width * canvas.height * 4 > 16 * 1024 * 1024) return false;
                // 大きな縮小の直接fallbackも別canvasで準備し、既存画像からfadeする。
                // 全viewportのrasterと2×2平均を急ぐと、tileの枚数制限とは別にUIを止める。
                // 暫定画像の画素数も1tile分までとし、完成tileは元の解像度で生成する。
                if (!this.directPlot_) {
                    const image = this.directCanvas_ ??= document.createElement("canvas");
                    const pixels = TiledCanvasRenderer.TILE_SIZE ** 2;
                    const shrink = Math.min(1, Math.sqrt(pixels / (canvas.width * canvas.height)));
                    image.width = Math.max(1, Math.min(pixels, Math.floor(canvas.width * shrink)));
                    image.height = Math.max(1, Math.min(pixels, Math.floor(canvas.height * shrink)));
                    image.getContext("2d")!.setTransform(image.width / context.width, 0, 0, image.height / context.height, 0, 0);
                    this.directPlot_ = { canvas: image, context, ready: false, shownAt: null };
                }
            }
        }
        const direct = this.directPlot_;
        if (!ready && direct && !direct.ready) {
            direct.ready = this.renderer_.draw(direct.canvas, null, view, direct.context, requestDraw,
                { axes: false, smoothOverview: true }) !== null;
            if (direct.ready) direct.shownAt = now;
        }
        let directAlpha = 0;
        if (!ready && direct?.ready) {
            directAlpha = Math.max(0, Math.min(1, (now - direct.shownAt!) / TiledCanvasRenderer.TILE_FADE_MS));
            this.tileFading_ ||= directAlpha < 1;
        }
        this.scheduleTiles();
        const tiles: PlotTile[] = [];
        // 一部だけ残ったcacheを突然貼らず、可視画像が揃ってから全体を切り替える。
        // 開始時刻は生成時でなく表示時なので、再訪したcacheにも同じfadeがかかる。
        // 表示開始後の縮小で外周が未生成になっても、既に見せたtileを撤回しない。
        for (const job of this.tileShownAt_ !== null ? visible : []) {
            const tile = this.tiles_.get(job.key);
            if (!tile) continue;
            this.tiles_.delete(job.key); this.tiles_.set(job.key, tile);
            tiles.push(tile);
        }
        const fallback = !complete && this.tileFallback_ && (this.tileFallback_ !== request.layer || this.tileShownAt_ !== null) ?
            Array.from(this.tiles_.values()).filter(tile => {
                    if (tile.layer !== this.tileFallback_) return false;
                    const [x0, y0, x1, y1] = this.tileBounds(tile, request);
                    return x1 > 0 && y1 > 0 && x0 < canvas.width && y0 < canvas.height;
                }) : [];
        const alpha = this.tileShownAt_ === null ? 1 : Math.max(0, Math.min(1, (now - this.tileShownAt_) / TiledCanvasRenderer.TILE_FADE_MS));
        const width = canvas.width, height = canvas.height;
        // 軸を描いたmain canvasは保存しない。表示に使った画像・座標・alphaを固定して
        // 必要な時だけ同じplotを再合成する。グリッド線の拡大や毎frameの画像コピーを避ける。
        const paint = (ctx: CanvasRenderingContext2D) => {
            ctx.save(); ctx.resetTransform(); ctx.globalAlpha = 1;
            ctx.fillStyle = "#1c1e23"; ctx.fillRect(0, 0, width, height);
            if (!complete) {
                for (const tile of fallback) this.blitTile(ctx, tile, request);
                if (previous) this.blitPlot(ctx, previous, request);
            }
            if (directAlpha > 0 && direct) {
                ctx.globalAlpha = directAlpha; this.blitPlot(ctx, direct, request);
            }
            ctx.globalAlpha = alpha;
            for (const tile of tiles) this.blitTile(ctx, tile, request);
            ctx.globalAlpha = 1; ctx.restore();
        };
        const ctx = canvas.getContext("2d")!;
        paint(ctx);
        const native = Math.abs(Math.log(request.layer.sx) - context.scaleXLog) < 1e-12 &&
            Math.abs(Math.log(request.layer.sy) - context.scaleYLog) < 1e-12;
        if (complete) {
            // 途中倍率の数枚だけで完成済みのfallbackを置き換えると、残りが空白に戻る。
            this.tileFallback_ = request.layer;
            if (native) this.tileGrid(gridMap, tiles, view, context);
            else gridMap.drawnIndex = null;
        } else gridMap.drawnIndex = null;
        this.renderer_.drawAxes(ctx, view, context);
        const displayedContext = complete && native ? { ...context,
            offsetX: (this.renderer_.MARGIN_LEFT_ * ratio.x + request.layer.phaseX -
                Math.round(this.renderer_.MARGIN_LEFT_ * ratio.x + request.layer.phaseX - context.offsetX * ratio.x)) / ratio.x,
            offsetY: (request.layer.phaseY - Math.round(request.layer.phaseY - context.offsetY * ratio.y)) / ratio.y } : context;
        this.displayedPlot_ = { context: displayedContext, paint,
            sources: new Set([...fallback, ...tiles].flatMap(tile => tile.canvas ? [tile.canvas] : [])
                .concat(!complete && previous ? [previous.canvas] : [], directAlpha > 0 && direct ? [direct.canvas] : [])),
            changed: directAlpha > 0 || (tiles.length > 0 && this.tileShownAt_ !== null && now > this.tileShownAt_),
            // 低解像度の直接画像は同じ倍率でも暫定扱いにし、完成tileへのfadeを省略しない。
            complete: complete && native };
        return true;
    }

    private capturePreviousTiles(): void {
        const request = this.tileRequest_;
        if (!request) return;
        const visible = this.tilePositions(request).filter(job => job.visible);
        const complete = visible.every(job => this.tiles_.has(job.key)) && !this.tileFading_ && (this.tileShownAt_ !== null ||
            (this.previousPlot_?.complete && this.zoomKey(this.previousPlot_.context.scaleXLog, this.previousPlot_.context.scaleYLog) === request.layer.key));
        const { ratio: r, layer } = request;
        // 最後の生成完了から再描画までの間にzoomが来ても、完成した倍率を使う。
        if (complete) this.tileFallback_ = layer;
        const displayed = this.displayedPlot_;
        if (!displayed?.changed) return;
        const c = displayed.context;
        const width = Math.round(c.width * r.x), height = Math.round(c.height * r.y);
        if (width * height * 4 > 16 * 1024 * 1024) return;
        // 合成元に旧snapshot自身が含まれるので、別canvasへ作ってから入れ替える。
        // 単なる旧画像の拡縮は保存せず、再サンプリングの積み重ねを避ける。
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        displayed.paint(ctx);
        if (this.previousPlot_) this.previousPlot_.canvas.width = 1;
        this.previousPlot_ = { canvas, complete: displayed.complete, context: c };
        displayed.changed = false;
    }

    private blitPlot(ctx: CanvasRenderingContext2D, plot: { canvas: HTMLCanvasElement; context: RendererContext }, request: TileRequest): void {
        const { context: c, ratio: r } = request;
        const sx = Math.exp(c.scaleXLog - plot.context.scaleXLog), sy = Math.exp(c.scaleYLog - plot.context.scaleYLog);
        const sourceRatio = { x: plot.canvas.width / plot.context.width, y: plot.canvas.height / plot.context.height };
        const left = this.renderer_.MARGIN_LEFT_ * sourceRatio.x, width = plot.canvas.width - left;
        const height = (plot.context.height - this.renderer_.MARGIN_BOTTOM_) * sourceRatio.y;
        // 薄い点が縮小で落ちないよう補間し、軸の余白が外周tileを隠さないようplotだけ貼る。
        // 暫定画像は表示canvasと解像度が異なるため、srcとdstの画素比を別々に使う。
        ctx.imageSmoothingEnabled = sx * r.x !== sourceRatio.x || sy * r.y !== sourceRatio.y;
        ctx.drawImage(plot.canvas, left, 0, width, height,
            this.renderer_.MARGIN_LEFT_ * r.x + (plot.context.offsetX * sx - c.offsetX) * r.x, (plot.context.offsetY * sy - c.offsetY) * r.y,
            (plot.context.width - this.renderer_.MARGIN_LEFT_) * r.x * sx, (plot.context.height - this.renderer_.MARGIN_BOTTOM_) * r.y * sy);
    }

    private tileBounds(tile: PlotTile, request: TileRequest): [number, number, number, number] {
        const size = TiledCanvasRenderer.TILE_SIZE, { context: c, ratio: r } = request;
        const sx = scaleX(c.scaleXLog) / tile.layer.sx, sy = scaleY(c.scaleYLog) / tile.layer.sy;
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
        ctx.imageSmoothingEnabled = tile.layer.sx !== scaleX(request.context.scaleXLog) || tile.layer.sy !== scaleY(request.context.scaleYLog);
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
        if (this.tileFrame_ !== null || !this.tileRequest_) return;
        // zoom中は可視tileだけ進める。先読みは停止後に再開し、入力・合成の時間を残す。
        const build = this.tileJobs_.length && (this.tileJobs_[0].visible || this.tileSettled_) && !this.tileBuilder_?.isPreparingRows;
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
        if (!request || (!this.tileJobs_[0]?.visible && !this.tileSettled_)) return;
        const start = performance.now(), generation = this.tileGeneration_, size = TiledCanvasRenderer.TILE_SIZE;
        const builder = this.tileBuilder_ ??= new CanvasRenderer(this.renderer_.rectRenderer);
        builder.MARGIN_LEFT_ = builder.MARGIN_BOTTOM_ = 0;
        // 軽いtileは同じframeで進め、操作中は入力・合成へ時間を残す。
        // 停止後は予算を広げて仕上げる。1枚の描画・転送は途中で止められないため、
        // 時間は終了後に判定する目安とし、空tile等にも枚数の上限を設ける。
        const visibleBatch = this.tileJobs_[0]?.visible;
        const budget = this.tileSettled_ ? (visibleBatch ? 6 : 3) : 2;
        const limit = this.tileSettled_ ? (visibleBatch ? 8 : 4) : 2;
        // 同じbatch内では表示範囲が変わらない。範囲検索と集合の生成は1回で済ませる。
        const positions = this.tilePositions(request);
        const visibleKeys = new Set(positions.filter(position => position.visible).map(position => position.key));
        const wantedKeys = new Set(positions.map(position => position.key));
        let visibleBytes = 0;
        for (const [key, cached] of this.tiles_) if (visibleKeys.has(key)) visibleBytes += cached.bytes;
        let count = 0, changed = false;
        while (count < limit && this.tileJobs_.length) {
            const job = this.tilePending_?.job ?? this.tileJobs_[0];
            // 可視tileの完了後は一度表示へ譲り、先読みを同じframeに積み増さない。
            if (count && job.visible !== visibleBatch) break;
            if (!this.tilePending_) {
                const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
                canvas.getContext("2d")!.setTransform(request.ratio.x, 0, 0, request.ratio.y, 0, 0);
                this.tilePending_ = { job, canvas, context: { ...request.context,
                    scaleXLog: Math.log(request.layer.sx), scaleYLog: Math.log(request.layer.sy),
                    width: size / request.ratio.x, height: size / request.ratio.y,
                    offsetX: (job.x * size + request.layer.phaseX) / request.ratio.x,
                    offsetY: (job.y * size + request.layer.phaseY) / request.ratio.y } };
            }
            const pending = this.tilePending_;
            // タイル内の候補数は画面全体より少ない。同じ画素への重複は小さい範囲でもまとめる。
            const rows = builder.draw(pending.canvas, null, request.view, pending.context, () => {
                if (generation === this.tileGeneration_ && this.tilePending_ === pending) this.scheduleTiles();
            }, { axes: false, aggregateSmallViews: true, smoothOverview: true });
            if (rows === null) break;
            const canvas = rows.length ? pending.canvas : null;
            if (!canvas) pending.canvas.width = 1;
            const tile: PlotTile = { layer: request.layer, x: job.x, y: job.y, canvas, rows,
                bytes: (canvas ? size * size * 4 : 128) + rows.byteLength };
            if (visibleBytes + tile.bytes > TiledCanvasRenderer.TILE_BUDGET) {
                if (canvas) canvas.width = 1;
                if (visibleKeys.has(job.key)) {
                    // 可視領域さえ予算に入らない場合、生成と追い出しを繰り返さず従来描画へ戻す。
                    const key = `${this.tileContentKey_}|${this.zoomKey(request.context.scaleXLog, request.context.scaleYLog)}`;
                    this.clear(); this.tileBypass_ = { view: request.view, key };
                    request.requestDraw(); return;
                }
                this.tilePrefetchDisabled_ = true; this.tilePending_ = null;
                builder.releasePreparedRows();
                this.tileJobs_ = this.tileJobs_.filter(next => next.visible);
                break;
            }
            this.tiles_.set(job.key, tile); this.tileBytes_ += tile.bytes;
            if (visibleKeys.has(job.key)) visibleBytes += tile.bytes;
            this.tilePending_ = null; builder.releasePreparedRows();
            this.tileJobs_ = this.tileJobs_.filter(next => next.key !== job.key);
            while (this.tileBytes_ > TiledCanvasRenderer.TILE_BUDGET || this.tiles_.size > 256) {
                // 同倍率でも以前の画面の外周は先に解放する。必要な外周を追い出した時だけ
                // 先読みを止め、広げた範囲の生成と追い出しが循環するのを防ぐ。
                const entries = Array.from(this.tiles_.entries());
                const oldest = entries.find(([key]) => !wantedKeys.has(key)) ?? entries.find(([key]) => !visibleKeys.has(key)) ?? entries[0];
                // 最後の合成で使った画像は解放前に保存し、次のzoomで消去済みcanvasを読まない。
                if (oldest[1].canvas && this.displayedPlot_?.sources.has(oldest[1].canvas)) this.capturePreviousTiles();
                if (!visibleKeys.has(job.key) && wantedKeys.has(oldest[0])) {
                    this.tilePrefetchDisabled_ = true;
                    this.tileJobs_ = this.tileJobs_.filter(next => next.visible);
                }
                this.tiles_.delete(oldest[0]); this.tileBytes_ -= oldest[1].bytes;
                if (visibleKeys.has(oldest[0])) visibleBytes -= oldest[1].bytes;
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
