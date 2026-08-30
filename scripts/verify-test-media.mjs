import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.resolve(
  process.argv[2] ?? path.join(root, "test-media", "generated"),
);
const ffprobe =
  process.env.FFPROBE ??
  (fs.existsSync("/opt/homebrew/bin/ffprobe")
    ? "/opt/homebrew/bin/ffprobe"
    : "ffprobe");

function probe(name) {
  const file = path.join(directory, name);
  assert.ok(fs.existsSync(file), `missing fixture: ${name}`);
  return JSON.parse(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    ),
  );
}

function video(data) {
  const stream = data.streams.find((item) => item.codec_type === "video");
  assert.ok(stream, "video stream is present");
  return stream;
}

const baseline = probe("01 — 1080p 23.976 AAC.mp4");
assert.equal(video(baseline).width, 1920);
assert.equal(video(baseline).height, 1080);
assert.equal(video(baseline).avg_frame_rate, "24000/1001");
assert.equal(
  baseline.streams.filter((item) => item.codec_type === "audio").length,
  1,
);

assert.equal(video(probe("02 — 4K 25.mp4")).width, 3840);
assert.equal(video(probe("03 — 4K 59.94.mp4")).avg_frame_rate, "60000/1001");
assert.equal(video(probe("04 — portrait 1080x1920.mp4")).height, 1920);
assert.equal(video(probe("05 — 720p.mp4")).width, 1280);
assert.equal(video(probe("06 — below 720p.mp4")).width, 640);

const vfrFile = path.join(directory, "07 — real VFR.mkv");
const vfrIntervals = execFileSync(
  ffprobe,
  [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    vfrFile,
  ],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/)
  .map(Number)
  .slice(1)
  .map((value, index, values) =>
    index === 0 ? value : value - (values[index - 1] ?? 0),
  )
  .filter((value) => value > 0);
const roundedIntervals = new Set(vfrIntervals.map((value) => value.toFixed(3)));
assert.ok(roundedIntervals.size >= 2, "VFR fixture has multiple frame intervals");

assert.equal(
  probe("08 — no audio.mp4").streams.some(
    (item) => item.codec_type === "audio",
  ),
  false,
);
assert.equal(
  probe("09 — two audio tracks.mkv").streams.filter(
    (item) => item.codec_type === "audio",
  ).length,
  2,
);

const rotation = video(probe("10 — rotation 90.mp4"));
assert.ok(
  rotation.side_data_list?.some(
    (item) => Math.abs(Number(item.rotation)) === 90,
  ),
  "rotation metadata is present",
);
assert.equal(
  video(probe("11 — anamorphic SAR 16-15.mkv")).sample_aspect_ratio,
  "16:15",
);
const odd = video(probe("12 — odd 641x359.mkv"));
assert.equal(odd.width, 641);
assert.equal(odd.height, 359);
const hdr = video(probe("13 — HDR10 metadata.mkv"));
assert.equal(hdr.color_primaries, "bt2020");
assert.equal(hdr.color_transfer, "smpte2084");
const gifWarning = probe("14 — 35 second warning source.mp4");
assert.ok(Number(gifWarning.format.duration) >= 35);
const longWarning = probe("15 — 305 second warning source.mp4");
assert.ok(Number(longWarning.format.duration) >= 305);
const reservedTransfer = video(probe("16 — ProRes reserved transfer.mov"));
assert.equal(reservedTransfer.codec_name, "prores");
assert.equal(reservedTransfer.pix_fmt, "yuv422p10le");
assert.equal(reservedTransfer.color_space, "bt709");
assert.equal(reservedTransfer.color_primaries, "bt709");
assert.equal(reservedTransfer.color_transfer, "reserved");
assert.ok(
  fs.existsSync(
    path.join(directory, "Unicode path 🎬", "Юникод — тест 🎞️.mp4"),
  ),
);

console.log(`Verified Stage 5 fixtures in ${directory}`);
