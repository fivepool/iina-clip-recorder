#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${1:-"$ROOT/test-media/generated"}
FFMPEG=${FFMPEG:-/opt/homebrew/bin/ffmpeg}

if [ ! -x "$FFMPEG" ]; then
  FFMPEG=$(command -v ffmpeg || true)
fi
if [ -z "$FFMPEG" ] || [ ! -x "$FFMPEG" ]; then
  echo "FFmpeg is required to generate Stage 5 fixtures." >&2
  exit 1
fi

mkdir -p "$OUT" "$OUT/Unicode path 🎬"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=24000/1001:duration=4" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=4" \
  -shortest -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p \
  -c:a aac -b:a 128k "$OUT/01 — 1080p 23.976 AAC.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=3840x2160:rate=25:duration=1" \
  -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p -an \
  "$OUT/02 — 4K 25.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=3840x2160:rate=60000/1001:duration=1" \
  -c:v libx264 -preset ultrafast -crf 36 -pix_fmt yuv420p -an \
  "$OUT/03 — 4K 59.94.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1080x1920:rate=24:duration=2" \
  -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -an \
  "$OUT/04 — portrait 1080x1920.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=2" \
  -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -an \
  "$OUT/05 — 720p.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=2" \
  -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -an \
  "$OUT/06 — below 720p.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" \
  -vf "select='if(lt(t,2),not(mod(n,2)),1)',setpts=PTS-STARTPTS" \
  -fps_mode vfr -c:v ffv1 -level 3 -an "$OUT/07 — real VFR.mkv"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=3" \
  -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -an \
  "$OUT/08 — no audio.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=3" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=3" \
  -map 0:v:0 -map 1:a:0 -map 2:a:0 \
  -metadata:s:a:0 title="Tone 440 Hz" -metadata:s:a:1 title="Tone 880 Hz" \
  -disposition:a:0 default -disposition:a:1 0 \
  -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -shortest "$OUT/09 — two audio tracks.mkv"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=2" \
  -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -an \
  "$OUT/.rotation-base.mp4"
"$FFMPEG" -hide_banner -loglevel error -y \
  -display_rotation:v:0 90 -i "$OUT/.rotation-base.mp4" \
  -map 0 -c copy "$OUT/10 — rotation 90.mp4"
rm -f "$OUT/.rotation-base.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=720x576:rate=25:duration=2" \
  -vf "setsar=16/15" -c:v libx264 -preset ultrafast -crf 28 \
  -pix_fmt yuv420p -an "$OUT/11 — anamorphic SAR 16-15.mkv"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=641x359:rate=24:duration=2" \
  -vf "format=yuv444p" -c:v ffv1 -level 3 -an \
  "$OUT/12 — odd 641x359.mkv"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=5" \
  -vf "format=yuv420p10le" -c:v libx265 -preset ultrafast \
  -x265-params "log-level=error:colorprim=9:transfer=16:colormatrix=9" \
  -an "$OUT/13 — HDR10 metadata.mkv"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=320x180:rate=12:duration=35" \
  -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -an \
  "$OUT/14 — 35 second warning source.mp4"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=160x90:rate=1:duration=305" \
  -c:v libx264 -preset ultrafast -crf 32 -pix_fmt yuv420p -an \
  "$OUT/15 — 305 second warning source.mp4"

# ProRes/MOV can carry reserved transfer value 3. FFmpeg 8+ exposes it as
# `(null)` or `reserved` and rejects 10-bit to 8-bit conversion until that
# invalid metadata value is sanitized.
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=2" \
  -vf "format=yuv422p10le,setparams=colorspace=bt709:color_primaries=bt709:color_trc=3" \
  -c:v prores_ks -profile:v 2 -an \
  "$OUT/16 — ProRes reserved transfer.mov"

"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=24:duration=3" \
  -f lavfi -i "sine=frequency=523.25:sample_rate=48000:duration=3" \
  -shortest -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p \
  -c:a aac -b:a 96k "$OUT/Unicode path 🎬/Юникод — тест 🎞️.mp4"

echo "Generated Stage 5 fixtures in $OUT"
