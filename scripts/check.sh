#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

node -e '
  const fs = require("node:fs");
  const info = JSON.parse(fs.readFileSync("Info.json", "utf8"));
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (info.version !== pkg.version) {
    throw new Error(`Info.json version ${info.version} does not match package.json ${pkg.version}`);
  }
'
node --check preferences/preferences.js
node --check preferences/preferences-core.js
test -s preferences/preferences.html
test -s preferences/preferences.css
test -s preferences/preferences.js
test -s preferences/preferences-core.js
test -s overlay/clip-saved.html
test -s overlay/export-warning.html
test -s docs/implementation-plan.md
test -s docs/architecture.md
test -s docs/manual-test-plan.md
test -s docs/known-limitations.md
test -x scripts/fixtures/ffmpeg-fail-gif.sh
test -x scripts/fixtures/ffmpeg-fail-mp4.sh
sh -n scripts/fixtures/ffmpeg-fail-gif.sh
sh -n scripts/fixtures/ffmpeg-fail-mp4.sh
sh -n scripts/generate-test-media.sh
node --check scripts/verify-test-media.mjs
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p tsconfig.tests.json
./node_modules/.bin/tsx --test tests/*.test.ts
node --test tests/*.test.cjs
./node_modules/esbuild/bin/esbuild src/main.ts \
  --bundle \
  --format=iife \
  --platform=neutral \
  --target=safari13 \
  --charset=utf8 \
  --legal-comments=none \
  --outfile=dist/index.js

test -s dist/index.js
