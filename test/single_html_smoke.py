"""Check that a Pages build contains the app without external script/style files."""

from html.parser import HTMLParser
from pathlib import Path
import sys


class AppHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.has_root = False
        self.inline_scripts = 0
        self.external_assets = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "div" and attrs.get("id") == "root":
            self.has_root = True
        if tag == "script":
            if "src" in attrs:
                self.external_assets.append(attrs["src"])
            else:
                self.inline_scripts += 1
        if tag == "link" and "stylesheet" in attrs.get("rel", "").lower().split():
            self.external_assets.append(attrs.get("href"))


path = Path(sys.argv[1])
html = path.read_text(encoding="utf-8")
app = AppHTML()
app.feed(html)
assert html.lstrip().lower().startswith("<!doctype html>"), "Missing HTML doctype"
assert app.has_root, "Missing app root"
assert app.inline_scripts > 0, "Missing inline app script"
assert not app.external_assets, "External app assets: {!r}".format(app.external_assets)
print("Single HTML verified: {}".format(path))
