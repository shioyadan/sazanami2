"""Exercise the launcher through its CLI and HTTP interface using only stdlib."""

from contextlib import contextmanager
import os
from pathlib import Path
import selectors
import shutil
import signal
import socket
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile


LAUNCHER = Path(__file__).resolve().parents[1] / "sazanami2.sh"


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sazanami2-launcher-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.install = self.root / "installed copy"
        self.install.mkdir()
        self.script = self.install / "sazanami2.sh"
        shutil.copy2(LAUNCHER, self.script)
        self.html = b"<!doctype html><title>Sazanami2 launcher test</title>"
        (self.install / "index.html").write_bytes(self.html)
        self.data = self.root / "data.csv"
        self.data.write_bytes(b"y,x,s\n1,2,XX\n2,4,YY\n")
        self.env = os.environ.copy()
        self.env.pop("SAZANAMI2_PORT", None)
        self.env["NO_COLOR"] = "1"
        # Local test requests must not go through proxy environment settings.
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @contextmanager
    def server(self, data=None, script=None):
        process = subprocess.Popen(
            [str(script or self.script), str(data or self.data)],
            cwd=self.root, env=self.env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(selector.select(timeout=10), "Server startup timed out")
            line = process.stdout.readline().strip()
            self.assertTrue(line.startswith("Sazanami2 URL: "), line)
            url = line.removeprefix("Sazanami2 URL: ")
            port = urllib.parse.urlsplit(url).port
            self.assertEqual(
                process.stdout.readline().strip(),
                "SSH tunnel: ssh -L {0}:127.0.0.1:{0} <host>".format(port),
            )
            self.assertEqual(process.stdout.readline().strip(), "Press Ctrl+C to stop the server.")
            yield url
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
            try:
                _, errors = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                self.fail("Server did not stop on Ctrl+C")
            self.assertEqual(process.returncode, 0, errors)

    def read(self, url):
        with self.http.open(url, timeout=5) as response:
            return response.read()

    def assert_data(self, url, data):
        # Match App's query decoding and resolution of the file URL.
        path = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["file"][0]
        data_url = urllib.parse.urljoin(url, path)
        self.assertEqual(self.read(data_url), data.read_bytes())
        return data_url

    def test_distribution_serves_only_app_and_selected_file(self):
        (self.install / "unrelated.txt").write_text("not exposed")
        with self.server() as url:
            self.assertEqual(self.read(url), self.html)
            self.assertEqual(self.read(urllib.parse.urljoin(url, "/index.html")), self.html)
            data_url = self.assert_data(url, self.data)
            request = urllib.request.Request(data_url, method="HEAD")
            with self.http.open(request, timeout=5) as response:
                self.assertEqual(int(response.headers["Content-Length"]), self.data.stat().st_size)
                self.assertEqual(response.read(), b"")
            for path in ("/unrelated.txt", "/sazanami2.sh", "/data/", "/../unrelated.txt", "/%2e%2e/unrelated.txt"):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.read(urllib.parse.urljoin(url, path))
                self.assertEqual(error.exception.code, 404)
                self.assertEqual(error.exception.read(), b"")
                error.exception.close()

    def test_special_filename_preserves_compression_extension(self):
        data = self.root / "日本語 space #?&%+.csv.zst"
        data.write_bytes(b"\x28\xb5\x2f\xfd compressed fixture")
        with self.server(data=data) as url:
            data_url = self.assert_data(url, data)
            self.assertTrue(urllib.parse.urlsplit(data_url).path.endswith(".zst"))

    def test_source_build_and_symlink_from_another_directory(self):
        dist = self.install / "dist"
        dist.mkdir()
        (self.install / "index.html").rename(dist / "index.html")
        (dist / "bundle.js").write_bytes(b"console.log('development bundle');")
        link = self.root / "launcher link"
        link.symlink_to(self.script)
        with self.server(script=link) as url:
            self.assertEqual(self.read(url), self.html)
            self.assertEqual(self.read(urllib.parse.urljoin(url, "/bundle.js")), (dist / "bundle.js").read_bytes())
            self.assert_data(url, self.data)

    def test_explicit_port(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.env["SAZANAMI2_PORT"] = str(port)
        with self.server() as url:
            self.assertEqual(urllib.parse.urlsplit(url).port, port)
            self.assert_data(url, self.data)

    def run_cli(self, *args):
        return subprocess.run(
            [str(self.script), *map(str, args)], cwd=self.root, env=self.env,
            capture_output=True, text=True, timeout=10,
        )

    def test_invalid_arguments_and_missing_build(self):
        self.assertEqual(self.run_cli("--help").returncode, 0)
        self.assertEqual(self.run_cli().returncode, 2)
        self.assertEqual(self.run_cli(self.data, self.data).returncode, 2)
        result = self.run_cli(self.root / "missing.csv")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not a readable file", result.stderr)
        (self.install / "index.html").unlink()
        result = self.run_cli(self.data)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("make production", result.stderr)

    def test_invalid_and_occupied_ports(self):
        for port in ("", "0", "-1", "65536", "abc", "12345678901234567890"):
            with self.subTest(port=port):
                self.env["SAZANAMI2_PORT"] = port
                result = self.run_cli(self.data)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SAZANAMI2_PORT must be", result.stderr)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            self.env["SAZANAMI2_PORT"] = str(sock.getsockname()[1])
            result = self.run_cli(self.data)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Could not start", result.stderr)
            self.assertNotIn("Sazanami2 URL:", result.stdout)


class UpdaterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sazanami2-updater-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.install = self.root / "installed copy"
        self.install.mkdir()
        self.script = self.install / "sazanami2.sh"
        self.index = self.install / "index.html"
        self.original_script = self.build_script("100-aaaaaaa-2026-01-01")
        self.original_html = b"<!doctype html><title>installed</title>"
        self.script.write_bytes(self.original_script)
        self.script.chmod(0o755)
        self.index.write_bytes(self.original_html)
        self.archive = self.root / "update archive.zip"
        self.payload = {
            "sazanami2.sh": self.build_script("200-bbbbbbb-2026-02-02"),
            "index.html": b"<!doctype html><title>updated</title>",
        }
        self.env = os.environ.copy()
        self.env["SAZANAMI2_UPDATE_URL"] = self.archive.as_uri()

    def build_script(self, build):
        return LAUNCHER.read_bytes().replace(b"build=0-source-unknown\n", ("build=" + build + "\n").encode())

    def write_archive(self, payload=None, prefix="sazanami2-latest/"):
        with zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in (self.payload if payload is None else payload).items():
                archive.writestr(prefix + name, content)

    def update(self, answer="y\n", script=None):
        result = subprocess.run(
            [str(script or self.script), "--update"], cwd=self.root,
            env=self.env, input=answer, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(list(self.install.glob(".sazanami2-update.*")), [])
        return result

    def assert_unchanged(self):
        self.assertEqual(self.script.read_bytes(), self.original_script)
        self.assertEqual(self.index.read_bytes(), self.original_html)

    def test_confirmed_update_and_already_current(self):
        self.write_archive()
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Installed build: aaaaaaa (2026-01-01)", result.stdout)
        self.assertIn("Available build: bbbbbbb (2026-02-02)", result.stdout)
        self.assertIn("A newer Sazanami2 build is available", result.stdout)
        self.assertIn("Install this update?", result.stderr)
        self.assertIn("Sazanami2 was updated", result.stdout)
        self.assertEqual(self.script.read_bytes(), self.payload["sazanami2.sh"])
        self.assertEqual(self.index.read_bytes(), self.payload["index.html"])
        self.assertEqual(self.script.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.index.stat().st_mode & 0o777, 0o644)
        result = self.update(answer="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already up to date", result.stdout)
        self.assertNotIn("Install this update?", result.stderr)

    def test_cancel_and_eof_preserve_installed_files(self):
        self.write_archive()
        for answer in ("n\n", "\n", ""):
            with self.subTest(answer=answer):
                result = self.update(answer)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Update cancelled", result.stdout)
                self.assert_unchanged()

    def test_versioned_archive(self):
        self.write_archive(prefix="sazanami2-v0.0.2/")
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.script.read_bytes(), self.payload["sazanami2.sh"])
        self.assertEqual(self.index.read_bytes(), self.payload["index.html"])

    def test_flat_and_ambiguous_archives_are_rejected(self):
        self.write_archive(prefix="")
        result = self.update()
        self.assertNotEqual(result.returncode, 0)
        self.assert_unchanged()
        self.write_archive()
        with zipfile.ZipFile(self.archive, "a") as archive:
            for name, content in self.payload.items():
                archive.writestr("sazanami2-v0.0.2/" + name, content)
        result = self.update()
        self.assertNotEqual(result.returncode, 0)
        self.assert_unchanged()

    def test_downgrade_is_identified_before_confirmation(self):
        self.payload["sazanami2.sh"] = self.build_script("50-ccccccc-2025-12-31")
        self.write_archive()
        result = self.update("n\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("older than this copy", result.stdout)
        self.assertIn("Available build: ccccccc (2025-12-31)", result.stdout)
        self.assertIn("Install this update?", result.stderr)
        self.assert_unchanged()

    def test_same_build_with_different_html_still_requires_confirmation(self):
        self.payload["sazanami2.sh"] = self.original_script
        self.write_archive()
        result = self.update("n\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("differs from this copy", result.stdout)
        self.assertIn("  index.html", result.stdout.splitlines())
        self.assertNotIn("  sazanami2.sh", result.stdout.splitlines())
        self.assert_unchanged()

    def test_invalid_archives_preserve_installed_files(self):
        invalid_payloads = (
            {"index.html": self.payload["index.html"]},
            {"sazanami2.sh": self.payload["sazanami2.sh"]},
            {**self.payload, "sazanami2.sh": LAUNCHER.read_bytes()},
            {**self.payload, "sazanami2.sh": self.payload["sazanami2.sh"] + b"\nif then\n"},
            {**self.payload, "index.html": b"not an HTML distribution"},
        )
        for index, payload in enumerate(invalid_payloads):
            with self.subTest(payload=index):
                self.write_archive(payload)
                result = self.update()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Sazanami2 update", result.stderr)
                self.assertNotIn("Install this update?", result.stderr)
                self.assert_unchanged()
        self.archive.write_bytes(b"not a ZIP archive")
        result = self.update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not download and unpack", result.stderr)
        self.assert_unchanged()

    def test_download_failure_preserves_installed_files(self):
        result = self.update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not download and unpack", result.stderr)
        self.assert_unchanged()

    def test_symlink_updates_target_and_ignores_unrelated_archive_entries(self):
        link = self.root / "launcher link"
        link.symlink_to(self.script)
        self.write_archive({**self.payload, "../outside.txt": b"must not be extracted"})
        result = self.update(script=link)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.read_bytes(), self.payload["sazanami2.sh"])
        self.assertEqual(self.index.read_bytes(), self.payload["index.html"])
        self.assertEqual(list(self.root.rglob("outside.txt")), [])

    def test_source_checkout_is_not_modified(self):
        dist = self.install / "dist"
        dist.mkdir()
        self.index.rename(dist / "index.html")
        self.write_archive()
        result = self.update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("only a distribution", result.stderr)
        self.assertIn("make production", result.stderr)
        self.assertEqual(self.script.read_bytes(), self.original_script)
        self.assertFalse(self.index.exists())
        self.assertEqual((dist / "index.html").read_bytes(), self.original_html)


if __name__ == "__main__":
    unittest.main()
