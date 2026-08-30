import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_CLIP_DURATION_SECONDS,
  validateClipRange,
} from "../src/clip-range";
import {
  buildEvenFullResolutionFilter,
  buildSarAwareScaleFilter,
  calculateBoundedDimensions,
} from "../src/dimensions";
import { shouldSanitizeReservedColorTransfer } from "../src/color-metadata";
import {
  assessDiskSpace,
  parsePosixDf,
  queryDiskSpace,
  type DiskSpaceInfo,
} from "../src/disk-space";
import {
  buildMp4Args,
  describeFfmpegFailure,
  exportMp4,
  shouldFallbackToLibx264,
} from "../src/export-mp4";
import {
  buildGifEncodeArgs,
  buildGifEncodeFilterGraph,
  buildGifPaletteArgs,
  buildGifPaletteFilter,
  describeGifFailure,
  exportGif,
} from "../src/export-gif";
import {
  LONG_CLIP_CONFIRMATION_SECONDS,
  MEBIBYTE,
  TOTAL_SIZE_CONFIRMATION_BYTES,
  buildExportRiskAssessment,
  estimateExportStorage,
  estimateGifStorage,
  estimateMp4Storage,
  formatBytes,
  formatDuration,
  type ExportStorageEstimate,
} from "../src/export-preflight";
import {
  buildExportConfirmationNotice,
  buildExportWarning,
} from "../src/export-confirmation";
import {
  createExportLifecycle,
  exportLifecycleIsCurrent,
  sourceStartBelongsToNaturalEof,
} from "../src/export-lifecycle";
import {
  MAXIMUM_BASENAME_UTF8_BYTES,
  buildClipBasename,
  chooseAvailableOutputPath,
  formatMediaTimeForFilename,
  sanitizeFilenameComponent,
  utf8ByteLength,
} from "../src/filenames";
import {
  buildSavedClipNotice,
  formatExportOutcomeMessage,
  type ExportOutcome,
} from "../src/notifications";
import {
  eofReachedFromEvent,
  hasKnownHdrParameterSet,
  isKnownHdr,
} from "../src/media-info";
import {
  initialRecorderState,
  reduceRecorderState,
} from "../src/recorder-state";
import {
  DEFAULT_RECORDER_PREFERENCES,
  validateRecorderPreferences,
} from "../src/preferences";
import {
  canonicalizeShortcutInput,
  formatShortcutForDisplay,
} from "../src/shortcut";
import { parseSourceFingerprint } from "../src/source-fingerprint";
import type { ClipRange, MediaSnapshot } from "../src/types";

const range: ClipRange = { start: 1.25, end: 3.75, duration: 2.5 };
const snapshot: MediaSnapshot = {
  sourcePath: "/Видео/тест 🎬.mkv",
  sourceUrl: "file:///Видео/тест%20🎬.mkv",
  sourceName: "тест 🎬.mkv",
  startPosition: 1.25,
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 23.976,
  selectedVideoStreamIndex: 0,
  selectedVideoIsExternal: false,
  hasEmbeddedAudio: true,
  selectedEmbeddedAudioStreamIndex: 1,
  selectedAudioIsExternal: false,
  videoParameters: null,
  isHdr: false,
};

test("validates and clamps a clip range", () => {
  assert.deepEqual(validateClipRange(-2, 12, 10), {
    ok: true,
    range: { start: 0, end: 10, duration: 10 },
  });
  assert.deepEqual(validateClipRange(4, 3, 10), {
    ok: false,
    error: "end_before_start",
  });
  assert.deepEqual(
    validateClipRange(1, 1 + MINIMUM_CLIP_DURATION_SECONDS / 2, 10),
    { ok: false, error: "too_short" },
  );
  assert.deepEqual(validateClipRange(Number.NaN, 2, 10), {
    ok: false,
    error: "invalid_timestamp",
  });
});

test("bounds dimensions, preserves display aspect ratio and never upscales", () => {
  assert.deepEqual(
    calculateBoundedDimensions(
      { width: 3840, height: 2160 },
      { width: 1920, height: 1080 },
    ),
    { width: 1920, height: 1080 },
  );
  assert.deepEqual(
    calculateBoundedDimensions(
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
    ),
    { width: 1280, height: 720 },
  );
  assert.deepEqual(
    calculateBoundedDimensions(
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
    ),
    { width: 606, height: 1080 },
  );
  assert.deepEqual(
    calculateBoundedDimensions(
      { width: 1440, height: 1080, sampleAspectRatio: 4 / 3 },
      { width: 1920, height: 1080 },
    ),
    { width: 1440, height: 810 },
  );
  assert.deepEqual(
    calculateBoundedDimensions(
      { width: 1919, height: 1079 },
      { width: 1920, height: 1080 },
    ),
    { width: 1918, height: 1078 },
  );
});

test("accounts for rotation in the pure geometry helper", () => {
  assert.deepEqual(
    calculateBoundedDimensions(
      { width: 1920, height: 1080, rotation: 90 },
      { width: 1920, height: 1080 },
    ),
    { width: 606, height: 1080 },
  );
});

test("builds an even square-pixel FFmpeg scale filter", () => {
  const filter = buildSarAwareScaleFilter(1920, 1080);
  assert.match(filter, /iw\*sar/);
  assert.match(filter, /1\/sar/);
  assert.match(filter, /trunc\(/);
  assert.match(filter, /setsar=1$/);
  const fullFilter = buildEvenFullResolutionFilter();
  assert.match(fullFilter, /trunc\(iw\/2\)/);
  assert.match(fullFilter, /trunc\(ih\/2\)/);
  assert.doesNotMatch(fullFilter, /setsar=1/);
});

test("builds safe, deterministic filenames while preserving Unicode", () => {
  assert.equal(formatMediaTimeForFilename(3661.007), "01h01m01s007");
  assert.equal(sanitizeFilenameComponent("  Мой: ролик 🎬 / test  "), "Мой_ ролик 🎬 _ test");
  assert.equal(
    buildClipBasename(
      "/Видео/Мой ролик 🎬.mov",
      new Date(2026, 6, 15, 9, 8, 7),
      1.25,
      3.75,
    ),
    "Мой ролик 🎬_clip_2026-07-15_09-08-07_00h00m01s250-00h00m03s750",
  );
});

test("allocates a non-conflicting output path without overwriting", () => {
  const occupied = new Set([
    "/tmp/name.mp4",
    "/tmp/name_2.mp4",
  ]);
  assert.equal(
    chooseAvailableOutputPath("/tmp", "name", ".mp4", (path) => occupied.has(path)),
    "/tmp/name_3.mp4",
  );
});

test("keeps the complete basename within a UTF-8 byte budget", () => {
  const basename = buildClipBasename(
    `/tmp/${"🎬".repeat(100)}.mp4`,
    new Date(2026, 6, 15, 9, 8, 7),
    1.25,
    3.75,
  );
  assert.ok(utf8ByteLength(basename) <= MAXIMUM_BASENAME_UTF8_BYTES);
  const finalComponent = `${basename}_10000.mp4`;
  assert.ok(utf8ByteLength(finalComponent) <= 255);
});

test("builds MP4 args as a shell-free argv with source timing and optional audio", () => {
  const args = buildMp4Args(
    {
      sourcePath: "/Видео/source with spaces 🎬.mkv",
      temporaryOutputPath: "/tmp/output with spaces.mp4",
      range,
    },
    "h264_videotoolbox",
  );
  assert.equal(args[args.indexOf("-ss") + 1], "1.250000");
  assert.equal(args[args.indexOf("-t") + 1], "2.500000");
  assert.ok(args.includes("/Видео/source with spaces 🎬.mkv"));
  assert.ok(args.includes("/tmp/output with spaces.mp4"));
  assert.ok(args.includes("0:a:0"));
  assert.ok(args.includes("h264_videotoolbox"));
  assert.ok(args.includes("passthrough"));
  assert.equal(args[args.indexOf("-enc_time_base:v") + 1], "demux");
  assert.equal(args.includes("-r"), false);
  assert.equal(args.includes("-c"), false);

  const silentArgs = buildMp4Args(
    {
      sourcePath: "/tmp/input.mp4",
      temporaryOutputPath: "/tmp/silent.mp4",
      range,
      includeAudio: false,
    },
    "h264_videotoolbox",
  );
  assert.ok(silentArgs.includes("-an"));
  assert.equal(silentArgs.includes("0:a:0"), false);
  assert.equal(silentArgs.includes("-c:a"), false);

  const fullArgs = buildMp4Args(
    {
      sourcePath: "/tmp/input.mp4",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
      resolution: "full",
    },
    "h264_videotoolbox",
  );
  const fullFilter = fullArgs[fullArgs.indexOf("-vf") + 1];
  assert.match(fullFilter ?? "", /trunc\(iw\/2\)/);
  assert.doesNotMatch(fullFilter ?? "", /1920/);

  const repairedArgs = buildMp4Args(
    {
      sourcePath: "/tmp/reserved-transfer.mov",
      temporaryOutputPath: "/tmp/repaired.mp4",
      range,
    },
    "libx264",
    true,
  );
  assert.match(
    repairedArgs[repairedArgs.indexOf("-vf") + 1] ?? "",
    /^setparams=color_trc=unknown,scale=/,
  );
  assert.doesNotMatch(
    args[args.indexOf("-vf") + 1] ?? "",
    /setparams=color_trc=/,
  );
});

test("builds deterministic, range-bounded two-pass GIF argv", () => {
  const input = {
    sourcePath: "/Видео/source with spaces 🎬.mkv",
    temporaryOutputPath: "/tmp/output with spaces.gif.part",
    temporaryPalettePath: "/tmp/palette with spaces.png",
    range,
    resolution: "720p" as const,
    frameRate: "12" as const,
  };
  const paletteArgs = buildGifPaletteArgs(input);
  const encodeArgs = buildGifEncodeArgs(input);
  assert.deepEqual(paletteArgs, buildGifPaletteArgs(input));
  assert.deepEqual(encodeArgs, buildGifEncodeArgs(input));

  for (const args of [paletteArgs, encodeArgs]) {
    assert.equal(args[args.indexOf("-ss") + 1], "1.250000");
    assert.equal(args[args.indexOf("-t") + 1], "2.500000");
    assert.ok(args.indexOf("-t") < args.indexOf("-i"));
    assert.ok(args.includes(input.sourcePath));
    assert.ok(args.includes("-an"));
    assert.equal(args.includes("-c:a"), false);
  }

  assert.equal(paletteArgs[paletteArgs.length - 1], input.temporaryPalettePath);
  assert.equal(paletteArgs[paletteArgs.indexOf("-f") + 1], "image2");
  assert.equal(paletteArgs[paletteArgs.indexOf("-frames:v") + 1], "1");
  const paletteFilter = paletteArgs[paletteArgs.indexOf("-vf") + 1] ?? "";
  assert.match(paletteFilter, /^fps=fps=12,/);
  assert.match(paletteFilter, /1280\/\(iw\*sar\)/);
  assert.match(paletteFilter, /720\/ih/);
  assert.match(paletteFilter, /palettegen=max_colors=256:stats_mode=diff$/);
  assert.doesNotMatch(paletteFilter, /paletteuse|split=/);

  assert.equal(encodeArgs[encodeArgs.length - 1], input.temporaryOutputPath);
  assert.equal(encodeArgs[encodeArgs.indexOf("-f") + 1], "gif");
  assert.ok(encodeArgs.includes(input.temporaryPalettePath));
  const graph = encodeArgs[encodeArgs.indexOf("-filter_complex") + 1] ?? "";
  assert.match(graph, /^\[0:v:0\]fps=fps=12,/);
  assert.doesNotMatch(graph, /palettegen|split=/);
  assert.match(
    graph,
    /\[gif_frames\]\[1:v:0\]paletteuse=dither=sierra2_4a:diff_mode=rectangle\[gif\]$/,
  );
  assert.equal(encodeArgs[encodeArgs.indexOf("-map") + 1], "[gif]");

  const repairedPalette = buildGifPaletteArgs(input, true);
  assert.match(
    repairedPalette[repairedPalette.indexOf("-vf") + 1] ?? "",
    /^setparams=color_trc=unknown,fps=fps=12,/,
  );
  const repairedEncode = buildGifEncodeArgs(input, true);
  assert.match(
    repairedEncode[repairedEncode.indexOf("-filter_complex") + 1] ?? "",
    /^\[0:v:0\]setparams=color_trc=unknown,fps=fps=12,/,
  );
});

test("builds Full Resolution and Match Source GIF filters without forced FPS", () => {
  const graph = buildGifEncodeFilterGraph("full", "source");
  assert.doesNotMatch(graph, /fps=fps=/);
  assert.match(graph, /round\(iw\*sar\*/);
  assert.match(graph, /min\(1,1\/sar\)/);
  assert.match(graph, /setsar=1/);
  assert.doesNotMatch(graph, /1280|720/);

  const paletteFilter = buildGifPaletteFilter("full", "source");
  assert.doesNotMatch(paletteFilter, /fps=fps=/);
  assert.match(paletteFilter, /palettegen=/);

  const args = buildGifEncodeArgs({
    sourcePath: "/tmp/input.mp4",
    temporaryOutputPath: "/tmp/output.gif",
    temporaryPalettePath: "/tmp/palette.png",
    range,
    resolution: "full",
    frameRate: "source",
  });
  assert.equal(args.includes("-r"), false);
  assert.equal(args[args.indexOf("-fps_mode:v") + 1], "passthrough");
});

test("classifies actionable GIF export failures", () => {
  assert.match(
    describeGifFailure({
      status: 1,
      stdout: "",
      stderr: "No space left on device",
    }),
    /free disk space/i,
  );
  assert.match(
    describeGifFailure({
      status: 1,
      stdout: "",
      stderr: "No such filter: 'palettegen'",
    }),
    /palette filters required/i,
  );
  assert.match(
    describeGifFailure({
      status: 1,
      stdout: "",
      stderr: "Decoder not found for stream #0:0",
    }),
    /could not decode/i,
  );
  assert.match(
    describeGifFailure({
      status: 1,
      stdout: "",
      stderr: "Permission denied",
    }),
    /permissions/i,
  );
  assert.match(
    describeGifFailure({ status: 9, stdout: "", stderr: "" }),
    /terminated/i,
  );
});

test("recognizes only the reserved-transfer swscale compatibility failure", () => {
  assert.equal(
    shouldSanitizeReservedColorTransfer(
      "Unsupported input (Operation not supported): fmt:yuv422p10le csp:bt709 prim:bt709 trc:(null) -> fmt:yuv420p csp:bt709 prim:bt709 trc:(null)",
    ),
    true,
  );
  assert.equal(
    shouldSanitizeReservedColorTransfer(
      "Unsupported input (Operation not supported): fmt:yuv422p10le csp:bt709 prim:bt709 trc:reserved -> fmt:yuv420p csp:bt709 prim:bt709 trc:reserved",
    ),
    true,
  );
  assert.equal(
    shouldSanitizeReservedColorTransfer(
      "Unsupported input: fmt:yuv420p csp:bt2020 prim:bt2020 trc:smpte2084 -> fmt:yuv420p trc:reserved",
    ),
    false,
  );
  assert.equal(
    shouldSanitizeReservedColorTransfer(
      "Unsupported input: fmt:yuv422p10le csp:bt2020 prim:bt2020 trc:reserved -> fmt:yuv420p csp:bt2020 prim:bt2020 trc:reserved",
    ),
    false,
  );
  assert.equal(
    shouldSanitizeReservedColorTransfer(
      "VideoToolbox compression session failed: Invalid time base: demux",
    ),
    false,
  );
});

test("runs both GIF passes, stops after a palette failure and always cleans up", async () => {
  let promoted = 0;
  let cleaned = 0;
  let verified = 0;
  let phases: string[] = [];
  const input = {
    sourcePath: "/tmp/input.mp4",
    temporaryOutputPath: "/tmp/output.gif",
    temporaryPalettePath: "/tmp/palette.png",
    range,
    resolution: "720p" as const,
    frameRate: "12" as const,
  };

  await exportGif(input, {
    async run(_args, phase) {
      phases.push(phase);
      return { status: 0, stdout: "", stderr: "" };
    },
    cleanupTemporaryFiles() {
      cleaned += 1;
    },
    async promoteTemporaryFile() {
      promoted += 1;
    },
    async verifySource() {
      verified += 1;
    },
  });
  assert.deepEqual(phases, ["palette", "encode"]);
  assert.equal(promoted, 1);
  assert.equal(cleaned, 1);
  assert.equal(verified, 2);

  phases = [];
  await assert.rejects(
    exportGif(input, {
      async run(_args, phase) {
        phases.push(phase);
        return {
          status: 1,
          stdout: "",
          stderr: "No space left on device",
        };
      },
      cleanupTemporaryFiles() {
        cleaned += 1;
      },
      async promoteTemporaryFile() {
        promoted += 1;
      },
      async verifySource() {
        verified += 1;
      },
    }),
    /free disk space/i,
  );
  assert.deepEqual(phases, ["palette"]);
  assert.equal(promoted, 1);
  assert.equal(cleaned, 2);
  assert.equal(verified, 3);
});

test("retries the complete GIF workflow after a reserved-transfer failure", async () => {
  const input = {
    sourcePath: "/tmp/reserved-transfer.mov",
    temporaryOutputPath: "/tmp/output.gif",
    temporaryPalettePath: "/tmp/palette.png",
    range,
    resolution: "720p" as const,
    frameRate: "12" as const,
  };
  const phases: string[] = [];
  const filters: string[] = [];
  let cleaned = 0;
  let promoted = 0;
  let verified = 0;

  await exportGif(input, {
    async run(args, phase) {
      phases.push(phase);
      const option = phase === "palette" ? "-vf" : "-filter_complex";
      filters.push(args[args.indexOf(option) + 1] ?? "");
      if (phases.length === 1) {
        return {
          status: 211,
          stdout: "",
          stderr:
            "Unsupported input: fmt:yuv422p10le csp:bt709 prim:bt709 trc:reserved -> fmt:bgra csp:gbr prim:bt709 trc:reserved",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    cleanupTemporaryFiles() {
      cleaned += 1;
    },
    async promoteTemporaryFile() {
      promoted += 1;
    },
    async verifySource() {
      verified += 1;
    },
  });

  assert.deepEqual(phases, ["palette", "palette", "encode"]);
  assert.doesNotMatch(filters[0] ?? "", /setparams=color_trc=/);
  assert.match(filters[1] ?? "", /setparams=color_trc=unknown/);
  assert.match(filters[2] ?? "", /setparams=color_trc=unknown/);
  assert.equal(cleaned, 2);
  assert.equal(promoted, 1);
  assert.equal(verified, 3);
});

test("restarts both GIF passes when the encode pass finds reserved transfer metadata", async () => {
  const input = {
    sourcePath: "/tmp/reserved-transfer.mov",
    temporaryOutputPath: "/tmp/output.gif",
    temporaryPalettePath: "/tmp/palette.png",
    range,
    resolution: "720p" as const,
    frameRate: "12" as const,
  };
  const phases: string[] = [];
  const filters: string[] = [];
  let cleaned = 0;
  let promoted = 0;
  let verified = 0;

  await exportGif(input, {
    async run(args, phase) {
      phases.push(phase);
      const option = phase === "palette" ? "-vf" : "-filter_complex";
      filters.push(args[args.indexOf(option) + 1] ?? "");
      if (phases.length === 2) {
        return {
          status: 211,
          stdout: "",
          stderr:
            "Unsupported input: fmt:yuv422p10le csp:bt709 prim:bt709 trc:reserved -> fmt:bgra csp:gbr prim:bt709 trc:reserved",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    cleanupTemporaryFiles() {
      cleaned += 1;
    },
    async promoteTemporaryFile() {
      promoted += 1;
    },
    async verifySource() {
      verified += 1;
    },
  });

  assert.deepEqual(phases, ["palette", "encode", "palette", "encode"]);
  assert.doesNotMatch(filters[0] ?? "", /setparams=color_trc=/);
  assert.doesNotMatch(filters[1] ?? "", /setparams=color_trc=/);
  assert.match(filters[2] ?? "", /setparams=color_trc=unknown/);
  assert.match(filters[3] ?? "", /setparams=color_trc=unknown/);
  assert.equal(cleaned, 2);
  assert.equal(promoted, 1);
  assert.equal(verified, 4);
});

test("canonicalizes configurable shortcuts and renders macOS notation", () => {
  assert.deepEqual(canonicalizeShortcutInput("Cmd + R"), {
    ok: true,
    value: "Meta+r",
  });
  assert.deepEqual(canonicalizeShortcutInput("⌃⌥C"), {
    ok: true,
    value: "Ctrl+Alt+c",
  });
  assert.equal(formatShortcutForDisplay("Meta+r"), "⌘R");
  assert.equal(formatShortcutForDisplay("Ctrl+Alt+Meta+c"), "⌃⌥⌘C");
  assert.deepEqual(canonicalizeShortcutInput("Ctrl+Alt+Shift+Cmd+F12"), {
    ok: true,
    value: "Ctrl+Alt+Shift+Meta+F12",
  });
  assert.equal(canonicalizeShortcutInput("R").ok, false);
  assert.equal(canonicalizeShortcutInput("Banana+r").ok, false);
  assert.equal(canonicalizeShortcutInput("Shift+r").ok, false);
  assert.equal(canonicalizeShortcutInput("Meta++r").ok, false);
  assert.equal(canonicalizeShortcutInput("+Meta+r").ok, false);
});

test("validates complete Stage 5 preference values", () => {
  assert.deepEqual(
    validateRecorderPreferences(DEFAULT_RECORDER_PREFERENCES),
    { ok: true, value: DEFAULT_RECORDER_PREFERENCES },
  );

  const custom = validateRecorderPreferences({
    ...DEFAULT_RECORDER_PREFERENCES,
    shortcut: "⌘R",
    mp4Resolution: "full",
    outputDirectory: "/Volumes/Clips 🎬",
    ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  });
  assert.equal(custom.ok, true);
  if (custom.ok) {
    assert.equal(custom.value.shortcut, "Meta+r");
    assert.equal(custom.value.mp4Resolution, "full");
  }

  assert.equal(
    validateRecorderPreferences({
      ...DEFAULT_RECORDER_PREFERENCES,
      mp4Enabled: false,
      gifEnabled: false,
    }).ok,
    false,
  );
  const gifOnly = validateRecorderPreferences({
    ...DEFAULT_RECORDER_PREFERENCES,
    mp4Enabled: false,
    gifEnabled: true,
    gifResolution: "full",
    gifFps: "source",
  });
  assert.equal(gifOnly.ok, true);
  if (gifOnly.ok) {
    assert.equal(gifOnly.value.mp4Enabled, false);
    assert.equal(gifOnly.value.gifEnabled, true);
    assert.equal(gifOnly.value.gifResolution, "full");
    assert.equal(gifOnly.value.gifFps, "source");
  }
  const silentMp4 = validateRecorderPreferences({
    ...DEFAULT_RECORDER_PREFERENCES,
    mp4WithoutAudio: true,
  });
  assert.equal(silentMp4.ok, true);
  if (silentMp4.ok) {
    assert.equal(silentMp4.value.mp4WithoutAudio, true);
  }
  assert.equal(
    validateRecorderPreferences({
      ...DEFAULT_RECORDER_PREFERENCES,
      mp4Resolution: "4k",
    }).ok,
    false,
  );
  assert.equal(
    validateRecorderPreferences({
      ...DEFAULT_RECORDER_PREFERENCES,
      outputDirectory: "relative/path",
    }).ok,
    false,
  );
});

test("formats complete, partial and failed multi-format notifications", () => {
  const mp4Success: ExportOutcome = {
    format: "MP4",
    ok: true,
    outputPath: "/Clips/clip.mp4",
    detail: "h264_videotoolbox",
  };
  const gifSuccess: ExportOutcome = {
    format: "GIF",
    ok: true,
    outputPath: "/Clips/clip.gif",
    detail: "palette",
  };
  const gifFailure: ExportOutcome = {
    format: "GIF",
    ok: false,
    outputPath: "/Clips/clip.gif",
    message: "palette filters are unavailable",
  };

  assert.equal(
    formatExportOutcomeMessage([mp4Success, gifSuccess]),
    [
      "Clips saved",
      "MP4: clip.mp4 (h264_videotoolbox)",
      "GIF: clip.gif (palette)",
      "/Clips",
    ].join("\n"),
  );
  assert.match(
    formatExportOutcomeMessage([mp4Success, gifFailure]),
    /partly completed[\s\S]*Saved MP4: clip\.mp4[\s\S]*GIF failed:/,
  );
  assert.match(
    formatExportOutcomeMessage([
      { ...mp4Success, ok: false, message: "encoder unavailable" },
      gifFailure,
    ]),
    /^Clip export failed[\s\S]*MP4: encoder unavailable[\s\S]*GIF:/,
  );
  assert.deepEqual(buildSavedClipNotice([mp4Success, gifSuccess], 6.673), {
    title: "Clips saved",
    detail: "MP4 + GIF · 6.7 seconds",
    actionLabel: "Reveal in Finder",
  });
  assert.deepEqual(buildSavedClipNotice([mp4Success, gifFailure], 10), {
    title: "Clip partly saved",
    detail: "MP4 · 10 seconds · GIF failed",
    actionLabel: "Reveal in Finder",
  });
});

test("builds libx264 fallback args and classifies encoder failures", () => {
  const args = buildMp4Args(
    {
      sourcePath: "/tmp/input.mp4",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
    },
    "libx264",
  );
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("20"));
  assert.equal(
    shouldFallbackToLibx264("Error creating a VideoToolbox compression session"),
    true,
  );
  assert.equal(shouldFallbackToLibx264("No space left on device"), false);
  assert.equal(
    shouldFallbackToLibx264(
      "[vost#0:0/h264_videotoolbox] Invalid time base: demux",
    ),
    false,
  );
  assert.match(
    describeFfmpegFailure(
      [{ status: 1, stdout: "", stderr: "No space left on device" }],
      false,
    ),
    /free disk space/i,
  );
  assert.match(
    describeFfmpegFailure(
      [
        { status: 1, stdout: "", stderr: "Unknown encoder 'h264_videotoolbox'" },
        { status: 1, stdout: "", stderr: "Unknown encoder 'libx264'" },
      ],
      true,
    ),
    /neither a usable videotoolbox nor libx264/i,
  );
  assert.match(
    describeFfmpegFailure(
      [{ status: 234, stdout: "", stderr: "Invalid time base: -1" }],
      true,
    ),
    /timestamp settings/i,
  );
});

test("rechecks the source before MP4 software fallback", async () => {
  const encoders: string[] = [];
  let verified = 0;
  let promoted = 0;
  await exportMp4(
    {
      sourcePath: "/tmp/input.mkv",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
    },
    {
      async run(_args, encoder) {
        encoders.push(encoder);
        return encoder === "h264_videotoolbox"
          ? {
              status: 1,
              stdout: "",
              stderr: "VideoToolbox compression session failed",
            }
          : { status: 0, stdout: "", stderr: "" };
      },
      cleanupTemporaryFile() {},
      async promoteTemporaryFile() {
        promoted += 1;
      },
      async verifySource() {
        verified += 1;
      },
    },
  );
  assert.deepEqual(encoders, ["h264_videotoolbox", "libx264"]);
  assert.equal(verified, 2);
  assert.equal(promoted, 1);
});

test("retries reserved transfer metadata before changing MP4 encoders", async () => {
  const encoders: string[] = [];
  const filters: string[] = [];
  let cleaned = 0;
  let verified = 0;

  await exportMp4(
    {
      sourcePath: "/tmp/reserved-transfer.mov",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
    },
    {
      async run(args, encoder) {
        encoders.push(encoder);
        filters.push(args[args.indexOf("-vf") + 1] ?? "");
        return encoders.length === 1
          ? {
              status: 211,
              stdout: "",
              stderr:
                "Unsupported input: fmt:yuv422p10le csp:bt709 prim:bt709 trc:(null) -> fmt:yuv420p csp:bt709 prim:bt709 trc:(null)",
            }
          : { status: 0, stdout: "", stderr: "" };
      },
      cleanupTemporaryFile() {
        cleaned += 1;
      },
      async promoteTemporaryFile() {},
      async verifySource() {
        verified += 1;
      },
    },
  );

  assert.deepEqual(encoders, ["h264_videotoolbox", "h264_videotoolbox"]);
  assert.doesNotMatch(filters[0] ?? "", /setparams=color_trc=/);
  assert.match(filters[1] ?? "", /^setparams=color_trc=unknown,/);
  assert.equal(cleaned, 1);
  assert.equal(verified, 2);
});

test("repairs reserved transfer metadata after MP4 software fallback", async () => {
  const encoders: string[] = [];
  const filters: string[] = [];

  await exportMp4(
    {
      sourcePath: "/tmp/reserved-transfer.mov",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
    },
    {
      async run(args, encoder) {
        encoders.push(encoder);
        filters.push(args[args.indexOf("-vf") + 1] ?? "");
        if (encoders.length === 1) {
          return {
            status: 1,
            stdout: "",
            stderr: "VideoToolbox compression session failed",
          };
        }
        if (encoders.length === 2) {
          return {
            status: 211,
            stdout: "",
            stderr:
              "Unsupported input: fmt:yuv422p10le csp:bt709 prim:bt709 trc:reserved -> fmt:yuv420p csp:bt709 prim:bt709 trc:reserved",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      cleanupTemporaryFile() {},
      async promoteTemporaryFile() {},
    },
  );

  assert.deepEqual(encoders, [
    "h264_videotoolbox",
    "libx264",
    "libx264",
  ]);
  assert.doesNotMatch(filters[1] ?? "", /setparams=color_trc=/);
  assert.match(filters[2] ?? "", /^setparams=color_trc=unknown,/);
});

test("maps the selected embedded audio stream by FFmpeg stream index", () => {
  const args = buildMp4Args(
    {
      sourcePath: "/tmp/input.mkv",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
      selectedEmbeddedAudioStreamIndex: 3,
    },
    "h264_videotoolbox",
  );
  assert.equal(args[args.indexOf("0:v:0") + 2], "0:3");
});

test("maps the selected video strictly and makes no-audio input explicit", () => {
  const selected = buildMp4Args(
    {
      sourcePath: "/tmp/multi-video.mkv",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
      selectedVideoStreamIndex: 4,
      selectedEmbeddedAudioStreamIndex: 5,
      hasEmbeddedAudio: true,
    },
    "h264_videotoolbox",
  );
  assert.ok(selected.includes("0:4"));
  assert.ok(selected.includes("0:5"));
  assert.equal(selected.includes("0:v:0"), false);
  assert.equal(selected.includes("0:a:0"), false);

  const noAudio = buildMp4Args(
    {
      sourcePath: "/tmp/video-only.mkv",
      temporaryOutputPath: "/tmp/output.mp4",
      range,
      hasEmbeddedAudio: false,
      includeAudio: true,
    },
    "h264_videotoolbox",
  );
  assert.ok(noAudio.includes("-an"));
  assert.equal(noAudio.includes("-c:a"), false);
  assert.equal(noAudio.includes("0:a:0"), false);
});

test("uses the selected video stream in both GIF passes", () => {
  const input = {
    sourcePath: "/tmp/multi-video.mkv",
    temporaryOutputPath: "/tmp/output.gif",
    temporaryPalettePath: "/tmp/palette.png",
    range,
    resolution: "720p" as const,
    frameRate: "12" as const,
    selectedVideoStreamIndex: 4,
  };
  const palette = buildGifPaletteArgs(input);
  const encode = buildGifEncodeArgs(input);
  assert.equal(palette[palette.indexOf("-map") + 1], "0:4");
  assert.match(
    encode[encode.indexOf("-filter_complex") + 1] ?? "",
    /^\[0:4\]/,
  );
});

test("estimates MP4 and GIF storage without changing export settings", () => {
  const audioMp4 = estimateMp4Storage(10, true);
  const silentMp4 = estimateMp4Storage(10, false);
  assert.equal(
    audioMp4.estimatedBytes,
    Math.ceil((10 * (7_000_000 + 192_000) * 1.03) / 8),
  );
  assert.equal(
    silentMp4.estimatedBytes,
    Math.ceil((10 * 7_000_000 * 1.03) / 8),
  );
  assert.ok(audioMp4.estimatedBytes > silentMp4.estimatedBytes);
  assert.ok(audioMp4.planningBytes > audioMp4.estimatedBytes);

  const gif = estimateGifStorage(
    { width: 1280, height: 720, fps: 23.976 },
    { duration: 10 },
    "720p",
    "12",
  );
  assert.equal(gif.frameCount, 120);
  assert.equal(gif.pixelFrames, 1280 * 720 * 120);
  assert.equal(gif.estimatedBytes, Math.ceil(gif.pixelFrames * 0.3));
  assert.ok(gif.planningBytes > gif.estimatedBytes);

  const small = estimateGifStorage(
    { width: 640, height: 360, fps: 24 },
    { duration: 10 },
    "720p",
    "12",
  );
  assert.equal(small.pixelFrames, 640 * 360 * 120);

  const unknownMatchSource = estimateGifStorage(
    { width: 320, height: 180, fps: null },
    { duration: 2 },
    "full",
    "source",
  );
  assert.equal(unknownMatchSource.estimatedFps, 60);
  assert.equal(unknownMatchSource.sourceFpsUnknown, true);
});

test("combines sequential export estimates and flags explicit risk boundaries", () => {
  const preferences = {
    ...DEFAULT_RECORDER_PREFERENCES,
    mp4Enabled: true,
    gifEnabled: true,
  };
  const estimate = estimateExportStorage(
    snapshot,
    { duration: 2 },
    preferences,
  );
  assert.equal(estimate.formats.length, 2);
  assert.equal(
    estimate.estimatedFinalBytes,
    estimate.formats.reduce((sum, item) => sum + item.estimatedBytes, 0),
  );
  assert.equal(
    estimate.estimatedTemporaryBytes,
    Math.max(...estimate.formats.map((item) => item.estimatedBytes)),
  );

  const mp4Only = {
    ...DEFAULT_RECORDER_PREFERENCES,
    mp4Enabled: true,
    gifEnabled: false,
  };
  const beforeLong = estimateExportStorage(
    snapshot,
    { duration: LONG_CLIP_CONFIRMATION_SECONDS - 0.001 },
    mp4Only,
  );
  assert.equal(
    buildExportRiskAssessment(
      beforeLong,
      { duration: LONG_CLIP_CONFIRMATION_SECONDS - 0.001 },
    ).risks.some((risk) => risk.code === "long_clip"),
    false,
  );
  const atLong = estimateExportStorage(
    snapshot,
    { duration: LONG_CLIP_CONFIRMATION_SECONDS },
    mp4Only,
  );
  assert.equal(
    buildExportRiskAssessment(
      atLong,
      { duration: LONG_CLIP_CONFIRMATION_SECONDS },
    ).risks.some((risk) => risk.code === "long_clip"),
    true,
  );

  const ordinaryGifPreferences = {
    ...DEFAULT_RECORDER_PREFERENCES,
    mp4Enabled: false,
    gifEnabled: true,
    gifResolution: "720p" as const,
    gifFps: "12" as const,
  };
  const ordinaryGif = estimateExportStorage(
    { ...snapshot, width: 320, height: 180, fps: 12 },
    { duration: 52 },
    ordinaryGifPreferences,
  );
  assert.equal(
    buildExportRiskAssessment(
      ordinaryGif,
      { duration: 52 },
    ).requiresConfirmation,
    false,
  );

  const boundaryEstimate: ExportStorageEstimate = {
    formats: [],
    estimatedFinalBytes: TOTAL_SIZE_CONFIRMATION_BYTES,
    planningFinalBytes: TOTAL_SIZE_CONFIRMATION_BYTES,
    estimatedTemporaryBytes: TOTAL_SIZE_CONFIRMATION_BYTES,
    planningTemporaryBytes: TOTAL_SIZE_CONFIRMATION_BYTES,
  };
  assert.equal(
    buildExportRiskAssessment(
      boundaryEstimate,
      { duration: 1 },
    ).risks.some((risk) => risk.code === "large_estimated_size"),
    true,
  );
});

test("builds one concise export confirmation without presenting a false maximum", () => {
  const estimate = estimateExportStorage(
    snapshot,
    { duration: LONG_CLIP_CONFIRMATION_SECONDS },
    {
      ...DEFAULT_RECORDER_PREFERENCES,
      mp4Enabled: false,
      gifEnabled: true,
    },
  );
  const risk = buildExportRiskAssessment(
    {
      ...estimate,
      estimatedFinalBytes: TOTAL_SIZE_CONFIRMATION_BYTES,
    },
    { duration: LONG_CLIP_CONFIRMATION_SECONDS },
  );
  const outputDisk: DiskSpaceInfo = {
    filesystem: "/dev/disk3s5",
    totalBytes: 100 * 1024 * MEBIBYTE,
    usedBytes: 40 * 1024 * MEBIBYTE,
    availableBytes: 60 * 1024 * MEBIBYTE,
    mountPoint: "/",
  };
  const assessment = assessDiskSpace(estimate, outputDisk, outputDisk);
  const notice = buildExportConfirmationNotice({
    estimate,
    assessment,
    outputDisk,
    temporaryDisk: outputDisk,
    range: {
      start: 0,
      end: LONG_CLIP_CONFIRMATION_SECONDS,
      duration: LONG_CLIP_CONFIRMATION_SECONDS,
    },
    risk,
  });

  assert.equal(notice.title, "Review export");
  assert.equal(
    notice.warning,
    "This export may create a large file and take a while.",
  );
  assert.doesNotMatch(notice.estimates, /allow|up to|planning|reserve/i);
  assert.equal(notice.warning.split("\n").length, 1);

  const lowReserveAssessment = {
    ...assessment,
    warnings: ["internal planning warning"],
  };
  assert.equal(
    buildExportWarning(risk, lowReserveAssessment),
    "This export may need more free space than the estimate shown.",
  );
});

test("formats approximate sizes and human-readable durations", () => {
  assert.equal(formatBytes(512 * MEBIBYTE), "512 MB");
  assert.equal(formatBytes(1.5 * 1024 * MEBIBYTE), "1.50 GB");
  assert.equal(formatBytes(1536), "2 KB");
  assert.equal(formatDuration(0.4), "0 sec");
  assert.equal(formatDuration(65), "1 min 5 sec");
  assert.equal(formatDuration(3661), "1 hr 1 min 1 sec");
});

test("parses macOS POSIX df output and keeps mount paths intact", () => {
  const parsed = parsePosixDf(
    [
      "Filesystem   1024-blocks      Used Available Capacity  Mounted on",
      "/dev/disk3s5   971350180 887233388  58345436    94%    /System/Volumes/Data",
    ].join("\r\n"),
  );
  assert.equal(parsed.filesystem, "/dev/disk3s5");
  assert.equal(parsed.availableBytes, 58_345_436 * 1024);
  assert.equal(parsed.mountPoint, "/System/Volumes/Data");

  const spaced = parsePosixDf(
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk9 1000 100 900 10% /Volumes/Clips 🎬\n",
  );
  assert.equal(spaced.mountPoint, "/Volumes/Clips 🎬");
  assert.throws(() => parsePosixDf("Filesystem 1024-blocks\n"), /data row/);
  assert.throws(
    () =>
      parsePosixDf(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1 1 unsafe 1% /\n",
      ),
    /unsigned integer/,
  );
});

test("queries df with a shell-free argv and classifies disk plans", async () => {
  const calls: Array<[string, readonly string[]]> = [];
  const output = await queryDiskSpace(
    "/Volumes/Clips 🎬",
    async (executable, args) => {
      calls.push([executable, args]);
      return {
        status: 0,
        stdout:
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/output 1000000 1000 999000 1% /Volumes/Clips 🎬\n",
        stderr: "",
      };
    },
  );
  assert.deepEqual(calls, [["/bin/df", ["-Pk", "/Volumes/Clips 🎬"]]]);
  assert.equal(output.filesystem, "/dev/output");
  await assert.rejects(
    queryDiskSpace("/bad", async () => ({
      status: 1,
      stdout: "",
      stderr: "not found",
    })),
    /Could not check free space/,
  );

  const info = (
    filesystem: string,
    availableBytes: number,
  ): DiskSpaceInfo => ({
    filesystem,
    totalBytes: availableBytes * 2,
    usedBytes: availableBytes,
    availableBytes,
    mountPoint: "/",
  });
  const plan: ExportStorageEstimate = {
    formats: [],
    estimatedFinalBytes: 100 * MEBIBYTE,
    planningFinalBytes: 200 * MEBIBYTE,
    estimatedTemporaryBytes: 60 * MEBIBYTE,
    planningTemporaryBytes: 120 * MEBIBYTE,
  };
  const same = assessDiskSpace(
    plan,
    info("/dev/same", 100 * MEBIBYTE),
    info("/dev/same", 100 * MEBIBYTE),
  );
  assert.equal(same.blocked, false);
  assert.equal(same.requirements.length, 1);
  assert.ok(same.warnings.length > 0);

  const different = assessDiskSpace(
    plan,
    info("/dev/output", 100 * MEBIBYTE - 1),
    info("/dev/temp", 1_000 * MEBIBYTE),
  );
  assert.equal(different.blocked, true);
  assert.match(different.blockMessage ?? "", /output disk/i);
  assert.equal(different.requirements.length, 2);
});

test("normalizes numeric mpv EOF payloads and detects known HDR metadata", () => {
  assert.equal(eofReachedFromEvent(true), true);
  assert.equal(eofReachedFromEvent(false), false);
  assert.equal(eofReachedFromEvent(1), true);
  assert.equal(eofReachedFromEvent(0), false);
  assert.equal(eofReachedFromEvent("yes"), null);
  assert.equal(isKnownHdr({ primaries: "bt.2020", gamma: "pq" }), true);
  assert.equal(isKnownHdr({ gamma: "smpte-st-2084" }), true);
  assert.equal(isKnownHdr({ transfer: "arib-std-b67" }), true);
  assert.equal(isKnownHdr({ primaries: "bt.709", gamma: "bt.1886" }), false);
  assert.equal(isKnownHdr({ "sig-peak": 1.5 }), true);
  assert.equal(
    hasKnownHdrParameterSet(
      { primaries: "bt.709", gamma: "bt.1886" },
      { primaries: "bt.2020", transfer: "smpte-st-2084" },
    ),
    true,
  );
});

test("parses stable source fingerprints and rejects malformed stat output", () => {
  assert.deepEqual(parseSourceFingerprint("16777234:12345:987654:1784250000\n"), {
    device: "16777234",
    inode: "12345",
    size: "987654",
    modified: "1784250000",
    value: "16777234:12345:987654:1784250000",
  });
  assert.throws(
    () => parseSourceFingerprint("device:inode:size:mtime"),
    /invalid source fingerprint/,
  );
});

test("keeps a natural-EOF export attached across exactly one playlist advance", () => {
  const ordinary = createExportLifecycle(4, false, true);
  assert.equal(exportLifecycleIsCurrent(ordinary, 4, true), true);
  assert.equal(exportLifecycleIsCurrent(ordinary, 4, false), false);
  assert.equal(exportLifecycleIsCurrent(ordinary, 5, true), false);
  assert.equal(sourceStartBelongsToNaturalEof(ordinary, 5), false);

  const eofBeforeAdvance = createExportLifecycle(4, true, true);
  assert.equal(exportLifecycleIsCurrent(eofBeforeAdvance, 4, true), true);
  assert.equal(exportLifecycleIsCurrent(eofBeforeAdvance, 4, false), true);
  assert.equal(exportLifecycleIsCurrent(eofBeforeAdvance, 5, false), true);
  assert.equal(sourceStartBelongsToNaturalEof(eofBeforeAdvance, 5), true);
  assert.equal(exportLifecycleIsCurrent(eofBeforeAdvance, 6, false), false);
  assert.equal(sourceStartBelongsToNaturalEof(eofBeforeAdvance, 6), false);

  const eofAfterAdvance = createExportLifecycle(5, true, false);
  assert.equal(exportLifecycleIsCurrent(eofAfterAdvance, 5, false), true);
  assert.equal(sourceStartBelongsToNaturalEof(eofAfterAdvance, 6), false);
});

test("enforces explicit recorder state transitions", () => {
  const idle = initialRecorderState();
  const recording = reduceRecorderState(idle, { type: "start", snapshot });
  assert.equal(recording.kind, "recording");
  const preflighting = reduceRecorderState(recording, {
    type: "stop",
    range,
  });
  assert.equal(preflighting.kind, "preflighting");
  assert.deepEqual(
    reduceRecorderState(preflighting, { type: "cancel" }),
    { kind: "idle" },
  );
  const encoding = reduceRecorderState(preflighting, {
    type: "beginEncoding",
  });
  assert.equal(encoding.kind, "encoding");
  assert.deepEqual(reduceRecorderState(encoding, { type: "complete" }), {
    kind: "idle",
  });
  const failed = reduceRecorderState(encoding, {
    type: "fail",
    message: "both formats failed",
  });
  assert.deepEqual(failed, {
    kind: "error",
    message: "both formats failed",
  });
  assert.deepEqual(reduceRecorderState(failed, { type: "reset" }), {
    kind: "idle",
  });
  assert.throws(
    () => reduceRecorderState(idle, { type: "complete" }),
    /Invalid recorder transition/,
  );
  assert.deepEqual(
    reduceRecorderState(recording, { type: "cancel" }),
    { kind: "idle" },
  );
});
