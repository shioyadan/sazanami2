import React, { useRef, useEffect, useState } from "react";
import Store, { ACTION, CHANGE } from "./store";
import { fileOpen } from "browser-fs-access";
import { Dropdown, Modal } from "react-bootstrap";

// react-icons 経由でアイコンをインポートすると，webpack でのビルド時に必要なアイコンのみがバンドルされる
import {
    BsList, BsX, BsArrowsFullscreen, BsJournalText, BsTrash, BsPalette,
    BsFolder2Open, BsSliders, BsKeyboard, BsInfoCircle
} from "react-icons/bs";

const ToolBar = ({ store }: { store: Store }) => {
    const [logCount, setLogCount] = useState(store.state.logs.length);
    const [showSettings, setShowSettings] = useState(store.state.showSettings);
    const [showLog, setShowLog] = useState(store.state.showDebugOverlay);
    const [showLegend, setShowLegend] = useState(false);

    const openFile = async () => {
        try {
            const file = await fileOpen();
            store.trigger(ACTION.FILE_LOAD_FROM_FILE_OBJECT, file);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") return;
            store.trigger(ACTION.LOG_ADD, "Error opening file: " + error);
        }
    };

    useEffect(() => {
        const onLogsChanged = () => setLogCount(store.state.logs.length);
        const onSettings = (show: boolean) => setShowSettings(show);
        const onLog = (show: boolean) => setShowLog(show);
        // 凡例はStoreの状態を持たないため、ColorLegendと同じ表示操作を購読する。
        const onLegend = (show?: boolean) => setShowLegend(current => typeof show === "boolean" ? show : !current);
        store.on(CHANGE.LOG_ADDED, onLogsChanged);
        store.on(CHANGE.LOG_CLEARED, onLogsChanged);
        store.on(CHANGE.SHOW_SETTINGS, onSettings);
        store.on(CHANGE.LOG_OVERLAY_VISIBILITY_CHANGED, onLog);
        store.on(ACTION.SHOW_COLOR_LEGEND, onLegend);
        return () => {
            store.off(CHANGE.LOG_ADDED, onLogsChanged);
            store.off(CHANGE.LOG_CLEARED, onLogsChanged);
            store.off(CHANGE.SHOW_SETTINGS, onSettings);
            store.off(CHANGE.LOG_OVERLAY_VISIBILITY_CHANGED, onLog);
            store.off(ACTION.SHOW_COLOR_LEGEND, onLegend);
        };
    }, [store]);

    return (
        <header className="app-toolbar" aria-label="Application toolbar">
            <button
                className="toolbar-action toolbar-primary" type="button"
                aria-label="Open file" title="Open file"
                onClick={() => void openFile()}
            >
                <BsFolder2Open aria-hidden="true" />
                <span className="toolbar-label">Open</span>
            </button>
            <button
                className="toolbar-action" type="button"
                aria-label="Fit data to canvas" title="Fit data to canvas"
                onClick={() => store.trigger(ACTION.CANVAS_FIT)}
            >
                <BsArrowsFullscreen aria-hidden="true" />
                <span className="toolbar-label">Fit</span>
            </button>
            <button
                className="toolbar-action" type="button"
                aria-label="View settings" title="View settings" aria-pressed={showSettings}
                onClick={() => store.trigger(ACTION.SHOW_SETTINGS, !store.state.showSettings)}
            >
                <BsSliders aria-hidden="true" />
                <span className="toolbar-label">View</span>
            </button>
            <button
                className="toolbar-action" type="button"
                aria-label="Color legend" title="Show or hide color legend" aria-pressed={showLegend}
                onClick={() => store.trigger(ACTION.SHOW_COLOR_LEGEND)}
            >
                <BsPalette aria-hidden="true" />
                <span className="toolbar-label">Legend</span>
            </button>
            <button
                className="toolbar-action" type="button"
                aria-label="Application log" aria-pressed={showLog}
                title={logCount === 0 ? "Application log" : `Application log: ${logCount} messages`}
                onClick={() => store.trigger(ACTION.SHOW_LOG_OVERLAY, !store.state.showDebugOverlay)}
            >
                <BsJournalText aria-hidden="true" />
                <span className="toolbar-label">Log</span>
                {logCount > 0 && (
                    <span className="toolbar-log-count" aria-label={`${logCount} log messages`}>
                        {logCount > 99 ? "99+" : logCount}
                    </span>
                )}
            </button>
            <div className="toolbar-spacer" />
            <Dropdown className="application-menu" focusFirstItemOnShow="keyboard">
                <Dropdown.Toggle
                    id="application-menu" variant="" className="toolbar-action"
                    aria-label="Application menu" title="Application menu"
                >
                    <BsList aria-hidden="true" />
                    <span className="toolbar-label">Menu</span>
                </Dropdown.Toggle>
                <Dropdown.Menu
                    align="end" className="application-menu-panel" variant="dark"
                    popperConfig={{ modifiers: [{ name: "offset", options: { offset: [0, 8] } }] }}
                >
                    <Dropdown.Item as="button" onClick={() => store.trigger(ACTION.SHOW_LOG_OVERLAY, true)}>
                        <BsJournalText aria-hidden="true" /> Application log
                    </Dropdown.Item>
                    <Dropdown.Item as="button" onClick={() => store.trigger(ACTION.DIALOG_HELP_OPEN)}>
                        <BsKeyboard aria-hidden="true" /> Keyboard shortcuts
                    </Dropdown.Item>
                    <Dropdown.Divider />
                    <Dropdown.Item as="button" onClick={() => store.trigger(ACTION.DIALOG_VERSION_OPEN)}>
                        <BsInfoCircle aria-hidden="true" /> Version information
                    </Dropdown.Item>
                </Dropdown.Menu>
            </Dropdown>
        </header>
    );
};

const StatusBar = (props: {store: Store;}) => {
    let store = props.store;
    const [statusBarMessage, setStatusBarMessage] = useState("");

    useEffect(() => { // マウント時
        store.on(CHANGE.MOUSE_MOVE, (message: string) => {
            setStatusBarMessage(message);
        });
        store.on(CHANGE.SHOW_MESSAGE_IN_STATUS_BAR, (message: string) => {
            setStatusBarMessage(message);
        });
    }, []);

    return (
        // {/* <div style={{ height: "40px", backgroundColor: "#eee", padding: "10px", textAlign: "left", borderTop: "1px solid #ccc" }}>
        //     <span>{statusBarMessage}</span> */}
        <div style={{ height: "24px", minHeight: "24px", 
            backgroundColor: "#272a31", 
            paddingLeft: "8px", 
            textAlign: "left", borderTop: "0.4px solid #383B41"}}
        >
            <span style={{ color: "#C9CACB", fontSize: "12px" }}>{statusBarMessage}</span>
        </div>
    );
};

/** 読み込みと索引生成のプログレスバーをツールバー直下へ積む。 */
const LoadingBar: React.FC<{ store: Store }> = ({ store }) => {
    const [visible, setVisible] = useState(false);
    const [progress, setProgress] = useState<number | null>(null); // null = 不定
    const [indexProgress, setIndexProgress] = useState<number | null>(store.loader.axisIndexes.progress);

    useEffect(() => {
        const onStart = () => { setVisible(true); setProgress(null); };
        const onProgress = (val: number) => {
            setProgress(Math.max(0, Math.min(100, 100*val)));
        };
        const onEnd = () => { setVisible(false); setProgress(null); };

        store.on(CHANGE.FILE_LOADING_START, onStart);
        store.on(CHANGE.FILE_LOAD_PROGRESS, onProgress);
        store.on(CHANGE.FILE_LOADING_END, onEnd);
        store.on(CHANGE.AXIS_INDEX_PROGRESS, setIndexProgress);
        setIndexProgress(store.loader.axisIndexes.progress);

        return () => {
            store.off(CHANGE.FILE_LOADING_START, onStart);
            store.off(CHANGE.FILE_LOAD_PROGRESS, onProgress);
            store.off(CHANGE.FILE_LOADING_END, onEnd);
            store.off(CHANGE.AXIS_INDEX_PROGRESS, setIndexProgress);
        };
    }, [store]);

    return (
        // 表示の開始・終了でCanvasの高さが変わり、表示準備をやり直すことを避ける。
        <div style={{ height: "4px", flexShrink: 0, backgroundColor: "#272a31" }}>
            <div style={{ height: "2px" }}>
                {visible && <div
                    role="progressbar" aria-label="Loading file"
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}
                    style={{ height: "2px", width: progress != null ? `${progress}%` : "0%", backgroundColor: "#007bff" }}
                />}
            </div>
            <div style={{ height: "2px" }}>
                {indexProgress !== null && <div
                    role="progressbar" aria-label="Indexing axes"
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={indexProgress * 100}
                    title={`Indexing axes: ${Math.floor(indexProgress * 100)}%`}
                    style={{ height: "2px", width: `${indexProgress * 100}%`, backgroundColor: "#f0ad4e" }}
                />}
            </div>
        </div>
    );
};


const VersionDialog = (props: {store: Store;}) => {
    const [show, setShow] = useState(false);
    const handleClose = () => {setShow(false)};
    
    useEffect(() => { // マウント時
        props.store.on(CHANGE.DIALOG_VERSION_OPEN, () => {setShow(true)});
    }, []);
    
    return (
        <Modal show={show} onHide={handleClose}>
        <Modal.Header closeButton>
            <Modal.Title>Version Information</Modal.Title>
        </Modal.Header>  
        <Modal.Body>Sazanami2 Version 0.0.2</Modal.Body>             
        </Modal>
    );
};

const HelpDialog = (props: { store: Store }) => {
    const [show, setShow] = useState(false);
    const handleClose = () => setShow(false);

    useEffect(() => {
        const openListener = () => setShow(true);
        props.store.on(CHANGE.DIALOG_HELP_OPEN, openListener);
        return () => {
            props.store.off(CHANGE.DIALOG_HELP_OPEN, openListener);
        };
    }, [props.store]);

    return (
        <Modal show={show} onHide={handleClose}>
            <Modal.Header closeButton>
                <Modal.Title>Help</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                {(() => {
                    const liStyle = { display: "flex", gap: "1rem", marginBottom: "0.5rem" };
                    const kbdStyle = { minWidth: "128px" };
                    return (
                        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                            <li style={liStyle}><kbd style={kbdStyle}>Drag with left button</kbd><span>Pan.</span></li>
                            <li style={liStyle}><kbd style={kbdStyle}>Drag with right button</kbd><span>Pinch.</span></li>
                            <li style={liStyle}><kbd style={kbdStyle}>Shift + mouse wheel</kbd><span>Zoom horizontal only.</span></li>
                            <li style={liStyle}><kbd style={kbdStyle}>Ctrl/⌘ + mouse wheel</kbd><span>Zoom in/out.</span></li>
                            <li style={liStyle}><kbd style={kbdStyle}>Ctrl/⌘ + up/down</kbd><span>Zoom vertical only.</span></li>
                            <li style={liStyle}><kbd style={kbdStyle}>Ctrl/⌘ + left/right</kbd><span>Zoom horizontal only.</span></li>
                            <li style={liStyle}><kbd style={kbdStyle}>Shift + up/down</kbd><span>Zoom in/out.</span></li>
                            <li style={liStyle}><kbd style={kbdStyle}>Ctrl/⌘ + ('+' / '-')</kbd><span>Zoom in/out.</span></li>
                        </ul>
                    );
                })()}
            </Modal.Body>
        </Modal>
    );
};


type SplitContainerProps = {
    leftPanel: React.ReactNode;
    rightPanel: React.ReactNode;
    defaultShowSettings?: boolean;
    defaultRightWidth?: number;
    store: Store;
};

const SplitContainer: React.FC<SplitContainerProps> = ({
    leftPanel,
    rightPanel,
    defaultShowSettings = true,
    defaultRightWidth = 260,
    store
}) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const draggingRef = useRef(false);

    const [showSettings, setShowSettings] = useState<boolean>(defaultShowSettings);
    const [rightWidth, setRightWidth] = useState<number>(defaultRightWidth);

    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            if (!draggingRef.current || !containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const xFromRight = rect.right - e.clientX; // distance from cursor to container's right edge
            const min = 160;
            const max = Math.max(240, rect.width * 0.7);
            const next = Math.min(Math.max(xFromRight, min), max);
            setRightWidth(next);
        };
        const onMouseUp = () => {
            draggingRef.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);

        const showSettingsListener = (show: boolean) => {
            setShowSettings(show);
        };
        store.on(CHANGE.SHOW_SETTINGS, showSettingsListener);

        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            store.off(CHANGE.SHOW_SETTINGS, showSettingsListener);
        };
    }, []);

    const handleSplitterDown = () => {
        draggingRef.current = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    return (
        <div style={{ flexGrow: 1, minHeight: 0, display: "flex" }} ref={containerRef}>
            {/* Left panel */}
            <div style={{ flex: 1, minWidth: 0 }}>
                {leftPanel}
            </div>

            {/* Splitter */}
            {showSettings && (
                <div
                    onMouseDown={handleSplitterDown}
                    role="separator"
                    aria-orientation="vertical"
                    className="splitter" 
                />
            )}

            {/* Right panel */}
            {showSettings && (
                <div 
                    className="splitter-right-panel" 
                    style={{ width: rightWidth, overflow: "auto" }}>
                    {rightPanel}
                </div>
            )}
        </div>
    );
};


type Props = {
    store: Store;
    width?: number;
    height?: number;
};

const LogOverlay: React.FC<Props> = ({ store, width = 420, height = 120 }) => {
    const [logs, setLogs] = useState<string[]>([]);
    const [visible, setVisible] = useState<boolean>(store.state.showDebugOverlay);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const onAdded = (entry: string) => setLogs(prev => [...prev, entry]);
        const onCleared = () => setLogs([]);
        const onVis = (show: boolean) => setVisible(show);

        store.on(CHANGE.LOG_ADDED, onAdded);
        store.on(CHANGE.LOG_CLEARED, onCleared);
        store.on(CHANGE.LOG_OVERLAY_VISIBILITY_CHANGED, onVis);

        setVisible(store.state.showDebugOverlay);

        return () => {
            store.off(CHANGE.LOG_ADDED, onAdded);
            store.off(CHANGE.LOG_CLEARED, onCleared);
            store.off(CHANGE.LOG_OVERLAY_VISIBILITY_CHANGED, onVis);
        };
    }, [store]);

    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [logs]);

    // 非表示なら描画しない
    if (!visible) return null;

    const iconBtn: React.CSSProperties = {
        position: "absolute",
        top: 2,
        width: 22,
        height: 22,
        border: "none",
        background: "transparent",
        color: "#E6E7E9",
        cursor: "pointer",
        padding: 0,
        display: "grid",
        placeItems: "center",
        lineHeight: 0
    };

    return (
        <div
            style={{
                position: "fixed",
                left: 8,
                bottom: 32, // StatusBar(24px)直上
                width,
                height,
                zIndex: 9999,
                overflow: "hidden",
                borderRadius: 6,
                background: "rgba(0,0,0,0.55)",
                color: "#E6E7E9",
                fontSize: 12,
                fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace'
            }}
        >
            {/* Clear（ゴミ箱アイコン） */}
            <button
                onClick={() => store.trigger(ACTION.LOG_CLEAR)}
                title="Clear"
                aria-label="Clear logs"
                style={{ ...iconBtn, right: 26 }}
            >
                <BsTrash size={14} />
            </button>

            {/* Close（バツアイコン） */}
            <button
                onClick={() => store.trigger(ACTION.SHOW_LOG_OVERLAY, false)}
                title="Close"
                aria-label="Close overlay"
                style={{ ...iconBtn, right: 4 }}
            >
                <BsX size={16} />
            </button>

            {/* 本文（メッセージだけ） */}
            <div
                ref={listRef}
                style={{
                    height: "100%",
                    overflow: "auto",
                    padding: "6px 8px",
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    paddingRight: 48 // 右上アイコン分の余白
                }}
            >
                {logs.map(l => (
                    <div>{l}</div>
                ))}
            </div>
        </div>
    );
};

export {ToolBar, StatusBar, LoadingBar, VersionDialog, HelpDialog, SplitContainer, LogOverlay};
