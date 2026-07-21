import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  buildGifEncodeArgs,
  buildGifPaletteArgs,
} from "../src/export-gif";
import { buildMp4Args } from "../src/export-mp4";
import type { ClipRange } from "../src/types";

const root = path.resolve(import.meta.dirname, "..");
const fixtures = path.resolve(
  process.env.IINA_CLIP_FIXTURES ??
    path.join(root, "test-media", "generated"),
);
const results = path.join(root, ".test-results", "media-integration");
const ffmpeg = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe";

function run(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(executable)} failed (${String(result.status)}):\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function fixture(name: string): string {
  const value = path.join(fixtures, name);
  assert.ok(fs.existsSync(value), `missing fixture: ${value}`);
  return value;
}

function probe(file: string): {
  readonly streams: ReadonlyArray<Record<string, unknown>>;
  readonly format: Record<string, unknown>;
} {
  return JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]),
  );
}

function video(file: string): Record<string, unknown> {
  const stream = probe(file).streams.find(
    (item) => item.codec_type === "video",
  );
  assert.ok(stream, `video stream missing: ${file}`);
  return stream;
}

function audio(file: string): ReadonlyArray<Record<string, unknown>> {
  return probe(file).streams.filter((item) => item.codec_type === "audio");
}

function encodeMp4(options: {
  readonly input: string;
  readonly output: string;
  readonly range?: ClipRange;
  readonly resolution?: "1080p" | "full";
  readonly selectedVideoStreamIndex?: number;
  readonly selectedEmbeddedAudioStreamIndex?: number;
  readonly hasEmbeddedAudio?: boolean;
  readonly includeAudio?: boolean;
}): void {
  run(
    ffmpeg,
    buildMp4Args(
      {
        sourcePath: options.input,
        temporaryOutputPath: options.output,
        range: options.range ?? { start: 0, end: 1, duration: 1 },
        resolution: options.resolution ?? "1080p",
        selectedVideoStreamIndex: options.selectedVideoStreamIndex ?? 0,
        ...(options.selectedEmbeddedAudioStreamIndex === undefined
          ? {}
          : {
              selectedEmbeddedAudioStreamIndex:
                options.selectedEmbeddedAudioStreamIndex,
            }),
        hasEmbeddedAudio: options.hasEmbeddedAudio ?? false,
        includeAudio: options.includeAudio ?? false,
      },
      "libx264",
    ),
  );
}

function timestamps(file: string): number[] {
  return run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    file,
  ])
    .trim()
    .split(/\r?\n/)
    .map(Number)
    .filter(Number.isFinite);
}

function deltas(values: readonly number[]): Set<string> {
  return new Set(
    values
      .slice(1)
      .map((value, index) => value - (values[index] ?? value))
      .filter((value) => value > 0)
      .map((value) => value.toFixed(3)),
  );
}

fs.rmSync(results, { recursive: true, force: true });
fs.mkdirSync(results, { recursive: true });

const portraitOutput = path.join(results, "portrait.mp4");
encodeMp4({
  input: fixture("04 — portrait 1080x1920.mp4"),
  output: portraitOutput,
});
assert.equal(video(portraitOutput).width, 606);
assert.equal(video(portraitOutput).height, 1080);

const smallOutput = path.join(results, "small-no-upscale.mp4");
encodeMp4({
  input: fixture("06 — below 720p.mp4"),
  output: smallOutput,
});
assert.equal(video(smallOutput).width, 640);
assert.equal(video(smallOutput).height, 360);

const rotationOutput = path.join(results, "rotation-full.mp4");
encodeMp4({
  input: fixture("10 — rotation 90.mp4"),
  output: rotationOutput,
  resolution: "full",
});
assert.equal(video(rotationOutput).width, 360);
assert.equal(video(rotationOutput).height, 640);

const sarOutput = path.join(results, "anamorphic.mp4");
encodeMp4({
  input: fixture("11 — anamorphic SAR 16-15.mkv"),
  output: sarOutput,
});
assert.equal(video(sarOutput).sample_aspect_ratio, "1:1");
assert.equal(video(sarOutput).display_aspect_ratio, "4:3");

const oddOutput = path.join(results, "odd-full.mp4");
encodeMp4({
  input: fixture("12 — odd 641x359.mkv"),
  output: oddOutput,
  resolution: "full",
});
assert.equal(Number(video(oddOutput).width) % 2, 0);
assert.equal(Number(video(oddOutput).height) % 2, 0);
assert.ok(Number(video(oddOutput).width) <= 641);
assert.ok(Number(video(oddOutput).height) <= 359);

const noAudioOutput = path.join(results, "no-audio.mp4");
encodeMp4({
  input: fixture("08 — no audio.mp4"),
  output: noAudioOutput,
  hasEmbeddedAudio: false,
  includeAudio: true,
});
assert.equal(audio(noAudioOutput).length, 0);

const selectedAudioOutput = path.join(results, "selected-audio.mp4");
encodeMp4({
  input: fixture("09 — two audio tracks.mkv"),
  output: selectedAudioOutput,
  hasEmbeddedAudio: true,
  includeAudio: true,
  selectedEmbeddedAudioStreamIndex: 2,
});
const selectedAudio = audio(selectedAudioOutput);
assert.equal(selectedAudio.length, 1);
assert.equal(
  (selectedAudio[0]?.tags as Record<string, unknown> | undefined)?.name,
  "Tone 880 Hz",
);

const vfrInput = fixture("07 — real VFR.mkv");
const vfrOutput = path.join(results, "vfr.mp4");
encodeMp4({
  input: vfrInput,
  output: vfrOutput,
  range: { start: 0, end: 3.8, duration: 3.8 },
  resolution: "full",
});
const inputDeltas = deltas(timestamps(vfrInput));
const outputDeltas = deltas(timestamps(vfrOutput));
assert.ok(inputDeltas.size >= 2, "input fixture is VFR");
assert.ok(outputDeltas.size >= 2, "MP4 output remains VFR");
for (const delta of inputDeltas) {
  assert.ok(outputDeltas.has(delta), `output preserves ${delta}s VFR interval`);
}

const gifInput = fixture("06 — below 720p.mp4");
const gifPalette = path.join(results, "palette.png");
const gifOutput = path.join(results, "clip.gif");
const gifCommand = {
  sourcePath: gifInput,
  temporaryOutputPath: gifOutput,
  temporaryPalettePath: gifPalette,
  range: { start: 0, end: 1.5, duration: 1.5 },
  resolution: "720p" as const,
  frameRate: "12" as const,
  selectedVideoStreamIndex: 0,
};
run(ffmpeg, buildGifPaletteArgs(gifCommand));
run(ffmpeg, buildGifEncodeArgs(gifCommand));
assert.equal(video(gifOutput).width, 640);
assert.equal(video(gifOutput).height, 360);
assert.equal(video(gifOutput).nb_frames, "18");
assert.equal(video(gifOutput).duration, "1.500000");
fs.rmSync(gifPalette, { force: true });

console.log(`Stage 5 media integration passed: ${results}`);
