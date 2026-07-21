#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CLI=${IINA_PLUGIN_CLI:-/Applications/IINA.app/Contents/MacOS/iina-plugin}

if [ ! -x "$CLI" ]; then
  echo "IINA plugin CLI not found: $CLI" >&2
  exit 1
fi

cd "$ROOT"
sh scripts/check.sh
VERSION=$(node -p 'JSON.parse(require("node:fs").readFileSync("Info.json", "utf8")).version')

STAGE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/iina-clip-recorder.XXXXXX")
trap 'rm -rf "$STAGE_ROOT"' EXIT HUP INT TERM
STAGE="$STAGE_ROOT/iina-clip-recorder"

mkdir -p "$STAGE/dist" "$STAGE/preferences" "$STAGE/overlay"
cp Info.json "$STAGE/"
cp dist/index.js "$STAGE/dist/"
cp preferences/preferences.html preferences/preferences.css preferences/preferences.js \
  preferences/preferences-core.js \
  "$STAGE/preferences/"
cp overlay/clip-saved.html overlay/export-warning.html "$STAGE/overlay/"

cd "$STAGE_ROOT"
"$CLI" pack iina-clip-recorder

mkdir -p "$ROOT/build"
ARCHIVE="iina-clip-recorder-$VERSION.iinaplgz"
ARCHIVE_PATH="$ROOT/build/$ARCHIVE"
mv "$STAGE_ROOT/$ARCHIVE" "$ARCHIVE_PATH"

unzip -t "$ARCHIVE_PATH" >/dev/null
CONTENTS=$(unzip -Z1 "$ARCHIVE_PATH")
for REQUIRED in \
  Info.json \
  dist/index.js \
  preferences/preferences.html \
  preferences/preferences.css \
  preferences/preferences.js \
  preferences/preferences-core.js \
  overlay/clip-saved.html \
  overlay/export-warning.html
do
  if ! printf '%s\n' "$CONTENTS" | grep -Fqx "$REQUIRED"; then
    echo "Package is missing required entry: $REQUIRED" >&2
    exit 1
  fi
done

if printf '%s\n' "$CONTENTS" | grep -Eq '^(src|scripts|tests|docs|node_modules)/|\.map$'; then
  echo "Package contains development-only files" >&2
  exit 1
fi

PACKAGED_VERSION=$(
  unzip -p "$ARCHIVE_PATH" Info.json |
    node -e 'let data=""; process.stdin.on("data", chunk => data += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(data).version));'
)
if [ "$PACKAGED_VERSION" != "$VERSION" ]; then
  echo "Packaged version $PACKAGED_VERSION does not match $VERSION" >&2
  exit 1
fi

echo "Created and verified $ARCHIVE_PATH"
