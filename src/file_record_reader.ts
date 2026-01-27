import getFZSTD_Reader from "./zstd_reader"

export interface FileRecordReaderOptions {
    file?: File;
    stream?: ReadableStream<Uint8Array>;
    fileName?: string;
    fileSize?: number;
    url?: string; 
}

export class FileRecordReader {
    private reader_!: ReadableStreamDefaultReader<Uint8Array>;
    private decoder_ = new TextDecoder('utf-8');
    private bytesRead_ = 0; // 読み取ったバイト数
    private initialized_ = false;
    private isZstd_ = false;
    private abortController_ = new AbortController();
    
    private url_?: string; // URL を保持
    private stream_: ReadableStream<Uint8Array>;
    private fileName_: string;
    private fileSize_: number;

    constructor(options: FileRecordReaderOptions) {
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

    async *load() {
        let quoteOrUnescape = false;
        let fragment = { escaped: false, value: '' };
        let record: typeof fragment[] = [];
        let numReads = 0;

        function push(escaped: boolean) {
            if (fragment.value) {
                record.push(fragment);
                fragment = { escaped, value: '' };
            }
        }

        await this.init_();

        while (true) {
            numReads++;
            if (numReads % 50000 === 0) {
                // UI の更新を待つために一瞬スリープをいれる
                await new Promise(r => setTimeout(r, 0)); 
                this.abortController_.signal.throwIfAborted();
            }

            const { done, value } = await this.reader_.read();
            if (done) {
                break;
            }

            // 非 zstd のときだけ、生バイトをここで進捗加算
            if (!this.isZstd_) {
                this.bytesRead_ += value.byteLength;
            }

            let input = this.decoder_.decode(value, { stream: true });

            parse: while (true) {
                if (quoteOrUnescape) {
                    switch (input[0]) {
                        case '"':
                            fragment.value += '"';
                            input = input.slice(1);
                            break;

                        case undefined:
                            break parse;

                        default:
                            push(false);
                    }

                    quoteOrUnescape = false;
                }

                const index = input.search(fragment.escaped ? /"/ : /["|\n]/);
                if (index < 0) {
                    fragment.value += input;
                    break;
                }

                const delimiter = input[index];
                fragment.value += input.slice(0, index);
                input = input.slice(index + 1);

                if (fragment.escaped) {
                    quoteOrUnescape = true;
                } else if (delimiter == '"') {
                    push(true);
                } else {
                    push(false);
                    yield record;
                    record = [];
                }
            }
        }

        this.abortController_.signal.throwIfAborted();

        // 終端で進捗を 100%
        this.bytesRead_ = this.fileSize_;

        push(false);

        if (record.length) {
            yield record;
        }
    }

    cancel() {
        if (this.reader_) {
            this.reader_.cancel();
            this.abortController_.abort();
        }
    }
}
