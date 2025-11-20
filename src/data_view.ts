// data_view.ts
import { Loader, ColumnBuffer, ColumnType, ColumnInterface  } from "./loader";
import { buildPaletteByName, inferColorMapName } from "./color_map";

// 軸と色の仕様
type ViewSpec = Readonly<{
    axisXField: string;
    axisYField: string;
    colorField?: string | null;
    colorMap?: string;
}>;

// 行の仕様
type ColumnSpec = Readonly<Record<string, string>>;

// View と Columns をまとめた全体の仕様（深い readonly）
type ViewDefinition = Readonly<{
    view: ViewSpec;
    columns: ColumnSpec;
}>;

const INITIAL_VIEW_DEFINITION: ViewDefinition = {
    view: {
        axisXField: "__index__",
        axisYField: "__index__",
        colorField: null,
        colorMap: "",
    },
    columns: {},
} as const; // as const を付けておくと深い readonly になる

// 一致比較
const isEqualViewDefinition = (a: ViewDefinition, b: ViewDefinition): boolean => {
    const va = a.view, vb = b.view;
    if (
        va.axisXField !== vb.axisXField ||
        va.axisYField !== vb.axisYField ||
        (va.colorField ?? null) !== (vb.colorField ?? null) || 
        (va.colorMap ?? null) !== (vb.colorMap ?? null)
    ) {
        return false;
    }
    const ca = a.columns ?? {};
    const cb = b.columns ?? {};
    const aKeys = Object.keys(ca).sort();
    const bKeys = Object.keys(cb).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
        if (aKeys[i] !== bKeys[i]) return false;
        const k = aKeys[i];
        if (ca[k] !== cb[k]) return false;
    }
    return true;
};

// 行インデクスを返す仮想カラム
class IndexColumn implements ColumnInterface {
    stat: { min: number; max: number, deviationFromMax: number };
    private nRows_: number;

    constructor(nRows: number) {
        this.nRows_ = nRows;
        this.stat = { min: 0, max: Math.max(0, nRows - 1), deviationFromMax: 0 };
    }

    getNumber(i: number): number {
        return i;
    }

    getString(i: number): string {
        return this.getNumber(i).toString();
    }
    get codeToStringList(): string[] { return [];}
    get codeToIntList(): number[] { return []; }

}

// 仮想列で使用する式エンジン
class ExpressionProjector {
    private expr_ = "";
    private varNames_: string[] = [];
    private cols_: ColumnInterface[] = [];
    private compiledExp_!: (...args: number[]) => number;
    private fastExp_: ((i: number) => number) | null = null;
    private numRows_ = 0;
    private min_ = 0;
    private max_ = 0;
    private deviationFromMax_ = 0;

    static isSafeExpression(expr: string): boolean {
        // 許容：数字・小数点・空白・演算子 + - * / % () 、識別子・下線
        // セミコロンや =、?、:、{}、[] などは禁止
        return /^[0-9\s+\-*/%().A-Za-z_]+$/.test(expr);
    }

    static extractVariables(expr: string): string[] {
        const idRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
        const disallow = new Set([
            "return","var","let","const","function","new","this","if","else","for","while","do","switch","case",
            "break","continue","try","catch","finally","throw","class","extends","super","import","export","default",
            "delete","in","instanceof","typeof","void","yield","await","with","debugger",
            "Math","Number","String","Boolean","Array","Object","Date","JSON","RegExp","Infinity","NaN","undefined","null"
        ]);
        const vars = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = idRegex.exec(expr)) !== null) {
            const id = m[0];
            if (disallow.has(id)) continue;
            vars.add(id);
        }
        return Array.from(vars);
    }

    static isIdentityExpr(expr: string, varName: string): boolean {
        let s = expr.replace(/\s+/g, "");
        while (s.startsWith("(") && s.endsWith(")")) {
            s = s.slice(1, -1);
        }
        return s === varName;
    }

    private rewriteExpression_(expr: string, vars: string[], args: string[]): string {
        let rewritten = expr;
        for (let i = 0; i < vars.length; i++) {
            const v = vars[i];
            const a = args[i];
            const re = new RegExp(`\\b${v}\\b`, "g");
            rewritten = rewritten.replace(re, a);
        }
        return rewritten;
    }

    init(resolveColumn: (name: string) => ColumnInterface, expr: string, numRows: number) {
        this.expr_ = expr.trim();
        this.numRows_ = numRows;

        // 変数抽出（最大2）
        this.varNames_ = ExpressionProjector.extractVariables(this.expr_);
        if (this.varNames_.length > 2) {
            throw new Error(`Expression uses more than 2 variables: ${this.expr_}`);
        }

        // 列束縛
        this.cols_ = this.varNames_.map(name => resolveColumn(name));

        // サニタイズ
        if (!ExpressionProjector.isSafeExpression(this.expr_)) {
            throw new Error(`Unsafe expression: ${this.expr_}`);
        }

        // fast path: 単一変数の恒等式
        if (this.varNames_.length === 1 && ExpressionProjector.isIdentityExpr(this.expr_, this.varNames_[0])) {
            const c0 = this.cols_[0];
            this.fastExp_ = (i: number) => c0.getNumber(i);
            this.min_ = c0.stat.min;
            this.max_ = c0.stat.max;
            return;
        }

        // new Function コンパイル
        const argNames = this.varNames_.map((_, i) => `v${i}raw`);
        const rewritten = this.rewriteExpression_(this.expr_, this.varNames_, argNames);
        const body = `return (${rewritten});`;
        this.compiledExp_ = new Function(...argNames, body) as (...args: number[]) => number;

        // min/max 推定（列 min/max を用いたコーナー評価）
        const k = this.cols_.length;
        if (k === 0) {
            const v = (this.compiledExp_ as () => number)();
            this.min_ = v;
            this.max_ = v;
            this.deviationFromMax_ = 0;
        } else if (k === 1) {
            const c0 = this.cols_[0];
            const a = (this.compiledExp_ as (v0raw: number) => number)(c0.stat.min);
            const b = (this.compiledExp_ as (v0raw: number) => number)(c0.stat.max);
            this.min_ = Math.min(a, b);
            this.max_ = Math.max(a, b);
            this.deviationFromMax_ = c0.stat.deviationFromMax;
        } else {
            const c0 = this.cols_[0];
            const c1 = this.cols_[1];
            const eval2 = this.compiledExp_ as (v0raw: number, v1raw: number) => number;
            const v00 = eval2(c0.stat.min, c1.stat.min);
            const v01 = eval2(c0.stat.min, c1.stat.max);
            const v10 = eval2(c0.stat.max, c1.stat.min);
            const v11 = eval2(c0.stat.max, c1.stat.max);
            this.min_ = Math.min(v00, v01, v10, v11);
            this.max_ = Math.max(v00, v01, v10, v11);
            this.deviationFromMax_ = 
                Math.min(
                    this.max_ - this.min_,
                    Math.max(c0.stat.deviationFromMax, c1.stat.deviationFromMax)
                );
        }
    }

    value(i: number): number {
        if (this.fastExp_) return this.fastExp_(i);
        const k = this.cols_.length;
        let v0raw = 0, v1raw = 0;
        if (k >= 1) v0raw = this.cols_[0].getNumber(i);
        if (k >= 2) v1raw = this.cols_[1].getNumber(i);
        return this.compiledExp_(v0raw, v1raw);
    }

    getMin(): number { return this.min_; }
    getMax(): number { return this.max_; }
    getDeviationFromMax(): number { return this.deviationFromMax_; }
}

// 式の評価結果を返す仮想数値カラム 
class ExpressionColumn implements ColumnInterface {
    readonly name: string;
    private projector_: ExpressionProjector;
    stat: { min: number; max: number, deviationFromMax: number };

    constructor(name: string, projector: ExpressionProjector) {
        this.name = name;
        this.projector_ = projector;
        this.stat = { min: projector.getMin(), max: projector.getMax(), deviationFromMax: projector.getDeviationFromMax() };
    }

    getNumber(i: number): number {
        return this.projector_.value(i);
    }

    getString(i: number): string {
        return this.getNumber(i).toString();
    }

    get codeToStringList(): string[] { return [];}
    get codeToIntList(): number[] { return []; }
}

// 仮想カラムレジストリ
// 仮想列は他の仮想列を参照不可
class VirtualColumnRegistry {
    private defs_ = new Map<string, string>();           // name → expr
    private columns_ = new Map<string, ColumnInterface>();   // name → 実体
    private loader_!: Loader;
    private numRows_ = 0;

    bind(loader: Loader) {
        this.loader_ = loader;
        this.numRows_ = loader.numRows;
    }

    add(name: string, expr: string) {
        const errors = collectColumnSpecErrors(this.loader_, { [name]: expr }, new Set(this.defs_.keys()));
        if (errors.length > 0) {
            throw new Error(errors.join("\n"));
        }
        this.defs_.set(name, expr);
    }

    list(): string[] {
        return Array.from(this.defs_.keys());
    }

    compileAll() {
        // 追加時に検証済みだが、未知列などの安全側チェックも再実施
        const errors = collectColumnSpecErrors(this.loader_, Object.fromEntries(this.defs_), new Set());
        if (errors.length > 0) {
            throw new Error(errors.join("\n"));
        }

        const resolveColumn = (name: string): ColumnInterface => {
            if (name === "__index__") return new IndexColumn(this.numRows_);
            // 仮想列参照は不可（仕様）
            if (this.defs_.has(name) || this.columns_.has(name)) {
                throw new Error(`Virtual column may not reference another virtual column: ${name}`);
            }
            const col = this.loader_.columnFromName(name);
            if (!col || typeof col.getNumber !== "function") {
                throw new Error(`Unknown column: ${name}`);
            }
            return col;
        };

        for (const [name, expr] of this.defs_) {
            const projector = new ExpressionProjector();
            projector.init(resolveColumn, expr, this.numRows_);
            const col = new ExpressionColumn(name, projector);
            this.columns_.set(name, col);
        }
    }

    get(name: string): ColumnInterface | undefined {
        return this.columns_.get(name);
    }
}


// 公開 DataView
export class DataView {
    private def_!: ViewDefinition;
    private numRows_ = 0;
    private xCol_!: ColumnInterface;
    private yCol_!: ColumnInterface;
    private colorCol_: ColumnInterface | null = null;
    private loaderRef_!: Loader;
    private resolveByName_!: (name: string) => ColumnInterface;
    private types_: { [column: string]: ColumnType } = {};

    // 内部レジストリ
    private registry_ = new VirtualColumnRegistry();

    // パレット管理
    private paletteName_: string | undefined;
    private paletteSize_ = 1024;
    private palettePacked_: Uint32Array = new Uint32Array(0);
    private paletteContinuous_: boolean = false;    // 連続値向けかどうか

    private initialized_ = false;

    // ColumnSpec が loader に対して追加可能かどうかを事前検証する。
    // エラーがある場合は ok:false とエラーメッセージ配列を返す。
    private validateColumnSpec_(loader: Loader, columns: ColumnSpec): { ok: boolean; errors: string[] } {
        const errors = collectColumnSpecErrors(loader, columns, new Set());
        return { ok: errors.length === 0, errors };
    }

    // DataView は Definition を受け取って初期化する
    init(loader: Loader, def: ViewDefinition): void {
        if (this.initialized_) {
            throw new Error("DataView has already been initialized.");
        }
        this.loaderRef_ = loader;
        const spec = def.view;
        const columns = def.columns ?? {};

        this.numRows_ = loader.numRows;

        // レジストリ準備
        this.registry_.bind(loader);

        // ColumnSpec 登録（仮想→実体化）
        if (Object.keys(columns).length > 0) {
            const validation = this.validateColumnSpec_(loader, columns);
            if (!validation.ok) {
                throw new Error(validation.errors.join("\n"));
            }
            for (const [name, expr] of Object.entries(columns)) {
                this.registry_.add(name, expr);
            }
            this.registry_.compileAll();
        }

        // 列解決
        const resolveByName = (name: string): ColumnInterface => {
            if (name === "__index__") return new IndexColumn(this.numRows_);
            const vcol = this.registry_.get(name);
            if (vcol) return vcol;
            let col = loader.columnFromName(name);
            if (!col) {
                col = new IndexColumn(this.numRows_); // フォールバックとして行インデクス列
            }
            return col;
        };
        this.resolveByName_ = resolveByName;

        this.xCol_ = resolveByName(spec.axisXField);
        this.yCol_ = resolveByName(spec.axisYField);
        this.colorCol_ = spec.colorField ? resolveByName(spec.colorField) : null;

        // パレット初期化
        let colorMap = spec.colorMap;
        if (!colorMap || colorMap.trim() === "") {
            colorMap = inferColorMapName(loader, spec.colorField);
        }
        this.paletteName_ = colorMap;
        let palInfo = buildPaletteByName(this.paletteName_, this.paletteSize_);
        this.palettePacked_ = palInfo[0];
        this.paletteContinuous_ = palInfo[1];

        this.def_ = { view: { ...spec }, columns: { ...columns } };

        // types 構築：実列 + 仮想列 + __index__
        this.types_ = { ...loader.types };
        for (const vName of this.registry_.list()) {
            this.types_[vName] = ColumnType.INTEGER; // 仮想列は数式で得られる数値列として扱う
        }
        this.types_["__index__"] = ColumnType.INTEGER; // 便宜上、仮想インデックス列も整数として公開


        this.initialized_ = true; // 以降は読み取り専用
    }

    // 引数で与えられた definition と一致しているか（View + Columns）
    isEqualViewDefinition(def: ViewDefinition): boolean {
        return isEqualViewDefinition(this.def_, def);
    }

    getX(i: number): number { return this.xCol_.getNumber(i); }
    getY(i: number): number { return this.yCol_.getNumber(i); }

    // カラーインデックスの取得
    // colorField の値をパレットサイズより小さい整数に丸める
    // 負の値は正に変換する
    getColorIndex(i: number): number {
        if (!this.colorCol_) return 0;
        const v = this.colorCol_.getNumber(i);
        if (!Number.isFinite(v)) return 0;

        if (this.paletteContinuous_) {  // 連続値っぽい場合はスケーリングする
            const range = this.colorCol_.stat.max - this.colorCol_.stat.min;
            const t = (v - this.colorCol_.stat.min) / range;
            return Math.floor(t * this.paletteSize_);
        }
        
        // 離散値っぽい場合は mod でそのまま丸める
        const n = Math.trunc(v);
        const m = this.paletteSize_;
        const idx = n % m;
        return idx < 0 ? idx + m : idx;
    }

    // パレット（uint32 RGBA packed）の取得
    getPalette(): Uint32Array {
        return this.palettePacked_;
    }

    // 2分探索
    lowerBound_(col: ColumnInterface, target: number): number {
        let lo = 0;
        let hi = this.numRows_;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (col.getNumber(mid) < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    getStartIdx(xStart: number, yStart: number): number {
        let xIndexStart = this.lowerBound_(this.xCol_, xStart);
        let yIndexStart = this.lowerBound_(this.yCol_, yStart);

        // 最大偏差率が小さい方を選ぶ
        let xDeviationFromMax_ = this.xCol_.stat.deviationFromMax / (this.xCol_.stat.max - this.xCol_.stat.min);
        let yDeviationFromMax_ = this.yCol_.stat.deviationFromMax / (this.yCol_.stat.max - this.yCol_.stat.min);

        // 最大偏差分を引く
        xIndexStart -= this.xCol_.stat.deviationFromMax;
        yIndexStart -= this.yCol_.stat.deviationFromMax;

        if (xDeviationFromMax_ == yDeviationFromMax_ ) 
            return Math.min(xIndexStart, yIndexStart); // 偏差が同じなら小さい方
        return xDeviationFromMax_ > yDeviationFromMax_ ? yIndexStart : xIndexStart;
    }

    getEndIdx(xEnd: number, yEnd: number): number {
        let xIndexEnd = Math.min(this.lowerBound_(this.xCol_, xEnd), this.numRows_);
        let yIndexEnd = Math.min(this.lowerBound_(this.yCol_, yEnd), this.numRows_);

        // 最大偏差分を足す
        xIndexEnd += this.xCol_.stat.deviationFromMax;
        yIndexEnd += this.yCol_.stat.deviationFromMax;

        // 最大偏差率が小さい方を選ぶ
        let xDeviationFromMax_ = this.xCol_.stat.deviationFromMax / (this.xCol_.stat.max - this.xCol_.stat.min);
        let yDeviationFromMax_ = this.yCol_.stat.deviationFromMax / (this.yCol_.stat.max - this.yCol_.stat.min);
        if (xDeviationFromMax_ == yDeviationFromMax_ ) 
            return Math.max(xIndexEnd, yIndexEnd); // 偏差が同じなら大きい方
        return xDeviationFromMax_ > yDeviationFromMax_ ? yIndexEnd : xIndexEnd;
    }

    getMaxX(): number { return this.xCol_.stat.max; }
    getMinX(): number { return this.xCol_.stat.min; }
    getMaxY(): number { return this.yCol_.stat.max; }
    getMinY(): number { return this.yCol_.stat.min; }

    getMaxColor(): number { return this.colorCol_ ? this.colorCol_.stat.max : 0; }
    getMinColor(): number { return this.colorCol_ ? this.colorCol_.stat.min : 0; }

    isColorContinuous(): boolean { return this.paletteContinuous_; }

    columnFromName(name: string): ColumnInterface {
        if (!this.initialized_) {
            throw new Error("DataView is not initialized yet.");
        }
        return this.resolveByName_(name);
    }
    get types(): { [column: string]: ColumnType } { return this.types_; }
    get definition() { return this.def_; }
}

const createDataView = (loader: Loader, def: ViewDefinition): DataView => {
    const dv = new DataView();
    dv.init(loader, def);
    return dv;
}

// 必要に応じて仮想列と列の仕様を推定して返す
const inferViewDefinition = (loader: Loader): ViewDefinition => {
    if (loader.detectionDone === false) {
        throw new Error("Type detection not done yet");
    }

    const h = loader.headers;
    if (h.length === 0) {
        return {
            view: { axisXField: "__index__", axisYField: "__index__", colorField: null, colorMap: undefined },
            columns: {}
        };
    }

    const eqCI = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const findHeader = (headers: string[], name: string) => headers.find(h => eqCI(h, name)) ?? null;
    const hasAll = (headers: string[], names: string[]) => names.every(n => headers.some(h => eqCI(h, n)));

    const base = (name: string) => loader.columnFromName(name).stat.max + 1;

    // OpenCL 形：x = cu * (max(wf)+1) + wf, y = cycle
    if (hasAll(h, ["cycle", "cu", "wf"])) {
        const cycle = findHeader(h, "cycle")!;
        const cu = findHeader(h, "cu")!;
        const wf = findHeader(h, "wf")!;
        const state = findHeader(h, "state");
        const wfBase = base(wf);
        const xExpr = `${cu} * ${wfBase} + ${wf}`;
        const xName = "cu_wf";
        const colorMap = inferColorMapName(loader, state);
        return {
            view: { axisXField: xName, axisYField: cycle, colorField: state ?? null, colorMap },
            columns: { [xName]: xExpr }
        };
    }

    // TAGE 形：x = Bank * 8 + (TblIdx % 8), y = __index__
    if (hasAll(h, ["Bank", "TblIdx"])) {
        const bank = findHeader(h, "Bank")!;
        const tbl = findHeader(h, "TblIdx")!;
        const actual = findHeader(h, "Actual");
        const xExpr = `${bank} * 8 + (${tbl} % 8)`;
        const xName = "bank_and_idx";
        const colorMap = inferColorMapName(loader, actual);
        return {
            view: { axisXField: xName, axisYField: "__index__", colorField: actual ?? null, colorMap },
            columns: { [xName]: xExpr }
        };
    }

    // フォールバック
    const n = h.length;
    if (n === 1) {
        const c0 = h[0];
        return {
            view: { axisXField: c0, axisYField: "__index__", colorField: null, colorMap: undefined },
            columns: {}
        };
    } else if (n === 2) {
        const c0 = h[0], c1 = h[1];
        return {
            view: { axisXField: c1, axisYField: c0, colorField: null, colorMap: undefined },
            columns: {}
        };
    } else {
        const c0 = h[0], c1 = h[1], c2 = h[2];
        const colorMap = inferColorMapName(loader, c2);
        return {
            view: { axisXField: c1, axisYField: c0, colorField: c2, colorMap },
            columns: {}
        };
    }
};

//  add/compileAll の事前チェックを共通化
//  既存列名と衝突したら常にエラー（大文字小文字は無視して判定）
//  仮想列は他の仮想列を参照不可
//  未知の列参照、非安全式、3変数以上はエラー
const collectColumnSpecErrors = (
    loader: Loader,
    columns: ColumnSpec,
    existingVirtualNames: Set<string>
): string[] => {
    const errors: string[] = [];
    const headers = loader.headers;
    const realLC = new Set(headers.map(h => h.toLowerCase()));
    const specNames = Object.keys(columns);
    const specNameSet = new Set<string>();

    for (const name of specNames) {
        if (!name) {
            errors.push("Virtual column name must be non-empty.");
            continue;
        }
        if (specNameSet.has(name)) {
            errors.push(`Duplicate virtual column name in ColumnSpec: '${name}'.`);
        } else {
            specNameSet.add(name);
        }
        if (realLC.has(name.toLowerCase())) {
            errors.push(`Virtual column name collides with real column: '${name}'.`);
        }
        if (existingVirtualNames.has(name)) {
            errors.push(`Virtual column already defined: '${name}'.`);
        }
    }

    for (const [name, expr] of Object.entries(columns)) {
        if (!expr) {
            errors.push(`Expression for virtual column '${name}' must be non-empty.`);
            continue;
        }
        if (!ExpressionProjector.isSafeExpression(expr)) {
            errors.push(`Unsafe virtual column expression for '${name}': ${expr}`);
            continue;
        }

        const vars = ExpressionProjector.extractVariables(expr);
        if (vars.length > 2) {
            errors.push(`Virtual column '${name}' uses more than 2 variables (${vars.length}).`);
        }

        for (const v of vars) {
            if (v === "__index__") continue;

            // 仮想列参照は禁止（自分以外の spec 内/既存仮想）
            if (specNameSet.has(v) || existingVirtualNames.has(v)) {
                errors.push(`Virtual column '${name}' may not reference another virtual column '${v}'.`);
                continue;
            }

            // 実在列チェック（厳密：大文字小文字も一致させる）
            if (!headers.includes(v)) {
                errors.push(`Unknown column referenced in '${name}': '${v}'.`);
            }
        }
    }

    return errors;
}

export { ViewSpec, ColumnSpec, ViewDefinition, isEqualViewDefinition, createDataView, inferViewDefinition, INITIAL_VIEW_DEFINITION };
