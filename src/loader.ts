import { FileLineReader, FileLineReaderOptions } from "./file_line_reader";
import { inferViewDefinition, ViewDefinition, DataView, isEqualViewDefinition, createDataView } from "./data_view";

export const columnDec = {
    toString(value: number | string) {
        return value.toString();
    }
};

export const columnHex = {
    toString(value: number | string) {
        return `0x${value.toString(16)}`;
    }
}

export const columnString = {
    toString(value: number | string) {
        return value.toString();
    }
}

type ColumnType = typeof columnDec | typeof columnHex | typeof columnString;

class ColumnStats {
    min: number = Infinity;
    max: number = -Infinity;
    deviationFromMax = 0;   // その時の最大値との偏差
}


// 内部で共有する最小インタフェース
export interface ColumnInterface {
    getNumber(i: number): number;
    getString(index: number): string;
    stat: { min: number; max: number, deviationFromMax: number };
    codeToValueList: (string | number)[] | null;
}

// 動的に拡張可能なバッファ
class ColumnBuffer implements ColumnInterface {
    private static readonly INITIAL_CAPACITY = 1024;

    // 格納タイプに応じて，buffer か string で持つかを変える
    type: ColumnType;
    length: number;

    buffer: Int32Array;
    rawStringList: string[]; // raw 文字列

    // 文字列の種類が少ない場合，code で保持し，圧縮して持つ
    // code は 0 から始まる連続値
    stringToCodeDict: { [value: string]: number };  // 文字列に対応する code を格納
    intToCodeDict: { [value: string]: number };  // 整数に対応する code を格納
    codeToValueList: (string | number)[] | null;

    // 統計情報
    stat: ColumnStats;

    constructor() {
        this.buffer = new Int32Array(ColumnBuffer.INITIAL_CAPACITY);
        this.length = 0;
        this.type = columnDec; // 初期は整数列
        this.stringToCodeDict = {};
        this.intToCodeDict = {};
        this.codeToValueList = null;
        this.rawStringList = [];
        this.stat = new ColumnStats();
    }

    getString(index: number): string {
        const value = this.codeToValueList ? this.codeToValueList[this.buffer[index]] :
                      this.type === columnString ? this.rawStringList[index] :
                      this.buffer[index];

        return this.type.toString(value);
    }

    getNumber(index: number): number {
        // 色づけの際にコードが取得される場合がある
        if (!this.codeToValueList && this.type === columnString) {
            throw new Error("Cannot get number from string column");
        }
        return this.buffer[index];
    }
}


class Loader {
    private lineNum: number = 1;
    private numRows_: number = 0;
    private numWarning: number = 0;

    private separatorIsTab_: boolean = true;

    private headers_: string[] = [];
    private headerIndex_: { [column: string]: number } = {};

    // データ保持
    private columnsArr_: ColumnBuffer[] = [];

    // DataView のキャッシュ
    private dataView_: DataView | null = null;
    private dataViewInvalidated_: boolean = false;

    // 型検出用
    private rawBuffer_: { [column: string]: string[] } = {};
    private detection_: { [column: string]: ColumnType } = {};
    private rawStringMap_: { [column: string]: { [value: string]: number } } = {};

    private detectionCount_: number = 0;
    private detectionDone_: boolean = false;
    private static readonly TYPE_DETECT_COUNT_ = 100000;
    get typeDetectLineNum() { return Loader.TYPE_DETECT_COUNT_; }
    private static readonly REPORT_INTERVAL_ = 1024 * 256;
    private startTime_: number = 0;
    private reader_: FileLineReader | null = null;

    private onFormatDetected_: null | (() => void) = null;
    private warningCallback_: null | ((msg: string) => void) = null;

    get detectionDone() { return this.detectionDone_; }

    constructor() {
        this.reset();
    }

    reset() {
        this.lineNum = 1;
        this.numRows_ = 0;
        this.numWarning = 0;
        this.headers_ = [];
        this.headerIndex_ = {};
        this.columnsArr_ = [];
        this.rawBuffer_ = {};
        this.detection_ = {};
        this.rawStringMap_ = {};
        this.detectionCount_ = 0;
        this.detectionDone_ = false;
        this.startTime_ = 0;
        if (this.reader_) {
            this.reader_.cancel();
            this.reader_ = null;
        }
        this.dataView_ = null;
        this.dataViewInvalidated_ = false;
        this.onFormatDetected_ = null;
    }

    load(
        reader: FileLineReader,
        finishCallback: (lines: number, elapsedMs: number) => void,
        formatDetected: () => void,
        progressCallback: (progress: number, lineNum: number) => void,
        errorCallback: (error: any, lineNum: number) => void,
        warningCallback: (msg: string) => void
    ) {
        this.reset();
        this.onFormatDetected_ = formatDetected;
        this.warningCallback_ = warningCallback;
        this.reader_ = reader;
        this.startTime_ = (new Date()).getTime();

        reader.load(
            (line: string) => { // onLineRead
                this.parseLine_(line);
                if (this.lineNum % Loader.REPORT_INTERVAL_ === 0) {
                    this.dataViewInvalidated_ = true;   // max を更新した可能性があるので invalidate
                    progressCallback(reader.getProgress(), this.lineNum);
                }
                this.lineNum++;
            },
            () => { // onFinish
                if (!this.detectionDone_) {
                    this.finalizeTypes_();
                }
                this.dataViewInvalidated_ = true;   // max を更新した可能性があるので invalidate
                let elapsed = ((new Date()).getTime() - this.startTime_);
                finishCallback(this.lineNum - 1, elapsed);
            },
            (error: any) => {   // onError
                errorCallback(error, this.lineNum);
            }
        );
    }

    // ヘッダー行設定
    private parseHeader_(line: string): void {
        // tab かカンマで区切られたヘッダーを想定
        line = line.trim();
        let commaValues = line.split(",");
        let tabValues = line.split("\t");
        this.separatorIsTab_ = (tabValues.length >= commaValues.length);

        let values = this.separatorIsTab_ ? tabValues : commaValues;
        this.headers_ = values;

        // データ列とタイプ検出用変数の初期化
        this.columnsArr_ = values.map((_, i) => (new ColumnBuffer()));
        values.forEach((header, i) => {
            this.headerIndex_[header] = i;
            this.rawBuffer_[header] = [];
            this.detection_[header] = columnDec; // 初期は整数列
            this.rawStringMap_[header] = {};
        });
    }

    private parseLine_(
        line: string
    ): void {
        line = line.trim();

        if (this.lineNum === 1) {
            this.parseHeader_(line);
        } else {
            let values = this.separatorIsTab_ ? line.split("\t") : line.split(",");

            // カラムに過不足がある場合
            if (values.length > this.headers_.length) {
                this.numWarning++;
                if (this.numWarning <= 10) {
                    this.warningCallback_?.(
                        `Warning: Line:${this.lineNum} Expected ${this.headers_.length} columns, but got ${values.length}`
                    );
                }
                values = values.slice(0, this.headers_.length);
            }
            if (values.length == 0) {
                return;
            }
            while (values.length < this.headers_.length) {
                values.push("");    // 不足分は空文字で埋める
            }

            // TYPE_DETECT_COUNT までは型検出を行う
            if (!this.detectionDone_) { 
                this.detectionCount_++;
                values.forEach((raw, index) => {
                    this.detectType_(this.headers_[index], raw ?? ""); // null or undefined to empty string
                });
                if (this.detectionCount_ === Loader.TYPE_DETECT_COUNT_) {
                    this.finalizeTypes_();
                }
            } else {
                values.forEach((raw, index) => {
                    const val = raw ?? "";
                    this.pushValue(index, val, false);
                });
            }

            this.numRows_++;
        }
    }


    private detectType_(header: string, value: string): void {
        this.rawBuffer_[header].push(value);
        const isHex = /^(?:0[xX])?[0-9A-Fa-f]+$/.test(value);
        const isDec = /^-?\d+$/.test(value);

        // 16進数が現れたら HEX に変更
        if (this.detection_[header] === columnDec && isHex && !isDec) {
            this.detection_[header] = columnHex;
        }
        // 数値じゃ無いものが1度でも現れたら STRING に変更
        if (this.detection_[header] !== columnString &&
            !((isHex || isDec) &&
              parseInt(value, this.detection_[header] === columnDec ? 10 : 16) <= 0x7fffffff)) {
            this.detection_[header] = columnString;
        }
        // 文字列の出現パターン数をカウントし，finalizeTypes_ で判定
        if (this.detection_[header] === columnString) {
            this.rawStringMap_[header][value] += 1;
        }
    }

    private finalizeTypes_(): void {
        this.headers_.forEach((header, index) => {
            // 文字列の出現パターン数をカウントし，一定割合を超えていたら raw string に
            let code = true;
            if (Object.keys(this.rawStringMap_[header]).length > Loader.TYPE_DETECT_COUNT_ / 3) {
                code = false;
            }

            let isOrgHex = this.detection_[header] === columnHex;
            if (this.detection_[header] === columnDec || this.detection_[header] === columnHex) {
                // 整数列の場合，出現パターン数が少なければ INT_CODE に変更
                const uniqueCount = new Set(this.rawBuffer_[header]).size;
                code = uniqueCount < 32;
            }
            const type = this.detection_[header];
            this.columnsArr_[index].type = type;

            if (code) {
                this.columnsArr_[index].codeToValueList = [];
            }

            // rawBufferからデータをバッファへ反映
            this.rawBuffer_[header].forEach(val => {
                this.pushValue(index, val, isOrgHex);
            });
            delete this.rawBuffer_[header];
        });
        this.detectionDone_ = true;
        this.onFormatDetected_?.();
    }

    private pushValue(index: number, raw: string, isOrgHex: boolean): void {
        const col = this.columnsArr_[index];
        if (col.codeToValueList) {
            if (col.type === columnString) {
                this.pushStringCode_(col.codeToValueList, index, raw);
            } else {
                this.pushIntCode_(col.codeToValueList, index, raw, isOrgHex);
            }
        } else if (col.type === columnString) {
            this.pushRawString_(index, raw);
        } else {
            this.pushBufferValue_(index, raw);
        }
    }

    // バッファサイズを拡張する
    private resizeBuffer_(index: number): void {
        const col = this.columnsArr_[index];
        if (col.length >= col.buffer.length) {
            const newBuf = new Int32Array(col.buffer.length * 2);
            newBuf.set(col.buffer);
            col.buffer = newBuf;
        }
    }

    /** Int32Array bufferに数値を追加 (整数・16進 or 10進) */
    private pushBufferValue_(index: number, raw: string): void {
        const col = this.columnsArr_[index];
        const num = col.type === columnHex ? parseInt(raw, 16) : parseInt(raw, 10);
        if (col.length >= col.buffer.length) {
            this.resizeBuffer_(index);
        }
        col.buffer[col.length] = num;
        col.length++;

        // stats更新
        const stat = col.stat;

        // その時の最大値からどのぐらい下がったか
        const dev = stat.max - num;
        if (stat.deviationFromMax < dev) {
            stat.deviationFromMax = dev;
        }
        if (num < stat.min) stat.min = num;
        if (num > stat.max) stat.max = num;
    }

    /** 文字列をコード化してbufferに追加 */
    private pushStringCode_(codeToValueList: (string | number)[], index: number, raw: string): void {
        const codeDict = this.columnsArr_[index].stringToCodeDict;
        let code: number;
        if (codeDict.hasOwnProperty(raw)) {
            code = codeDict[raw];
        } else {
            code = codeToValueList.length;
            codeDict[raw] = code;
            codeToValueList.push(raw);
        }
        // bufferに追加
        const col = this.columnsArr_[index];
        if (col.length >= col.buffer.length) {
            this.resizeBuffer_(index);
        }
        col.buffer[col.length] = code;
        col.length++;

        // stats更新
        const stat = col.stat;
        const dev = stat.max - code;
        if (stat.deviationFromMax < dev) {
            stat.deviationFromMax = dev;
        }
        if (code > stat.max) stat.max = code;
        if (code < stat.min) stat.min = code;
    }

    private pushIntCode_(codeToValueList: (string | number)[], index: number, raw: string, isHex = false): void {
        const codeDict = this.columnsArr_[index].intToCodeDict;
        let code: number;
        let val = isHex ? parseInt(raw, 16) : parseInt(raw, 10);
        if (codeDict.hasOwnProperty(val)) {
            code = codeDict[val];
        } else {
            code = codeToValueList.length;
            codeDict[val] = code;
            codeToValueList.push(val);
        }
        // bufferに追加
        const col = this.columnsArr_[index];
        if (col.length >= col.buffer.length) {
            this.resizeBuffer_(index);
        }
        col.buffer[col.length] = code;
        col.length++;

        // stats更新
        const stat = col.stat;
        const dev = stat.max - code;
        if (stat.deviationFromMax < dev) {
            stat.deviationFromMax = dev;
        }
        if (code > stat.max) stat.max = code;
        if (code < stat.min) stat.min = code;
    }

    // 文字列列の生データを追加
    private pushRawString_(index: number, raw: string): void {
        const col = this.columnsArr_[index];
        col.rawStringList.push(raw);
        col.length++;
    }

    // タイプの辞書を作って返す
    public get types(): { [column: string]: ColumnType } {
        const result: { [column: string]: ColumnType } = {};
        this.headers_.forEach((header, i) => {
            result[header] = this.columnsArr_[i].type;
        });
        return result;
    }

    public get stats(): { [column: string]: ColumnStats } {
        const result: { [column: string]: ColumnStats } = {};
        this.headers_.forEach((header, i) => {
            result[header] = this.columnsArr_[i].stat;
        });
        return result;
    }

    public get headers(): string[] {
        return this.headers_;
    }

    public get columns(): ColumnInterface[] {
        return this.columnsArr_;
    }

    public columnFromName(name: string): ColumnInterface {
        return this.columnsArr_[this.headerIndex_[name]];
    }

    public get headerIndexDict(): { [column: string]: number } {
        return this.headerIndex_;
    }

    public get numRows(): number {
        return this.numRows_;
    }

    public GetDataView(dataViewDef: ViewDefinition | null): DataView | null {
        if (dataViewDef === null) 
            return null;

        if (!this.dataView_ || this.dataViewInvalidated_  || 
            (dataViewDef && !isEqualViewDefinition(dataViewDef, this.dataView_.definition))
        ) {
            this.dataView_ = createDataView(this, dataViewDef);
            this.dataViewInvalidated_ = false;
        }
        return this.dataView_;
    }
}

export { Loader, ColumnType, ColumnBuffer, DataView, ColumnStats };
