# Deployment and release

## GitHub Pages

Pushing to `master` or `stable` runs `.github/workflows/pages.yml`. It builds both branches and
deploys them together, following the same layout as Konata:

| URL | Branch | Purpose |
| --- | --- | --- |
| `https://shioyadan.github.io/sazanami2/` | `master` | Latest development version |
| `https://shioyadan.github.io/sazanami2/stable/` | `stable` | Stable version |
| `https://shioyadan.github.io/sazanami2/sazanami2-latest.zip` | `master` | Tested development distribution |

Both Web versions are included in one artifact because each deployment replaces the whole site.
The development archive is built with `make latest-archive`, which runs `make check` first. The
stable checkout is typechecked and built, and its single HTML is checked before deployment. Keep
`stable` at a tested release commit.

The sample in `docs/sample.csv` is published as `sample.csv`. The README's demo link opens it
through the app's `file` parameter.

In repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**. The
`github-pages` environment must allow deployments from both `master` and `stable`. See
[GitHub's custom workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
The workflow also supports **Run workflow** for a manual deployment.

The root URL now serves the development version; the stable version moves to `/stable/`. The old
`/unstable/` path and flat ZIP download are not published. When promoting `stable`, include the
new workflow files so subsequent stable pushes use the same layout.

## Distribution and updates

```bash
make latest-archive
make release-archive
```

The latest archive has a fixed name. The versioned archive takes its version from `package.json`
and verifies that `package-lock.json` agrees. For example:

```text
dist-release/sazanami2-latest.zip
└── sazanami2-latest/
    ├── index.html
    ├── sazanami2.sh
    ├── README.md
    ├── LICENSE.md
    ├── THIRD-PARTY-LICENSES.md
    └── docs/

dist-release/sazanami2-v0.0.2.zip
└── sazanami2-v0.0.2/
    └── ...
```

The launcher contains the source commit timestamp, abbreviated hash, and date. `--update`
downloads the fixed latest archive and asks before replacing its adjacent launcher and HTML.
It updates to the development version even when run from a versioned release. `SAZANAMI2_UPDATE_URL`
can select another archive for a mirror or local testing. Only the named app files are extracted.

`make check` runs TypeScript checks, the launcher/update tests, a production build, and a check
that the HTML embeds its scripts and styles. It does not run browser interaction tests.

## Publish a release

Update `package.json` and `package-lock.json` to the next version, commit the changes, and merge
them into `master`. Verify the development deployment, then fast-forward `stable` to the tested
release commit:

```bash
git fetch origin
git switch stable
git pull --ff-only origin stable
git merge --ff-only master
git push origin stable
git switch master
```

After verifying the stable deployment, create a new annotated tag matching the package version:

```bash
version="$(node -p 'require("./package.json").version')"
git tag -a "v$version" -m "Sazanami2 v$version"
git push origin "v$version"
```

Use a new version; existing tags are not moved. `.github/workflows/release.yml` verifies that the
tag matches `package.json` and that the commit is reachable from both `master` and `stable`. It
runs `make release-archive` and attaches the ZIP to a GitHub Release. The release workflow uses
its `GITHUB_TOKEN` with `contents: write` permission.
