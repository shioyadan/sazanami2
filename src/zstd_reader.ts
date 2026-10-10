// zstd_reader.ts
import ZstdWorker from "./zstd_worker";

// worker からはチャンクの展開後に postMessage で "progress" が来るので，
// data に対する，圧縮元バイト数のクレジットを持たせる
type OutQueueItem = { 
    buf: Uint8Array; 
    credit: number 
};

// ファイル名・サイズは将来の展開処理で使えるよう、未使用でも引数として維持する。
const getFZSTD_Reader = (stream: ReadableStream<Uint8Array>, fileName: string, fileSize: number, updateByteReads: (bytes: number) => void) => {
    const compressedReader = stream.getReader();
    const worker = new ZstdWorker();

    // outQueue: Uint8Array[] -> OutQueueItem[]（credit を保持）
    const outQueue: OutQueueItem[] = [];
    let pendingResolve: ((v: OutQueueItem | null) => void) | null = null;

    // end を受けても「すぐ閉じない」ためのフラグ
    let endedFromWorker = false;
    let eofSent = false;

    // progress を data に付けられないときに貯める
    let creditCarry = 0;

    // 直近の未クレジット data に progress をひも付ける helper
    const attachCreditToTail = (bytes: number) => {
        if (bytes <= 0) return;
        for (let i = outQueue.length - 1; i >= 0; i--) {
            if (outQueue[i].credit === 0) {
                outQueue[i].credit = bytes;
                return;
            }
        }
        // 今キューに data が無い/全部クレジット済み → 次の data に回す
        creditCarry += bytes;
    };

    worker.onmessage = (e: MessageEvent) => {
        const { type } = e.data || {};
        if (type === "data") {
            const data = new Uint8Array(e.data.chunk);
            // data 到着時点で carry があれば、この data に付与
            const item: OutQueueItem = { buf: data, credit: 0 };
            if (creditCarry > 0) {
                item.credit = creditCarry >>> 0;
                creditCarry = 0;
            }

            if (pendingResolve) {
                const resolve = pendingResolve; pendingResolve = null;
                resolve(item);
            } else {
                outQueue.push(item);
            }
        } else if (type === "progress") {
            // 直近 data にクレジットとしてひも付ける
            const bytes: number = e.data.bytes;
            if (bytes > 0) 
                attachCreditToTail(bytes);
        } else if (type === "end") {
            // すべての data を吐き切った“後”に閉じたい
            endedFromWorker = true;
            if (pendingResolve && outQueue.length === 0) {
                const resolve = pendingResolve; pendingResolve = null;
                resolve(null);
            }
        }
    };

    const decompressedStream = new ReadableStream<Uint8Array>({
        start() {},
        pull: async (controller) => {
            // 1) まず手元のキューを優先して吐く
            if (outQueue.length > 0) {
                const { buf, credit } = outQueue.shift()!;
                controller.enqueue(buf);
                // 進捗は「ストリームから読み出されたデータ」に対応する圧縮元バイトで加算
                if (credit > 0) updateByteReads(credit);
                return;
            }

            // 2) 既に worker 側は終了合図済み & キュー空 → 閉じる
            if (endedFromWorker) {
                controller.close();
                // 正常終了でも念のため掃除
                try { worker.terminate(); } catch {}
                return;
            }

            // 3) 次の伸長チャンクを待ちつつ、圧縮側を1ステップ進める
            const nextItem = await new Promise<OutQueueItem | null>(async (resolve) => {
                pendingResolve = resolve;

                const { done, value } = await compressedReader.read();

                if (done) {
                    if (!eofSent) {
                        eofSent = true;
                        const empty = new Uint8Array(0);
                        worker.postMessage({ type: "push", chunk: empty, isLast: true }, [empty.buffer]);
                        await compressedReader.cancel().catch(() => {});
                    }
                    return; // resolve は worker 側の "end" で行う
                }

                if (value && value.byteLength > 0) {
                    // 進捗は worker からの "progress" を data にひも付ける方式に統一
                    worker.postMessage({ type: "push", chunk: value, isLast: false }, [value.buffer]);
                }
            });

            if (nextItem) {
                controller.enqueue(nextItem.buf);
                if (nextItem.credit > 0) updateByteReads(nextItem.credit);
                return;
            }

            // ここに来るのは "end" により resolve(null) されたとき
            controller.close();
            try { worker.terminate(); } catch {}
        },
        cancel: async () => {
            try { worker.postMessage({ type: "cancel" }); } catch {}
            try { worker.terminate(); } catch {}
            await compressedReader.cancel().catch(() => {});
        }
    });

    return decompressedStream.getReader();
};

export default getFZSTD_Reader;
