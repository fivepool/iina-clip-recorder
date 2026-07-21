#!/bin/sh
set -eu

REAL_FFMPEG=${REAL_FFMPEG:-/opt/homebrew/bin/ffmpeg}
if [ ! -x "$REAL_FFMPEG" ] && [ -x /usr/local/bin/ffmpeg ]; then
  REAL_FFMPEG=/usr/local/bin/ffmpeg
fi
if [ ! -x "$REAL_FFMPEG" ]; then
  echo "Set REAL_FFMPEG to an executable FFmpeg path" >&2
  exit 127
fi

previous=""
for argument in "$@"; do
  if [ "$previous" = "-f" ] && [ "$argument" = "gif" ]; then
    echo "Intentional Stage 4 GIF failure" >&2
    exit 42
  fi
  previous=$argument
done

exec "$REAL_FFMPEG" "$@"
