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
cd "$(dirname "$ROOT")"
"$CLI" unlink "$(basename "$ROOT")"
"$CLI" link "$(basename "$ROOT")"
