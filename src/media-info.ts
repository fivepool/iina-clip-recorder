import { UserFacingError, type MediaSnapshot } from "./types";

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
    ? value
    : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeNativeProperty(name: string): Record<string, unknown> | null {
  try {
    return recordValue(iina.mpv.getNative<unknown>(name));
  } catch (error) {
    iina.console.warn(`Unable to read mpv property ${name}: ${String(error)}`);
    return null;
  }
}

function safeNumberProperty(name: string): number | null {
  try {
    return finitePositive(iina.mpv.getNumber(name));
  } catch {
    return null;
  }
}

export function currentSourcePath(): string | null {
  try {
    const value = iina.mpv.getString("path") as unknown;
    return typeof value === "string" && value.startsWith("/") ? value : null;
  } catch {
    return null;
  }
}

export function isKnownHdr(
  parameters: Readonly<Record<string, unknown>> | null,
): boolean {
  if (parameters === null) {
    return false;
  }
  const primaries = String(parameters.primaries ?? "").toLowerCase();
  const transfer = String(
    parameters.gamma ?? parameters.transfer ?? "",
  ).toLowerCase();
  const signalPeak = finitePositive(parameters["sig-peak"]);
  return (
    primaries.includes("2020") ||
    ["pq", "hlg", "st2084", "st-2084", "smpte2084", "arib-std-b67"].some(
      (marker) => transfer.includes(marker),
    ) ||
    (signalPeak !== null && signalPeak > 1.1)
  );
}

export function hasKnownHdrParameterSet(
  ...parameterSets: readonly (
    | Readonly<Record<string, unknown>>
    | null
  )[]
): boolean {
  return parameterSets.some((parameters) => isKnownHdr(parameters));
}

/**
 * IINA 1.4.4 observes new mpv property events as MPV_FORMAT_DOUBLE by
 * default, so flag callbacks can arrive as 0/1 numbers rather than booleans.
 */
export function eofReachedFromEvent(value: unknown): boolean | null {
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

export function captureCurrentMedia(): MediaSnapshot {
  if (iina.core.status.idle) {
    throw new UserFacingError(
      "Open a local video before starting a clip.",
      "no_media",
    );
  }
  if (iina.core.status.isNetworkResource) {
    throw new UserFacingError(
      "Network streams are not supported yet. Open a local video file.",
      "network_source",
    );
  }

  const sourcePath = currentSourcePath();
  if (sourcePath === null) {
    throw new UserFacingError(
      "The current source is not a regular local file.",
      "unsupported_local_source",
    );
  }
  if (!iina.file.exists(sourcePath)) {
    throw new UserFacingError(
      "The source file is no longer available.",
      "missing_source",
    );
  }

  const position = iina.core.status.position;
  const duration = iina.core.status.duration;
  if (position === null || !Number.isFinite(position)) {
    throw new UserFacingError(
      "IINA has not reported a valid playback position yet.",
      "missing_position",
    );
  }
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    throw new UserFacingError(
      "This file does not have a finite duration and cannot be clipped yet.",
      "missing_duration",
    );
  }

  const decodedParameters = safeNativeProperty("video-dec-params");
  const containerParameters = safeNativeProperty("video-params");
  const effectiveParameters =
    decodedParameters === null
      ? containerParameters
      : containerParameters === null
        ? decodedParameters
        : { ...containerParameters, ...decodedParameters };
  const width =
    finitePositive(effectiveParameters?.w) ??
    finitePositive(iina.core.status.videoWidth);
  const height =
    finitePositive(effectiveParameters?.h) ??
    finitePositive(iina.core.status.videoHeight);
  if (width === null || height === null) {
    throw new UserFacingError(
      "The current file does not contain a usable video track.",
      "missing_video",
    );
  }
  if (width < 2 || height < 2) {
    throw new UserFacingError(
      "The selected video track is too small to export safely.",
      "unsupported_video_dimensions",
    );
  }

  const selectedVideoTrack =
    iina.core.video.tracks.find((track) => track.isSelected) ??
    iina.core.video.tracks[0];
  const fps =
    finitePositive(selectedVideoTrack?.demuxFPS) ??
    safeNumberProperty("container-fps");
  const sourceUrlValue = iina.core.status.url as unknown;
  const selectedVideoParameters = safeNativeProperty("current-tracks/video");
  const selectedVideoIsExternal =
    selectedVideoParameters?.external === true ||
    selectedVideoParameters?.external === "yes";
  if (selectedVideoIsExternal) {
    throw new UserFacingError(
      "External video tracks are not supported. Select a video track embedded in the source file.",
      "external_video_not_supported",
    );
  }
  const selectedVideoStreamIndex = finiteNonNegativeInteger(
    selectedVideoParameters?.["ff-index"],
  );
  if (
    selectedVideoStreamIndex === null &&
    iina.core.video.tracks.length > 1
  ) {
    throw new UserFacingError(
      "IINA did not identify the selected video stream reliably.",
      "selected_video_stream_unknown",
    );
  }
  const selectedAudioParameters = safeNativeProperty("current-tracks/audio");
  const selectedAudioIsExternal =
    selectedAudioParameters?.external === true ||
    selectedAudioParameters?.external === "yes";

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
      (track) => !track.isExternal,
    ),
    selectedEmbeddedAudioStreamIndex: selectedAudioIsExternal
      ? null
      : finiteNonNegativeInteger(selectedAudioParameters?.["ff-index"]),
    selectedAudioIsExternal,
    videoParameters: effectiveParameters,
    isHdr: hasKnownHdrParameterSet(
      decodedParameters,
      containerParameters,
    ),
  };
}
