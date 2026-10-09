/// <reference lib="dom" />
// 上記がないと，なぜか worker と解釈されてしまう

// タイル原点の減算で生じる微小誤差を半画素境界で吸収し、描画位置と集約を揃える。
function pixelEdge(value: number): number { return Math.ceil(value - 0.5 - 1e-9); }

class RectRendererWebGL {

    // DOM/CSS 次元
    private imageHeightDOM_: number = 0;
    private imageWidthDOM_: number = 0;
    private imageHeightCSS_: number = 0;
    private imageWidthCSS_: number = 0;

    // 2D は合成と細い点の画素描画に使用
    private ctx2d_: CanvasRenderingContext2D | null = null;

    // CSS→DOM 変換用スケール
    private imageWidthScale_: number = 0;
    private imageHeightScale_: number = 0;

    // 直近状態（2D の状態変更を最小化）
    private fillStylePrev: string = "";
    private fillHuePrev: number = -1;

    // WebGL2 用オフスクリーン（DOM ピクセルサイズ）
    private overlayCanvas_: HTMLCanvasElement | null = null;
    private gl_: WebGL2RenderingContext | null = null;

    // GL リソース
    private program_: WebGLProgram | null = null;
    private attrib_a_unit_: number = 0;  // layout(location=0)
    private attrib_a_pos_: number = 1;   // layout(location=1)
    private attrib_a_size_: number = 2;  // layout(location=2)
    private attrib_a_color_: number = 3; // layout(location=3)
    private uniform_u_resolution_: WebGLUniformLocation | null = null;
    private bufUnit_: WebGLBuffer | null = null;  // 単位クアッド（6頂点）
    private bufPos_: WebGLBuffer | null = null;   // インスタンス左上 (x,y)
    private bufSize_: WebGLBuffer | null = null;  // インスタンス幅高 (w,h)
    private bufColor_: WebGLBuffer | null = null; // インスタンス色 (rgba u8)

    // バッチ用ワーク
    private rawMode_: boolean = false;
    private rasterMode_: boolean = false;
    private rasterImage_: ImageData | null = null;
    private rasterPixels_: Uint32Array | null = null;
    private rasterSamples_: 1 | 2 = 1;
    private rasterOutput_: ImageData | null = null;
    private cap_: number = 0;
    private count_: number = 0;
    private pos_: Float32Array = new Float32Array(0);
    private size_: Float32Array = new Float32Array(0);
    private color_: Uint32Array = new Uint32Array(0); // RGBA（各 0..255）

    constructor() {
    }

    init() {
        this.overlayCanvas_ = document.createElement("canvas");
        const gl = this.overlayCanvas_.getContext("webgl2", {
            alpha: true,
            antialias: false,
            preserveDrawingBuffer: true
        }) as WebGL2RenderingContext | null;
        if (!gl) {
            return false;
        }
        this.gl_ = gl;
        this.initGL_();
        return true;
    }

    // 公開 API（clientWidth/Height は 2D が初期化済みの時のみ有効）
    get clientWidth(): number { return this.ctx2d_?.canvas.clientWidth ?? 0; }
    get clientHeight(): number { return this.ctx2d_?.canvas.clientHeight ?? 0; }

    // 不透明な細い点は画素へ直接描き、GL描画後のCanvas間転送を避ける。
    // 適用条件と画像サイズの上限はCanvasRendererが判定する。
    beginRasterMode(canvas: HTMLCanvasElement, background: number, width = canvas.clientWidth, height = canvas.clientHeight, samples: 1 | 2 = 1): void {
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2D rendering context could not be obtained.");
        this.ctx2d_ = ctx;
        this.rasterSamples_ = samples;
        this.imageWidthDOM_ = canvas.width * samples; this.imageHeightDOM_ = canvas.height * samples;
        this.imageWidthScale_ = this.imageWidthDOM_ / Math.max(1, width);
        this.imageHeightScale_ = this.imageHeightDOM_ / Math.max(1, height);
        if (!this.rasterImage_ || this.rasterImage_.width !== this.imageWidthDOM_ || this.rasterImage_.height !== this.imageHeightDOM_) {
            this.rasterImage_ = ctx.createImageData(this.imageWidthDOM_, this.imageHeightDOM_);
            this.rasterPixels_ = new Uint32Array(this.rasterImage_.data.buffer);
        }
        this.rasterPixels_!.fill(background);
        this.rasterMode_ = true;
        this.rawMode_ = true;
    }

    // beginRawMode でキャンバスを受け取り、必要なら WebGL2 を初期化
    beginRawMode(canvas: HTMLCanvasElement, scale: number, width = canvas.clientWidth, height = canvas.clientHeight): void {
        // 2D を確保
        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) throw new Error("2D rendering context could not be obtained.");
        this.ctx2d_ = ctx2d;

        // DOM/CSS サイズ・スケール更新
        this.imageHeightDOM_ = canvas.height;
        this.imageWidthDOM_ = canvas.width;
        this.imageHeightCSS_ = height;
        this.imageWidthCSS_ = width;
        this.imageWidthScale_ = canvas.width / Math.max(1, width);
        this.imageHeightScale_ = canvas.height / Math.max(1, height);

        // オフスクリーンと WebGL2 準備（初回のみ作成）
        if (!this.overlayCanvas_) {
            throw new Error("Overlay canvas has not been created.");
        }

        // オーバーレイのサイズを 2D キャンバスと一致させる
        if (this.overlayCanvas_.width != canvas.width || this.overlayCanvas_.height != canvas.height) {
            this.overlayCanvas_.width = canvas.width;
            this.overlayCanvas_.height = canvas.height;
        }

        // バッチ状態リセット
        this.rasterMode_ = false;
        this.rawMode_ = true;
        this.count_ = 0;

        // ビューポート／クリア
        const gl = this.gl_!;
        gl.viewport(0, 0, this.overlayCanvas_.width, this.overlayCanvas_.height);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program_);
        if (this.uniform_u_resolution_) {
            gl.uniform2f(this.uniform_u_resolution_, this.overlayCanvas_.width, this.overlayCanvas_.height);
        }
    }

    endRawMode(): void {
        if (!this.rawMode_) return;
        if (this.rasterMode_) {
            let image = this.rasterImage_!;
            if (this.rasterSamples_ === 2) {
                const width = image.width / 2, height = image.height / 2;
                if (!this.rasterOutput_ || this.rasterOutput_.width !== width || this.rasterOutput_.height !== height) {
                    this.rasterOutput_ = this.ctx2d_!.createImageData(width, height);
                }
                const source = this.rasterPixels_!, output = new Uint32Array(this.rasterOutput_.data.buffer);
                // 不透明な2×2画素を面積で平均する。Canvasの補間品質やGPUに結果を依存させない。
                for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                    const p = y * 2 * image.width + x * 2;
                    const a = source[p], b = source[p + 1], c = source[p + image.width], d = source[p + image.width + 1];
                    const rb = (((a & 0xff00ff) + (b & 0xff00ff) + (c & 0xff00ff) + (d & 0xff00ff) + 0x020002) >>> 2) & 0xff00ff;
                    const g = (((a & 0xff00) + (b & 0xff00) + (c & 0xff00) + (d & 0xff00) + 0x0200) >>> 2) & 0xff00;
                    output[y * width + x] = 0xff000000 | rb | g;
                }
                image = this.rasterOutput_;
            }
            this.ctx2d_!.putImageData(image, 0, 0);
            this.rasterMode_ = false;
            this.rawMode_ = false;
            return;
        }
        this.flush_();

        // メイン 2D へピクセル等倍で合成
        const ctx2d = this.ctx2d_!;
        ctx2d.save();
        ctx2d.resetTransform();
        ctx2d.globalCompositeOperation = "source-over";
        ctx2d.imageSmoothingEnabled = false;
        ctx2d.drawImage(this.overlayCanvas_!, 0, 0);
        ctx2d.restore();

        this.rawMode_ = false;
    }

    // 多数呼ばれる：raw 中は GPU バッチに積む。非 raw は 2D 即時描画。
    fillRect(cssLeft: number, cssTop: number, cssWidth: number, cssHeight: number, packed: number): void {
        if (this.rasterMode_) {
            // 画素中心が矩形内にある範囲を使い、表示準備の被覆判定と揃える。
            const x0 = Math.max(0, pixelEdge(cssLeft * this.imageWidthScale_));
            const x1 = Math.min(this.imageWidthDOM_, pixelEdge((cssLeft + cssWidth) * this.imageWidthScale_));
            const y0 = Math.max(0, pixelEdge(cssTop * this.imageHeightScale_));
            const y1 = Math.min(this.imageHeightDOM_, pixelEdge((cssTop + cssHeight) * this.imageHeightScale_));
            if (x0 >= x1) return;
            for (let y = y0; y < y1; y++) this.rasterPixels_!.fill(packed, y * this.imageWidthDOM_ + x0, y * this.imageWidthDOM_ + x1);
            return;
        }
        if (this.rawMode_) {
            this.queueRectPacked_(cssLeft, cssTop, cssWidth, cssHeight, packed);
            return;
        }
        // 非 raw は 2D で即時
        this.ctx2d_!.fillStyle = this.toStyle_(packed);
        this.ctx2d_!.fillRect(cssLeft, cssTop, cssWidth, cssHeight);
    }

    // 内部処理
    private toStyle_(colorVal: number): string {
        return `rgba(${(colorVal) & 255}, ${(colorVal >>> 8) & 255}, ${(colorVal >>> 16) & 255}, ${((colorVal >>> 24) & 255) / 255})`;
    }

    private queueRectPacked_(cssLeft: number, cssTop: number, cssWidth: number, cssHeight: number, packedRGBA: number): void {
        // 画素中心で被覆を確定してからGPUへ渡す。元の小数座標を渡すと、
        // GPUのsubpixel精度によって半画素付近の点が隣の行へ移り、集約時の判定とずれる。
        const sx = this.imageWidthScale_;
        const sy = this.imageHeightScale_;
        const wDOM = this.imageWidthDOM_;
        const hDOM = this.imageHeightDOM_;

        const x0 = Math.max(0, pixelEdge(cssLeft * sx));
        const y0 = Math.max(0, pixelEdge(cssTop * sy));
        const x1 = Math.min(wDOM, pixelEdge((cssLeft + cssWidth) * sx));
        const y1 = Math.min(hDOM, pixelEdge((cssTop + cssHeight) * sy));
        if (x1 <= x0 || y1 <= y0) return;

        if (this.count_ >= this.cap_) this.grow_();
        const i2 = this.count_ * 2;
        this.pos_[i2 + 0] = x0;
        this.pos_[i2 + 1] = y0;
        this.size_[i2 + 0] = x1 - x0;
        this.size_[i2 + 1] = y1 - y0;

        this.color_[this.count_] = packedRGBA;
        this.count_++;
    }

    private grow_(): void {
        const newCap = Math.max(2048, this.cap_ * 2);  // 最低 2048 から
        const pos = new Float32Array(newCap * 2);
        const siz = new Float32Array(newCap * 2);
        const col = new Uint32Array(newCap);
        if (this.cap_ > 0) {
            pos.set(this.pos_.subarray(0, this.cap_ * 2));
            siz.set(this.size_.subarray(0, this.cap_ * 2));
            col.set(this.color_.subarray(0, this.cap_));
        }
        this.pos_ = pos;
        this.size_ = siz;
        this.color_ = col;
        this.cap_ = newCap;
    }

    private flush_(): void {
        if (this.count_ === 0) return;
        const gl = this.gl_!;

        // インスタンス属性をアップロード
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos_);
        gl.bufferData(gl.ARRAY_BUFFER, this.pos_.subarray(0, this.count_ * 2), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.attrib_a_pos_);
        gl.vertexAttribPointer(this.attrib_a_pos_, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(this.attrib_a_pos_, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSize_);
        gl.bufferData(gl.ARRAY_BUFFER, this.size_.subarray(0, this.count_ * 2), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.attrib_a_size_);
        gl.vertexAttribPointer(this.attrib_a_size_, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(this.attrib_a_size_, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufColor_);
        gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.color_.buffer, 0, this.count_ * 4), gl.DYNAMIC_DRAW); // アップロード時だけバイトビューに変換して送る
        gl.enableVertexAttribArray(this.attrib_a_color_);
        gl.vertexAttribPointer(this.attrib_a_color_, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        gl.vertexAttribDivisor(this.attrib_a_color_, 1);

        // 単位クアッド（6頂点）
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUnit_);
        gl.enableVertexAttribArray(this.attrib_a_unit_);
        gl.vertexAttribPointer(this.attrib_a_unit_, 2, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(this.attrib_a_unit_, 0);

        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count_);
        this.count_ = 0;
    }

    private initGL_(): void {
        const gl = this.gl_!;

        // 最小限のシェーダ：位置変換＋色の受け渡しのみ（HSL→RGB は CPU キャッシュ）
        const vs = `#version 300 es\n
            layout(location=0) in vec2 a_unit;   // 頂点ごとの単位クアッド (0..1)
            layout(location=1) in vec2 a_pos;    // インスタンス左上（px）
            layout(location=2) in vec2 a_size;   // インスタンス幅高（px）
            layout(location=3) in vec4 a_color;  // インスタンス色（0..1）
            uniform vec2 u_resolution;           // 画面サイズ（px）
            out vec4 v_color;
            void main(){
                vec2 pos = a_pos + a_unit * a_size;
                vec2 zeroToOne = pos / u_resolution;
                vec2 clip = zeroToOne * 2.0 - 1.0;
                gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0); // Y 反転
                v_color = a_color;
            }
        `;

        const fs = `#version 300 es\n
            precision mediump float;
            in vec4 v_color;
            out vec4 outColor;
            void main(){ outColor = v_color; }
        `;

        const program = this.linkProgram_(vs, fs);
        this.program_ = program;
        this.uniform_u_resolution_ = gl.getUniformLocation(program, "u_resolution");

        // バッファ作成
        this.bufUnit_ = gl.createBuffer();
        this.bufPos_  = gl.createBuffer();
        this.bufSize_ = gl.createBuffer();
        this.bufColor_= gl.createBuffer();

        // 単位クアッド（2 三角形 × 3 頂点）
        const quad = new Float32Array([
            0,0,  1,0,  0,1,
            0,1,  1,0,  1,1,
        ]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufUnit_);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    }

    private compileShader_(type: number, src: string): WebGLShader {
        const gl = this.gl_!;
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(sh) ?? "";
            gl.deleteShader(sh);
            throw new Error("Shader compile failed: " + log);
        }
        return sh;
    }

    private linkProgram_(vsSrc: string, fsSrc: string): WebGLProgram {
        const gl = this.gl_!;
        const vs = this.compileShader_(gl.VERTEX_SHADER, vsSrc);
        const fs = this.compileShader_(gl.FRAGMENT_SHADER, fsSrc);
        const prog = gl.createProgram()!;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(prog) ?? "";
            gl.deleteProgram(prog);
            throw new Error("Program link failed: " + log);
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return prog;
    }
}


// 細かい FillRect を行う際に，ImageData を直接操作してソフト描画を行い高速化するためのクラス
class RectRendererSoft {
    // DOM/CSS 次元（読み取り専用）
    imageHeightDOM_: number = 0;
    imageWidthDOM_: number = 0;
    imageHeightCSS_: number = 0;
    imageWidthCSS_: number = 0;

    private ctx_: CanvasRenderingContext2D | null = null;
    private imageDataHandle_: ImageData | null = null;
    private imageDataUint32Ptr_: Uint32Array | null = null;
    private imageWidthScale_: number = 0;
    private imageHeightScale_: number = 0;

    private fillHuePrev_: number = -1;
    private fillStylePrev_: string = "";

    // オーバーレイ（raw描画）用のオフスクリーンキャンバス
    private overlayCanvas_: HTMLCanvasElement | null = null;
    private overlayCtx_: CanvasRenderingContext2D | null = null;

    constructor() {
        this.ctx_ = null;
        this.overlayCanvas_ = null;
        this.overlayCtx_ = null;
    }

    init() {
        // オーバーレイの用意（同サイズ）
        if (!this.overlayCanvas_) {
            this.overlayCanvas_ = document.createElement("canvas");
        }
        return true;
    }

    beginRawMode(canvas: HTMLCanvasElement, scale: number, width = canvas.clientWidth, height = canvas.clientHeight): void {
        // 画像サイズ（DOM/CSS）
        this.imageHeightDOM_ = canvas.height;
        this.imageWidthDOM_  = canvas.width;
        this.imageHeightCSS_ = height;
        this.imageWidthCSS_  = width;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("2D rendering context could not be obtained.");
        }
        this.ctx_ = ctx;

        this.imageWidthScale_  = canvas.width  / Math.max(1, width);
        this.imageHeightScale_ = canvas.height / Math.max(1, height);

        if (!this.overlayCanvas_) {
            return;
        }
        this.overlayCanvas_.width = this.imageWidthDOM_;
        this.overlayCanvas_.height = this.imageHeightDOM_;
        const overlayCtx_ = this.overlayCanvas_.getContext("2d");
        if (!overlayCtx_) {
            throw new Error("Overlay 2D context could not be obtained.");
        }
        this.overlayCtx_ = overlayCtx_;
        
        // 通常の fillRect を使う
        if (scale > 1) {
            return;
        }

        // キャンバス全体の ImageData を取得．全てゼロでクリアされる
        this.imageDataHandle_   = this.overlayCtx_.createImageData(this.imageWidthDOM_, this.imageHeightDOM_);
        this.imageDataUint32Ptr_ = new Uint32Array(this.imageDataHandle_.data.buffer);
    }

    endRawMode(): void {
        if (!this.overlayCtx_ || !this.ctx_ || !this.overlayCanvas_) {
            return;
        }
        if (this.imageDataHandle_) {
            // overlay にピクセルを反映
            this.overlayCtx_.putImageData(this.imageDataHandle_, 0, 0);

            
            this.ctx_.save();
            // drawImage は現在の transform の影響を受けるため、
            // CSS↔DOM のスケーリングや translate を無視してピクセル等倍で描く
            this.ctx_.resetTransform(); // モダン環境

            // 合成モードを変更（デフォルトは 'source-over'）
            this.ctx_.globalCompositeOperation = 'source-over';

            // 画像スムージングを無効化（ピクセルずれ時のにじみ防止）
            this.ctx_.imageSmoothingEnabled = false;

            // DOM ピクセル座標でそのまま重ねる
            this.ctx_.drawImage(this.overlayCanvas_, 0, 0);
            this.ctx_.restore();
        }
        this.imageDataHandle_ = null;
        this.imageDataUint32Ptr_ = null;
    }


    private fillRectRaw_(
        cssLeft: number,
        cssTop: number,
        cssWidth: number,
        cssHeight: number,
        rgb: number
    ): void {
        if (!this.imageDataUint32Ptr_) return; // raw mode でなければ何もしない

        // left や top などの座標系は CSS 座標で与えられるが，
        // imageData は DOM 座標系で与えられるのでスケールする
        const sx = this.imageWidthScale_;
        const sy = this.imageHeightScale_;
        const wCSS = this.imageWidthCSS_;
        const hCSS = this.imageHeightCSS_;
        const wDOM = this.imageWidthDOM_;
        const hDOM = Math.floor(hCSS * sy);

        // CSS→DOM 変換
        let left   = cssLeft * sx;
        let top    = cssTop * sy;
        let right  = Math.min(cssLeft + cssWidth,  wCSS) * sx;
        let bottom = Math.min(cssTop  + cssHeight, hCSS) * sy;

        // 左・上もクランプ
        left   = Math.max(0, left);
        top    = Math.max(0, top);
        right  = Math.max(left,  Math.min(right,  wDOM));
        bottom = Math.max(top,   Math.min(bottom, hDOM));

        // width や height は小数になっている可能性があるので，
        // ループ回数の判定は小数のまま行う
        // 小数の空間で +1 づつサンプリングしていることになる
        // +0.5 は四捨五入のため
        const x0 = Math.floor(left + 0.5);
        const y0 = Math.floor(top  + 0.5);
        const x1 = Math.floor(right  - 0.5);
        const y1 = Math.floor(bottom - 0.5);

        const imageData = this.imageDataUint32Ptr_;

        let rowStart = y0 * wDOM;
        for (let y = y0; y <= y1; y++) {
            let p = rowStart + x0;
            const pEnd = rowStart + x1;
            for (; p <= pEnd; p++) {
                imageData[p] = rgb; // RGBA 32bit 直接書き込み
            }
            rowStart += wDOM;
        }
    }

    toStyle_(colorVal: number): string {
        return `rgba(${(colorVal) & 255}, ${(colorVal >>> 8) & 255}, ${(colorVal >>> 16) & 255}, ${((colorVal >> 24)& 255) / 255})`;
    };

    fillRect(cssLeft: number, cssTop: number, cssWidth: number, cssHeight: number, packed: number): void {
        if (!this.ctx_)
            return;

        if (this.imageDataUint32Ptr_)  {
            this.fillRectRaw_(cssLeft, cssTop, cssWidth, cssHeight, packed);
        }
        else {
            let style = this.toStyle_(packed);
            this.ctx_.fillStyle = style;
            this.ctx_.fillRect(cssLeft, cssTop, cssWidth, cssHeight);
        }
    }
}

export { RectRendererSoft, RectRendererWebGL, pixelEdge };
