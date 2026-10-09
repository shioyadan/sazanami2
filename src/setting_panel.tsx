import React, { useEffect, useMemo, useState } from "react";
import { Accordion } from "react-bootstrap";
import Store, { ACTION, CHANGE } from "./store";
import ViewDefinitionEditor from "./view_definition_editor";
import { BsX } from "react-icons/bs";

/** 配色 */
const BG_PANEL = "#1f2229";
const HEAD_BG  = "#242830";
const BD       = "#383B41";
const TXT      = "#E7E8E9";
const TXT_SUB  = "#C9CACB";

/** ドロップダウンの固定オプション */
const SIZE_OPTIONS: number[] = [0.1, 0.5, 1, 2, 3, 4, 5];

function nearestOption(v: number): number {
    let best: number = SIZE_OPTIONS[0], bestDiff = Math.abs(v - best);
    for (const x of SIZE_OPTIONS) { 
        const d = Math.abs(v - x); 
        if (d < bestDiff) { best = x; bestDiff = d; } 
    }
    return best;
}

/** Render 設定 */
export const RenderSettingsPanel: React.FC<{ store: Store }> = ({ store }) => {
    const initial = useMemo<number>(() => {
        const cur = Math.max(store.state.renderCtx.minPlotWidth, store.state.renderCtx.minPlotHeight);
        return nearestOption(cur);
    }, [store.state.renderCtx.minPlotWidth, store.state.renderCtx.minPlotHeight]);

    const [minSize, setMinSize] = useState<number>(initial);

    const apply = (nextSize: number) => {
        setMinSize(nextSize);
        const next = { 
            ...store.state.renderCtx, 
            minPlotWidth: nextSize, 
            minPlotHeight: nextSize 
        };
        store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next); 
    };

    return (
        <div style={{ padding: 10, display: "grid", gap: 8 }}>
            <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 12, color: TXT_SUB, lineHeight: 1.35 }}>
                    Minimum plot size (px)
                </span>
                <select
                    value={String(minSize)}
                    onChange={(e) => apply(parseFloat(e.target.value))}
                    style={{
                        background: HEAD_BG, color: TXT, borderRadius: 6,
                        padding: "6px 8px", border: `1px solid ${BD}`,
                        fontSize: 13, 
                    }}
                >
                    {SIZE_OPTIONS.map((opt) => 
                        (<option key={opt} value={String(opt)}>{opt}</option>))}
                </select>
            </label>
        </div>
    );
};

/** View 設定 */
export const ViewSettingsPanel: React.FC<{ store: Store }> = ({ store }) => {
    return (
        <div style={{ padding: 10 }}>
            <ViewDefinitionEditor store={store} />
        </div>
    );
};

const CompatibilitySettingsPanel: React.FC<{ store: Store }> = ({ store }) => {
    const [tiled, setTiled] = useState(store.state.tiledRenderingEnabled);
    useEffect(() => {
        const update = () => setTiled(store.state.tiledRenderingEnabled);
        store.on(CHANGE.COMPATIBILITY_CHANGED, update);
        return () => store.off(CHANGE.COMPATIBILITY_CHANGED, update);
    }, [store]);
    return <label style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", color: TXT, fontSize: 13 }}>
        <input type="checkbox" checked={tiled} onChange={event => store.trigger(ACTION.SET_TILED_RENDERING, event.target.checked)} />
        Tiled rendering
    </label>;
};

const SettingsPanel: React.FC<{ store: Store }> = ({ store }) => {
    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", background: BG_PANEL }}>
            {/* スタイル */}
            <style>{`
                [data-settings-acc="1"] .accordion, [data-settings-acc="1"] .accordion-item, [data-settings-acc="1"] .accordion-body { background-color: ${BG_PANEL}; border-color: ${BD}; }
                [data-settings-acc="1"] .accordion-item { border: 1px solid ${BD}; border-radius: 0; }
                [data-settings-acc="1"] .accordion-item + .accordion-item { border-top: none; }
                [data-settings-acc="1"] .accordion-button { padding: 6px 10px; background-color: ${HEAD_BG}; color: ${TXT}; box-shadow: none; font-weight: 600; letter-spacing: 0.1px; }
                [data-settings-acc="1"] .accordion-button:hover { background-color: #2b3038; }
                [data-settings-acc="1"] .accordion-button:not(.collapsed) { background-color: ${HEAD_BG}; color: ${TXT}; box-shadow: none; }
                [data-settings-acc="1"] .accordion-button:focus { box-shadow: none; }
                [data-settings-acc="1"] .accordion-button::after { filter: invert(1) grayscale(1) opacity(.7); }
                [data-settings-acc="1"] .accordion-body { line-height: 1.35; }
            `}</style>

            {/* 固定ヘッダ */}
            <div style={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: BG_PANEL, borderBottom: `1px solid ${BD}`, color: TXT }}>
                <div style={{ fontWeight: 600 }}>Settings</div>
                <button
                    onClick={() => store.trigger(ACTION.SHOW_SETTINGS, false)}
                    style={{ background: "transparent", border: "none", color: TXT, cursor: "pointer" }}
                    aria-label="Close settings" title="Close"
                >
                    <BsX size={16} />
                </button>
            </div>

            {/* 本体：View 上、Render 下 */}
            <div style={{ overflow: "auto" }} data-settings-acc="1">
                <Accordion defaultActiveKey={["view", "render"]} alwaysOpen>
                    <Accordion.Item eventKey="view">
                        <Accordion.Header>View</Accordion.Header>
                        <Accordion.Body style={{ padding: 0 }}>
                            <ViewSettingsPanel store={store} />
                        </Accordion.Body>
                    </Accordion.Item>
                    <Accordion.Item eventKey="render">
                        <Accordion.Header>Render</Accordion.Header>
                        <Accordion.Body style={{ padding: 0 }}>
                            <RenderSettingsPanel store={store} />
                        </Accordion.Body>
                    </Accordion.Item>
                    <Accordion.Item eventKey="compatibility">
                        <Accordion.Header>Compatibility</Accordion.Header>
                        <Accordion.Body style={{ padding: 0 }}>
                            <CompatibilitySettingsPanel store={store} />
                        </Accordion.Body>
                    </Accordion.Item>
                </Accordion>
            </div>
        </div>
    );
};

export default SettingsPanel;
