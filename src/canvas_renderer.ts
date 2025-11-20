// canvas_renderer.ts
import { Loader, DataView } from "./loader";
import { RectRendererSoft, RectRendererWebGL } from "./rect_renderer";

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

class CanvasRenderer {
    MARGIN_LEFT_ = 50;
    MARGIN_BOTTOM_ = 20;
    BASE_HEIGHT_ = 1000;
    ZOOM_STEP_LOG_ = Math.log(1.3); // 対数ズーム量

    rectRenderer: RectRendererSoft|RectRendererWebGL;

    constructor() {
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


    draw(canvas: HTMLCanvasElement, gridMap: GridMap, dataView: DataView | null, renderCtx: RendererContext) {
        let canvasCtx = canvas.getContext("2d")!;
        if (!canvasCtx) return;

        // let startTime = (new Date()).getTime();

        const { width, height, offsetX, offsetY } = renderCtx;
        const scaleXVal = scaleX(renderCtx.scaleXLog);
        const scaleYVal = scaleY(renderCtx.scaleYLog);

        this.clear(canvasCtx, renderCtx);

        if (!dataView) return;

        // プロット領域がサイズ０となると色々壊れるのでリターン
        const plotHeight = Math.max(height - this.MARGIN_BOTTOM_, 0);
        const plotWidth = Math.max(width - this.MARGIN_LEFT_, 0);
        if (plotHeight <= 0 || plotWidth <= 0) return;

        // 表示セル数
        const visibleCols = Math.ceil(plotWidth / scaleXVal);
        const visibleRows = Math.ceil(plotHeight / scaleYVal);

        // グリッドの上限を設定
        const MAX_RES = 128;
        const gridCols = Math.min(visibleCols, MAX_RES);
        const gridRows = Math.min(visibleRows, MAX_RES);

        // 1ピクセルに描画される論理高さ
        const ratioY = 1 / scaleYVal; 

        // データ描画用ピクセルサイズ
        const pxW = Math.max(scaleXVal, renderCtx.minPlotWidth);
        const pxH = Math.max(scaleYVal, renderCtx.minPlotHeight);

        // 描画セルの start/end インデックス
        const xStart = Math.floor((offsetX - this.MARGIN_LEFT_) / scaleXVal);
        const yStart = Math.floor(offsetY / scaleYVal);
        const startIdx = dataView.getStartIdx(xStart, yStart);
        const endIdx   = dataView.getEndIdx(xStart + visibleCols - 1, yStart + visibleRows - 1);

        // drawnIndex を gridCols × gridRows で初期化
        if (gridMap.drawnIndex?.length != gridCols * gridRows) {
            gridMap.drawnIndex = new Int32Array(gridCols * gridRows).fill(-1);
        }
        else {
            gridMap.drawnIndex.fill(-1);
        }

        const gridColRatio = gridCols / visibleCols;
        const gridRowRatio = gridRows / visibleRows;

        // 描画まびき
        // X 方向の密度に応じても間引き量をかえる
        const avgNumPointX = (dataView.getEndIdx(Infinity,Infinity) - dataView.getStartIdx(-Infinity, -Infinity) + 1) / (dataView.getMaxY() - dataView.getMinY() + 1);
        let step = Math.max(1, Math.floor(ratioY * avgNumPointX / 4 / 32));

        if (endIdx - startIdx < 100000) step = 1; // 少ない場合は間引かない

        // データ描画＆インデックス記録
        this.rectRenderer.beginRawMode(canvas, scaleYVal);

        let colorPalette = dataView.getPalette();

        for (let i = startIdx; i <= endIdx; i += step) {
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
            // モアレを軽減するために適当にノイズを乗せる
            if (step > 1) {
                i += ((((i * 17) >> 5) ^ ((i * 31) >> 10)) & 7) == 0 ? 1 : 0;
            }
        }
        this.rectRenderer.endRawMode();

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
        const visibleCols = Math.ceil((renderCtx.width - this.MARGIN_LEFT_) / scaleXVal);
        const visibleRows = Math.ceil(plotHeight / scaleYVal);

        // 最大解像度制限
        const MAX_RES = 128;
        const gridCols = Math.min(visibleCols, MAX_RES);
        const gridRows = Math.min(visibleRows, MAX_RES);

        const xStart = Math.floor((renderCtx.offsetX - this.MARGIN_LEFT_) / scaleXVal);
        const yStart = Math.floor(renderCtx.offsetY / scaleYVal);

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

        const SAFE_MIN = 1e-6;
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
