.DEFAULT_GOAL := all

.PHONY: all production serve init clean docker-run docker-build pack launcher-check \
	typecheck check archive latest-archive release-archive release-version-check

BUILD_ID := $(shell git show -s --format=%ct-%h-%cs HEAD)
PACKAGE_VERSION := $(shell node -p 'require("./package.json").version')
ARCHIVE_NAME := sazanami2-v$(PACKAGE_VERSION)
ARCHIVE_ROOT := dist-release
ARCHIVE_DIR := $(ARCHIVE_ROOT)/$(ARCHIVE_NAME)
ARCHIVE_PATH := $(ARCHIVE_ROOT)/$(ARCHIVE_NAME).zip

all:
	mkdir -p dist
	npx webpack

production:
	mkdir -p dist
	npx webpack --mode production
	cp sazanami2.sh dist/sazanami2.sh
	sed -i 's/^build=0-source-unknown$$/build=$(BUILD_ID)/' dist/sazanami2.sh
	grep -qx 'build=$(BUILD_ID)' dist/sazanami2.sh
	chmod +x dist/sazanami2.sh
	cp src/launch_httpd.sh dist/launch_httpd.sh
	cp ./THIRD-PARTY-LICENSES.md dist/THIRD-PARTY-LICENSES.md
	cp ./README.md dist/README.md
	cp ./LICENSE.md dist/LICENSE.md
	mkdir -p dist/docs
	cp docs/releasing.md docs/sample.csv dist/docs/

serve:
	npx webpack serve --open

launcher-check:
	bash -n sazanami2.sh
	test -x sazanami2.sh
	python3 test/sazanami2_launcher_test.py

typecheck:
	./node_modules/.bin/tsc --noEmit

check:
	$(MAKE) typecheck
	$(MAKE) launcher-check
	$(MAKE) production
	python3 test/single_html_smoke.py dist/index.html

init:
	npm install
	npx license-checker --production --relativeLicensePath --excludePackages sazanami2@0.0.2 > THIRD-PARTY-LICENSES.md
	sed -i "s|$(shell pwd)/||g" THIRD-PARTY-LICENSES.md

clean:
	rm -rf dist dist-release

docker-run:
	./docker/run.sh

docker-build:
	cd docker; make docker-build

pack: release-archive

release-version-check:
	node -e 'const p = require("./package.json"); const l = require("./package-lock.json"); if (p.version !== l.version || p.version !== l.packages[""].version) throw new Error("package.json and package-lock.json versions do not match.");'

# check済みの配布物を、展開時に専用フォルダへ収まるZIPにまとめる。
archive:
	rm -rf "$(ARCHIVE_DIR)" "$(ARCHIVE_PATH)"
	mkdir -p "$(ARCHIVE_DIR)"
	cp -a dist/. "$(ARCHIVE_DIR)/"
	cd "$(ARCHIVE_ROOT)" && zip -q -r "$(ARCHIVE_NAME).zip" "$(ARCHIVE_NAME)"
	zip -T "$(ARCHIVE_PATH)"
	@echo "Archive created: $(ARCHIVE_PATH)"

latest-archive: check
	$(MAKE) archive ARCHIVE_NAME=sazanami2-latest

release-archive: release-version-check check
	$(MAKE) archive
