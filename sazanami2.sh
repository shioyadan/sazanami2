#!/usr/bin/env bash

# リモートやWSL上のデータを、SSH port forwarding先のbrowserから開く。
# HTMLと指定ファイルを固定URLへ対応付ける。
set -eu

# productionビルド時にcommit時刻・hash・日付へ置換する。
build=0-source-unknown

usage() {
    echo "Usage: $0 FILE" >&2
    echo "       $0 --update" >&2
    echo "  FILE: CSV/TSV data, optionally compressed with Zstandard" >&2
    echo "  SAZANAMI2_PORT: listening port (default: an available port)" >&2
}

if [ "$#" -eq 1 ] && { [ "$1" = "--help" ] || [ "$1" = "-h" ]; }; then
    usage
    exit 0
fi
if [ "$#" -ne 1 ]; then
    usage
    exit 2
fi

# symlink経由でも本体の隣にあるHTMLを参照する。
script_path="$(realpath -- "$0")"
script_dir="$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)"

if [ "$1" = "--update" ]; then
    index_path="$script_dir/index.html"
    if [ ! -f "$index_path" ]; then
        echo "Sazanami2 can update only a distribution with index.html next to sazanami2.sh. In a source checkout, rebuild with make production." >&2
        exit 1
    fi

    update_dir="$(mktemp -d "$script_dir/.sazanami2-update.XXXXXX")"
    trap 'rm -rf -- "$update_dir"' EXIT
    trap 'exit 1' HUP INT TERM

    echo "Downloading the latest Sazanami2 development build..."
    update_url="${SAZANAMI2_UPDATE_URL:-https://shioyadan.github.io/sazanami2/sazanami2-latest.zip}"
    # ZIP内の既知の2ファイルだけを取得し、検証が終わるまで既存配布物に触れない。
    if ! python3 - "$update_url" "$update_dir" <<'PY'
from pathlib import Path
import re
import socket
import sys
import urllib.request
import zipfile

url, destination = sys.argv[1:]
destination = Path(destination)
archive_path = destination / "sazanami2-latest.zip"
socket.setdefaulttimeout(30)
try:
    urllib.request.urlretrieve(url, archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        # latest/versioned ZIPの専用フォルダから配布物を取得する。
        prefixes = {
            name.rsplit("/", 1)[0] + "/" for name in names
            if re.fullmatch(r"sazanami2-(?:latest|v[0-9]+\.[0-9]+\.[0-9]+)/sazanami2\.sh", name)
        }
        candidates = [
            prefix for prefix in prefixes
            if all(names.count(prefix + name) == 1 for name in ("sazanami2.sh", "index.html"))
        ]
        if len(candidates) != 1:
            raise ValueError("ZIP must contain exactly one Sazanami2 distribution")
        prefix = candidates[0]
        for name in ("sazanami2.sh", "index.html"):
            (destination / name).write_bytes(archive.read(prefix + name))
except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
    sys.exit("Could not download and unpack the Sazanami2 update: {}".format(error))
PY
    then
        exit 1
    fi

    payload_build="$(sed -n 's/^build=//p' "$update_dir/sazanami2.sh")"
    if [[ ! "$payload_build" =~ ^[0-9]+-[0-9a-f]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
        [ "$(head -n 1 "$update_dir/sazanami2.sh")" != '#!/usr/bin/env bash' ] ||
        ! bash -n "$update_dir/sazanami2.sh" ||
        ! head -c 64 "$update_dir/index.html" | grep -qi '^<!doctype html>'; then
        echo "The downloaded Sazanami2 update is invalid." >&2
        exit 1
    fi

    IFS=- read -r current_time current_hash current_date <<< "$build"
    IFS=- read -r payload_time payload_hash payload_date <<< "$payload_build"
    printf 'Installed build: %s (%s)\n' "$current_hash" "$current_date"
    printf 'Available build: %s (%s)\n' "$payload_hash" "$payload_date"
    if cmp -s "$update_dir/sazanami2.sh" "$script_path" &&
        cmp -s "$update_dir/index.html" "$index_path"; then
        echo "Sazanami2 is already up to date."
        exit 0
    fi
    if [ "$payload_time" -gt "$current_time" ]; then
        echo "A newer Sazanami2 build is available:"
    elif [ "$payload_time" -lt "$current_time" ]; then
        echo "The available Sazanami2 build is older than this copy:"
    else
        echo "The available Sazanami2 build differs from this copy:"
    fi
    cmp -s "$update_dir/sazanami2.sh" "$script_path" || echo "  sazanami2.sh"
    cmp -s "$update_dir/index.html" "$index_path" || echo "  index.html"
    printf 'Install this update? [y/N] ' >&2
    if ! read -r answer; then
        echo >&2
        answer=
    fi
    case "$answer" in
        y|Y|yes|Yes|YES) ;;
        *)
            echo "Update cancelled."
            exit 0
            ;;
    esac

    chmod 755 "$update_dir/sazanami2.sh"
    chmod 644 "$update_dir/index.html"
    # scriptを先に置換し、中断時にも--updateを再実行できるようにする。
    mv -f "$update_dir/sazanami2.sh" "$script_path"
    mv -f "$update_dir/index.html" "$index_path"
    echo "Sazanami2 was updated to the latest development build."
    exit 0
fi

# 配布物では同梱HTML、source treeではdistのビルドを使う。
if [ -f "$script_dir/index.html" ]; then
    index_file="$script_dir/index.html"
elif [ -f "$script_dir/dist/index.html" ]; then
    index_file="$script_dir/dist/index.html"
else
    echo "index.html was not found. Run make production or extract a Sazanami2 distribution first." >&2
    exit 1
fi

if [ ! -f "$1" ] || [ ! -r "$1" ]; then
    echo "Data is not a readable file: $1" >&2
    exit 1
fi
data_file="$(realpath -- "$1")"

# 実際にbindしてからURLを表示する。execでCtrl+Cもserverへ直接届く。
exec python3 - "$index_file" "$data_file" <<'PY'
import http.server
import os
from pathlib import Path
import sys
import urllib.parse

index = Path(sys.argv[1])
data = Path(sys.argv[2])
raw_port = os.environ.get("SAZANAMI2_PORT")
port = 0
if raw_port is not None:
    if not raw_port.isascii() or not raw_port.isdecimal() or len(raw_port) > 5:
        sys.exit("SAZANAMI2_PORT must be an integer from 1 to 65535.")
    port = int(raw_port)
    if not 1 <= port <= 65535:
        sys.exit("SAZANAMI2_PORT must be an integer from 1 to 65535.")

if any(ord(char) < 32 or ord(char) == 127 for char in data.name):
    sys.exit("Data file names must not contain control characters.")

# 拡張子を残すことで、ブラウザ側のZstandard判定を有効にする。
data_path = "/data/" + data.name
files = {"/": index, "/index.html": index, data_path: data}
# developmentビルドでも起動できるよう、分離されたJSがあれば配信する。
bundle = index.with_name("bundle.js")
if bundle.is_file():
    files["/bundle.js"] = bundle


class Handler(http.server.SimpleHTTPRequestHandler):
    def file_path(self):
        return urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)

    def translate_path(self, path):
        return str(files[self.file_path()])

    def send_head(self):
        if self.file_path() not in files:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        return super().send_head()


try:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
except OSError as error:
    sys.exit("Could not start the Sazanami2 server: {}".format(error))

with server:
    port = server.server_port
    # queryとファイル名の両方をencodeし、空白・日本語・#などを保持する。
    query = urllib.parse.urlencode({"file": urllib.parse.quote(data_path, safe="/")})
    url = "http://127.0.0.1:{}/?{}".format(port, query)
    cyan = green = reset = ""
    if sys.stdout.isatty() and os.environ.get("TERM", "dumb") != "dumb" and not os.environ.get("NO_COLOR"):
        cyan, green, reset = "\033[1;36m", "\033[1;32m", "\033[0m"
    print("Sazanami2 URL: {}{}{}".format(cyan, url, reset), flush=True)
    print("SSH tunnel: {}ssh -L {}:127.0.0.1:{} <host>{}".format(green, port, port, reset), flush=True)
    print("Press Ctrl+C to stop the server.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
PY
