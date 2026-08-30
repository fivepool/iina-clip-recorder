import { buildSarAwareScaleFilter } from "./dimensions";
import {
  sanitizeReservedColorTransfer,
  shouldSanitizeReservedColorTransfer,
} from "./color-metadata";
import type { GifFrameRate, GifResolution } from "./preferences";
import type { ClipRange } from "./types";

export interface GifProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GifCommandInput {
  readonly sourcePath: string;
  readonly temporaryOutputPath: string;
  readonly temporaryPalettePath: string;
  readonly range: ClipRange;
  readonly resolution: GifResolution;
  readonly frameRate: GifFrameRate;
  readonly selectedVideoStreamIndex?: number | null;
}

export type GifExportPhase = "palette" | "encode";

export interface GifExportRuntime {
  run(
    args: readonly string[],
    phase: GifExportPhase,
  ): Promise<GifProcessResult>;
  cleanupTemporaryFiles(): void;
  promoteTemporaryFile(): Promise<void>;
  verifySource?(): Promise<void>;
}

export class GifExportError extends Error {
  constructor(
    message: string,
    readonly result: GifProcessResult,
    readonly phase: GifExportPhase,
  ) {
    super(message);
    this.name = "GifExportError";
  }
}

function formatSeconds(value: number): string {
  return value.toFixed(6);
}

/**
 * GIF does not carry sample-aspect-ratio metadata. Full resolution therefore
 * converts to square pixels while keeping both output dimensions within the
 * decoded raster. Unlike H.264, GIF accepts odd dimensions.
 */
export function buildGifFullResolutionFilter(): string {
  const factor = "min(1,1/sar)";
  return `scale=w='max(1,round(iw*sar*${factor}))':h='max(1,round(ih*${factor}))':flags=lanczos,setsar=1`;
}

export function buildGifProcessingFilter(
  resolution: GifResolution,
  frameRate: GifFrameRate,
  repairReservedColorTransfer = false,
): string {
  const scaleFilter =
    resolution === "720p"
      ? buildSarAwareScaleFilter(1280, 720)
      : buildGifFullResolutionFilter();

  // Omitting the fps filter for Match Source preserves the decoded timestamps,
  // including variable frame timing. The GIF muxer then represents those
  // timestamps as frame delays instead of converting the clip to an arbitrary
  // constant rate.
  const processingFilters =
    frameRate === "12" ? `fps=fps=12,${scaleFilter}` : scaleFilter;

  return repairReservedColorTransfer
    ? sanitizeReservedColorTransfer(processingFilters)
    : processingFilters;
}

export function buildGifPaletteFilter(
  resolution: GifResolution,
  frameRate: GifFrameRate,
  repairReservedColorTransfer = false,
): string {
  return `${buildGifProcessingFilter(resolution, frameRate, repairReservedColorTransfer)},palettegen=max_colors=256:stats_mode=diff`;
}

export function buildGifEncodeFilterGraph(
  resolution: GifResolution,
  frameRate: GifFrameRate,
  selectedVideoStreamIndex?: number | null,
  repairReservedColorTransfer = false,
): string {
  const videoInput =
    selectedVideoStreamIndex === null ||
    selectedVideoStreamIndex === undefined
      ? "0:v:0"
      : `0:${selectedVideoStreamIndex}`;
  return (
    `[${videoInput}]${buildGifProcessingFilter(resolution, frameRate, repairReservedColorTransfer)}[gif_frames];` +
    "[gif_frames][1:v:0]paletteuse=dither=sierra2_4a:diff_mode=rectangle[gif]"
  );
}

/**
 * Build the first pass. Both -ss and -t are input options placed before -i.
 * palettegen emits its single frame only at EOF, so an output-side -t would
 * otherwise make FFmpeg scan from the marker to the end of the whole movie.
 */
export function buildGifPaletteArgs(
  input: GifCommandInput,
  repairReservedColorTransfer = false,
): string[] {
  const videoMap =
    input.selectedVideoStreamIndex === null ||
    input.selectedVideoStreamIndex === undefined
      ? "0:v:0"
      : `0:${input.selectedVideoStreamIndex}`;
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
    buildGifPaletteFilter(
      input.resolution,
      input.frameRate,
      repairReservedColorTransfer,
    ),
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-dn",
    "-f",
    "image2",
    input.temporaryPalettePath,
  ];
}

/** Build the second pass using the already-generated palette image. */
export function buildGifEncodeArgs(
  input: GifCommandInput,
  repairReservedColorTransfer = false,
): string[] {
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
      input.selectedVideoStreamIndex,
      repairReservedColorTransfer,
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
    input.temporaryOutputPath,
  ];
}

export function describeGifFailure(
  result: GifProcessResult,
  phase: GifExportPhase = "encode",
): string {
  const stderr = result.stderr.toLowerCase();

  if (
    stderr.includes("no space left on device") ||
    stderr.includes("disk quota exceeded")
  ) {
    return "There is not enough free disk space to export this GIF.";
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
    return "FFmpeg could not decode this source for GIF export. See the IINA log for details.";
  }
  if (
    stderr.includes("no such filter: 'palettegen'") ||
    stderr.includes("no such filter: palettegen") ||
    stderr.includes("no such filter: 'paletteuse'") ||
    stderr.includes("no such filter: paletteuse")
  ) {
    return "This FFmpeg build does not include the palette filters required for GIF export.";
  }
  if (result.status === 9 || result.status === 137) {
    return "FFmpeg was terminated before the GIF finished. Check available memory and the IINA log.";
  }
  return phase === "palette"
    ? "FFmpeg could not generate the GIF color palette. See the IINA log for details."
    : "FFmpeg could not create this GIF. See the IINA log for details.";
}

export async function exportGif(
  input: GifCommandInput,
  runtime: GifExportRuntime,
): Promise<void> {
  try {
    let repairReservedColorTransfer = false;

    for (;;) {
      await runtime.verifySource?.();
      const paletteResult = await runtime.run(
        buildGifPaletteArgs(input, repairReservedColorTransfer),
        "palette",
      );
      if (paletteResult.status !== 0) {
        if (
          !repairReservedColorTransfer &&
          shouldSanitizeReservedColorTransfer(paletteResult.stderr)
        ) {
          runtime.cleanupTemporaryFiles();
          repairReservedColorTransfer = true;
          continue;
        }
        throw new GifExportError(
          describeGifFailure(paletteResult, "palette"),
          paletteResult,
          "palette",
        );
      }

      await runtime.verifySource?.();
      const encodeResult = await runtime.run(
        buildGifEncodeArgs(input, repairReservedColorTransfer),
        "encode",
      );
      if (encodeResult.status !== 0) {
        if (
          !repairReservedColorTransfer &&
          shouldSanitizeReservedColorTransfer(encodeResult.stderr)
        ) {
          runtime.cleanupTemporaryFiles();
          repairReservedColorTransfer = true;
          continue;
        }
        throw new GifExportError(
          describeGifFailure(encodeResult, "encode"),
          encodeResult,
          "encode",
        );
      }
      await runtime.promoteTemporaryFile();
      return;
    }
  } finally {
    runtime.cleanupTemporaryFiles();
  }
}
