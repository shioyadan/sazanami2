import React, { useRef, useEffect, createContext, useContext } from "react";
import Store, { ACTION, CHANGE } from "./store";
import { CanvasRenderer, RendererContext, GridMap, scaleX, scaleY } from "./canvas_renderer";

const MainCanvas: React.FC<{ store: Store }> = ({ store }) => {
    const rendererRef = useRef<CanvasRenderer>(new CanvasRenderer());
    const gridMapRef = useRef<GridMap>(new GridMap());
    const divRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // ズーム用アニメーションの RA フレームID
    const zoomRafIdRef = useRef<number | null>(null);
    // パン（スクロール）
    const panRef = useRef({ remainingDx: 0, remainingDy: 0, rafId: null as number | null });

    // 一回の操作あたりのアニメーション時間（一定時間で終わる）
    const ZOOM_DURATION_MS = 90;        // ズームの所要時間
    const PAN_DURATION_MS = 90;         // パンの所要時間
    const ZOOM_DIVISIONS_WHEEL = 10;    // ホイールズームの分割数
    const ZOOM_DIVISIONS_KEY = 10;      // キー操作ズームの分割数

    // タッチジェスチャー状態
    const touchRef = useRef<{
        inPinch: boolean;
        inSwipe: boolean;
        initialDistance: number;
        lastCenter: { x: number; y: number } | null;
        initialScaleXLog: number;
        initialScaleYLog: number;
        lastPos: { x: number; y: number } | null;
    }>({
        inPinch: false,
        inSwipe: false,
        initialDistance: 0,
        lastCenter: null,
        initialScaleXLog: 0,
        initialScaleYLog: 0,
        lastPos: null
    });

    useEffect(() => {
        const renderer = rendererRef.current;
        const gridMap = gridMapRef.current;
        const draw = () => renderer.draw(canvasRef.current!, gridMap, store.loader.GetDataView(store.state.viewDef), store.state.renderCtx);

        const canvas = canvasRef.current!;
        const div = divRef.current!;

        // ===== アニメーションユーティリティ =====
        const cancelZoomAnimation = () => {
            if (zoomRafIdRef.current != null) {
                cancelAnimationFrame(zoomRafIdRef.current);
                zoomRafIdRef.current = null;
            }
        };
        const cancelPanAnimation = () => {
            if (panRef.current.rafId != null) {
                cancelAnimationFrame(panRef.current.rafId);
                panRef.current.rafId = null;
            }
        };

        /**
         * 時間基準のズームアニメーション。
         * totalDivisions: ズーム1回分を何分割するか（合計は必ず1ステップ分）
         * stepper(divisions): 1刻みだけズームを進める関数（内部で base/divisions を進める）
         */
        const animateZoomByTime = (
            durationMs: number,
            totalDivisions: number,
            stepper: (divisions: number) => void
        ) => {
            cancelZoomAnimation();

            const divisions = Math.max(1, Math.floor(totalDivisions));
            const start = performance.now();
            let applied = 0; // 既に適用した刻み数

            // easing（加速→減速）
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

            const tick = (now: number) => {
                const t = Math.max(0, Math.min(1, (now - start) / durationMs));
                const eased = easeOutCubic(t);

                // 目標刻み数（0..divisions）を時間から算出
                const target = Math.floor(eased * divisions);
                // 未適用分だけ進める（フレームレートに依らず最終合計は divisions になる）
                for (let i = applied; i < target; i++) {
                    stepper(divisions);
                }
                if (target > applied) {
                    draw();
                    applied = target;
                }

                if (t < 1) {
                    zoomRafIdRef.current = requestAnimationFrame(tick);
                } else {
                    // 念のため取りこぼしがあれば最終反映
                    for (let i = applied; i < divisions; i++) {
                        stepper(divisions);
                    }
                    draw();
                    zoomRafIdRef.current = null;
                }
            };

            zoomRafIdRef.current = requestAnimationFrame(tick);
        };

        /**
         * 時間基準のパン（オフセット移動）アニメーション。
         * 絶対位置補間：開始位置から目的地までを直接補間することで逆ブレを防ぐ。
         * totalDx/totalDy: 最終的に移動したい量（従来の1操作ぶん）
         * 所要時間は durationMs で一定。Easing で見た目を自然に。
         */
        const animatePanByTime = (
            durationMs: number,
            totalDx: number,
            totalDy: number
        ) => {
            cancelPanAnimation();
            totalDx += panRef.current.remainingDx;
            totalDy += panRef.current.remainingDy;

            const start = performance.now();
            const fromX = store.state.renderCtx.offsetX;
            const fromY = store.state.renderCtx.offsetY;

            // easing（加速→減速）
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

            const tick = (now: number) => {
                const t = Math.max(0, Math.min(1, (now - start) / durationMs));
                const eased = easeOutCubic(t);

                // 絶対位置を補間して直接設定（差分適用しない）
                const renderCtx = {
                    ...store.state.renderCtx,
                    offsetX: fromX + totalDx * eased,
                    offsetY: fromY + totalDy * eased,
                };
                panRef.current.remainingDx = totalDx * (1 - eased);
                panRef.current.remainingDy = totalDy * (1 - eased);
                store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, renderCtx);
                draw();

                if (t < 1) {
                    panRef.current.rafId = requestAnimationFrame(tick);
                } else {
                    // 最終位置にスナップ（浮動小数の誤差吸収）
                    const renderCtx = {
                        ...store.state.renderCtx,
                        offsetX: fromX + totalDx,
                        offsetY: fromY + totalDy,
                    };
                    store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, renderCtx);
                    draw();
                    panRef.current.remainingDx = 0;
                    panRef.current.remainingDy = 0;
                    panRef.current.rafId = null;
                }
            };

            panRef.current.remainingDx = totalDx;
            panRef.current.remainingDy = totalDy;
            panRef.current.rafId = requestAnimationFrame(tick);
        };
        // =======================================

        // 2つのタッチ間の距離を計算
        const getTouchDistance = (t1: Touch, t2: Touch): number => {
            const dx = t1.clientX - t2.clientX;
            const dy = t1.clientY - t2.clientY;
            return Math.hypot(dx, dy);
        };

        // 2つのタッチの中心点を取得（Canvas ローカル座標）
        const getTouchCenter = (t1: Touch, t2: Touch): { x: number; y: number } => {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (t1.clientX + t2.clientX) / 2 - rect.left,
                y: (t1.clientY + t2.clientY) / 2 - rect.top
            };
        };

        // 単一タッチ位置（Canvas ローカル座標）
        const getSingleTouchPos = (t: Touch): { x: number; y: number } => {
            const rect = canvas.getBoundingClientRect();
            return { x: t.clientX - rect.left, y: t.clientY - rect.top };
        };

        // ピンチズームおよびタッチ移動対応用のタッチイベントハンドラ
        const handleTouchStart = (e: TouchEvent) => {
            // ジェスチャ開始時は既存アニメーションを止める（競合防止）
            cancelZoomAnimation();
            cancelPanAnimation();

            if (e.touches.length === 2) { // 2本指でのタッチ開始
                const d = getTouchDistance(e.touches[0], e.touches[1]);
                touchRef.current.initialDistance = d;
                touchRef.current.lastCenter = getTouchCenter(e.touches[0], e.touches[1]);
                touchRef.current.initialScaleXLog = store.state.renderCtx.scaleXLog;
                touchRef.current.initialScaleYLog = store.state.renderCtx.scaleYLog;
                touchRef.current.inPinch = true;
                touchRef.current.inSwipe = false;
            } else if (e.touches.length === 1) { // 1本指でのタッチ開始
                touchRef.current.lastPos = getSingleTouchPos(e.touches[0]);
                touchRef.current.inSwipe = true;
                touchRef.current.inPinch = false;
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            e.preventDefault(); // デフォルトのタッチスクロールを無効化

            // マージン（左側）を Renderer から取得（なければ 0）
            const marginLeft = (renderer as any).MARGIN_LEFT_ ?? 0;

            if (e.touches.length === 2 && touchRef.current.inPinch) {
                // ピンチ：倍率と中心を更新
                const newDistance = getTouchDistance(e.touches[0], e.touches[1]);
                const zoomFactor = newDistance / Math.max(1e-6, touchRef.current.initialDistance);

                // ピンチ操作に応じたズーム処理（対数スケール：自然対数を使用）
                const targetXLog = touchRef.current.initialScaleXLog + Math.log(zoomFactor);
                const targetYLog = touchRef.current.initialScaleYLog + Math.log(zoomFactor);

                const center = getTouchCenter(e.touches[0], e.touches[1]);
                const lastCenter = touchRef.current.lastCenter ?? center;

                // 直前スケール（prev）を保存
                const prevX = scaleX(store.state.renderCtx.scaleXLog);
                const prevY = scaleY(store.state.renderCtx.scaleYLog);

                // 新しいスケール（new）
                const newX = scaleX(targetXLog);
                const newY = scaleY(targetYLog);

                // アンカー（中心）を固定するようにオフセットを更新（zoomUniform と同等）
                const relX = center.x - marginLeft + store.state.renderCtx.offsetX;
                const relY = center.y + store.state.renderCtx.offsetY;
                let nextOffsetX = relX * (newX / Math.max(prevX, 1e-12)) - (center.x - marginLeft);
                let nextOffsetY = relY * (newY / Math.max(prevY, 1e-12)) - center.y;

                // 中心の移動に合わせてパン（指に追従）
                const dx = center.x - lastCenter.x;
                const dy = center.y - lastCenter.y;
                nextOffsetX -= dx;
                nextOffsetY -= dy;

                // 中心を記録
                touchRef.current.lastCenter = center;

                const next = {
                    ...store.state.renderCtx,
                    scaleXLog: targetXLog,
                    scaleYLog: targetYLog,
                    offsetX: nextOffsetX,
                    offsetY: nextOffsetY,
                };
                store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
                draw();
            } else if (e.touches.length === 1 && touchRef.current.inSwipe) {
                // 1本指の移動操作（即時パン）
                const current = getSingleTouchPos(e.touches[0]);
                const last = touchRef.current.lastPos ?? current;

                const dx = current.x - last.x;
                const dy = current.y - last.y;

                const next = {
                    ...store.state.renderCtx,
                    offsetX: store.state.renderCtx.offsetX - dx,
                    offsetY: store.state.renderCtx.offsetY - dy,
                };

                touchRef.current.lastPos = current;

                store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
                draw();
            }
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2) {  // 2本指での操作が終わったらリセット
                touchRef.current.inPinch = false;
                touchRef.current.lastCenter = null;
            }
            if (e.touches.length === 1) { // 1本指のタッチが残っている場合はスクロールに移行するために位置を更新
                touchRef.current.lastPos = getSingleTouchPos(e.touches[0]);
                touchRef.current.inSwipe = true;
            }
            if (e.touches.length < 1) { // 1本指のタッチが終了した場合もリセット
                touchRef.current.inSwipe = false;
                touchRef.current.lastPos = null;
            }
        };

        // Resize handler
        const handleResize = () => {
            const dpr = window.devicePixelRatio || 1;
            const width = div.clientWidth;
            const height = div.clientHeight;
            const targetW = Math.max(0, Math.floor(width * dpr));
            const targetH = Math.max(0, Math.floor(height * dpr));
            // 変更があるときだけ更新（不要な再確保を避ける）
            if (canvas.width !== targetW) canvas.width = targetW;
            if (canvas.height !== targetH) canvas.height = targetH;

            const canvasCtx = canvas.getContext("2d")!;

            canvasCtx.resetTransform?.();
            canvasCtx.scale(dpr, dpr);

            store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, { ...store.state.renderCtx, width, height });
            draw();
        };

        // Wheel handler
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // 一回の操作で進むズーム量は常に「1ステップ」固定
            // 所要時間は常に ZOOM_DURATION_MS で一定
            const zoomIn = e.deltaY < 0;

            if (e.ctrlKey) {
                // 一様ズーム
                animateZoomByTime(ZOOM_DURATION_MS, ZOOM_DIVISIONS_WHEEL, (divs) => {
                    const next = renderer.zoomUniform(store.state.renderCtx, mouseX, mouseY, zoomIn, divs);
                    store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
                });
            } else if (e.shiftKey) {
                // 水平ズーム
                animateZoomByTime(ZOOM_DURATION_MS, ZOOM_DIVISIONS_WHEEL, (divs) => {
                    const next = renderer.zoomHorizontal(store.state.renderCtx, mouseX, mouseY, zoomIn, divs);
                    store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
                });
            } else {
                // スクロールもアニメーション
                // ホイールイベント 1 回ぶんの deltaX と deltaY を一定時間で補間
                animatePanByTime(PAN_DURATION_MS, e.deltaX, e.deltaY);
            }
        };

        // キーボード操作
        const handleKeyDown = (e: KeyboardEvent) => {
            // input要素やtextarea要素にフォーカスがある場合は無視
            const activeElement = document.activeElement;
            if (activeElement && (
                activeElement.tagName === 'INPUT' || 
                activeElement.tagName === 'TEXTAREA' ||
                (activeElement as HTMLElement).contentEditable === 'true'
            )) {
                return;
            }


            const zoomX = store.state.renderCtx.width / 2;
            const zoomY = store.state.renderCtx.height / 2;

            const runZoom = (mode: "uniform" | "horizontal" | "vertical", zoomIn: boolean) => {
                e.preventDefault();
                animateZoomByTime(ZOOM_DURATION_MS, ZOOM_DIVISIONS_KEY, (divs) => {
                    let next: RendererContext;
                    if (mode === "uniform") {
                        next = renderer.zoomUniform(store.state.renderCtx, zoomX, zoomY, zoomIn, divs);
                    } else if (mode === "horizontal") {
                        next = renderer.zoomHorizontal(store.state.renderCtx, zoomX, zoomY, zoomIn, divs);
                    } else {
                        next = renderer.zoomVertical(store.state.renderCtx, zoomX, zoomY, zoomIn, divs);
                    }
                    store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
                });
            };

            const isAccel = e.ctrlKey || e.metaKey; // Win/Linux: Ctrl, macOS: ⌘
            const k = e.key;
            let upOrDown = k === "ArrowUp" || k === "ArrowDown";
            let leftOrRight = k === "ArrowLeft" || k === "ArrowRight";
            if (isAccel && leftOrRight)   { runZoom("horizontal", k === "ArrowRight"); return; }  // Accel(⌘/Ctrl) + ←/→ : horizontal
            if (isAccel && upOrDown)      { runZoom("vertical",   k === "ArrowUp");    return; }  // Accel(⌘/Ctrl) + ↑/↓ : vertical
            if (e.shiftKey && upOrDown)   { runZoom("uniform",    k === "ArrowUp");    return; }  // Shift + ↑/↓ : uniform
            if (k === "+" || k === "=")   { runZoom("uniform", true); return; }            // + / - : uniform Shift+= が "+" の配列向け
            if (k === "-")                { runZoom("uniform", false); return; }

            // パン（視点移動）
            const PAN_STEP = 120;   // 矢印キー
            const PAGE_STEP = 480; // PageUp/Down

            switch (e.key) {
                case "ArrowLeft":
                    // 左へパン（Xマイナス方向）
                    animatePanByTime(PAN_DURATION_MS, -PAN_STEP, 0);
                    break;
                case "ArrowRight":
                    // 右へパン（Xプラス方向）
                    animatePanByTime(PAN_DURATION_MS, PAN_STEP, 0);
                    break;
                case "ArrowUp":
                    // 上へパン（Yマイナス方向）
                    animatePanByTime(PAN_DURATION_MS, 0, -PAN_STEP);
                    break;
                case "ArrowDown":
                    // 下へパン（Yプラス方向）
                    animatePanByTime(PAN_DURATION_MS, 0, PAN_STEP);
                    break;
                case "PageUp":
                    // 大きく上へパン
                    animatePanByTime(PAN_DURATION_MS, 0, -PAGE_STEP);
                    break;
                case "PageDown":
                    // 大きく下へパン
                    animatePanByTime(PAN_DURATION_MS, 0, PAGE_STEP);
                    break;
            }
        };

        // Drag handlers for panning and pinching
        let dragState: null | {
            type: "pan",
            lastX: number,
            lastY: number
        } | {
            type: "pinch",
            initialScaleXLog: number,
            initialScaleYLog: number,
            dx: number,
            dy: number
        } = null;
        const handleMouseDown = (e: MouseEvent) => {
            if (dragState) {
                return;
            }

            // パン開始時にズーム/パンのアニメーションが走っていれば止める（競合防止）
            cancelZoomAnimation();
            cancelPanAnimation();

            canvas.style.cursor = "grabbing";

            if (e.button == 2) {
                dragState = {
                    type: "pinch",
                    initialScaleXLog: store.state.renderCtx.scaleXLog,
                    initialScaleYLog: store.state.renderCtx.scaleYLog,
                    dx: 0,
                    dy: 0
                };
                canvas.requestPointerLock();
            } else {
                dragState = {
                    type: "pan",
                    lastX: e.clientX,
                    lastY: e.clientY
                };
            }
        };

        const handleMouseMove = (e: MouseEvent) => {
            if (!dragState) {
                const dataView = store.loader.GetDataView(store.state.viewDef);
                if (!dataView || !gridMap.drawnIndex) {
                    store.trigger(ACTION.MOUSE_MOVE, "");
                    return;
                }

                // マウス位置（CSSピクセル）のテキストを得る
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                const payload = renderer.getText(mouseX, mouseY, gridMap, dataView, store.state.renderCtx, store.loader);
                store.trigger(ACTION.MOUSE_MOVE, payload);
                return;
            }

            let next;

            switch (dragState.type) {
                case "pan":
                    const dx = e.clientX - dragState.lastX;
                    const dy = e.clientY - dragState.lastY;
                    dragState.lastX = e.clientX;
                    dragState.lastY = e.clientY;

                    next = {
                        ...store.state.renderCtx,
                        offsetX: store.state.renderCtx.offsetX - dx,
                        offsetY: store.state.renderCtx.offsetY - dy,
                    };
                    break;

                case "pinch":
                    dragState.dx += e.movementX;
                    dragState.dy += e.movementY;

                    next = renderer.applyZoom(store.state.renderCtx, e.clientX, e.clientY, {
                        x: dragState.initialScaleXLog + Math.sign(dragState.dx) * Math.max(0, Math.log(Math.abs(dragState.dx) / canvas.width * 1e2)),
                        y: dragState.initialScaleYLog + Math.sign(dragState.dy) * Math.max(0, Math.log(Math.abs(dragState.dy) / canvas.height * 1e2))
                    });
                    break;
            }

            store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
            draw();
        };

        const handleMouseUp = (e: MouseEvent) => {
            if (dragState?.type != (e.button == 2 ? "pinch" : "pan")) {
                return;
            }

            dragState = null;
            document.exitPointerLock();
            canvas.style.cursor = "default";
        };

        const ro = new ResizeObserver(handleResize);
        ro.observe(div);

        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        div.addEventListener("wheel", handleWheel, { passive: false });
        window.addEventListener("keydown", handleKeyDown);
        canvas.addEventListener("mousedown", handleMouseDown);
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);

        // タッチリスナー（passive:false で preventDefault を有効化）
        canvas.addEventListener("touchstart", handleTouchStart as any, { passive: false });
        canvas.addEventListener("touchmove", handleTouchMove as any, { passive: false });
        canvas.addEventListener("touchend", handleTouchEnd as any, { passive: false });
        canvas.addEventListener("touchcancel", handleTouchEnd as any, { passive: false });

        handleResize();

        // Store change handler
        const onFileLoadStarted = () => {
            const next = { ...store.state.renderCtx, numRows: 0 };
            store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
            handleResize();
            const canvasCtx = canvas.getContext("2d")!;
            renderer.clear(canvasCtx, next);
            gridMap.drawnIndex = null;    // ここでクリアしておかないと，描画前にマウスオーバーで参照されてしまう
        };
        const onFileFormatDetected = () => {
            // 初回表示で範囲外だったらリセット
            // if (renderCtx.offsetY + renderCtx.height < renderCtx.dataView.getMinY()) {
            //     renderCtx.offsetY = renderCtx.dataView.getMinY();
            // }
            // if (renderCtx.offsetY > renderCtx.dataView.getMaxY()) {
            //     renderCtx.offsetY = renderCtx.dataView.getMaxY() - renderCtx.height;
            // }
            if (!store.state.viewDef) {
                console.log("No view definition after format detected");
                return;
            }
            const dataView = store.loader.GetDataView(store.state.viewDef);
            const next = renderer.fitScaleToData(dataView, store.state.renderCtx, 1.0);
            store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
        };
        const onContentUpdated = () => {
            if (!store.state.viewDef) {
                return; // まだフォーマットが確定しておらずビュー定義がない
            }
            draw();
        };
        store.on(CHANGE.FILE_LOADED, onContentUpdated);
        store.on(CHANGE.FILE_LOADING_START, onFileLoadStarted);
        store.on(CHANGE.FILE_FORMAT_DETECTED, onFileFormatDetected);
        store.on(CHANGE.CONTENT_UPDATED, onContentUpdated);
        store.on(CHANGE.CANVAS_FIT, () => {
            const dataView = store.loader.GetDataView(store.state.viewDef);
            const next = renderer.fitScaleToData(dataView, store.state.renderCtx, 1.0);
            store.trigger(ACTION.UPDATE_RENDERER_CONTEXT, next);
            draw();
        });

        // Cleanup
        return () => {
            cancelZoomAnimation();
            cancelPanAnimation();
            div.removeEventListener("wheel", handleWheel);
            window.removeEventListener("keydown", handleKeyDown);
            canvas.removeEventListener("mousedown", handleMouseDown);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);

            canvas.removeEventListener("touchstart", handleTouchStart as any);
            canvas.removeEventListener("touchmove", handleTouchMove as any);
            canvas.removeEventListener("touchend", handleTouchEnd as any);
            canvas.removeEventListener("touchcancel", handleTouchEnd as any);
        };
    }, []);


    return (
        <div
            ref={divRef}
            style={{ width: "100%", height: "100%", overflow: "hidden" }}
        >
            <canvas
                ref={canvasRef}
                style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }}
            />
        </div>
    );
};

export default MainCanvas;
