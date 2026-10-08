import getFZSTD_Reader from "./zstd_reader"
import { yieldToUI } from "./axis_index";

export interface FileLineReaderOptions {
    file?: File;
    stream?: ReadableStream<Uint8Array>;
    fileName?: string;
    fileSize?: number;
    url?: string; 
}

export class FileLineReader {
    private reader_!: ReadableStreamDefaultReader<Uint8Array>;
    private decoder_ = new TextDecoder('utf-8');
    private buffer_ = '';
    private bytesRead_ = 0; // 読み取ったバイト数
    private decodedChars_ = 0;
    private processedChars_ = 0;
    private numLines_ = 0;
    private initialized_ = false;
    private isZstd_ = false;
    private canceled_ = false;
    
    private url_?: string; // URL を保持
    private stream_: ReadableStream<Uint8Array>;
    private fileName_: string;
    private fileSize_: number;

    constructor(options: FileLineReaderOptions) {
        if (options.file) {
            const file = options.file;
            this.stream_ = file.stream() || new Response(file).body as ReadableStream<Uint8Array>;
            this.fileName_ = file.name;
            this.fileSize_ = file.size;
        } else if (options.url) {
            // fetch は非同期なので、ここではプレースホルダをセットし実際の fetch は init_() 内で行う
            this.url_ = options.url;
            this.stream_ = undefined as any;
            this.fileName_ = new URL(options.url).pathname.split("/").pop() || "data";
            this.fileSize_ = 0;
        } else if (options.stream) {
            this.stream_ = options.stream;
            this.fileName_ = options.fileName ?? "unknown";
            this.fileSize_ = options.fileSize ?? 0;
        } else {
            throw new Error("Either file or stream must be provided.");
        }
    }

    /** 現在までの読み取り割合（0〜1）。空ファイルは 1。 */
    getProgress(): number {
        const total = this.fileSize_;
        if (total === 0) return 1;
        return Math.min(1, this.bytesRead_ / total);
    }

    getRowCountEstimate(): number | null {
        if (this.isZstd_ || !this.fileSize_ || !this.processedChars_) return null;
        const fraction = this.processedChars_ / this.decodedChars_ * this.bytesRead_ / this.fileSize_;
        return fraction > 0 ? Math.ceil(this.numLines_ / fraction) : null;
    }

    /** 初期化：拡張子で判定し、必要なら zstd 伸長ストリームを用意（pull 駆動） */
    private async init_(): Promise<void> {
        if (this.initialized_) return;
        this.initialized_ = true;

        if (this.url_) {
            const resp = await fetch(this.url_, { cache: "no-cache" });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            if (!resp.body) throw new Error("ReadableStream not supported");

            this.stream_ = resp.body;
            this.fileSize_ = parseInt(resp.headers.get("content-length") || "0", 10) || 0;
        }

        if (/\.(zst|zstd)(?:\.txt)?$/i.test(this.fileName_)) {
            this.isZstd_ = true;
            this.reader_ = getFZSTD_Reader(
                this.stream_,
                this.fileName_,
                this.fileSize_,
                (bytes) => { this.bytesRead_ += bytes; }
            );
        } else {
            this.reader_ = this.stream_.getReader();
        }
    }


    /** コールバックを受け取り、1行読み込むたびに onLineRead を呼ぶ。 */
    async load(
        onLineRead: (line: string) => void,
        finishCallback: () => void,
        errorCallback: (e: any) => void
    ): Promise<void> {
        try {
            await this.init_();
            if (this.canceled_) { await this.reader_.cancel(); return; }
            let lines = 0, deadline = performance.now() + 6;
            while (!this.canceled_) {
                const { done, value } = await this.reader_.read();
                if (this.canceled_) return;
                if (done) break;
                const decoded = this.decoder_.decode(value, { stream: true });
                this.decodedChars_ += decoded.length;
                this.buffer_ += decoded;
                if (!this.isZstd_) this.bytesRead_ += value.byteLength;

                // 行ごとのPromiseと残り文字列の切り出しを避け、受信chunk内をまとめて処理する。
                let start = 0, end: number;
                while ((end = this.buffer_.indexOf('\n', start)) !== -1) {
                    this.processedChars_ += end - start + 1;
                    this.numLines_++;
                    onLineRead(this.buffer_.slice(start, end));
                    if (this.canceled_) return;
                    start = end + 1;
                    if ((++lines & 1023) === 0 && performance.now() >= deadline) {
                        await yieldToUI();
                        if (this.canceled_) return;
                        deadline = performance.now() + 6;
                    }
                }
                this.buffer_ = this.buffer_.slice(start);
            }
            if (this.canceled_) return;
            const tail = this.decoder_.decode();
            this.decodedChars_ += tail.length;
            this.buffer_ += tail;
            if (this.buffer_.length) {
                this.processedChars_ += this.buffer_.length;
                this.numLines_++;
                onLineRead(this.buffer_);
            }
            if (this.canceled_) return;
            this.buffer_ = '';
            this.bytesRead_ = this.fileSize_;
            finishCallback();
        } catch (e) {
            if (!this.canceled_) errorCallback(e);
        }
    }

    cancel() {
        this.canceled_ = true;
        if (this.reader_) {
            this.reader_.cancel();
        }
    }
}
