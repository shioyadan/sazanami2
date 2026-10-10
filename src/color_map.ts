import { Loader } from "./loader";


// パレット生成
const clamp01 = (x: number) => x < 0 ? 0 : (x > 1 ? 1 : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const packRGBA = (r: number, g: number, b: number, a: number = 255): number =>
    ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);

const hexToRGB = (hex: string): [number, number, number] => {
    const s = hex.replace("#", "");
    const n = parseInt(s, 16);
    if (s.length === 6) {
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    }
    // #rgb
    return [((n >> 8) & 0xf) * 17, ((n >> 4) & 0xf) * 17, (n & 0xf) * 17];
};

const buildGradient = (stops: Array<[number, string]>, size: number): Uint32Array => {
    // stops: t in [0..1], hex color
    const out = new Uint32Array(size);
    const sorted = stops.slice().sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < size; i++) {
        const t = i / (size - 1);
        let j = 0;
        while (j + 1 < sorted.length && t > sorted[j + 1][0]) j++;
        const [t0, c0] = sorted[j];
        const [t1, c1] = sorted[Math.min(j + 1, sorted.length - 1)];
        const [r0, g0, b0] = hexToRGB(c0);
        const [r1, g1, b1] = hexToRGB(c1);
        const u = t1 === t0 ? 0 : clamp01((t - t0) / (t1 - t0));
        const r = Math.round(lerp(r0, r1, u));
        const g = Math.round(lerp(g0, g1, u));
        const b = Math.round(lerp(b0, b1, u));
        out[i] = packRGBA(r, g, b, 255);
    }
    return out;
};

const buildCategoricalRepeat = (hexList: string[], size: number): Uint32Array => {
    const out = new Uint32Array(size);
    const m = hexList.length;
    for (let i = 0; i < size; i++) {
        const [r, g, b] = hexToRGB(hexList[i % m]);
        out[i] = packRGBA(r, g, b, 255);
    }
    return out;
};

// 代表的なパレット（簡易実装）
const OKABE_ITO = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#999999"];
const GLASBEY_32 = [
    "#0000FF","#FF0000","#00FF00","#000000","#FFFF00","#00FFFF","#FF00FF","#808080",
    "#800000","#808000","#008000","#800080","#008080","#000080","#FF8080","#80FF80",
    "#8080FF","#804000","#408000","#008040","#400080","#800040","#408080","#804080",
    "#408040","#FF8000","#80FF00","#00FF80","#0080FF","#8000FF","#FF0080","#00FFFF"
];

// viridis の近似勾配（代表点）
const VIRIDIS_STOPS: Array<[number, string]> = [
    [0.00, "#440154"],
    [0.25, "#3B528B"],
    [0.50, "#21918C"],
    [0.75, "#5EC962"],
    [1.00, "#FDE725"]
];

// RdBu の近似勾配（白中心）
const RDBU_STOPS: Array<[number, string]> = [
    [0.00, "#2166AC"],
    [0.50, "#FFFFFF"],
    [1.00, "#B2182B"]
];

// 相対輝度（WCAG準拠）
const relLum = (r: number, g: number, b: number) => {
    const f = (u: number) => {
        const s = u / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

// コントラスト比
const contrast = (a: [number, number, number], b: [number, number, number]) => {
    const [L1, L2] = [relLum(...a), relLum(...b)].sort((x, y) => y - x);
    return (L1 + 0.05) / (L2 + 0.05);
};

// RGB → HSL
const rgb2hsl = (r: number, g: number, b: number): [number, number, number] => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2, d = max - min;
    if (d) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h, s, l];
};

// HSL → RGB
const hsl2rgb = (h: number, s: number, l: number): [number, number, number] => {
    const f = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    if (!s) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const r = f(p, q, h + 1 / 3);
    const g = f(p, q, h);
    const b = f(p, q, h - 1 / 3);
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

// 単一色を暗背景で見やすいように調整
const adjust = (
    rgb: [number, number, number],
    bg: [number, number, number],
    cr = 3,
    maxL = 0.85   // 明度の上限（1.0=完全白 → 少し抑える）
) => {
    let [h, s, l] = rgb2hsl(...rgb);

    // 明るすぎる色は抑える
    if (l > maxL) {
        l = maxL;
        return hsl2rgb(h, s, l);
    }

    // 暗すぎる色はコントラストを満たすまで明度を上げる
    if (contrast(rgb, bg) >= cr) return rgb;
    for (let i = 0; i < 40; i++) {
        l = Math.min(maxL, l + 0.02);
        if (i > 10) s = Math.max(0, s - 0.02);
        const c = hsl2rgb(h, s, l);
        if (contrast(c, bg) >= cr) return c;
    }
    return hsl2rgb(h, s, l);
};

// パレット全体を暗背景向けに調整
const postAdjustForDarkBG = (
    pal: Uint32Array,
    bgHex = "#000000",
    cr = 3,
    maxL = 0.85
) => {
    const [br, bg, bb] = hexToRGB(bgHex);
    for (let i = 0; i < pal.length; i++) {
        const p = pal[i];
        const r =  p & 255, g = (p >> 8)  & 255, b = (p >> 16) & 255;
        const [R, G, B] = adjust([r, g, b], [br, bg, bb], cr, maxL);
        pal[i] = packRGBA(R, G, B, 255);
    }
    return pal;
};

// カラーマップ名からパレット生成
// 返値: [パレット配列, 連続値向けかどうか]
const buildPaletteByName = (name: string | undefined, size: number): [Uint32Array, boolean ]=> {
    const key = (name ?? "viridis").toLowerCase();
    let pal: Uint32Array;
    let continuous: boolean;
    if (key === "okabe-ito" || key === "okabeito" || key === "okabe_ito") {
        pal = buildCategoricalRepeat(OKABE_ITO, size);
        continuous = false;
    }
    else if (key === "glasbey") {
        pal = buildCategoricalRepeat(GLASBEY_32, size);
        continuous = false;
    }
    else if (key === "rdbu" || key === "rd_bu" || key === "rd-bu") {
        pal = buildGradient(RDBU_STOPS, size);
        continuous = true;
    }
    else if (key === "viridis") {
        pal = buildGradient(VIRIDIS_STOPS, size);
        continuous = true;
    }
    else {
        // 不明な名前は okabe-ito 扱い
        pal = buildCategoricalRepeat(OKABE_ITO, size);
        continuous = false;
    }

    // 暗背景向けに調整
    return [postAdjustForDarkBG(pal), continuous];
};



// カラーマップ名推定
// 上記の議論に基づく簡易ヒューリスティック：
// - 連続値（ユニーク数多い or 小数あり） → ゼロを跨ぐなら発散 "RdBu", そうでなければ順次 "viridis"
// - カテゴリ（整数中心でユニーク ≤ 12） → "okabe-ito"
// - 中～多数カテゴリ（12 < k ≤ 70） → "glasbey"
// - それ以上 → 依然 "glasbey"（描き分けは凡例側で対処）
const inferColorMapName = (loader: Loader, fieldName: string | null | undefined): string | undefined => {
    if (!fieldName) return "";
    const colBuf = loader.columnFromName(fieldName);
    if (!colBuf) return "";

    const n = loader.numRows;
    const sampler = colBuf;
    const maxScan = Math.min(n, loader.typeDetectLineNum);  // Loader のタイプディテクトにあわせる
    const uniques = new Set<number>();
    let sawFloat = false;

    for (let i = 0; i < maxScan; i++) {
        const v = sampler.getNumber(i);
        if (Number.isFinite(v)) {
            uniques.add(v);
            if (!Number.isInteger(v)) sawFloat = true;
            if (uniques.size > 256) break; // 打ち切り
        }
    }

    const k = uniques.size;
    const min = colBuf.stat.min;
    const max = colBuf.stat.max;

    // 連続値判定
    const looksContinuous = sawFloat || k > 128;

    if (looksContinuous) {
        if (min < 0 && max > 0) {
            return "RdBu";
        } else {
            return "viridis";
        }
    }

    // 離散（整数）とみなす
    if (k <= 8) {
        return "okabe-ito";
    } else {
        return "glasbey";
    }
};


export { buildPaletteByName, inferColorMapName };
