import React, { useRef, useEffect, useState } from "react";
import Store, { ACTION, CHANGE } from "./store";
import ViewDefinitionEditor from "./view_definition_editor";


import { fileOpen } from "browser-fs-access";
import { Nav, Navbar, NavDropdown, Accordion, Modal } from "react-bootstrap";
import { INITIAL_RENDERER_CONTEXT } from "./canvas_renderer";

// react-icons 経由でアイコンをインポートすると，webpack でのビルド時に必要なアイコンのみがバンドルされる
import { BsList, BsX, BsArrowsFullscreen, BsJournalText, BsTrash, BsPalette } from 'react-icons/bs';

const ToolBar = (props: {store: Store;}) => {
    let store = props.store;
    const [logCount, setLogCount] = useState(0);

    const openFile = async () => {
         try {
            // ファイルを読み込む
            const file = await fileOpen();
            store.trigger(ACTION.FILE_LOAD_FROM_FILE_OBJECT, file);
         }
         catch (error) {
            store.trigger(ACTION.LOG_ADD, "Error opening file:" + error);
         }
        // console.log(contents); // ファイル内容を表示
    };

    // メニューアイテムの選択時の処理
    const dispatch = (selectedKey: string|null, event: React.SyntheticEvent<unknown>) => {
        event.preventDefault();    // ページ遷移を防ぐ
        switch (selectedKey) {
        case "menu_version":  store.trigger(ACTION.DIALOG_VERSION_OPEN); break;
        case "menu_load": openFile(); break;
        case "menu_keyboard_shortcuts": store.trigger(ACTION.DIALOG_HELP_OPEN); break;
        case "menu_settings": store.trigger(ACTION.SHOW_SETTINGS, !store.state.showSettings); break;
        case "menu_fit": store.trigger(ACTION.CANVAS_FIT); break;
        case "menu_debug_overlay_toggle": store.trigger(ACTION.SHOW_LOG_OVERLAY, !store.state.showDebugOverlay); break;
        case "menu_legend_toggle": store.trigger(ACTION.SHOW_COLOR_LEGEND); break;
        }
        setSelectedKey(0);
    };
    const [selectedKey, setSelectedKey] = useState(0);

    useEffect(() => { // マウント時
        const onAdded = () => setLogCount(c => c + 1);
        const onCleared = () => setLogCount(0);
        store.on(CHANGE.LOG_ADDED, onAdded);
        store.on(CHANGE.LOG_CLEARED, onCleared);
        return () => {
            store.off(CHANGE.LOG_ADDED, onAdded);
            store.off(CHANGE.LOG_CLEARED, onCleared);
        };
    }, []);

    return (
        <Navbar expand={true} 
            variant="dark"
            style={{ backgroundColor: "#272a31"}}
        >
            <Navbar.Toggle aria-controls="responsive-navbar-nav" />
            <Navbar.Collapse id="responsive-navbar-nav">
            <Nav onSelect={dispatch} activeKey={selectedKey}>
                <NavDropdown menuVariant="dark" title={<BsList size={16}/>} id="collapsible-nav-dropdown">
                    <NavDropdown.Item eventKey="menu_load">
                        Load file
                    </NavDropdown.Item>
                    <NavDropdown.Item eventKey="menu_settings">
                        Settings
                    </NavDropdown.Item>
                    <NavDropdown.Item eventKey="menu_keyboard_shortcuts">
                        Keyboard shortcuts
                    </NavDropdown.Item>
                    <NavDropdown.Divider />
                    <NavDropdown.Item eventKey="menu_version">
                        Version information
                    </NavDropdown.Item>
                </NavDropdown>
            </Nav>
            <Nav onSelect={dispatch} activeKey={selectedKey}
                style={{ color: "#C9CACB" }} className="me-auto" // このクラスでリンクが左側に配置される
            >
                <Nav.Link className="nav-link tool-bar-link" eventKey="menu_fit">
                    <BsArrowsFullscreen size={14} /> Fit
                </Nav.Link>
                <Nav.Link
                    className="nav-link tool-bar-link"
                    eventKey="menu_legend_toggle"
                    title="Show/Hide legend"
                >
                    <BsPalette size={14} /> Legend
                </Nav.Link>
                <Nav.Link
                    className="nav-link tool-bar-link"
                    eventKey="menu_debug_overlay_toggle"
                    title={logCount === 0 ? "No logs yet" : `${logCount} logs`}
                >
                    <BsJournalText size={14} />{" "}
                    {logCount > 0 ? `Log (${logCount})` : "Log"}
                </Nav.Link>
                {
                /*
                <Nav.Link className="nav-link tool-bar-link" eventKey="zoom-in">
                    <i className="bi bi-zoom-in"></i> Zoom In                
                </Nav.Link>
                <Nav.Link className="nav-link tool-bar-link" eventKey="zoom-out">
                    <i className="bi bi-zoom-out"></i> Zoom Out                
                </Nav.Link> */}
            </Nav>
            </Navbar.Collapse>
        </Navbar>
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

/** ファイルロード中のプログレスバー（ツールバー直下に表示） */
const LoadingBar: React.FC<{ store: Store }> = ({ store }) => {
    const [visible, setVisible] = useState(false);
    const [progress, setProgress] = useState<number | null>(null); // null = 不定

    useEffect(() => {
        const onStart = () => { setVisible(true); setProgress(null); };
        const onProgress = (val: number) => {
            setProgress(Math.max(0, Math.min(100, 100*val)));
        };
        const onEnd = () => { setVisible(false); setProgress(null); };

        store.on(CHANGE.FILE_LOADING_START, onStart);
        store.on(CHANGE.FILE_LOAD_PROGRESS, onProgress);
        store.on(CHANGE.FILE_LOADING_END, onEnd);

        return () => {
            store.off(CHANGE.FILE_LOADING_START, onStart);
            store.off(CHANGE.FILE_LOAD_PROGRESS, onProgress);
            store.off(CHANGE.FILE_LOADING_END, onEnd);
        };
    }, [store]);

    if (!visible) return null;

    return (
        <div style={{ background: "transparent"}}>
            <div
                style={{
                    height: "2px",
                    width: progress != null ? `${progress}%` : "0%",
                    backgroundColor: "#007bff", // 青
                }}
            />
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
