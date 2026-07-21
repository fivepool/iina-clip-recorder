import type {
  GifFrameRate,
  GifResolution,
  RecorderPreferences,
} from "./preferences";
import type { ClipRange, MediaSnapshot } from "./types";

export const MEBIBYTE = 1024 * 1024;
export const GIBIBYTE = 1024 * MEBIBYTE;

export const LONG_CLIP_CONFIRMATION_SECONDS = 5 * 60;
export const TOTAL_SIZE_CONFIRMATION_BYTES = 512 * MEBIBYTE;

const MP4_VIDEO_BITRATE_BITS_PER_SECOND = 7_000_000;
const MP4_AUDIO_BITRATE_BITS_PER_SECOND = 192_000;
const MP4_MUX_MARGIN = 1.03;
const MP4_PLANNING_MULTIPLIER = 1.35;
const MP4_MINIMUM_PLANNING_MARGIN = 32 * MEBIBYTE;

// Calibrated from real Stage 4/5 720p/12 fps exports. The planning value stays
// intentionally much higher because GIF size varies strongly with motion,
// grain, noise, dithering and palette efficiency.
const GIF_ESTIMATED_BYTES_PER_PIXEL_FRAME = 0.3;
const GIF_PLANNING_BYTES_PER_PIXEL_FRAME = 2;
const GIF_PLANNING_MARGIN = 8 * MEBIBYTE;
const UNKNOWN_SOURCE_FPS = 60;
const MAXIMUM_ESTIMATED_SOURCE_FPS = 120;

export type ExportEstimateFormat = "MP4" | "GIF";

export interface FormatStorageEstimate {
  readonly format: ExportEstimateFormat;
  readonly estimatedBytes: number;
  readonly planningBytes: number;
  readonly uncertain: boolean;
}

export interface Mp4StorageEstimate extends FormatStorageEstimate {
  readonly format: "MP4";
  readonly includesAudio: boolean;
}

export interface GifStorageEstimate extends FormatStorageEstimate {
  readonly format: "GIF";
  readonly frameCount: number;
  readonly pixelFrames: number;
  readonly estimatedFps: number;
  readonly sourceFpsUnknown: boolean;
}

export interface ExportStorageEstimate {
  readonly formats: readonly FormatStorageEstimate[];
  readonly estimatedFinalBytes: number;
  readonly planningFinalBytes: number;
  readonly estimatedTemporaryBytes: number;
  readonly planningTemporaryBytes: number;
}

export type ExportRiskCode =
  | "long_clip"
  | "large_estimated_size";

export interface ExportRisk {
  readonly code: ExportRiskCode;
}

export interface ExportRiskAssessment {
  readonly requiresConfirmation: boolean;
  readonly risks: readonly ExportRisk[];
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}

function safeCeil(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} is outside the supported range`);
  }
  return Math.ceil(value);
}

export function estimateMp4Storage(
  duration: number,
  includeAudio: boolean,
): Mp4StorageEstimate {
  requirePositiveFinite(duration, "duration");
  const bitrate =
    MP4_VIDEO_BITRATE_BITS_PER_SECOND +
    (includeAudio ? MP4_AUDIO_BITRATE_BITS_PER_SECOND : 0);
  const estimatedBytes = safeCeil(
    (duration * bitrate * MP4_MUX_MARGIN) / 8,
    "MP4 estimate",
  );
  const planningBytes = safeCeil(
    Math.max(
      estimatedBytes * MP4_PLANNING_MULTIPLIER,
      estimatedBytes + MP4_MINIMUM_PLANNING_MARGIN,
    ),
    "MP4 planning estimate",
  );
  return {
    format: "MP4",
    estimatedBytes,
    planningBytes,
    includesAudio: includeAudio,
    // VideoToolbox is bitrate-targeted, but the libx264 CRF fallback is not.
    uncertain: true,
  };
}

function gifPixelCount(
  snapshot: Pick<MediaSnapshot, "width" | "height">,
  resolution: GifResolution,
): number {
  requirePositiveFinite(snapshot.width, "source width");
  requirePositiveFinite(snapshot.height, "source height");
  const sourcePixels = snapshot.width * snapshot.height;
  return resolution === "720p"
    ? Math.min(sourcePixels, 1280 * 720)
    : sourcePixels;
}

function gifEstimatedFps(
  snapshot: Pick<MediaSnapshot, "fps">,
  frameRate: GifFrameRate,
): { readonly fps: number; readonly sourceFpsUnknown: boolean } {
  if (frameRate === "12") {
    return { fps: 12, sourceFpsUnknown: false };
  }
  const sourceFps = snapshot.fps;
  if (
    sourceFps === null ||
    !Number.isFinite(sourceFps) ||
    sourceFps <= 0
  ) {
    return { fps: UNKNOWN_SOURCE_FPS, sourceFpsUnknown: true };
  }
  return {
    fps: Math.min(MAXIMUM_ESTIMATED_SOURCE_FPS, Math.max(1, sourceFps)),
    sourceFpsUnknown: false,
  };
}

export function estimateGifStorage(
  snapshot: Pick<MediaSnapshot, "width" | "height" | "fps">,
  range: Pick<ClipRange, "duration">,
  resolution: GifResolution,
  frameRate: GifFrameRate,
): GifStorageEstimate {
  requirePositiveFinite(range.duration, "duration");
  const { fps, sourceFpsUnknown } = gifEstimatedFps(snapshot, frameRate);
  const frameCount = safeCeil(range.duration * fps, "GIF frame count");
  const pixelFrames = safeCeil(
    gifPixelCount(snapshot, resolution) * frameCount,
    "GIF pixel-frame count",
  );
  const estimatedBytes = safeCeil(
    pixelFrames * GIF_ESTIMATED_BYTES_PER_PIXEL_FRAME,
    "GIF estimate",
  );
  const planningBytes = safeCeil(
    pixelFrames * GIF_PLANNING_BYTES_PER_PIXEL_FRAME + GIF_PLANNING_MARGIN,
    "GIF planning estimate",
  );
  return {
    format: "GIF",
    estimatedBytes,
    planningBytes,
    frameCount,
    pixelFrames,
    estimatedFps: fps,
    sourceFpsUnknown,
    uncertain: true,
  };
}

export function estimateExportStorage(
  snapshot: Pick<
    MediaSnapshot,
    "width" | "height" | "fps" | "hasEmbeddedAudio"
  >,
  range: Pick<ClipRange, "duration">,
  preferences: Pick<
    RecorderPreferences,
    | "mp4Enabled"
    | "mp4WithoutAudio"
    | "gifEnabled"
    | "gifResolution"
    | "gifFps"
  >,
): ExportStorageEstimate {
  const formats: FormatStorageEstimate[] = [];
  if (preferences.mp4Enabled) {
    formats.push(
      estimateMp4Storage(
        range.duration,
        !preferences.mp4WithoutAudio && snapshot.hasEmbeddedAudio,
      ),
    );
  }
  if (preferences.gifEnabled) {
    formats.push(
      estimateGifStorage(
        snapshot,
        range,
        preferences.gifResolution,
        preferences.gifFps,
      ),
    );
  }
  if (formats.length === 0) {
    throw new RangeError("At least one export format must be enabled");
  }

  return {
    formats,
    estimatedFinalBytes: formats.reduce(
      (total, estimate) => total + estimate.estimatedBytes,
      0,
    ),
    planningFinalBytes: formats.reduce(
      (total, estimate) => total + estimate.planningBytes,
      0,
    ),
    // Jobs are intentionally sequential in IINA 1.4.4. Only the largest
    // unfinished output needs to coexist in the plugin temporary directory.
    estimatedTemporaryBytes: Math.max(
      ...formats.map((estimate) => estimate.estimatedBytes),
    ),
    planningTemporaryBytes: Math.max(
      ...formats.map((estimate) => estimate.planningBytes),
    ),
  };
}

export function buildExportRiskAssessment(
  estimate: ExportStorageEstimate,
  range: Pick<ClipRange, "duration">,
): ExportRiskAssessment {
  const risks: ExportRisk[] = [];
  const add = (code: ExportRiskCode): void => {
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
    risks,
  };
}

export function formatBytes(bytes: number): string {
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

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "unknown duration";
  }
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  const parts: string[] = [];
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
