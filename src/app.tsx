// src/app.tsx
import React, { useRef, useEffect } from "react";
import Store, { ACTION } from "./store";

import {StatusBar, ToolBar, LoadingBar, VersionDialog, HelpDialog, SplitContainer, LogOverlay} from "./ui_parts";
import SettingsPanel from "./setting_panel";
import ColorLegend from "./color_legend";

import MainCanvas from "./main_canvas";

const App = () => {
    const storeRef = useRef(new Store());
    const divRef = useRef<HTMLDivElement>(null);
    useEffect(() => { // マウント時

        // ページ離脱時に設定保存
        const onPageHide = () => {
            storeRef.current.trigger(ACTION.SETTINGS_SAVE_REQUEST);
        };
        window.addEventListener("pagehide", onPageHide); 

        // URL からのファイル読み出し
        const getTargetFileURL = (): string | null => {
            const search = new URLSearchParams(window.location.search);
            let url = search.get("file");
            if (!url && window.location.hash.startsWith("#file=")) {
                url = decodeURIComponent(window.location.hash.slice("#file=".length));
            }
            if (!url) return "";
            const abs = new URL(url, window.location.href).toString();  // 相対パス対応（<base> 未設定でも ok）
            return abs;
        }
        const loadFromLocation = () => {
            storeRef.current.trigger(ACTION.FILE_LOAD_FROM_URL, getTargetFileURL());    // URL パラメータからの自動読み込み試行
        }
        window.addEventListener("hashchange", loadFromLocation);    // ハッシュ変更で再ロード
        window.addEventListener("popstate", loadFromLocation);  // 履歴APIで ?file= を pushState/replaceState している場合の戻る/進む対応
        loadFromLocation(); // 初回ロード

        // クリーンアップ
        return () => {
            window.removeEventListener("pagehide", onPageHide);
            window.removeEventListener("hashchange", loadFromLocation);
            window.removeEventListener("popstate", loadFromLocation);
        };

    }, []);

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        divRef.current!.style.cursor = "default";
        const file = e.dataTransfer.files[0];
        if (file) {
            storeRef.current.trigger(ACTION.FILE_LOAD_FROM_FILE_OBJECT, file);
        }
    };
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => e.preventDefault();

    return (
        <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            ref={divRef}
        >
            {/* // flexDirection: "column" と flexGrow: 1 を使うことで，Canvas が画面いっぱいに広がるようにしている */}
            <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
                <ToolBar store={storeRef.current} />
                <LoadingBar store={storeRef.current} />
                <SplitContainer store={storeRef.current}
                    leftPanel={<MainCanvas store={storeRef.current} />}
                    rightPanel={<SettingsPanel store={storeRef.current} />}
                />
                <ColorLegend store={storeRef.current} />
                <LogOverlay store={storeRef.current} />
                <StatusBar store={storeRef.current} />
            </div>
            <VersionDialog store={storeRef.current} />
            <HelpDialog store={storeRef.current} />
        </div>
    );
};

export default App;
