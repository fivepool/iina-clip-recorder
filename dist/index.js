"use strict";
(() => {
  // src/clip-range.ts
  var MINIMUM_CLIP_DURATION_SECONDS = 0.1;
  function clamp(value, lower, upper) {
    return Math.min(upper, Math.max(lower, value));
  }
  function validateClipRange(rawStart, rawEnd, mediaDuration, minimumDuration = MINIMUM_CLIP_DURATION_SECONDS) {
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      return { ok: false, error: "invalid_timestamp" };
    }
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) {
      return { ok: false, error: "invalid_duration" };
    }
    const start = clamp(rawStart, 0, mediaDuration);
    const end = clamp(rawEnd, 0, mediaDuration);
    if (end < start) {
      return { ok: false, error: "end_before_start" };
    }
    const duration = end - start;
    if (!Number.isFinite(minimumDuration) || minimumDuration < 0 || duration < minimumDuration) {
      return { ok: false, error: "too_short" };
    }
    return {
      ok: true,
      range: { start, end, duration }
    };
  }

  // src/export-preflight.ts
  var MEBIBYTE = 1024 * 1024;
  var GIBIBYTE = 1024 * MEBIBYTE;
  var LONG_CLIP_CONFIRMATION_SECONDS = 5 * 60;
  var TOTAL_SIZE_CONFIRMATION_BYTES = 512 * MEBIBYTE;
  var MP4_VIDEO_BITRATE_BITS_PER_SECOND = 7e6;
  var MP4_AUDIO_BITRATE_BITS_PER_SECOND = 192e3;
  var MP4_MUX_MARGIN = 1.03;
  var MP4_PLANNING_MULTIPLIER = 1.35;
  var MP4_MINIMUM_PLANNING_MARGIN = 32 * MEBIBYTE;
  var GIF_ESTIMATED_BYTES_PER_PIXEL_FRAME = 0.3;
  var GIF_PLANNING_BYTES_PER_PIXEL_FRAME = 2;
  var GIF_PLANNING_MARGIN = 8 * MEBIBYTE;
  var UNKNOWN_SOURCE_FPS = 60;
  var MAXIMUM_ESTIMATED_SOURCE_FPS = 120;
  function requirePositiveFinite(value, label) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${label} must be a positive finite number`);
    }
  }
  function safeCeil(value, label) {
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(`${label} is outside the supported range`);
    }
    return Math.ceil(value);
  }
  function estimateMp4Storage(duration, includeAudio) {
    requirePositiveFinite(duration, "duration");
    const bitrate = MP4_VIDEO_BITRATE_BITS_PER_SECOND + (includeAudio ? MP4_AUDIO_BITRATE_BITS_PER_SECOND : 0);
    const estimatedBytes = safeCeil(
      duration * bitrate * MP4_MUX_MARGIN / 8,
      "MP4 estimate"
    );
    const planningBytes = safeCeil(
      Math.max(
        estimatedBytes * MP4_PLANNING_MULTIPLIER,
        estimatedBytes + MP4_MINIMUM_PLANNING_MARGIN
      ),
      "MP4 planning estimate"
    );
    return {
      format: "MP4",
      estimatedBytes,
      planningBytes,
      includesAudio: includeAudio,
      // VideoToolbox is bitrate-targeted, but the libx264 CRF fallback is not.
      uncertain: true
    };
  }
  function gifPixelCount(snapshot, resolution) {
    requirePositiveFinite(snapshot.width, "source width");
    requirePositiveFinite(snapshot.height, "source height");
    const sourcePixels = snapshot.width * snapshot.height;
    return resolution === "720p" ? Math.min(sourcePixels, 1280 * 720) : sourcePixels;
  }
  function gifEstimatedFps(snapshot, frameRate) {
    if (frameRate === "12") {
      return { fps: 12, sourceFpsUnknown: false };
    }
    const sourceFps = snapshot.fps;
    if (sourceFps === null || !Number.isFinite(sourceFps) || sourceFps <= 0) {
      return { fps: UNKNOWN_SOURCE_FPS, sourceFpsUnknown: true };
    }
    return {
      fps: Math.min(MAXIMUM_ESTIMATED_SOURCE_FPS, Math.max(1, sourceFps)),
      sourceFpsUnknown: false
    };
  }
  function estimateGifStorage(snapshot, range, resolution, frameRate) {
    requirePositiveFinite(range.duration, "duration");
    const { fps, sourceFpsUnknown } = gifEstimatedFps(snapshot, frameRate);
    const frameCount = safeCeil(range.duration * fps, "GIF frame count");
    const pixelFrames = safeCeil(
      gifPixelCount(snapshot, resolution) * frameCount,
      "GIF pixel-frame count"
    );
    const estimatedBytes = safeCeil(
      pixelFrames * GIF_ESTIMATED_BYTES_PER_PIXEL_FRAME,
      "GIF estimate"
    );
    const planningBytes = safeCeil(
      pixelFrames * GIF_PLANNING_BYTES_PER_PIXEL_FRAME + GIF_PLANNING_MARGIN,
      "GIF planning estimate"
    );
    return {
      format: "GIF",
      estimatedBytes,
      planningBytes,
      frameCount,
      pixelFrames,
      estimatedFps: fps,
      sourceFpsUnknown,
      uncertain: true
    };
  }
  function estimateExportStorage(snapshot, range, preferences) {
    const formats = [];
    if (preferences.mp4Enabled) {
      formats.push(
        estimateMp4Storage(
          range.duration,
          !preferences.mp4WithoutAudio && snapshot.hasEmbeddedAudio
        )
      );
    }
    if (preferences.gifEnabled) {
      formats.push(
        estimateGifStorage(
          snapshot,
          range,
          preferences.gifResolution,
          preferences.gifFps
        )
      );
    }
    if (formats.length === 0) {
      throw new RangeError("At least one export format must be enabled");
    }
    return {
      formats,
      estimatedFinalBytes: formats.reduce(
        (total, estimate) => total + estimate.estimatedBytes,
        0
      ),
      planningFinalBytes: formats.reduce(
        (total, estimate) => total + estimate.planningBytes,
        0
      ),
      // Jobs are intentionally sequential in IINA 1.4.4. Only the largest
      // unfinished output needs to coexist in the plugin temporary directory.
      estimatedTemporaryBytes: Math.max(
        ...formats.map((estimate) => estimate.estimatedBytes)
      ),
      planningTemporaryBytes: Math.max(
        ...formats.map((estimate) => estimate.planningBytes)
      )
    };
  }
  function buildExportRiskAssessment(estimate, range) {
    const risks = [];
    const add = (code) => {
      if (!risks.some((risk) => risk.code === code)) {
        risks.push({ code });
      }
    };
    if (range.duration >= LONG_CLIP_CONFIRMATION_SECONDS) {
      add("long_clip");
    }
    if (estimate.estimatedFinalBytes >= TOTAL_SIZE_CONFIRMATION_BYTES) {
      add("large_estimated_size");
    }
    return {
      requiresConfirmation: risks.length > 0,
      risks
    };
  }
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "unknown";
    }
    if (bytes >= GIBIBYTE) {
      const gib = bytes / GIBIBYTE;
      return `${gib.toFixed(gib >= 10 ? 1 : 2)} GB`;
    }
    if (bytes >= MEBIBYTE) {
      const mib = bytes / MEBIBYTE;
      return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
    }
    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${Math.round(bytes)} B`;
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "unknown duration";
    }
    const rounded = Math.round(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor(rounded % 3600 / 60);
    const remainingSeconds = rounded % 60;
    const parts = [];
    if (hours > 0) {
      parts.push(`${hours} hr`);
    }
    if (minutes > 0) {
      parts.push(`${minutes} min`);
    }
    if (remainingSeconds > 0 || parts.length === 0) {
      parts.push(`${remainingSeconds} sec`);
    }
    return parts.join(" ");
  }

  // src/types.ts
  var UserFacingError = class extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
      this.name = "UserFacingError";
    }
  };
  function errorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  // src/ffmpeg.ts
  var COMMON_FFMPEG_PATHS = [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/local/bin/ffmpeg"
  ];
  function asProcessResult(value) {
    if (typeof value !== "object" || value === null) {
      throw new Error("IINA returned an invalid process result");
    }
    const candidate = value;
    if (typeof candidate.status !== "number" || typeof candidate.stdout !== "string" || typeof candidate.stderr !== "string") {
      throw new Error("IINA returned an incomplete process result");
    }
    return {
      status: candidate.status,
      stdout: candidate.stdout,
      stderr: candidate.stderr
    };
  }
  async function runProcess(executable, args) {
    try {
      return asProcessResult(
        await iina.utils.exec(executable, [...args], null, null, null)
      );
    } catch (error) {
      throw new UserFacingError(
        `Could not launch ${executable}: ${errorMessage(error)}`,
        "process_launch_failed"
      );
    }
  }
  function resolveConfiguredExecutable(path) {
    if (path.length === 0) {
      return null;
    }
    const resolved = iina.utils.resolvePath(path);
    return typeof resolved === "string" && resolved.startsWith("/") ? resolved : null;
  }
  async function probeFfmpeg(candidate) {
    try {
      if (!iina.utils.fileInPath(candidate)) {
        return false;
      }
      const result = await runProcess(candidate, ["-hide_banner", "-version"]);
      if (result.status === 0 && result.stdout.toLowerCase().includes("ffmpeg")) {
        return true;
      }
      iina.console.warn(
        `[Clip Recorder] FFmpeg probe failed for ${candidate}: status ${result.status}`
      );
    } catch (error) {
      iina.console.warn(
        `[Clip Recorder] FFmpeg probe failed for ${candidate}: ${errorMessage(error)}`
      );
    }
    return false;
  }
  async function discoverFfmpeg(configuredPath) {
    const configured = resolveConfiguredExecutable(configuredPath);
    if (configuredPath.length > 0 && configured === null) {
      iina.console.warn(
        "[Clip Recorder] Ignoring a non-absolute custom FFmpeg path"
      );
    }
    const candidates = [configured, "ffmpeg", ...COMMON_FFMPEG_PATHS].filter(
      (candidate) => candidate !== null
    );
    const uniqueCandidates = [...new Set(candidates)];
    for (const candidate of uniqueCandidates) {
      if (await probeFfmpeg(candidate)) {
        iina.console.log(`[Clip Recorder] Using FFmpeg: ${candidate}`);
        return candidate;
      }
    }
    return null;
  }
  async function ensureOutputDirectory(directory2) {
    const result = await runProcess("/bin/mkdir", ["-p", directory2]);
    if (result.status !== 0 || !iina.file.exists(directory2)) {
      throw new UserFacingError(
        `Cannot create or access the output directory: ${directory2}`,
        "output_directory_unavailable"
      );
    }
    const probePath = `${directory2.replace(/\/+$/, "")}/.iina-clip-recorder-write-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const touchResult = await runProcess("/usr/bin/touch", [probePath]);
    if (touchResult.status !== 0 || !iina.file.exists(probePath)) {
      throw new UserFacingError(
        `The output directory is not writable: ${directory2}`,
        "output_directory_not_writable"
      );
    }
    const removeResult = await runProcess("/bin/rm", ["-f", probePath]);
    if (removeResult.status !== 0 || iina.file.exists(probePath)) {
      throw new UserFacingError(
        `A write-test file could not be removed from: ${directory2}`,
        "output_directory_cleanup_failed"
      );
    }
  }
  async function cleanupStaleTemporaryFiles() {
    const resolved = iina.utils.resolvePath("@tmp/.");
    if (typeof resolved !== "string" || !resolved.startsWith("/")) {
      return;
    }
    const result = await runProcess("/usr/bin/find", [
      resolved,
      "-type",
      "f",
      "-name",
      "clip-recorder-*",
      "-mmin",
      "+1440",
      "-delete"
    ]);
    if (result.status !== 0) {
      iina.console.warn(
        `[Clip Recorder] Stale temporary cleanup failed with status ${result.status}`
      );
    }
  }
  function createTemporaryExportFile(extension) {
    const token = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const magicPath = `@tmp/clip-recorder-${token}.${extension}`;
    const resolved = iina.utils.resolvePath(magicPath);
    if (typeof resolved !== "string" || !resolved.startsWith("/")) {
      throw new UserFacingError(
        "IINA did not provide a usable temporary directory.",
        "temporary_directory_unavailable"
      );
    }
    return { magicPath, resolvedPath: resolved };
  }
  function createTemporaryMp4File() {
    return createTemporaryExportFile("mp4");
  }
  function createTemporaryGifFile() {
    return createTemporaryExportFile("gif");
  }
  function createTemporaryGifPaletteFile() {
    return createTemporaryExportFile("png");
  }
  function redact(value, redactions) {
    return [...redactions].sort((left, right) => right.value.length - left.value.length).reduce(
      (text, item) => item.value.length > 0 ? text.split(item.value).join(item.replacement) : text,
      value
    );
  }
  function commandForLog(executable, args, redactions) {
    return [executable, ...args].map((argument) => JSON.stringify(redact(argument, redactions))).join(" ");
  }
  function createExportRuntimeCore(options) {
    var _a;
    const outputDirectory = options.outputPath.slice(0, options.outputPath.lastIndexOf("/")) || "/";
    const temporaryFiles = [
      options.temporaryFile,
      ...(_a = options.auxiliaryTemporaryFiles) != null ? _a : []
    ];
    const redactions = [
      { value: options.sourcePath, replacement: "<source>" },
      ...temporaryFiles.map((file, index) => ({
        value: file.resolvedPath,
        replacement: index === 0 ? "<temporary-output>" : "<temporary-palette>"
      })),
      { value: outputDirectory, replacement: "<output-directory>" }
    ];
    const cleanupTemporaryFiles = () => {
      for (const file of temporaryFiles) {
        try {
          if (iina.file.exists(file.magicPath)) {
            iina.file.delete(file.magicPath);
          }
        } catch (error) {
          iina.console.warn(
            `[Clip Recorder] Temporary cleanup failed: ${errorMessage(error)}`
          );
        }
      }
    };
    return {
      cleanupTemporaryFiles,
      async run(args, label) {
        iina.console.log(
          `[Clip Recorder] FFmpeg (${label}): ${commandForLog(options.executable, args, redactions)}`
        );
        const result = await runProcess(options.executable, args);
        if (result.status !== 0) {
          iina.console.error(
            `[Clip Recorder] FFmpeg (${label}) exited ${result.status}
${redact(result.stderr, redactions)}`
          );
        }
        return result;
      },
      async promoteTemporaryFile() {
        const moveResult = await runProcess("/bin/mv", [
          "-n",
          options.temporaryFile.resolvedPath,
          options.outputPath
        ]);
        if (moveResult.status !== 0 || iina.file.exists(options.temporaryFile.magicPath) || !iina.file.exists(options.outputPath)) {
          throw new UserFacingError(
            "The clip was encoded, but could not be moved into the output folder.",
            "output_promotion_failed"
          );
        }
      }
    };
  }
  function createMp4ExportRuntime(options) {
    const core = createExportRuntimeCore(options);
    return {
      async run(args, encoder) {
        return core.run(args, encoder);
      },
      cleanupTemporaryFile: core.cleanupTemporaryFiles,
      promoteTemporaryFile: core.promoteTemporaryFile,
      onSoftwareFallback: options.onSoftwareFallback,
      ...options.verifySource === void 0 ? {} : { verifySource: options.verifySource }
    };
  }
  function createGifExportRuntime(options) {
    const core = createExportRuntimeCore({
      ...options,
      auxiliaryTemporaryFiles: [options.paletteFile]
    });
    return {
      run(args, phase) {
        return core.run(
          args,
          phase === "palette" ? "GIF palette" : "GIF encode"
        );
      },
      cleanupTemporaryFiles: core.cleanupTemporaryFiles,
      promoteTemporaryFile: core.promoteTemporaryFile,
      ...options.verifySource === void 0 ? {} : { verifySource: options.verifySource }
    };
  }

  // src/disk-space.ts
  function parseSafeBlocks(value, label) {
    if (!/^\d+$/.test(value)) {
      throw new Error(`df ${label} is not an unsigned integer`);
    }
    const blocks = Number(value);
    if (!Number.isSafeInteger(blocks)) {
      throw new Error(`df ${label} is outside the safe integer range`);
    }
    const bytes = blocks * 1024;
    if (!Number.isSafeInteger(bytes)) {
      throw new Error(`df ${label} byte count is outside the safe integer range`);
    }
    return bytes;
  }
  function parsePosixDf(stdout) {
    var _a, _b, _c, _d;
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length < 2) {
      throw new Error("df output does not contain a data row");
    }
    const columns = ((_a = lines[lines.length - 1]) != null ? _a : "").split(/\s+/);
    if (columns.length < 6) {
      throw new Error("df output row is incomplete");
    }
    const filesystem = columns[0];
    if (filesystem === void 0 || filesystem.length === 0) {
      throw new Error("df output does not identify a filesystem");
    }
    return {
      filesystem,
      totalBytes: parseSafeBlocks((_b = columns[1]) != null ? _b : "", "total blocks"),
      usedBytes: parseSafeBlocks((_c = columns[2]) != null ? _c : "", "used blocks"),
      availableBytes: parseSafeBlocks((_d = columns[3]) != null ? _d : "", "available blocks"),
      mountPoint: columns.slice(5).join(" ")
    };
  }
  async function queryDiskSpace(path, run = runProcess) {
    const result = await run("/bin/df", ["-Pk", path]);
    if (result.status !== 0) {
      throw new UserFacingError(
        `Could not check free space for ${path}.`,
        "disk_space_check_failed"
      );
    }
    try {
      return parsePosixDf(result.stdout);
    } catch (error) {
      throw new UserFacingError(
        `IINA received an unreadable free-space result for ${path}: ${String(error)}`,
        "disk_space_result_invalid"
      );
    }
  }
  function resolvePluginTemporaryDirectory() {
    const resolved = iina.utils.resolvePath("@tmp/.");
    if (typeof resolved !== "string" || !resolved.startsWith("/")) {
      throw new UserFacingError(
        "IINA did not provide a usable temporary directory.",
        "temporary_directory_unavailable"
      );
    }
    return resolved;
  }
  function headroom(planningBytes) {
    return Math.max(256 * MEBIBYTE, Math.ceil(planningBytes * 0.1));
  }
  function requirement(label, availableBytes, estimatedRequiredBytes, planningRequiredBytes) {
    return {
      label,
      availableBytes,
      estimatedRequiredBytes,
      planningRequiredBytes,
      headroomBytes: headroom(planningRequiredBytes)
    };
  }
  function assessDiskSpace(estimate, output, temporary) {
    const sameFilesystem = output.filesystem === temporary.filesystem;
    const requirements = sameFilesystem ? [
      requirement(
        "output",
        Math.min(output.availableBytes, temporary.availableBytes),
        estimate.estimatedFinalBytes,
        estimate.planningFinalBytes
      )
    ] : [
      requirement(
        "output",
        output.availableBytes,
        estimate.estimatedFinalBytes,
        estimate.planningFinalBytes
      ),
      requirement(
        "temporary",
        temporary.availableBytes,
        estimate.estimatedTemporaryBytes,
        estimate.planningTemporaryBytes
      )
    ];
    const insufficient = requirements.find(
      (item) => item.availableBytes < item.estimatedRequiredBytes
    );
    const warnings = requirements.filter(
      (item) => item.availableBytes < item.planningRequiredBytes + item.headroomBytes
    ).map(
      (item) => item.label === "output" ? "The output disk has less than the conservative planning reserve." : "IINA’s temporary disk has less than the conservative planning reserve."
    );
    return {
      sameFilesystem,
      blocked: insufficient !== void 0,
      blockMessage: insufficient === void 0 ? null : insufficient.label === "output" ? "The output disk has less free space than the approximate export size." : "IINA’s temporary disk has less free space than the approximate working-file size.",
      warnings,
      requirements
    };
  }

  // src/dimensions.ts
  function requirePositiveFinite2(value, label) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${label} must be a positive finite number`);
    }
  }
  function buildSarAwareScaleFilter(maximumWidth, maximumHeight) {
    requirePositiveFinite2(maximumWidth, "maximum width");
    requirePositiveFinite2(maximumHeight, "maximum height");
    const maxWidth = Math.floor(maximumWidth);
    const maxHeight = Math.floor(maximumHeight);
    const factor = `min(1,min(1/sar,min(${maxWidth}/(iw*sar),${maxHeight}/ih)))`;
    const width = `max(2,trunc(iw*sar*${factor}/2)*2)`;
    const height = `max(2,trunc(ih*${factor}/2)*2)`;
    return `scale=w='${width}':h='${height}':flags=lanczos,setsar=1`;
  }
  function buildEvenFullResolutionFilter() {
    const width = "max(2,trunc(iw/2)*2)";
    const height = "max(2,trunc(ih/2)*2)";
    return `scale=w='${width}':h='${height}':flags=lanczos`;
  }

  // src/export-gif.ts
  var GifExportError = class extends Error {
    constructor(message, result, phase) {
      super(message);
      this.result = result;
      this.phase = phase;
      this.name = "GifExportError";
    }
  };
  function formatSeconds(value) {
    return value.toFixed(6);
  }
  function buildGifFullResolutionFilter() {
    const factor = "min(1,1/sar)";
    return `scale=w='max(1,round(iw*sar*${factor}))':h='max(1,round(ih*${factor}))':flags=lanczos,setsar=1`;
  }
  function buildGifProcessingFilter(resolution, frameRate) {
    const scaleFilter = resolution === "720p" ? buildSarAwareScaleFilter(1280, 720) : buildGifFullResolutionFilter();
    const processingFilters = frameRate === "12" ? `fps=fps=12,${scaleFilter}` : scaleFilter;
    return processingFilters;
  }
  function buildGifPaletteFilter(resolution, frameRate) {
    return `${buildGifProcessingFilter(resolution, frameRate)},palettegen=max_colors=256:stats_mode=diff`;
  }
  function buildGifEncodeFilterGraph(resolution, frameRate, selectedVideoStreamIndex) {
    const videoInput = selectedVideoStreamIndex === null || selectedVideoStreamIndex === void 0 ? "0:v:0" : `0:${selectedVideoStreamIndex}`;
    return `[${videoInput}]${buildGifProcessingFilter(resolution, frameRate)}[gif_frames];[gif_frames][1:v:0]paletteuse=dither=sierra2_4a:diff_mode=rectangle[gif]`;
  }
  function buildGifPaletteArgs(input) {
    const videoMap = input.selectedVideoStreamIndex === null || input.selectedVideoStreamIndex === void 0 ? "0:v:0" : `0:${input.selectedVideoStreamIndex}`;
    return [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-n",
      "-ss",
      formatSeconds(input.range.start),
      "-t",
      formatSeconds(input.range.duration),
      "-i",
      input.sourcePath,
      "-map",
      videoMap,
      "-vf",
      buildGifPaletteFilter(input.resolution, input.frameRate),
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-f",
      "image2",
      input.temporaryPalettePath
    ];
  }
  function buildGifEncodeArgs(input) {
    return [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-n",
      "-ss",
      formatSeconds(input.range.start),
      "-t",
      formatSeconds(input.range.duration),
      "-i",
      input.sourcePath,
      "-i",
      input.temporaryPalettePath,
      "-filter_complex",
      buildGifEncodeFilterGraph(
        input.resolution,
        input.frameRate,
        input.selectedVideoStreamIndex
      ),
      "-map",
      "[gif]",
      "-an",
      "-sn",
      "-dn",
      "-fps_mode:v",
      "passthrough",
      "-loop",
      "0",
      "-f",
      "gif",
      input.temporaryOutputPath
    ];
  }
  function describeGifFailure(result, phase = "encode") {
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes("no space left on device") || stderr.includes("disk quota exceeded")) {
      return "There is not enough free disk space to export this GIF.";
    }
    if (stderr.includes("permission denied") || stderr.includes("operation not permitted") || stderr.includes("read-only file system")) {
      return "FFmpeg cannot access the source or its working files. Check file and folder permissions.";
    }
    if (stderr.includes("invalid data found when processing input") || stderr.includes("could not find codec parameters") || stderr.includes("decoder not found") || stderr.includes("unknown decoder")) {
      return "FFmpeg could not decode this source for GIF export. See the IINA log for details.";
    }
    if (stderr.includes("no such filter: 'palettegen'") || stderr.includes("no such filter: palettegen") || stderr.includes("no such filter: 'paletteuse'") || stderr.includes("no such filter: paletteuse")) {
      return "This FFmpeg build does not include the palette filters required for GIF export.";
    }
    if (result.status === 9 || result.status === 137) {
      return "FFmpeg was terminated before the GIF finished. Check available memory and the IINA log.";
    }
    return phase === "palette" ? "FFmpeg could not generate the GIF color palette. See the IINA log for details." : "FFmpeg could not create this GIF. See the IINA log for details.";
  }
  async function exportGif(input, runtime) {
    var _a, _b;
    try {
      await ((_a = runtime.verifySource) == null ? void 0 : _a.call(runtime));
      const paletteResult = await runtime.run(
        buildGifPaletteArgs(input),
        "palette"
      );
      if (paletteResult.status !== 0) {
        throw new GifExportError(
          describeGifFailure(paletteResult, "palette"),
          paletteResult,
          "palette"
        );
      }
      await ((_b = runtime.verifySource) == null ? void 0 : _b.call(runtime));
      const encodeResult = await runtime.run(
        buildGifEncodeArgs(input),
        "encode"
      );
      if (encodeResult.status !== 0) {
        throw new GifExportError(
          describeGifFailure(encodeResult, "encode"),
          encodeResult,
          "encode"
        );
      }
      await runtime.promoteTemporaryFile();
    } finally {
      runtime.cleanupTemporaryFiles();
    }
  }

  // src/export-mp4.ts
  var Mp4ExportError = class extends Error {
    constructor(message, attempts) {
      super(message);
      this.attempts = attempts;
      this.name = "Mp4ExportError";
    }
  };
  function formatSeconds2(value) {
    return value.toFixed(6);
  }
  function buildMp4Args(input, encoder) {
    var _a, _b, _c, _d;
    const maximumWidth = (_a = input.maximumWidth) != null ? _a : 1920;
    const maximumHeight = (_b = input.maximumHeight) != null ? _b : 1080;
    const videoFilter = ((_c = input.resolution) != null ? _c : "1080p") === "full" ? buildEvenFullResolutionFilter() : buildSarAwareScaleFilter(maximumWidth, maximumHeight);
    const encoderArgs = encoder === "h264_videotoolbox" ? [
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      "7000k",
      "-profile:v",
      "high",
      "-allow_sw",
      "0"
    ] : [
      "-c:v",
      "libx264",
      "-crf",
      "20",
      "-preset",
      "fast",
      "-profile:v",
      "high"
    ];
    const includeAudio = (_d = input.includeAudio) != null ? _d : true;
    const videoMap = input.selectedVideoStreamIndex === null || input.selectedVideoStreamIndex === void 0 ? "0:v:0" : `0:${input.selectedVideoStreamIndex}`;
    const shouldEncodeAudio = includeAudio && input.hasEmbeddedAudio !== false;
    const audioMap = input.selectedEmbeddedAudioStreamIndex === null || input.selectedEmbeddedAudioStreamIndex === void 0 ? "0:a:0" : `0:${input.selectedEmbeddedAudioStreamIndex}`;
    return [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-n",
      "-ss",
      formatSeconds2(input.range.start),
      "-i",
      input.sourcePath,
      "-t",
      formatSeconds2(input.range.duration),
      "-map",
      videoMap,
      ...shouldEncodeAudio ? ["-map", audioMap] : ["-an"],
      "-sn",
      "-dn",
      "-vf",
      videoFilter,
      ...encoderArgs,
      "-pix_fmt",
      "yuv420p",
      "-tag:v",
      "avc1",
      "-fps_mode:v",
      "passthrough",
      // Preserve the demuxer's time base for VFR instead of quantizing encoder
      // timestamps to the inverse nominal frame rate.
      "-enc_time_base:v",
      "demux",
      ...shouldEncodeAudio ? ["-c:a", "aac", "-b:a", "192k"] : [],
      "-movflags",
      "+faststart",
      input.temporaryOutputPath
    ];
  }
  function shouldFallbackToLibx264(stderr) {
    const normalized = stderr.toLowerCase();
    if (normalized.includes("invalid time base")) {
      return false;
    }
    return [
      "h264_videotoolbox",
      "videotoolbox",
      "compression session",
      "unknown encoder",
      "hardware encoder",
      "error while opening encoder"
    ].some((marker) => normalized.includes(marker));
  }
  function describeFfmpegFailure(attempts, exhaustedEncoders) {
    const stderr = attempts.map((attempt) => attempt.stderr).join("\n").toLowerCase();
    if (stderr.includes("no space left on device") || stderr.includes("disk quota exceeded")) {
      return "There is not enough free disk space to export this clip.";
    }
    if (stderr.includes("permission denied") || stderr.includes("operation not permitted") || stderr.includes("read-only file system")) {
      return "FFmpeg cannot access the source or its working files. Check file and folder permissions.";
    }
    if (stderr.includes("invalid data found when processing input") || stderr.includes("could not find codec parameters") || stderr.includes("decoder not found") || stderr.includes("unknown decoder")) {
      return "FFmpeg could not decode this source. See the IINA log for details.";
    }
    if (stderr.includes("invalid time base")) {
      return "FFmpeg rejected the video timestamp settings. Update IINA Clip Recorder or use a compatible FFmpeg build.";
    }
    if (exhaustedEncoders && stderr.includes("unknown encoder")) {
      return "This FFmpeg build has neither a usable VideoToolbox nor libx264 H.264 encoder.";
    }
    return exhaustedEncoders ? "Neither VideoToolbox nor libx264 could encode this clip. See the IINA log for details." : "FFmpeg could not encode this clip. See the IINA log for details.";
  }
  async function exportMp4(input, runtime) {
    var _a, _b, _c;
    const attempts = [];
    await ((_a = runtime.verifySource) == null ? void 0 : _a.call(runtime));
    const hardwareResult = await runtime.run(
      buildMp4Args(input, "h264_videotoolbox"),
      "h264_videotoolbox"
    );
    attempts.push(hardwareResult);
    if (hardwareResult.status === 0) {
      await runtime.promoteTemporaryFile();
      return { encoder: "h264_videotoolbox" };
    }
    runtime.cleanupTemporaryFile();
    if (!shouldFallbackToLibx264(hardwareResult.stderr)) {
      throw new Mp4ExportError(
        describeFfmpegFailure(attempts, false),
        attempts
      );
    }
    (_b = runtime.onSoftwareFallback) == null ? void 0 : _b.call(runtime);
    await ((_c = runtime.verifySource) == null ? void 0 : _c.call(runtime));
    const softwareResult = await runtime.run(
      buildMp4Args(input, "libx264"),
      "libx264"
    );
    attempts.push(softwareResult);
    if (softwareResult.status !== 0) {
      runtime.cleanupTemporaryFile();
      throw new Mp4ExportError(
        describeFfmpegFailure(attempts, true),
        attempts
      );
    }
    await runtime.promoteTemporaryFile();
    return { encoder: "libx264" };
  }

  // src/export-confirmation.ts
  function hasRisk(risk, code) {
    return risk.risks.some((item) => item.code === code);
  }
  function buildExportWarning(risk, assessment) {
    if (assessment.warnings.length > 0) {
      return "This export may need more free space than the estimate shown.";
    }
    const isLong = hasRisk(risk, "long_clip");
    const isLarge = hasRisk(risk, "large_estimated_size");
    if (isLong && isLarge) {
      return "This export may create a large file and take a while.";
    }
    if (isLarge) {
      return "This export may create a large file.";
    }
    return "This export may take a while.";
  }
  function buildExportConfirmationNotice(options) {
    const estimates = options.estimate.formats.map(
      (item) => `${item.format}: about ${formatBytes(item.estimatedBytes)}`
    ).join("\n");
    const disk = options.assessment.sameFilesystem ? `Free space: ${formatBytes(options.outputDisk.availableBytes)}` : [
      `Output free: ${formatBytes(options.outputDisk.availableBytes)}`,
      `Temporary free: ${formatBytes(options.temporaryDisk.availableBytes)}`
    ].join("\n");
    return {
      title: "Review export",
      duration: `Selected range: ${formatDuration(options.range.duration)}`,
      estimates,
      disk,
      warning: buildExportWarning(options.risk, options.assessment),
      confirmLabel: "Export",
      cancelLabel: "Cancel"
    };
  }

  // src/export-lifecycle.ts
  function createExportLifecycle(generation, sourceMayDetach, sourceIsStillCurrent) {
    return {
      originGeneration: generation,
      maximumVisibleGeneration: generation + (sourceMayDetach && sourceIsStillCurrent ? 1 : 0),
      sourceMayDetach
    };
  }
  function exportLifecycleIsCurrent(lifecycle, generation, sourceIsStillCurrent) {
    if (generation < lifecycle.originGeneration || generation > lifecycle.maximumVisibleGeneration) {
      return false;
    }
    return lifecycle.sourceMayDetach || sourceIsStillCurrent;
  }
  function sourceStartBelongsToNaturalEof(lifecycle, generation) {
    return lifecycle !== null && lifecycle.sourceMayDetach && generation > lifecycle.originGeneration && generation <= lifecycle.maximumVisibleGeneration;
  }

  // src/filenames.ts
  var MAXIMUM_BASENAME_UTF8_BYTES = 220;
  function pad(value, length = 2) {
    return String(value).padStart(length, "0");
  }
  function formatTimestamp(date) {
    return [
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
    ].join("_");
  }
  function formatMediaTimeForFilename(seconds) {
    const totalMilliseconds = Math.max(0, Math.round(seconds * 1e3));
    const milliseconds = totalMilliseconds % 1e3;
    const totalSeconds = Math.floor(totalMilliseconds / 1e3);
    const wholeSeconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return `${pad(hours)}h${pad(minutes)}m${pad(wholeSeconds)}s${pad(milliseconds, 3)}`;
  }
  function sourceStem(sourcePath) {
    const basename = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
    const lastDot = basename.lastIndexOf(".");
    return lastDot > 0 ? basename.slice(0, lastDot) : basename;
  }
  function sanitizeFilenameComponent(value) {
    const cleaned = value.replace(/[\u0000-\u001f\u007f/:]/g, "_").replace(/\s+/g, " ").trim().replace(/^[. ]+|[. ]+$/g, "");
    const safe = cleaned.length > 0 ? cleaned : "video";
    return safe;
  }
  function utf8ByteLength(value) {
    var _a;
    let length = 0;
    for (const character of Array.from(value)) {
      const codePoint = (_a = character.codePointAt(0)) != null ? _a : 0;
      length += codePoint <= 127 ? 1 : codePoint <= 2047 ? 2 : codePoint <= 65535 ? 3 : 4;
    }
    return length;
  }
  function truncateToUtf8Bytes(value, maximumBytes) {
    let result = "";
    let usedBytes = 0;
    for (const character of Array.from(value)) {
      const characterBytes = utf8ByteLength(character);
      if (usedBytes + characterBytes > maximumBytes) {
        break;
      }
      result += character;
      usedBytes += characterBytes;
    }
    return result;
  }
  function buildClipBasename(sourcePath, createdAt, start, end) {
    const suffix = [
      "clip",
      formatTimestamp(createdAt),
      `${formatMediaTimeForFilename(start)}-${formatMediaTimeForFilename(end)}`
    ].join("_");
    const stemBudget = Math.max(
      1,
      MAXIMUM_BASENAME_UTF8_BYTES - utf8ByteLength(suffix) - 1
    );
    const sanitizedStem = sanitizeFilenameComponent(sourceStem(sourcePath));
    const stem = truncateToUtf8Bytes(sanitizedStem, stemBudget) || "video";
    return `${stem}_${suffix}`;
  }
  function joinPath(directory2, filename2) {
    return directory2 === "/" ? `/${filename2}` : `${directory2.replace(/\/+$/, "")}/${filename2}`;
  }
  function chooseAvailableOutputPath(directory2, basename, extension, exists, maximumAttempts = 1e4) {
    const normalizedExtension = extension.replace(/^\.+/, "");
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const suffix = attempt === 1 ? "" : `_${attempt}`;
      const path = joinPath(directory2, `${basename}${suffix}.${normalizedExtension}`);
      if (!exists(path)) {
        return path;
      }
    }
    throw new Error("Unable to allocate a unique output filename");
  }

  // src/media-info.ts
  function finitePositive(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }
  function finiteNonNegativeInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value) ? value : null;
  }
  function recordValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function safeNativeProperty(name) {
    try {
      return recordValue(iina.mpv.getNative(name));
    } catch (error) {
      iina.console.warn(`Unable to read mpv property ${name}: ${String(error)}`);
      return null;
    }
  }
  function safeNumberProperty(name) {
    try {
      return finitePositive(iina.mpv.getNumber(name));
    } catch {
      return null;
    }
  }
  function currentSourcePath() {
    try {
      const value = iina.mpv.getString("path");
      return typeof value === "string" && value.startsWith("/") ? value : null;
    } catch {
      return null;
    }
  }
  function isKnownHdr(parameters) {
    var _a, _b, _c;
    if (parameters === null) {
      return false;
    }
    const primaries = String((_a = parameters.primaries) != null ? _a : "").toLowerCase();
    const transfer = String(
      (_c = (_b = parameters.gamma) != null ? _b : parameters.transfer) != null ? _c : ""
    ).toLowerCase();
    const signalPeak = finitePositive(parameters["sig-peak"]);
    return primaries.includes("2020") || ["pq", "hlg", "st2084", "st-2084", "smpte2084", "arib-std-b67"].some(
      (marker) => transfer.includes(marker)
    ) || signalPeak !== null && signalPeak > 1.1;
  }
  function hasKnownHdrParameterSet(...parameterSets) {
    return parameterSets.some((parameters) => isKnownHdr(parameters));
  }
  function eofReachedFromEvent(value) {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === 0) {
      return false;
    }
    if (value === 1) {
      return true;
    }
    return null;
  }
  function captureCurrentMedia() {
    var _a, _b, _c, _d;
    if (iina.core.status.idle) {
      throw new UserFacingError(
        "Open a local video before starting a clip.",
        "no_media"
      );
    }
    if (iina.core.status.isNetworkResource) {
      throw new UserFacingError(
        "Network streams are not supported yet. Open a local video file.",
        "network_source"
      );
    }
    const sourcePath = currentSourcePath();
    if (sourcePath === null) {
      throw new UserFacingError(
        "The current source is not a regular local file.",
        "unsupported_local_source"
      );
    }
    if (!iina.file.exists(sourcePath)) {
      throw new UserFacingError(
        "The source file is no longer available.",
        "missing_source"
      );
    }
    const position = iina.core.status.position;
    const duration = iina.core.status.duration;
    if (position === null || !Number.isFinite(position)) {
      throw new UserFacingError(
        "IINA has not reported a valid playback position yet.",
        "missing_position"
      );
    }
    if (duration === null || !Number.isFinite(duration) || duration <= 0) {
      throw new UserFacingError(
        "This file does not have a finite duration and cannot be clipped yet.",
        "missing_duration"
      );
    }
    const decodedParameters = safeNativeProperty("video-dec-params");
    const containerParameters = safeNativeProperty("video-params");
    const effectiveParameters = decodedParameters === null ? containerParameters : containerParameters === null ? decodedParameters : { ...containerParameters, ...decodedParameters };
    const width = (_a = finitePositive(effectiveParameters == null ? void 0 : effectiveParameters.w)) != null ? _a : finitePositive(iina.core.status.videoWidth);
    const height = (_b = finitePositive(effectiveParameters == null ? void 0 : effectiveParameters.h)) != null ? _b : finitePositive(iina.core.status.videoHeight);
    if (width === null || height === null) {
      throw new UserFacingError(
        "The current file does not contain a usable video track.",
        "missing_video"
      );
    }
    if (width < 2 || height < 2) {
      throw new UserFacingError(
        "The selected video track is too small to export safely.",
        "unsupported_video_dimensions"
      );
    }
    const selectedVideoTrack = (_c = iina.core.video.tracks.find((track) => track.isSelected)) != null ? _c : iina.core.video.tracks[0];
    const fps = (_d = finitePositive(selectedVideoTrack == null ? void 0 : selectedVideoTrack.demuxFPS)) != null ? _d : safeNumberProperty("container-fps");
    const sourceUrlValue = iina.core.status.url;
    const selectedVideoParameters = safeNativeProperty("current-tracks/video");
    const selectedVideoIsExternal = (selectedVideoParameters == null ? void 0 : selectedVideoParameters.external) === true || (selectedVideoParameters == null ? void 0 : selectedVideoParameters.external) === "yes";
    if (selectedVideoIsExternal) {
      throw new UserFacingError(
        "External video tracks are not supported. Select a video track embedded in the source file.",
        "external_video_not_supported"
      );
    }
    const selectedVideoStreamIndex = finiteNonNegativeInteger(
      selectedVideoParameters == null ? void 0 : selectedVideoParameters["ff-index"]
    );
    if (selectedVideoStreamIndex === null && iina.core.video.tracks.length > 1) {
      throw new UserFacingError(
        "IINA did not identify the selected video stream reliably.",
        "selected_video_stream_unknown"
      );
    }
    const selectedAudioParameters = safeNativeProperty("current-tracks/audio");
    const selectedAudioIsExternal = (selectedAudioParameters == null ? void 0 : selectedAudioParameters.external) === true || (selectedAudioParameters == null ? void 0 : selectedAudioParameters.external) === "yes";
    return {
      sourcePath,
      sourceUrl: typeof sourceUrlValue === "string" ? sourceUrlValue : sourcePath,
      sourceName: sourcePath.slice(sourcePath.lastIndexOf("/") + 1),
      startPosition: Math.min(duration, Math.max(0, position)),
      duration,
      width,
      height,
      fps,
      selectedVideoStreamIndex,
      selectedVideoIsExternal,
      hasEmbeddedAudio: iina.core.audio.tracks.some(
        (track) => !track.isExternal
      ),
      selectedEmbeddedAudioStreamIndex: selectedAudioIsExternal ? null : finiteNonNegativeInteger(selectedAudioParameters == null ? void 0 : selectedAudioParameters["ff-index"]),
      selectedAudioIsExternal,
      videoParameters: effectiveParameters,
      isHdr: hasKnownHdrParameterSet(
        decodedParameters,
        containerParameters
      )
    };
  }

  // src/notifications.ts
  function canShowOsd() {
    return iina.core.window.loaded;
  }
  function showOsd(message) {
    if (canShowOsd()) {
      iina.core.osd(message);
    }
  }
  function notifyRecordingStarted() {
    showOsd("Clip start marked");
  }
  function notifyEncodingBusy() {
    showOsd("A clip is already being encoded");
  }
  function filename(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }
  function directory(path) {
    return path.slice(0, path.lastIndexOf("/")) || "/";
  }
  function formatClipDurationSeconds(duration) {
    const rounded = Math.max(0, Math.round(duration * 10) / 10);
    return `${rounded.toFixed(Number.isInteger(rounded) ? 0 : 1)} seconds`;
  }
  function buildSavedClipNotice(outcomes, duration) {
    const successful = outcomes.filter(
      (outcome) => outcome.ok
    );
    const failed = outcomes.filter(
      (outcome) => !outcome.ok
    );
    const formats = successful.map((outcome) => outcome.format).join(" + ");
    const suffix = failed.length > 0 ? ` · ${failed.map((outcome) => `${outcome.format} failed`).join(", ")}` : "";
    return {
      title: failed.length > 0 ? "Clip partly saved" : successful.length === 1 ? "Clip saved" : "Clips saved",
      detail: `${formats} · ${formatClipDurationSeconds(duration)}${suffix}`,
      actionLabel: "Reveal in Finder"
    };
  }
  function formatExportOutcomeMessage(outcomes) {
    const successful = outcomes.filter(
      (outcome) => outcome.ok
    );
    const failed = outcomes.filter(
      (outcome) => !outcome.ok
    );
    if (failed.length === 0) {
      const heading = successful.length === 1 ? "Clip saved" : "Clips saved";
      const lines = successful.map((outcome) => {
        const suffix = outcome.detail ? ` (${outcome.detail})` : "";
        return `${outcome.format}: ${filename(outcome.outputPath)}${suffix}`;
      });
      const destination = successful[0];
      return destination === void 0 ? "Clip Recorder finished without an export result" : [heading, ...lines, directory(destination.outputPath)].join("\n");
    }
    if (successful.length > 0) {
      const firstSuccessful = successful[0];
      if (firstSuccessful === void 0) {
        return "Clip export failed";
      }
      const savedLines = successful.map(
        (outcome) => `Saved ${outcome.format}: ${filename(outcome.outputPath)}`
      );
      const failedLines = failed.map(
        (outcome) => `${outcome.format} failed: ${outcome.message}`
      );
      return [
        "Clip export partly completed",
        ...savedLines,
        ...failedLines,
        directory(firstSuccessful.outputPath)
      ].join("\n");
    }
    return [
      "Clip export failed",
      ...failed.map((outcome) => `${outcome.format}: ${outcome.message}`)
    ].join("\n");
  }
  function notifyError(message) {
    showOsd(`Clip Recorder: ${message}`);
  }
  function logDetailedError(context, error) {
    const stack = error instanceof Error && error.stack ? `
${error.stack}` : "";
    iina.console.error(`[Clip Recorder] ${context}: ${errorMessage(error)}${stack}`);
  }

  // src/overlay.ts
  function formatElapsed(seconds) {
    const milliseconds = Math.max(0, Math.floor(seconds * 1e3));
    const totalSeconds = Math.floor(milliseconds / 1e3);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const wholeSeconds = totalSeconds % 60;
    const tenths = Math.floor(milliseconds % 1e3 / 100);
    const base = `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${tenths}`;
    return hours > 0 ? `${String(hours).padStart(2, "0")}:${base}` : base;
  }
  function escapeHtml(value) {
    return value.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;").split("'").join("&#39;");
  }
  var OVERLAY_STYLE = [
    "html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }",
    "body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; }",
    ".clip-recorder-badge { position: absolute; top: calc(18px + env(safe-area-inset-top)); right: calc(18px + env(safe-area-inset-right)); display: flex; align-items: center; gap: 8px; padding: 7px 11px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: white; background: linear-gradient(145deg, rgba(28,29,32,.78), rgba(10,10,12,.72)); box-shadow: 0 5px 18px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.07); backdrop-filter: blur(18px) saturate(130%); -webkit-backdrop-filter: blur(18px) saturate(130%); font-size: 13px; font-weight: 650; letter-spacing: .04em; font-variant-numeric: tabular-nums; white-space: nowrap; }",
    ".clip-recorder-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #ff3b30; box-shadow: 0 0 0 2px rgba(255,59,48,.22); }",
    ".clip-recorder-badge.encoding .clip-recorder-dot { background: #ffcc00; animation: clip-recorder-pulse 1.1s ease-in-out infinite; }",
    ".clip-recorder-badge.result { max-width: min(520px, calc(100% - 36px)); white-space: normal; letter-spacing: 0; line-height: 1.35; }",
    ".clip-recorder-badge.result.error .clip-recorder-dot { background: #ff453a; animation: none; }",
    ".clip-recorder-note { color: rgba(255,255,255,.72); font-weight: 500; letter-spacing: 0; }",
    "@keyframes clip-recorder-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }"
  ].join("\n");
  var RecorderOverlay = class {
    constructor() {
      this.initialized = false;
      this.eventSubscribed = false;
      this.mode = "simple";
      this.dismissTimer = null;
      this.pendingSavedNotice = null;
      this.pendingConfirmationNotice = null;
      this.confirmationResolver = null;
      this.confirmationToken = 0;
      this.revealHandler = null;
    }
    clearDismissTimer() {
      if (this.dismissTimer !== null) {
        clearTimeout(this.dismissTimer);
        this.dismissTimer = null;
      }
    }
    activateSimpleMode() {
      if (!iina.core.window.loaded) {
        return false;
      }
      if (!this.initialized || this.mode !== "simple") {
        this.cancelExportConfirmation();
        iina.overlay.simpleMode();
        iina.overlay.setClickable(false);
        iina.overlay.setStyle(OVERLAY_STYLE);
        iina.overlay.setContent("");
        this.initialized = true;
        this.mode = "simple";
      }
      return true;
    }
    postPendingSavedNotice() {
      if (this.pendingSavedNotice !== null && this.mode === "saved") {
        iina.overlay.postMessage("clip-recorder-show-saved", this.pendingSavedNotice);
      }
    }
    handleOverlayLoaded() {
      if (this.mode === "confirmation") {
        const token = this.confirmationToken;
        iina.console.log(
          "[Clip Recorder] Export confirmation overlay loaded; actions armed"
        );
        iina.overlay.onMessage("clip-recorder-confirm-export", () => {
          if (this.mode === "confirmation" && token === this.confirmationToken) {
            this.settleExportConfirmation(true);
          }
        });
        iina.overlay.onMessage("clip-recorder-cancel-export", () => {
          if (this.mode === "confirmation" && token === this.confirmationToken) {
            this.settleExportConfirmation(false);
          }
        });
        if (this.pendingConfirmationNotice !== null) {
          iina.overlay.postMessage(
            "clip-recorder-show-export-warning",
            this.pendingConfirmationNotice
          );
        }
        return;
      }
      if (this.mode !== "saved") {
        return;
      }
      iina.console.log(
        "[Clip Recorder] Saved overlay loaded; Reveal in Finder handler armed"
      );
      iina.overlay.onMessage("clip-recorder-reveal", () => {
        var _a;
        iina.console.log(
          "[Clip Recorder] Reveal in Finder received from saved overlay"
        );
        (_a = this.revealHandler) == null ? void 0 : _a.call(this);
      });
      this.postPendingSavedNotice();
    }
    initialize() {
      if (!this.eventSubscribed) {
        iina.event.on("iina.plugin-overlay-loaded", () => {
          this.handleOverlayLoaded();
        });
        this.eventSubscribed = true;
      }
      if (this.initialized || !iina.core.window.loaded) {
        return;
      }
      this.activateSimpleMode();
    }
    setRevealHandler(handler) {
      this.revealHandler = handler;
    }
    settleExportConfirmation(confirmed) {
      const resolver = this.confirmationResolver;
      if (resolver === null) {
        return;
      }
      this.confirmationResolver = null;
      this.pendingConfirmationNotice = null;
      this.confirmationToken += 1;
      iina.overlay.setClickable(false);
      iina.overlay.hide();
      resolver(confirmed);
    }
    cancelExportConfirmation() {
      this.settleExportConfirmation(false);
    }
    requestExportConfirmation(notice) {
      this.clearDismissTimer();
      this.initialize();
      this.cancelExportConfirmation();
      if (!iina.core.window.loaded) {
        return Promise.resolve(false);
      }
      this.pendingSavedNotice = null;
      this.pendingConfirmationNotice = notice;
      this.mode = "confirmation";
      this.confirmationToken += 1;
      return new Promise((resolve) => {
        this.confirmationResolver = resolve;
        try {
          iina.overlay.loadFile("overlay/export-warning.html");
          iina.overlay.setClickable(true);
          iina.overlay.show();
        } catch (error) {
          iina.console.error(
            `[Clip Recorder] Could not show export confirmation: ${String(error)}`
          );
          this.settleExportConfirmation(false);
        }
      });
    }
    showRecording(elapsed, beforeStart) {
      this.clearDismissTimer();
      this.initialize();
      if (!this.activateSimpleMode()) {
        return;
      }
      const note = beforeStart ? '<span class="clip-recorder-note">seeked before start</span>' : "";
      iina.overlay.setContent(`<div class="clip-recorder-badge"><span class="clip-recorder-dot"></span><span>REC</span><span>${formatElapsed(elapsed)}</span>${note}</div>`);
      iina.overlay.show();
    }
    showEncoding(label = "Encoding MP4…") {
      this.clearDismissTimer();
      this.initialize();
      if (!this.activateSimpleMode()) {
        return;
      }
      iina.overlay.setContent(`<div class="clip-recorder-badge encoding"><span class="clip-recorder-dot"></span><span>${escapeHtml(label)}</span></div>`);
      iina.overlay.show();
    }
    showSaved(notice, duration = 4e3) {
      this.clearDismissTimer();
      this.initialize();
      this.cancelExportConfirmation();
      if (!iina.core.window.loaded) {
        return;
      }
      this.pendingSavedNotice = notice;
      this.mode = "saved";
      iina.overlay.loadFile("overlay/clip-saved.html");
      iina.overlay.setClickable(true);
      iina.overlay.show();
      this.dismissTimer = setTimeout(() => {
        this.dismissTimer = null;
        this.hide();
      }, duration);
    }
    showResult(message, isError, duration = 1e4) {
      this.clearDismissTimer();
      this.initialize();
      if (!this.activateSimpleMode()) {
        return;
      }
      const errorClass = isError ? " error" : "";
      iina.overlay.setContent(`<div class="clip-recorder-badge result${errorClass}"><span class="clip-recorder-dot"></span><span>${escapeHtml(message)}</span></div>`);
      iina.overlay.show();
      this.dismissTimer = setTimeout(() => {
        this.dismissTimer = null;
        this.hide();
      }, duration);
    }
    hide() {
      this.clearDismissTimer();
      this.pendingSavedNotice = null;
      if (this.confirmationResolver !== null) {
        this.settleExportConfirmation(false);
        return;
      }
      this.pendingConfirmationNotice = null;
      if (this.initialized || this.mode === "saved" || this.mode === "confirmation") {
        iina.overlay.setClickable(false);
        iina.overlay.hide();
      }
    }
  };

  // src/shortcut.ts
  var DEFAULT_SHORTCUT_INPUT = "Meta+r";
  var EMERGENCY_FALLBACK_SHORTCUT = "Ctrl+Alt+Meta+c";
  var MODIFIER_ALIASES = {
    alt: "Alt",
    cmd: "Meta",
    command: "Meta",
    control: "Ctrl",
    ctrl: "Ctrl",
    meta: "Meta",
    opt: "Alt",
    option: "Alt",
    shift: "Shift"
  };
  var MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
  var NAMED_KEYS = /* @__PURE__ */ new Set([
    "BS",
    "DEL",
    "DOWN",
    "END",
    "ENTER",
    "ESC",
    "HOME",
    "LEFT",
    "PGDWN",
    "PGUP",
    "RIGHT",
    "SPACE",
    "TAB",
    "UP",
    ...Array.from({ length: 20 }, (_, index) => `F${index + 1}`)
  ]);
  function expandModifierGlyphs(value) {
    return value.split("⌃").join("Ctrl+").split("⌥").join("Alt+").split("⇧").join("Shift+").split("⌘").join("Meta+");
  }
  function canonicalizeShortcutInput(value) {
    const expanded = expandModifierGlyphs(value.trim()).replace(/\s*\+\s*/g, "+");
    if (expanded.length === 0 || expanded.length > 80) {
      return {
        ok: false,
        message: "Shortcut must contain one modified key, for example Meta+r."
      };
    }
    if (expanded.includes("-") || expanded.includes(",") || expanded.startsWith("+") || expanded.endsWith("+") || expanded.includes("++")) {
      return {
        ok: false,
        message: "Key sequences are not supported; enter one key combination."
      };
    }
    const tokens = expanded.split("+");
    if (tokens.length < 2 || tokens.length > 5) {
      return {
        ok: false,
        message: "Shortcut must have a modifier and one key, for example Meta+r."
      };
    }
    const rawKey = tokens[tokens.length - 1];
    if (rawKey === void 0) {
      return { ok: false, message: "Shortcut is missing its regular key." };
    }
    const modifiers = /* @__PURE__ */ new Set();
    for (const token of tokens.slice(0, -1)) {
      const canonical = MODIFIER_ALIASES[token.toLowerCase()];
      if (canonical === void 0) {
        return {
          ok: false,
          message: `Unknown shortcut modifier: ${token}.`
        };
      }
      if (modifiers.has(canonical)) {
        return {
          ok: false,
          message: `Shortcut modifier ${canonical} is repeated.`
        };
      }
      modifiers.add(canonical);
    }
    if (!modifiers.has("Meta") && !modifiers.has("Ctrl") && !modifiers.has("Alt")) {
      return {
        ok: false,
        message: "Shortcut must include Command, Control, or Option."
      };
    }
    let key;
    if (/^[a-z0-9]$/i.test(rawKey)) {
      key = rawKey.toLowerCase();
    } else {
      const namedKey = rawKey.toUpperCase();
      if (!NAMED_KEYS.has(namedKey)) {
        return {
          ok: false,
          message: `Unsupported shortcut key: ${rawKey}.`
        };
      }
      key = namedKey;
    }
    return {
      ok: true,
      value: [
        ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
        key
      ].join("+")
    };
  }
  function formatShortcutForDisplay(normalized) {
    var _a;
    const parts = normalized.split("+");
    const key = (_a = parts.pop()) != null ? _a : "";
    const symbols = parts.map((part) => {
      switch (part) {
        case "Ctrl":
          return "⌃";
        case "Alt":
          return "⌥";
        case "Shift":
          return "⇧";
        case "Meta":
          return "⌘";
        default:
          return "";
      }
    }).join("");
    return `${symbols}${key.length === 1 ? key.toUpperCase() : key}`;
  }
  function preferenceString(key, fallback) {
    const value = iina.preferences.get(key);
    return typeof value === "string" ? value : fallback;
  }
  function registerShortcut(toggle2, getLastOutputPath) {
    let activeShortcut = "";
    let conflictDescription = null;
    let lastPreferenceValue = "";
    const registeredShortcuts = /* @__PURE__ */ new Set();
    const writeRuntimeStatus = (message, normalized) => {
      let changed = false;
      if (preferenceString("shortcutStatus", "") !== message) {
        iina.preferences.set("shortcutStatus", message);
        changed = true;
      }
      if (preferenceString("shortcutNormalized", "") !== normalized) {
        iina.preferences.set("shortcutNormalized", normalized);
        changed = true;
      }
      if (changed) {
        iina.preferences.sync();
      }
    };
    const registerHandler = (normalized) => {
      if (registeredShortcuts.has(normalized)) {
        return;
      }
      iina.input.onKeyDown(
        normalized,
        ({ isRepeat }) => {
          if (activeShortcut !== normalized) {
            return false;
          }
          if (isRepeat) {
            return true;
          }
          toggle2();
          return true;
        },
        iina.input.PRIORITY_HIGH
      );
      registeredShortcuts.add(normalized);
    };
    const tryActivate = (raw) => {
      const parsed = canonicalizeShortcutInput(raw);
      if (!parsed.ok) {
        return { ok: false, message: parsed.message };
      }
      let normalized;
      try {
        normalized = iina.input.normalizeKeyCode(parsed.value);
      } catch (error) {
        return {
          ok: false,
          message: `IINA could not normalize ${parsed.value}: ${String(error)}`
        };
      }
      const existingBinding = iina.input.getAllKeyBindings()[normalized];
      if (existingBinding !== void 0) {
        conflictDescription = `${existingBinding.key}: ${existingBinding.action}`;
        return {
          ok: false,
          message: `${formatShortcutForDisplay(normalized)} conflicts with ${existingBinding.action}.`
        };
      }
      conflictDescription = null;
      registerHandler(normalized);
      activeShortcut = normalized;
      return { ok: true };
    };
    const applyPreference = (raw) => {
      const requested = tryActivate(raw);
      if (!requested.ok) {
        const requestedFailure = requested.message;
        if (activeShortcut.length === 0) {
          for (const fallback of [
            DEFAULT_SHORTCUT_INPUT,
            EMERGENCY_FALLBACK_SHORTCUT
          ]) {
            if (tryActivate(fallback).ok) {
              break;
            }
          }
        }
        const suffix = activeShortcut.length > 0 ? ` Keeping ${formatShortcutForDisplay(activeShortcut)} active.` : " Use the plugin menu until the shortcut is corrected.";
        const message2 = `Not applied: ${requestedFailure}${suffix}`;
        iina.console.warn(`[Clip Recorder] ${message2}`);
        writeRuntimeStatus(message2, activeShortcut);
        return;
      }
      const display = formatShortcutForDisplay(activeShortcut);
      const message = `Active in player windows: ${display}`;
      iina.console.log(`[Clip Recorder] Shortcut ${message}`);
      writeRuntimeStatus(message, activeShortcut);
    };
    const refreshPreference = () => {
      const raw = preferenceString("shortcut", DEFAULT_SHORTCUT_INPUT).trim();
      if (raw === lastPreferenceValue) {
        return;
      }
      lastPreferenceValue = raw;
      applyPreference(raw);
    };
    const toggleItem = iina.menu.item("Start / Stop Clip Selection", () => {
      toggle2();
    });
    const showLastItem = iina.menu.item(
      "Show Last Clip in Finder",
      () => {
        const path = getLastOutputPath();
        if (path !== null && iina.file.exists(path)) {
          iina.file.showInFinder(path);
        } else {
          iina.core.osd("No exported clip is available yet");
        }
      },
      { enabled: true }
    );
    iina.menu.addItem(toggleItem);
    iina.menu.addItem(showLastItem);
    refreshPreference();
    return {
      get activeShortcut() {
        return activeShortcut;
      },
      get displayShortcut() {
        return formatShortcutForDisplay(activeShortcut);
      },
      get conflictDescription() {
        return conflictDescription;
      },
      refreshPreference,
      update(_state, _lastOutputPath) {
      }
    };
  }

  // src/preferences.ts
  var DEFAULT_SHORTCUT = "Meta+r";
  var DEFAULT_OUTPUT_DIRECTORY = "~/Movies/IINA Clips";
  function stringValue(value, fallback, label, errors) {
    if (value === void 0 || value === null) {
      return fallback;
    }
    if (typeof value !== "string") {
      errors.push(`${label} must be a string.`);
      return fallback;
    }
    return value.trim();
  }
  function booleanValue(value, fallback, label, errors) {
    if (value === void 0 || value === null) {
      return fallback;
    }
    if (typeof value !== "boolean") {
      errors.push(`${label} must be a boolean.`);
      return fallback;
    }
    return value;
  }
  function enumValue(value, allowed, fallback, label, errors) {
    if (value === void 0 || value === null) {
      return fallback;
    }
    if (typeof value !== "string" || !allowed.includes(value)) {
      errors.push(`${label} has an unsupported value.`);
      return fallback;
    }
    return value;
  }
  function isLocalPathInput(value) {
    return value === "~" || value.startsWith("~/") || value.startsWith("/");
  }
  function validateRecorderPreferences(raw) {
    const errors = [];
    const shortcutInput = stringValue(
      raw.shortcut,
      DEFAULT_SHORTCUT,
      "Shortcut",
      errors
    );
    const shortcutResult = canonicalizeShortcutInput(shortcutInput);
    if (!shortcutResult.ok) {
      errors.push(shortcutResult.message);
    }
    const shortcut2 = shortcutResult.ok ? shortcutResult.value : DEFAULT_SHORTCUT;
    const mp4Enabled = booleanValue(
      raw.mp4Enabled,
      true,
      "MP4 enabled",
      errors
    );
    const mp4WithoutAudio = booleanValue(
      raw.mp4WithoutAudio,
      false,
      "MP4 without audio",
      errors
    );
    const gifEnabled = booleanValue(
      raw.gifEnabled,
      false,
      "GIF enabled",
      errors
    );
    const mp4Resolution = enumValue(
      raw.mp4Resolution,
      ["1080p", "full"],
      "1080p",
      "MP4 resolution",
      errors
    );
    const gifResolution = enumValue(
      raw.gifResolution,
      ["720p", "full"],
      "720p",
      "GIF resolution",
      errors
    );
    const gifFps = enumValue(
      raw.gifFps,
      ["12", "source"],
      "12",
      "GIF frame rate",
      errors
    );
    const outputDirectory = stringValue(
      raw.outputDirectory,
      DEFAULT_OUTPUT_DIRECTORY,
      "Output directory",
      errors
    );
    const ffmpegPath = stringValue(
      raw.ffmpegPath,
      "",
      "FFmpeg path",
      errors
    );
    if (outputDirectory.length === 0 || !isLocalPathInput(outputDirectory)) {
      errors.push("Output directory must start with / or ~/.");
    }
    if (ffmpegPath.length > 0 && !isLocalPathInput(ffmpegPath)) {
      errors.push("FFmpeg path must be empty or start with / or ~/.");
    }
    if (!mp4Enabled && !gifEnabled) {
      errors.push("At least one output format must be enabled.");
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      value: {
        shortcut: shortcut2,
        mp4Enabled,
        mp4WithoutAudio,
        gifEnabled,
        mp4Resolution,
        gifResolution,
        gifFps,
        outputDirectory,
        ffmpegPath
      }
    };
  }
  function readRawPreferences() {
    return {
      shortcut: iina.preferences.get("shortcut"),
      mp4Enabled: iina.preferences.get("mp4Enabled"),
      mp4WithoutAudio: iina.preferences.get("mp4WithoutAudio"),
      gifEnabled: iina.preferences.get("gifEnabled"),
      mp4Resolution: iina.preferences.get("mp4Resolution"),
      gifResolution: iina.preferences.get("gifResolution"),
      gifFps: iina.preferences.get("gifFps"),
      outputDirectory: iina.preferences.get("outputDirectory"),
      ffmpegPath: iina.preferences.get("ffmpegPath")
    };
  }
  function readRecorderPreferences() {
    const result = validateRecorderPreferences(readRawPreferences());
    if (!result.ok) {
      throw new UserFacingError(
        `Invalid Clip Recorder preferences: ${result.errors.join(" ")}`,
        "invalid_preferences"
      );
    }
    const resolvedDirectory = iina.utils.resolvePath(
      result.value.outputDirectory
    );
    if (typeof resolvedDirectory !== "string" || !resolvedDirectory.startsWith("/")) {
      throw new UserFacingError(
        "The output directory must resolve to an absolute local path.",
        "invalid_output_directory"
      );
    }
    return {
      ...result.value,
      outputDirectory: resolvedDirectory
    };
  }

  // src/recorder-state.ts
  function initialRecorderState() {
    return { kind: "idle" };
  }
  function reduceRecorderState(state2, event) {
    if (event.type === "reset") {
      return initialRecorderState();
    }
    if (event.type === "fail") {
      return { kind: "error", message: event.message };
    }
    switch (state2.kind) {
      case "idle":
        if (event.type === "start") {
          return { kind: "recording", snapshot: event.snapshot };
        }
        break;
      case "recording":
        if (event.type === "stop") {
          return {
            kind: "preflighting",
            snapshot: state2.snapshot,
            range: event.range
          };
        }
        if (event.type === "cancel") {
          return initialRecorderState();
        }
        break;
      case "preflighting":
        if (event.type === "beginEncoding") {
          return {
            kind: "encoding",
            snapshot: state2.snapshot,
            range: state2.range
          };
        }
        if (event.type === "cancel") {
          return initialRecorderState();
        }
        break;
      case "encoding":
        if (event.type === "complete") {
          return initialRecorderState();
        }
        break;
      case "error":
        if (event.type === "cancel") {
          return initialRecorderState();
        }
        break;
    }
    throw new Error(`Invalid recorder transition: ${state2.kind} + ${event.type}`);
  }

  // src/source-fingerprint.ts
  function parseSourceFingerprint(value) {
    const normalized = value.trim();
    const match = /^(\d+):(\d+):(\d+):(-?\d+)$/.exec(normalized);
    if (match === null) {
      throw new Error("stat returned an invalid source fingerprint");
    }
    const [, device, inode, size, modified] = match;
    if (device === void 0 || inode === void 0 || size === void 0 || modified === void 0) {
      throw new Error("stat returned an incomplete source fingerprint");
    }
    return { device, inode, size, modified, value: normalized };
  }
  async function readSourceFingerprint(sourcePath) {
    const result = await runProcess("/usr/bin/stat", [
      "-L",
      "-f",
      "%d:%i:%z:%m",
      sourcePath
    ]);
    if (result.status !== 0) {
      throw new UserFacingError(
        "The source file is no longer available.",
        "missing_source"
      );
    }
    try {
      return parseSourceFingerprint(result.stdout);
    } catch {
      throw new UserFacingError(
        "The source file could not be identified reliably.",
        "source_fingerprint_unavailable"
      );
    }
  }
  async function assertSourceFingerprint(sourcePath, expected) {
    const current = await readSourceFingerprint(sourcePath);
    if (current.value !== expected.value) {
      throw new UserFacingError(
        "The source file changed after the start marker. The export was canceled.",
        "source_file_changed"
      );
    }
  }

  // src/main.ts
  var TOGGLE_DEBOUNCE_MILLISECONDS = 100;
  var overlay = new RecorderOverlay();
  var state = initialRecorderState();
  var activeSession = null;
  var lastOutputPath = null;
  var overlayTimer = null;
  var actionInFlight = false;
  var lastToggleAt = 0;
  var windowClosing = false;
  var lifecycleGeneration = 0;
  var preparingSnapshot = null;
  var pendingEndPosition = null;
  var pendingEof = false;
  var pendingEofGeneration = null;
  var naturalEofObserved = false;
  var activeExportLifecycle = null;
  var cachedFfmpeg = null;
  overlay.setRevealHandler(() => {
    const outputPath = lastOutputPath;
    overlay.hide();
    if (outputPath === null || !iina.file.exists(outputPath)) {
      showOsd("The exported clip is no longer available");
      return;
    }
    iina.console.log(
      `[Clip Recorder] Revealing exported clip in Finder: ${outputPath}`
    );
    iina.file.showInFinder(outputPath);
  });
  var shortcut = registerShortcut(requestToggle, () => lastOutputPath);
  function dispatch(event) {
    state = reduceRecorderState(state, event);
    shortcut.update(state, lastOutputPath);
  }
  function clearOverlayTimer() {
    if (overlayTimer !== null) {
      clearInterval(overlayTimer);
      overlayTimer = null;
    }
  }
  function sameSource(snapshot) {
    return currentSourcePath() === snapshot.sourcePath;
  }
  function updateRecordingOverlay(snapshot) {
    if (state.kind !== "recording" || windowClosing) {
      return;
    }
    if (!sameSource(snapshot)) {
      cancelRecording("Clip selection canceled because the source changed.", true);
      return;
    }
    const position = iina.core.status.position;
    if (position === null || !Number.isFinite(position)) {
      return;
    }
    const elapsed = position - snapshot.startPosition;
    overlay.showRecording(Math.max(0, elapsed), elapsed < 0);
  }
  function startRecordingOverlay(snapshot) {
    clearOverlayTimer();
    updateRecordingOverlay(snapshot);
    overlayTimer = setInterval(() => updateRecordingOverlay(snapshot), 100);
  }
  function cancelRecording(message, showMessage) {
    if (state.kind !== "recording") {
      return;
    }
    clearOverlayTimer();
    overlay.hide();
    activeSession = null;
    activeExportLifecycle = null;
    dispatch({ type: "cancel" });
    iina.console.warn(`[Clip Recorder] ${message}`);
    if (showMessage && !windowClosing) {
      showOsd(message);
    }
  }
  function rangeErrorMessage(error) {
    switch (error) {
      case "end_before_start":
        return "The end is before the start. The selection was reset.";
      case "too_short":
        return "The selected clip must be at least 0.1 seconds long.";
      case "invalid_duration":
        return "IINA did not report a valid media duration.";
      case "invalid_timestamp":
        return "IINA did not report valid clip timestamps.";
    }
  }
  function encodingLabel(preferences) {
    if (preferences.mp4Enabled && preferences.gifEnabled) {
      return "Encoding MP4 + GIF…";
    }
    return preferences.gifEnabled ? "Encoding GIF…" : "Encoding MP4…";
  }
  function preflightIsCurrent(lifecycle, snapshot) {
    return state.kind === "preflighting" && activeSession !== null && activeExportLifecycle === lifecycle && !windowClosing && exportLifecycleIsCurrent(
      lifecycle,
      lifecycleGeneration,
      sameSource(snapshot)
    );
  }
  function cancelPreflight(message, showMessage) {
    if (state.kind !== "preflighting") {
      return;
    }
    overlay.cancelExportConfirmation();
    overlay.hide();
    activeSession = null;
    activeExportLifecycle = null;
    dispatch({ type: "cancel" });
    iina.console.warn(`[Clip Recorder] ${message}`);
    if (showMessage && !windowClosing) {
      showOsd(message);
    }
  }
  function keepPreflightOrCancel(lifecycle, snapshot) {
    if (preflightIsCurrent(lifecycle, snapshot)) {
      return true;
    }
    if (state.kind === "preflighting") {
      cancelPreflight(
        "Clip export canceled because the player or source changed.",
        !windowClosing
      );
    }
    return false;
  }
  async function runExportPreflight(options) {
    var _a;
    const estimate = estimateExportStorage(
      options.snapshot,
      options.range,
      options.session.preferences
    );
    const risk = buildExportRiskAssessment(
      estimate,
      options.range
    );
    const temporaryDirectory = resolvePluginTemporaryDirectory();
    const outputDisk = await queryDiskSpace(
      options.session.preferences.outputDirectory
    );
    if (!keepPreflightOrCancel(options.lifecycle, options.snapshot)) {
      return false;
    }
    const temporaryDisk = await queryDiskSpace(temporaryDirectory);
    if (!keepPreflightOrCancel(options.lifecycle, options.snapshot)) {
      return false;
    }
    const diskAssessment = assessDiskSpace(
      estimate,
      outputDisk,
      temporaryDisk
    );
    iina.console.log(
      [
        "[Clip Recorder] Export preflight:",
        `range=${options.range.duration.toFixed(3)}s`,
        `estimated=${formatBytes(estimate.estimatedFinalBytes)}`,
        `planning=${formatBytes(estimate.planningFinalBytes)}`,
        `outputFree=${formatBytes(outputDisk.availableBytes)}`,
        `temporaryFree=${formatBytes(temporaryDisk.availableBytes)}`,
        `sameFilesystem=${String(diskAssessment.sameFilesystem)}`
      ].join(" ")
    );
    if (diskAssessment.blocked) {
      const requirements = diskAssessment.requirements.map(
        (item) => `${item.label}: ${formatBytes(item.availableBytes)} free, about ${formatBytes(item.estimatedRequiredBytes)} estimated`
      ).join("; ");
      iina.console.error(
        `[Clip Recorder] Export blocked by free-space preflight: ${requirements}`
      );
      throw new UserFacingError(
        `${(_a = diskAssessment.blockMessage) != null ? _a : "There is not enough free disk space"} Shorten the range or free some space.`,
        "insufficient_disk_space"
      );
    }
    if (!risk.requiresConfirmation && diskAssessment.warnings.length === 0) {
      return true;
    }
    const confirmed = await overlay.requestExportConfirmation(
      buildExportConfirmationNotice({
        estimate,
        assessment: diskAssessment,
        outputDisk,
        temporaryDisk,
        range: options.range,
        risk
      })
    );
    if (!keepPreflightOrCancel(options.lifecycle, options.snapshot)) {
      return false;
    }
    if (!confirmed) {
      cancelPreflight("Clip export canceled.", true);
      return false;
    }
    return true;
  }
  async function runMp4ExportJob(options) {
    let runtime = null;
    try {
      const temporaryFile = createTemporaryMp4File();
      runtime = createMp4ExportRuntime({
        executable: options.session.ffmpeg,
        sourcePath: options.snapshot.sourcePath,
        temporaryFile,
        outputPath: options.outputPath,
        verifySource: () => assertSourceFingerprint(
          options.snapshot.sourcePath,
          options.session.sourceFingerprint
        ),
        onSoftwareFallback: () => {
          if (options.isVisible()) {
            overlay.showEncoding("Encoding… MP4 is using libx264");
          }
        }
      });
      const exportResult = await exportMp4(
        {
          sourcePath: options.snapshot.sourcePath,
          temporaryOutputPath: temporaryFile.resolvedPath,
          range: options.range,
          resolution: options.session.preferences.mp4Resolution,
          selectedVideoStreamIndex: options.snapshot.selectedVideoStreamIndex,
          includeAudio: !options.session.preferences.mp4WithoutAudio,
          hasEmbeddedAudio: options.snapshot.hasEmbeddedAudio,
          selectedEmbeddedAudioStreamIndex: options.snapshot.selectedEmbeddedAudioStreamIndex
        },
        runtime
      );
      iina.console.log(
        `[Clip Recorder] MP4 export complete with ${exportResult.encoder}: ${options.outputPath}`
      );
      return {
        format: "MP4",
        ok: true,
        outputPath: options.outputPath,
        detail: options.session.preferences.mp4WithoutAudio ? `${exportResult.encoder}, no audio` : exportResult.encoder
      };
    } catch (error) {
      logDetailedError("MP4 export failed", error);
      return {
        format: "MP4",
        ok: false,
        outputPath: options.outputPath,
        message: errorMessage(error)
      };
    } finally {
      runtime == null ? void 0 : runtime.cleanupTemporaryFile();
    }
  }
  async function runGifExportJob(options) {
    let runtime = null;
    try {
      const temporaryFile = createTemporaryGifFile();
      const paletteFile = createTemporaryGifPaletteFile();
      runtime = createGifExportRuntime({
        executable: options.session.ffmpeg,
        sourcePath: options.snapshot.sourcePath,
        temporaryFile,
        paletteFile,
        outputPath: options.outputPath,
        verifySource: () => assertSourceFingerprint(
          options.snapshot.sourcePath,
          options.session.sourceFingerprint
        )
      });
      await exportGif(
        {
          sourcePath: options.snapshot.sourcePath,
          temporaryOutputPath: temporaryFile.resolvedPath,
          temporaryPalettePath: paletteFile.resolvedPath,
          range: options.range,
          resolution: options.session.preferences.gifResolution,
          frameRate: options.session.preferences.gifFps,
          selectedVideoStreamIndex: options.snapshot.selectedVideoStreamIndex
        },
        runtime
      );
      iina.console.log(`[Clip Recorder] GIF export complete: ${options.outputPath}`);
      return {
        format: "GIF",
        ok: true,
        outputPath: options.outputPath,
        detail: "two-pass palette"
      };
    } catch (error) {
      logDetailedError("GIF export failed", error);
      return {
        format: "GIF",
        ok: false,
        outputPath: options.outputPath,
        message: errorMessage(error)
      };
    } finally {
      runtime == null ? void 0 : runtime.cleanupTemporaryFiles();
    }
  }
  async function resolvedFfmpeg(configuredPath) {
    if (cachedFfmpeg !== null && cachedFfmpeg.configuredPath === configuredPath && iina.file.exists(cachedFfmpeg.path)) {
      return cachedFfmpeg.path;
    }
    const path = await discoverFfmpeg(configuredPath);
    if (path === null) {
      throw new UserFacingError(
        "FFmpeg was not found. Install it with ‘brew install ffmpeg’ or configure an absolute path.",
        "ffmpeg_not_found"
      );
    }
    cachedFfmpeg = { configuredPath, path };
    return path;
  }
  async function startRecording() {
    const generation = lifecycleGeneration;
    const snapshot = captureCurrentMedia();
    preparingSnapshot = snapshot;
    pendingEndPosition = null;
    pendingEof = false;
    pendingEofGeneration = null;
    if (snapshot.isHdr) {
      throw new UserFacingError(
        "HDR export is not enabled in this version; SDR conversion must be explicit.",
        "hdr_not_supported"
      );
    }
    const preferences = readRecorderPreferences();
    if (preferences.mp4Enabled && !preferences.mp4WithoutAudio && snapshot.selectedAudioIsExternal) {
      throw new UserFacingError(
        "External audio tracks are not supported for MP4 export. Select an embedded audio track or enable MP4 without audio.",
        "external_audio_not_supported"
      );
    }
    const sourceFingerprint = await readSourceFingerprint(snapshot.sourcePath);
    const ffmpeg = await resolvedFfmpeg(preferences.ffmpegPath);
    const completedAtEofWhilePreparing = pendingEof && pendingEofGeneration === generation && lifecycleGeneration === generation + 1;
    if (generation !== lifecycleGeneration && !completedAtEofWhilePreparing || windowClosing) {
      iina.console.log(
        "[Clip Recorder] Start preparation canceled by a window or source lifecycle change."
      );
      preparingSnapshot = null;
      pendingEndPosition = null;
      pendingEof = false;
      pendingEofGeneration = null;
      return;
    }
    if (!sameSource(snapshot) && !completedAtEofWhilePreparing) {
      throw new UserFacingError(
        "The source changed while Clip Recorder was preparing.",
        "source_changed"
      );
    }
    activeSession = { ffmpeg, preferences, sourceFingerprint };
    dispatch({ type: "start", snapshot });
    iina.console.log(
      `[Clip Recorder] Start marked at ${snapshot.startPosition.toFixed(6)} seconds`
    );
    let reachedEof = pendingEof;
    try {
      reachedEof = reachedEof || iina.mpv.getFlag("eof-reached");
    } catch (error) {
      logDetailedError("Unable to verify EOF after FFmpeg preparation", error);
    }
    const queuedEnd = reachedEof ? snapshot.duration : pendingEndPosition;
    preparingSnapshot = null;
    pendingEndPosition = null;
    pendingEof = false;
    pendingEofGeneration = null;
    if (queuedEnd !== null) {
      await finishRecording(queuedEnd, {
        sourceMayDetach: reachedEof
      });
      return;
    }
    startRecordingOverlay(snapshot);
    notifyRecordingStarted();
  }
  async function finishRecording(endPosition, options = {}) {
    var _a, _b;
    if (state.kind !== "recording" || activeSession === null) {
      return;
    }
    const snapshot = state.snapshot;
    const session = activeSession;
    const sourceIsStillCurrent = sameSource(snapshot);
    if (!sourceIsStillCurrent && !options.sourceMayDetach) {
      throw new UserFacingError(
        "The source changed before the end was marked.",
        "source_changed"
      );
    }
    if (!iina.file.exists(snapshot.sourcePath)) {
      throw new UserFacingError(
        "The source file is no longer available.",
        "missing_source"
      );
    }
    const result = validateClipRange(
      snapshot.startPosition,
      endPosition,
      snapshot.duration
    );
    if (!result.ok) {
      throw new UserFacingError(
        rangeErrorMessage(result.error),
        `invalid_range_${result.error}`
      );
    }
    clearOverlayTimer();
    dispatch({ type: "stop", range: result.range });
    overlay.showEncoding("Checking export…");
    iina.console.log(
      `[Clip Recorder] End marked at ${result.range.end.toFixed(6)} seconds; checking ${result.range.duration.toFixed(6)} seconds for export`
    );
    const exportLifecycle = createExportLifecycle(
      lifecycleGeneration,
      options.sourceMayDetach === true,
      sourceIsStillCurrent
    );
    activeExportLifecycle = exportLifecycle;
    const isVisible = () => !windowClosing && exportLifecycleIsCurrent(
      exportLifecycle,
      lifecycleGeneration,
      sameSource(snapshot)
    );
    await ensureOutputDirectory(session.preferences.outputDirectory);
    if (!keepPreflightOrCancel(exportLifecycle, snapshot)) {
      iina.console.log(
        "[Clip Recorder] Export preflight stopped after the player lifecycle changed."
      );
      return;
    }
    await assertSourceFingerprint(
      snapshot.sourcePath,
      session.sourceFingerprint
    );
    if (!keepPreflightOrCancel(exportLifecycle, snapshot)) {
      return;
    }
    const preflightAccepted = await runExportPreflight({
      lifecycle: exportLifecycle,
      snapshot,
      range: result.range,
      session
    });
    if (!preflightAccepted) {
      return;
    }
    if (!keepPreflightOrCancel(exportLifecycle, snapshot) || !iina.file.exists(snapshot.sourcePath)) {
      cancelPreflight(
        "Clip export canceled because the source changed or is no longer available.",
        true
      );
      return;
    }
    await assertSourceFingerprint(
      snapshot.sourcePath,
      session.sourceFingerprint
    );
    if (!keepPreflightOrCancel(exportLifecycle, snapshot)) {
      return;
    }
    dispatch({ type: "beginEncoding" });
    overlay.showEncoding(encodingLabel(session.preferences));
    iina.console.log(
      `[Clip Recorder] Encoding ${result.range.duration.toFixed(6)} seconds`
    );
    const basename = buildClipBasename(
      snapshot.sourcePath,
      /* @__PURE__ */ new Date(),
      result.range.start,
      result.range.end
    );
    if (!session.preferences.mp4Enabled && !session.preferences.gifEnabled) {
      throw new UserFacingError(
        "At least one output format must be enabled.",
        "no_output_formats"
      );
    }
    const outcomes = [];
    if (session.preferences.mp4Enabled) {
      if (session.preferences.gifEnabled && isVisible()) {
        overlay.showEncoding("Encoding MP4 (1/2)…");
      }
      const outputPath = chooseAvailableOutputPath(
        session.preferences.outputDirectory,
        basename,
        "mp4",
        (path) => iina.file.exists(path)
      );
      outcomes.push(
        await runMp4ExportJob({
          session,
          snapshot,
          range: result.range,
          outputPath,
          isVisible
        })
      );
    }
    if (session.preferences.gifEnabled) {
      if (session.preferences.mp4Enabled && isVisible()) {
        overlay.showEncoding("Encoding GIF (2/2)…");
      }
      const outputPath = chooseAvailableOutputPath(
        session.preferences.outputDirectory,
        basename,
        "gif",
        (path) => iina.file.exists(path)
      );
      outcomes.push(
        await runGifExportJob({
          session,
          snapshot,
          range: result.range,
          outputPath
        })
      );
    }
    const successful = outcomes.filter((outcome) => outcome.ok);
    const failed = outcomes.filter((outcome) => !outcome.ok);
    const savedNotice = successful.length > 0 ? buildSavedClipNotice(outcomes, result.range.duration) : null;
    const preferredLastOutput = (_a = successful.find((outcome) => outcome.format === "MP4")) != null ? _a : successful[0];
    lastOutputPath = (_b = preferredLastOutput == null ? void 0 : preferredLastOutput.outputPath) != null ? _b : lastOutputPath;
    activeSession = null;
    activeExportLifecycle = null;
    overlay.hide();
    if (successful.length > 0) {
      dispatch({ type: "complete" });
    } else {
      dispatch({
        type: "fail",
        message: "All requested export formats failed."
      });
      dispatch({ type: "reset" });
    }
    shortcut.update(state, lastOutputPath);
    if (isVisible()) {
      if (successful.length > 0) {
        overlay.showSaved(savedNotice);
      } else {
        const failedFormats = failed.map((outcome) => outcome.format).join(" + ");
        showOsd(formatExportOutcomeMessage(outcomes));
        overlay.showResult(
          `${failedFormats} export failed. See the IINA log for details.`,
          true
        );
      }
    }
  }
  async function toggle() {
    if (state.kind === "encoding") {
      notifyEncodingBusy();
      return;
    }
    if (state.kind === "preflighting") {
      showOsd("Choose Export or Cancel in the export confirmation");
      return;
    }
    if (state.kind === "recording") {
      const position = iina.core.status.position;
      if (position === null || !Number.isFinite(position)) {
        throw new UserFacingError(
          "IINA did not report a valid end position.",
          "missing_end_position"
        );
      }
      await finishRecording(position);
      return;
    }
    if (state.kind === "error") {
      dispatch({ type: "reset" });
    }
    await startRecording();
  }
  function reportFailure(context, error) {
    clearOverlayTimer();
    overlay.hide();
    activeSession = null;
    activeExportLifecycle = null;
    preparingSnapshot = null;
    pendingEndPosition = null;
    pendingEof = false;
    pendingEofGeneration = null;
    naturalEofObserved = false;
    logDetailedError(context, error);
    const message = errorMessage(error);
    try {
      dispatch({ type: "fail", message });
      if (!windowClosing) {
        notifyError(message);
        overlay.showResult(
          "Clip Recorder error. See the IINA log for details.",
          true
        );
      }
      dispatch({ type: "reset" });
    } catch (stateError) {
      state = initialRecorderState();
      shortcut.update(state, lastOutputPath);
      logDetailedError("State recovery failed", stateError);
    }
  }
  function runExclusive(context, action) {
    if (actionInFlight) {
      if (state.kind === "encoding") {
        notifyEncodingBusy();
      } else if (state.kind === "preflighting") {
        showOsd("Choose Export or Cancel in the export confirmation");
      }
      return;
    }
    actionInFlight = true;
    void action().catch((error) => reportFailure(context, error)).finally(() => {
      actionInFlight = false;
    });
  }
  function requestToggle() {
    const now = Date.now();
    if (now - lastToggleAt < TOGGLE_DEBOUNCE_MILLISECONDS) {
      iina.console.warn("[Clip Recorder] Ignoring a repeated shortcut event");
      return;
    }
    lastToggleAt = now;
    if (preparingSnapshot !== null && actionInFlight) {
      const position = iina.core.status.position;
      if (position !== null && Number.isFinite(position)) {
        pendingEndPosition = position;
        iina.console.log(
          `[Clip Recorder] End queued during FFmpeg preparation at ${position.toFixed(6)} seconds`
        );
      }
      return;
    }
    runExclusive("Shortcut action failed", toggle);
  }
  function onSourceStarted() {
    lifecycleGeneration += 1;
    const continuesNaturalEofExport = sourceStartBelongsToNaturalEof(
      activeExportLifecycle,
      lifecycleGeneration
    );
    const continuesNaturalEofPreparation = preparingSnapshot !== null && pendingEof && pendingEofGeneration !== null && lifecycleGeneration === pendingEofGeneration + 1;
    windowClosing = false;
    if (!continuesNaturalEofPreparation) {
      preparingSnapshot = null;
      pendingEndPosition = null;
      pendingEof = false;
      pendingEofGeneration = null;
    }
    naturalEofObserved = false;
    overlay.initialize();
    if (state.kind === "recording") {
      cancelRecording("Clip selection canceled because the source changed.", true);
      return;
    }
    if (state.kind === "preflighting") {
      if (continuesNaturalEofExport) {
        iina.console.log(
          "[Clip Recorder] The playlist advanced after natural EOF; export preflight continues from the immutable source."
        );
        return;
      }
      cancelPreflight(
        "Clip export canceled because the source changed.",
        true
      );
      return;
    }
    if (state.kind === "encoding") {
      if (continuesNaturalEofExport) {
        iina.console.log(
          "[Clip Recorder] The playlist advanced after natural EOF; encoding continues from the immutable source."
        );
        return;
      }
      overlay.hide();
      iina.console.log(
        "[Clip Recorder] Source changed while encoding; the immutable export job continues."
      );
    }
  }
  function queueOrFinishAtEof() {
    if (preparingSnapshot !== null) {
      pendingEof = true;
      pendingEofGeneration = lifecycleGeneration;
      pendingEndPosition = preparingSnapshot.duration;
      return;
    }
    if (state.kind === "recording") {
      const end = state.snapshot.duration;
      runExclusive(
        "Automatic EOF export failed",
        () => finishRecording(end, { sourceMayDetach: true })
      );
    }
  }
  function readEofFlag() {
    try {
      return iina.mpv.getFlag("eof-reached");
    } catch (error) {
      logDetailedError("Unable to read EOF state", error);
      return false;
    }
  }
  function onEofChanged(value) {
    var _a;
    const reachedEof = (_a = eofReachedFromEvent(value)) != null ? _a : readEofFlag();
    if (reachedEof) {
      naturalEofObserved = true;
      queueOrFinishAtEof();
    }
  }
  function onEndFile() {
    if (!windowClosing && naturalEofObserved) {
      queueOrFinishAtEof();
    }
  }
  function onWindowWillClose() {
    lifecycleGeneration += 1;
    windowClosing = true;
    preparingSnapshot = null;
    pendingEndPosition = null;
    pendingEof = false;
    pendingEofGeneration = null;
    naturalEofObserved = false;
    clearOverlayTimer();
    overlay.hide();
    if (state.kind === "recording") {
      cancelRecording("Clip selection canceled because the player closed.", false);
    } else if (state.kind === "preflighting") {
      cancelPreflight("Clip export canceled because the player closed.", false);
    } else if (state.kind === "encoding") {
      activeExportLifecycle = null;
      iina.console.warn(
        "[Clip Recorder] The player closed during encoding. IINA 1.4.4 exposes no process cancellation API."
      );
    }
  }
  function logRuntimeVersion() {
    const version = iina.core.getVersion();
    iina.console.log(
      `[Clip Recorder] Loaded in IINA ${version.iina} (${version.build}), mpv ${version.mpv}; shortcut ${shortcut.activeShortcut} (${shortcut.displayShortcut})`
    );
    if (version.iina !== "1.4.4" || version.build !== "168") {
      iina.console.warn(
        `[Clip Recorder] This vertical slice was audited for IINA 1.4.4 (168), not ${version.iina} (${version.build}).`
      );
    }
    if (shortcut.conflictDescription !== null) {
      iina.console.warn(
        `[Clip Recorder] The configured shortcut may be unavailable because it conflicts with ${shortcut.conflictDescription}`
      );
    }
  }
  if (iina.core.window.loaded) {
    overlay.initialize();
  }
  iina.event.on("iina.window-loaded", () => overlay.initialize());
  iina.event.on("iina.file-started", onSourceStarted);
  iina.event.on("iina.window-will-close", onWindowWillClose);
  iina.mpv.addHook("on_unload", 50, async (next) => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const reachedEof = !windowClosing && readEofFlag();
      naturalEofObserved = reachedEof;
      iina.console.log(
        `[Clip Recorder] on_unload observed eof-reached=${String(reachedEof)}`
      );
      if (reachedEof) {
        queueOrFinishAtEof();
      }
    } catch (error) {
      naturalEofObserved = false;
      logDetailedError("Unable to classify source unload", error);
    } finally {
      next == null ? void 0 : next();
    }
  });
  iina.event.on("mpv.eof-reached.changed", onEofChanged);
  iina.event.on("mpv.end-file", onEndFile);
  shortcut.update(state, lastOutputPath);
  logRuntimeVersion();
  void cleanupStaleTemporaryFiles().catch((error) => {
    logDetailedError("Stale temporary cleanup failed", error);
  });
})();
