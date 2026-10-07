# Sazanami2

Sazanami2 is a browser-based visualizer for large CSV and TSV datasets. It plots each row using
selected columns for the X and Y coordinates and another column for color.
[Open the live demo](https://shioyadan.github.io/sazanami2/?file=sample.csv).

Sazanami2 runs entirely in the browser as a single, self-contained HTML file. Local data stays in
your browser and is never uploaded. It can load gigabyte-scale files, including Zstandard-compressed
data, and supports smooth zooming and scrolling through large datasets.

## Quick start

* No installation is required to use the hosted version. Open
  [Sazanami2 Web](https://shioyadan.github.io/sazanami2/) in a browser, then choose **Load file**
  from the menu or drag and drop a CSV, TSV, or `.zst` file onto the window.
* On a remote server or WSL, use the built-in Web server:

    ```bash
    # Download and extract the latest development build.
    curl -fLO https://shioyadan.github.io/sazanami2/sazanami2-latest.zip
    unzip -q sazanami2-latest.zip
    cd sazanami2-latest

    # Start the launcher on the machine that holds the data.
    ./sazanami2.sh /path/to/data.csv.zst
    ```

    The launcher selects an available port and displays:

    ```text
    Sazanami2 URL: http://127.0.0.1:30080/?file=%2Fdata%2Fdata.csv.zst
    SSH tunnel: ssh -L 30080:127.0.0.1:30080 <host>
    Press Ctrl+C to stop the server.
    ```

    For a remote host, run the SSH command on your local machine, replacing `<host>` with the
    remote host, then open the displayed URL in your local browser. For a local file, open the URL
    directly. Keep the launcher running while using the app; press Ctrl+C to stop it.

## Usage

### File format

The first row contains column names separated by commas or tabs. Subsequent rows contain decimal
integers, hexadecimal integers, or strings. Repeated strings can be assigned numeric IDs in order
of first appearance for coloring and plotting.

For example, this CSV plots four points with a separate color for each value in `s`:

```csv
y,x,s
1,2,XX
2,4,YY
2,1,ZZ
4,5,AA
```

Zstandard-compressed files (`.zst`) can be opened directly.

### View controls

- **Settings:** Drag columns onto the X, Y, and Color slots. Add a derived column to compute values
  from an expression using up to two input columns.
- **Fit:** Fit the whole dataset into the canvas.
- **Legend:** Show or hide the color legend.
- **Log:** Review loading warnings and other messages.
- **Canvas:** Drag with the left mouse button to pan. Use Ctrl/Command+mouse wheel to zoom, or
  Shift+mouse wheel to zoom horizontally. Touch input supports pinching and swiping.

View definitions can be imported and exported as JSON from the settings panel. The app also saves
view definitions for matching column headers between browser sessions.

### Load data from a server

When hosting the HTML alongside data files, the `file` URL parameter loads a file automatically:

```text
https://your-server.example/index.html?file=log.zst
```

The launcher requires Bash, Python 3, and `realpath`. It listens on `127.0.0.1` and serves the app
and the selected data file. To choose a port explicitly:

```bash
SAZANAMI2_PORT=30080 ./sazanami2.sh /path/to/data.tsv
```

It works from any directory and through symlinks.

## Distribution and updates

### Update a downloaded copy

```bash
./sazanami2-latest/sazanami2.sh --update
```

The script downloads the latest tested development build from Sazanami2 Web. It displays the
installed and available commit hashes and dates, then asks before replacing the adjacent launcher
and HTML. Matching files are left unchanged; failed downloads and invalid archives leave the
installed copy intact. Updating a versioned release also switches it to the latest development build.

In a source checkout, rebuild with `make production`. The updater can be tried on the built copy
with `./dist/sazanami2.sh --update`. `SAZANAMI2_UPDATE_URL` overrides the download URL for a mirror
or local test archive.

### Other ways to run

- **Stable Web version:** Open [Sazanami2 Web stable](https://shioyadan.github.io/sazanami2/stable/).
- **Latest development Web version:** Open [Sazanami2 Web](https://shioyadan.github.io/sazanami2/).
- **Versioned releases:** Tagged releases publish `sazanami2-v*.zip` archives to
  [GitHub Releases](https://github.com/shioyadan/sazanami2/releases).
- **Offline:** Extract a distribution and open its `index.html` directly in a browser.

## Development

The project targets Node.js 18 on Ubuntu 24.04. The provided Docker environment uses that Ubuntu
version. To build and enter it:

```bash
make docker-build
make docker-run
```

Run the same Make targets inside the container or in a local development environment:

```bash
make init             # Install dependencies and regenerate the third-party license list
make                  # Build the development application
make serve            # Start the development server
make production       # Build dist/index.html and the launcher
make check            # Check types, launcher behavior, and the production HTML
make latest-archive   # Verify and package dist-release/sazanami2-latest.zip
make release-archive  # Verify and package a versioned ZIP
```

`./docker/run.sh make` also runs a command directly in the Docker environment. `make pack` is an
alias for `make release-archive`.

See [Deployment and release](docs/releasing.md) for GitHub Pages setup and release procedures.

## License

Copyright (C) 2025 Ryota Shioya <shioya@ci.i.u-tokyo.ac.jp>

Sazanami2 is released under the BSD 3-Clause License. See [LICENSE.md](LICENSE.md).
The application includes third-party packages under their respective licenses. See
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
