// store.ts
import { Loader } from "./loader";
import { ViewDefinition, DataView, inferViewDefinition, createDataView, INITIAL_VIEW_DEFINITION } from "./data_view";
import { Settings } from "./settings";
import { FileRecordReader } from "./file_record_reader";
import { RendererContext, INITIAL_RENDERER_CONTEXT } from "./canvas_renderer";

// ACTION は ACTION_END の直前に追加していく（CHANGE の開始値に影響するため）
enum ACTION {
    FILE_LOAD_FROM_FILE_OBJECT,
    FILE_LOAD_FROM_FILE_RECORD_READER,
    FILE_LOAD_FROM_URL,
    DIALOG_VERSION_OPEN,
    DIALOG_HELP_OPEN,
    MOUSE_MOVE,
    SHOW_SETTINGS, // 設定パネルの表示
    SHOW_MESSAGE_IN_STATUS_BAR,
    CANVAS_FIT,
    SET_VIEW_SPEC, // 互換用（未使用なら残しておく）
    VIEW_DEF_APPLY,           // ビューから設定
    VIEW_DEF_INFER_REQUEST,   // データから推論（コミットに反映）
    LOG_ADD,                  // 文字列ログを追加
    LOG_CLEAR,                // ログをクリア
    SHOW_LOG_OVERLAY,       // デバッグオーバーレイの表示/非表示
    SETTINGS_SAVE_REQUEST,  // 設定保存リクエスト
    UPDATE_RENDERER_CONTEXT,    // RendererContext の更新
    SHOW_COLOR_LEGEND,         // カラーレジェンドの表示/非表示
    ACTION_END, // 末尾
};

enum CHANGE {
    FILE_LOADED = ACTION.ACTION_END + 1,
    FILE_LOADING_START,
    FILE_FORMAT_DETECTED,
    FILE_LOAD_PROGRESS,
    FILE_LOADING_END,
    DIALOG_VERSION_OPEN,
    DIALOG_HELP_OPEN,
    MOUSE_MOVE,
    SHOW_SETTINGS, // 設定パネルの表示
    SHOW_MESSAGE_IN_STATUS_BAR,
    CHANGE_UI_THEME,
    CONTENT_UPDATED,
    CANVAS_FIT,

    HEADERS_CHANGED,          // ヘッダ一覧が利用可能になった／変わった
    VIEW_DEF_CHANGED,         // コミット済み ViewDefinition が変わった
    VIEW_DEF_PREVIEWED,       // プレビューが適用された（必要に応じて購読）
    LOG_ADDED,                // payload: LogEntry
    LOG_CLEARED,
    LOG_OVERLAY_VISIBILITY_CHANGED, // payload: boolean
};

type StoreState = Readonly<{
    renderCtx: RendererContext;     // レンダラのコンテクスト
    viewDef: ViewDefinition;         // ビューの定義
    showSettings: boolean;          // 設定パネルの表示フラグ
    showDebugOverlay: boolean;      // デバッグオーバーレイの表示フラグ
    logs: readonly string[];        // ログの配列
}>;

// 初期値
const INITIAL_STORE_STATE: StoreState = {
    renderCtx: INITIAL_RENDERER_CONTEXT,
    viewDef: INITIAL_VIEW_DEFINITION,
    showSettings: true,
    showDebugOverlay: false,
    logs: [],
} as const;

class Store {
    // イベントハンドラ登録
    handlers_: { [key: number]: Array<(...args: any[]) => void> } = {};

    // Loader（TSV 読み込み・列アクセス）
    loader: Loader;

    // state はイミュータブルに持つ
    private state_: StoreState = INITIAL_STORE_STATE;
    get state(): StoreState { return this.state_; }

    // 内部専用：状態の置換（常に新インスタンスで）
    private setState(next: StoreState) {
        this.state_ = next;
    }

    // 部分更新（パッチ）ユーティリティ
    private patchState(patch: Partial<StoreState>) {
        this.setState({ ...this.state_, ...patch });
    }

    // アプリ設定
    settings = new Settings();
    saveDefinition() {
        if (this.state_.viewDef && this.loader.headers.length > 0) {
            const key = (this.loader.headers ?? []).join("--");
            if (key) {
                this.settings.viewDefMapHistory[key] = this.state_.viewDef;
                this.settings.save();
            }
        }
    };

    constructor() {
        this.settings.load();
        this.loader = new Loader();

        
        // ---------------- ファイルロード ----------------
        this.on(ACTION.FILE_LOAD_FROM_FILE_OBJECT, (file: File) => {
            const reader = new FileRecordReader({ file });
            this.trigger(ACTION.FILE_LOAD_FROM_FILE_RECORD_READER, reader);
        });
        this.on(ACTION.FILE_LOAD_FROM_FILE_RECORD_READER, (fileRecordReader: FileRecordReader) => {
            this.saveDefinition();
            // 新規ファイル読み込み時は ViewDefinition をリセット
            this.patchState({ viewDef: INITIAL_VIEW_DEFINITION });
            this.trigger(CHANGE.FILE_LOADING_START);

            this.loader.load(
                fileRecordReader,
                () => {
                    // フォーマット検出完了
                    let key = (this.loader.headers ?? []).join("--");
                    let def: ViewDefinition | null = null;
                    if (key != "" && key in this.settings.viewDefMapHistory) {  // 過去に保存された定義があれば復元して適用
                        def = this.settings.viewDefMapHistory[key];
                    }
                    else {
                        def = inferViewDefinition(this.loader);
                    }
                    applyDefinition(def);
                    this.trigger(CHANGE.FILE_FORMAT_DETECTED);
                },
                (percent, _recordNum) => {
                    // 進捗
                    this.trigger(CHANGE.FILE_LOAD_PROGRESS, percent);
                    this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, `${Math.floor(percent * 100)}% Loaded`);
                    this.trigger(ACTION.UPDATE_RENDERER_CONTEXT, 
                        { ...this.state_.renderCtx, numRows: this.loader.numRows });
                    this.trigger(CHANGE.CONTENT_UPDATED);
                },
                (msg) => { // warning
                    this.trigger(ACTION.LOG_ADD, msg);
                }
            ).then(([records, elapsedMs]) => {
                // ロード完了
                this.trigger(CHANGE.FILE_LOADING_END);
                this.trigger(CHANGE.FILE_LOADED);
                // ヘッダが揃ったことを通知（Editor の候補更新用）
                this.trigger(CHANGE.HEADERS_CHANGED, this.loader.headers);
                // キャンバス再描画など
                this.trigger(CHANGE.CONTENT_UPDATED);

                // メッセージ
                let message = `File loaded successfully: ${records} records in ${elapsedMs} ms`;
                this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, message);
                this.trigger(ACTION.LOG_ADD, message);
            }, (err) => {
                if (err.name == "AbortError") {
                    return;
                }

                console.error(`Error loading file: ${err}`);
                this.trigger(CHANGE.FILE_LOADING_END);
                this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, "Failed to load file");
                this.trigger(ACTION.LOG_ADD, "File load failed: " + err);
            });
        });

        this.on(ACTION.DIALOG_VERSION_OPEN, () => { this.trigger(CHANGE.DIALOG_VERSION_OPEN); });
        this.on(ACTION.DIALOG_HELP_OPEN, () => { this.trigger(CHANGE.DIALOG_HELP_OPEN); });
        this.on(ACTION.MOUSE_MOVE, (str) => { this.trigger(CHANGE.MOUSE_MOVE, str); });
        this.on(ACTION.SHOW_MESSAGE_IN_STATUS_BAR, (str) => { this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, str); });
        this.on(ACTION.SHOW_SETTINGS, (show) => {
            this.patchState({ showSettings: show });
            this.trigger(CHANGE.SHOW_SETTINGS, show);
        });
        this.on(ACTION.CANVAS_FIT, () => { this.trigger(CHANGE.CANVAS_FIT); });

        this.on(ACTION.LOG_ADD, (payload: string) => {
            const nextLogs = [...this.state_.logs, payload];
            this.patchState({ logs: nextLogs });
            this.trigger(CHANGE.LOG_ADDED, payload);
        });
        this.on(ACTION.LOG_CLEAR, () => {
            this.patchState({ logs: [] });
            this.trigger(CHANGE.LOG_CLEARED);
        });

        this.on(ACTION.SHOW_LOG_OVERLAY, (show: boolean) => {
            this.patchState({ showDebugOverlay: !!show });
            this.trigger(CHANGE.LOG_OVERLAY_VISIBILITY_CHANGED, this.state_.showDebugOverlay);
        });

        this.on(ACTION.SETTINGS_SAVE_REQUEST, () => {
            this.saveDefinition();
            this.settings.save();
        });

        this.on(ACTION.UPDATE_RENDERER_CONTEXT, (renderCtx: RendererContext) => {
            if (renderCtx === this.state_.renderCtx) return; // 変更なし最適化
            this.patchState({ renderCtx });
            this.trigger(CHANGE.CONTENT_UPDATED);
        });

        // data_view.ts のバリデーションを用いて厳密チェックし、初期化が通るかを確認する
        const validateAndTryInit_ = (def: ViewDefinition): boolean => {
            try {
                // 初期化が通る＝レンダリング可能な定義
                const dv = createDataView(this.loader, def);
                return true;
            } catch (e) {
                let msg = "DataView.init failed:" + e;
                console.error(msg);
                this.trigger(ACTION.LOG_ADD, msg);
                return false;
            }
        }

        // Apply: バリデーションのうえでコミット＆適用
        const applyDefinition = (def: ViewDefinition) => {
            const ok = validateAndTryInit_(def);
            this.patchState({ viewDef: def });
            if (!ok) {
                this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, "Apply failed: validation error");
                return;
            }
            this.trigger(CHANGE.VIEW_DEF_CHANGED, def);
        }

        this.on(ACTION.VIEW_DEF_APPLY, (def: ViewDefinition) => {
            applyDefinition(def);
            this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, "View applied");
            this.trigger(CHANGE.CONTENT_UPDATED);
        });

        // Infer: データから推論 → コミット＆適用（ドラフト初期化のため CHANGE を飛ばす）
        this.on(ACTION.VIEW_DEF_INFER_REQUEST, () => {
            const inferred = inferViewDefinition(this.loader);
            applyDefinition(inferred);
            this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, "View applied");
            this.trigger(CHANGE.CONTENT_UPDATED);
        });

        // URL にファイルが渡されていたら，それをロード
        this.on(ACTION.FILE_LOAD_FROM_URL, async (url: string) => {
            if (!url) return;

            try {
                const reader = new FileRecordReader({url});
                // 既存の読み込みフローへ
                this.trigger(ACTION.LOG_ADD, `Loading from URL: ${url}`);
                this.trigger(ACTION.FILE_LOAD_FROM_FILE_RECORD_READER, reader);
            } catch (e) {
                console.error(e);
                this.trigger(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, "Failed to fetch ?file= URL");
                this.trigger(ACTION.LOG_ADD, `Auto-load failed: ${e}`);
            }
        });

    } // constructor()

    on(event: CHANGE | ACTION, handler: (...args: any[]) => void): void {
        if (!(event in CHANGE || event in ACTION)) {
            console.log(`Unknown event ${event}`);
        }
        if (!(event in this.handlers_)) {
            this.handlers_[event] = [];
        }
        this.handlers_[event].push(handler);
    }

    off(event: CHANGE | ACTION, handler?: (...args: any[]) => void): void {
        if (!(event in CHANGE || event in ACTION)) {
            console.warn(`Unknown event ${event}`);
            return;
        }
        const list = this.handlers_[event];
        if (!list || list.length === 0) {
            return;
        }
        if (handler) {
            this.handlers_[event] = list.filter(h => h !== handler);
        } else {
            delete this.handlers_[event];
        }
    }

    trigger(event: CHANGE | ACTION, ...args: any[]) {
        if (!(event in CHANGE || event in ACTION)) {
            console.log(`Unknown event ${event}`);
        }
        if (event in this.handlers_) {
            const handlers = this.handlers_[event];
            for (const h of handlers) {
                h.apply(null, args);
            }
        }
    }

}

export default Store;
export { ACTION, CHANGE };
