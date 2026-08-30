import {
  buildEvenFullResolutionFilter,
  buildSarAwareScaleFilter,
} from "./dimensions";
import {
  sanitizeReservedColorTransfer,
  shouldSanitizeReservedColorTransfer,
} from "./color-metadata";
import type { Mp4Resolution } from "./preferences";
import type { ClipRange } from "./types";

export type Mp4Encoder = "h264_videotoolbox" | "libx264";

export interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Mp4CommandInput {
  readonly sourcePath: string;
  readonly temporaryOutputPath: string;
  readonly range: ClipRange;
  readonly maximumWidth?: number;
  readonly maximumHeight?: number;
  readonly resolution?: Mp4Resolution;
  readonly selectedVideoStreamIndex?: number | null;
  readonly hasEmbeddedAudio?: boolean;
  readonly selectedEmbeddedAudioStreamIndex?: number | null;
  readonly includeAudio?: boolean;
}

export interface Mp4ExportRuntime {
  run(args: readonly string[], encoder: Mp4Encoder): Promise<ProcessResult>;
  cleanupTemporaryFile(): void;
  promoteTemporaryFile(): Promise<void>;
  onSoftwareFallback?(): void;
  verifySource?(): Promise<void>;
}

export interface Mp4ExportResult {
  readonly encoder: Mp4Encoder;
}

export class Mp4ExportError extends Error {
  constructor(
    message: string,
    readonly attempts: readonly ProcessResult[],
  ) {
    super(message);
    this.name = "Mp4ExportError";
  }
}

function formatSeconds(value: number): string {
  return value.toFixed(6);
}

export function buildMp4Args(
  input: Mp4CommandInput,
  encoder: Mp4Encoder,
  repairReservedColorTransfer = false,
): string[] {
  const maximumWidth = input.maximumWidth ?? 1920;
  const maximumHeight = input.maximumHeight ?? 1080;
  const scaleFilter =
    (input.resolution ?? "1080p") === "full"
      ? buildEvenFullResolutionFilter()
      : buildSarAwareScaleFilter(maximumWidth, maximumHeight);
  const videoFilter = repairReservedColorTransfer
    ? sanitizeReservedColorTransfer(scaleFilter)
    : scaleFilter;
  const encoderArgs =
    encoder === "h264_videotoolbox"
      ? [
          "-c:v",
          "h264_videotoolbox",
          "-b:v",
          "7000k",
          "-profile:v",
          "high",
          "-allow_sw",
          "0",
        ]
      : [
          "-c:v",
          "libx264",
          "-crf",
          "20",
          "-preset",
          "fast",
          "-profile:v",
          "high",
        ];
  const includeAudio = input.includeAudio ?? true;
  const videoMap =
    input.selectedVideoStreamIndex === null ||
    input.selectedVideoStreamIndex === undefined
      ? "0:v:0"
      : `0:${input.selectedVideoStreamIndex}`;
  const shouldEncodeAudio = includeAudio && input.hasEmbeddedAudio !== false;
  const audioMap =
    input.selectedEmbeddedAudioStreamIndex === null ||
    input.selectedEmbeddedAudioStreamIndex === undefined
      ? "0:a:0"
      : `0:${input.selectedEmbeddedAudioStreamIndex}`;

  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-n",
    "-ss",
    formatSeconds(input.range.start),
    "-i",
    input.sourcePath,
    "-t",
    formatSeconds(input.range.duration),
    "-map",
    videoMap,
    ...(shouldEncodeAudio ? ["-map", audioMap] : ["-an"]),
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
    ...(shouldEncodeAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-movflags",
    "+faststart",
    input.temporaryOutputPath,
  ];
}

export function shouldFallbackToLibx264(stderr: string): boolean {
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
    "error while opening encoder",
  ].some((marker) => normalized.includes(marker));
}

export function describeFfmpegFailure(
  attempts: readonly ProcessResult[],
  exhaustedEncoders: boolean,
): string {
  const stderr = attempts
    .map((attempt) => attempt.stderr)
    .join("\n")
    .toLowerCase();

  if (
    stderr.includes("no space left on device") ||
    stderr.includes("disk quota exceeded")
  ) {
    return "There is not enough free disk space to export this clip.";
  }
  if (
    stderr.includes("permission denied") ||
    stderr.includes("operation not permitted") ||
    stderr.includes("read-only file system")
  ) {
    return "FFmpeg cannot access the source or its working files. Check file and folder permissions.";
  }
  if (
    stderr.includes("invalid data found when processing input") ||
    stderr.includes("could not find codec parameters") ||
    stderr.includes("decoder not found") ||
    stderr.includes("unknown decoder")
  ) {
    return "FFmpeg could not decode this source. See the IINA log for details.";
  }
  if (stderr.includes("invalid time base")) {
    return "FFmpeg rejected the video timestamp settings. Update IINA Clip Recorder or use a compatible FFmpeg build.";
  }
  if (exhaustedEncoders && stderr.includes("unknown encoder")) {
    return "This FFmpeg build has neither a usable VideoToolbox nor libx264 H.264 encoder.";
  }
  return exhaustedEncoders
    ? "Neither VideoToolbox nor libx264 could encode this clip. See the IINA log for details."
    : "FFmpeg could not encode this clip. See the IINA log for details.";
}

export async function exportMp4(
  input: Mp4CommandInput,
  runtime: Mp4ExportRuntime,
): Promise<Mp4ExportResult> {
  const attempts: ProcessResult[] = [];
  const runEncoder = async (encoder: Mp4Encoder): Promise<ProcessResult> => {
    await runtime.verifySource?.();
    let result = await runtime.run(buildMp4Args(input, encoder), encoder);
    attempts.push(result);

    if (
      result.status !== 0 &&
      shouldSanitizeReservedColorTransfer(result.stderr)
    ) {
      runtime.cleanupTemporaryFile();
      await runtime.verifySource?.();
      result = await runtime.run(buildMp4Args(input, encoder, true), encoder);
      attempts.push(result);
    }

    return result;
  };

  const hardwareResult = await runEncoder("h264_videotoolbox");

  if (hardwareResult.status === 0) {
    await runtime.promoteTemporaryFile();
    return { encoder: "h264_videotoolbox" };
  }

  runtime.cleanupTemporaryFile();
  if (!shouldFallbackToLibx264(hardwareResult.stderr)) {
    throw new Mp4ExportError(
      describeFfmpegFailure(attempts, false),
      attempts,
    );
  }

  runtime.onSoftwareFallback?.();
  const softwareResult = await runEncoder("libx264");

  if (softwareResult.status !== 0) {
    runtime.cleanupTemporaryFile();
    throw new Mp4ExportError(
      describeFfmpegFailure(attempts, true),
      attempts,
    );
  }

  await runtime.promoteTemporaryFile();
  return { encoder: "libx264" };
}
