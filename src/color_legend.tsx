// color_legend.tsx
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Store, { CHANGE, ACTION } from "./store";
import { columnString } from "./loader";

type Props = {
    store: Store;
    direction?: "horizontal" | "vertical";
    maxCategories?: number;
    defaultVisible?: boolean;
};

const packedToCss = (p: number): string => {
    const r = p & 0xff;
    const g = (p >> 8) & 0xff;
    const b = (p >> 16) & 0xff;
    const a = ((p >> 24) & 0xff) / 255;
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

const paletteToLinearGradient = (
    palette: Uint32Array,
    direction: "horizontal" | "vertical"
): string => {
    if (!palette || palette.length === 0) return "transparent";
    const n = palette.length;
    const step = Math.max(1, Math.floor(n / 64));
    const stops: string[] = [];
    for (let i = 0; i < n; i += step) {
        const t = (i / (n - 1)) * 100;
        stops.push(`${packedToCss(palette[i])} ${t.toFixed(2)}%`);
    }
    if (!stops[stops.length - 1].includes("100%")) {
        stops.push(`${packedToCss(palette[n - 1])} 100%`);
    }
    const dir = direction === "horizontal" ? "to right" : "to top";
    return `linear-gradient(${dir}, ${stops.join(", ")})`;
}

const modIndex = (n: number, m: number): number => {
    const r = n % m;
    return r < 0 ? r + m : r;
}


const ColorLegend: React.FC<Props> = ({
    store,
    direction = "horizontal",
    maxCategories = 64,
    defaultVisible = false
}) => {
    // 表示制御（ツールバーの ACTION.SHOW_COLOR_LEGEND でトグル/セット）
    const [visible, setVisible] = useState<boolean>(defaultVisible);
    const [, setBump] = useState(0);

    useEffect(() => {
        // React に状態変更を伝えるためのダミーフック
        const bump = () => setBump((x) => x + 1);
        [CHANGE.VIEW_DEF_CHANGED, CHANGE.FILE_FORMAT_DETECTED, CHANGE.FILE_LOADED, CHANGE.CONTENT_UPDATED]
            .forEach(ev => store.on(ev, bump));

        const onToggle = (show?: boolean) => {
            if (typeof show === "boolean") setVisible(show);
            else setVisible((v) => !v);
        };
        store.on(ACTION.SHOW_COLOR_LEGEND, onToggle);

        return () => {
            [CHANGE.VIEW_DEF_CHANGED, CHANGE.FILE_FORMAT_DETECTED, CHANGE.FILE_LOADED, CHANGE.CONTENT_UPDATED]
                .forEach(ev => store.off(ev, bump));
            store.off(ACTION.SHOW_COLOR_LEGEND, onToggle);
        };
    }, [store]);

    // 表示内容（フック数は固定）
    const view = useMemo(() => {
        const def = store.state.viewDef;
        const loader = store.loader;
        const dv = loader.GetDataView(def);
        if (!dv) return { ready: false as const };

        const palette = dv.getPalette();
        const colorField = (dv.definition.view.colorField as string) ?? "";
        if (!colorField) {
            return {
                ready: true as const,
                mode: "none" as const,
                title: "Legend",
                palette
            };
        }

        const types = dv.types;
        const t = types[colorField];

        if (dv.isColorContinuous()) {
            return {
                ready: true as const,
                mode: "continuous" as const,
                title: `Legend · ${colorField}`,
                palette,
                min: t.toString(dv.getMinColor()),
                max: t.toString(dv.getMaxColor())
            };
        }

        const col = dv.columnFromName(colorField);

        type Item = { label: string; idx: number };
        const items: Item[] = [];

        if (col.codeToValueList) {
            const pairs = col.codeToValueList.map((value, code) => ({ value, code }));
            pairs.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.code - b.code));
            for (let i = 0; i < Math.min(pairs.length, maxCategories); i++) {
                const { value, code } = pairs[i];
                items.push({ label: `${t.toString(value)} (${code})`, idx: modIndex(code, palette.length) });
            }
        } else {
            if (t === columnString) {
                const seen = new Set<string>();
                const scan = Math.min(store.loader.numRows, maxCategories * 4);
                for (let i = 0; i < scan && items.length < maxCategories; i++) {
                    const s = col.getString(i);
                    if (seen.has(s)) continue;
                    seen.add(s);
                    let h = 0; for (let j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) | 0;
                    items.push({ label: s, idx: modIndex(h, palette.length) });
                }
            } else {
                const seen = new Set<number>();
                const scan = Math.min(store.loader.numRows, maxCategories * 4);
                for (let i = 0; i < scan && items.length < maxCategories; i++) {
                    const v = col.getNumber(i);
                    if (!Number.isFinite(v) || seen.has(v)) continue;
                    seen.add(v);
                    items.push({ label: t.toString(v), idx: modIndex(Math.trunc(v), palette.length) });
                }
            }
        }

        return {
            ready: true as const,
            mode: "categorical" as const,
            title: `Legend · ${colorField}`,
            palette,
            items
        };
    }, [store.state.viewDef, store.loader, direction, maxCategories]);

    // ドラッグ（全面ドラッグ可）
    const [pos, setPos] = useState<{ x: number; y: number }>(() => {
        return { x: 60, y: 60 };    // 初期位置
    });
    const boxRef = useRef<HTMLDivElement | null>(null);
    const dragging = useRef(false);
    const dragOffset = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!dragging.current) return;
            setPos({ x: e.clientX - dragOffset.current.dx, y: e.clientY - dragOffset.current.dy });
        };
        const onUp = () => {
            dragging.current = false;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, []);

    const beginDrag = (e: React.MouseEvent) => {
        const rect = boxRef.current?.getBoundingClientRect();
        if (!rect) return;
        dragging.current = true;
        dragOffset.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
    };

    // 非表示 or 未準備のときは描画しない（フックは上で全て呼んでいるのでOK）
    if (!visible || !view.ready) return null;

    const wrapStyle: React.CSSProperties = {
        position: "fixed",
        left: pos.x,
        top: pos.y,
        zIndex: 10000,
        background: "rgba(27,30,35,0.92)",
        border: "1px solid #383B41",
        borderRadius: 8,
        color: "#C9CACB",
        fontSize: 12,
        padding: 8,
        cursor: "grab",              // 全体ドラッグ
        userSelect: "none"
    };

    const titleStyle: React.CSSProperties = {
        fontWeight: 600,
        marginBottom: 6
    };

    const handleMouseDown = (e: React.MouseEvent) => beginDrag(e);

    if (view.mode === "continuous") {
        const grad = paletteToLinearGradient(view.palette!, direction);
        const barStyle: React.CSSProperties =
            direction === "horizontal"
                ? { width: 240, height: 16 }
                : { width: 16, height: 160 };
        return (
            <div ref={boxRef} style={wrapStyle} onMouseDown={handleMouseDown}>
                <div style={titleStyle}>{view.title}</div>
                <div
                    style={{
                        ...barStyle,
                        borderRadius: 4,
                        background: grad,
                        border: "1px solid #383B41"
                    }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, width: direction === "horizontal" ? 240 : 160 }}>
                    <span>{view.min}</span>
                    <span>{view.max}</span>
                </div>
            </div>
        );
    }

    if (view.mode === "categorical") {
        return (
            <div ref={boxRef} style={wrapStyle} onMouseDown={handleMouseDown}>
                <div style={titleStyle}>{view.title}</div>
                <div style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr" }}>
                    {view.items!.map((it, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                            <div
                                style={{
                                    width: 14,
                                    height: 14,
                                    borderRadius: 3,
                                    background: packedToCss(view.palette![Math.max(0, Math.min(view.palette!.length - 1, it.idx))]),
                                    border: "1px solid #383B41",
                                    flex: "0 0 auto"
                                }}
                            />
                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {it.label}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div ref={boxRef} style={wrapStyle} onMouseDown={handleMouseDown}>
            <div style={titleStyle}>{view.title}</div>
            <div style={{ opacity: 0.8 }}>No color field</div>
        </div>
    );
};

export default ColorLegend;
