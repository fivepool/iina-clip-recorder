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

last_argument=""
for argument in "$@"; do
  last_argument=$argument
done

case "$last_argument" in
  *.mp4)
    echo "Intentional Stage 4 MP4 failure" >&2
    exit 43
    ;;
esac

exec "$REAL_FFMPEG" "$@"
