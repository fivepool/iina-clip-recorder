import { canonicalizeShortcutInput } from "./shortcut";
import { UserFacingError } from "./types";

export const DEFAULT_SHORTCUT = "Meta+r";
export const DEFAULT_OUTPUT_DIRECTORY = "~/Movies/IINA Clips";

export type Mp4Resolution = "1080p" | "full";
export type GifResolution = "720p" | "full";
export type GifFrameRate = "12" | "source";

export interface RecorderPreferences {
  readonly shortcut: string;
  readonly mp4Enabled: boolean;
  readonly mp4WithoutAudio: boolean;
  readonly gifEnabled: boolean;
  readonly mp4Resolution: Mp4Resolution;
  readonly gifResolution: GifResolution;
  readonly gifFps: GifFrameRate;
  readonly outputDirectory: string;
  readonly ffmpegPath: string;
}

export interface RawRecorderPreferences {
  readonly shortcut?: unknown;
  readonly mp4Enabled?: unknown;
  readonly mp4WithoutAudio?: unknown;
  readonly gifEnabled?: unknown;
  readonly mp4Resolution?: unknown;
  readonly gifResolution?: unknown;
  readonly gifFps?: unknown;
  readonly outputDirectory?: unknown;
  readonly ffmpegPath?: unknown;
}

export const DEFAULT_RECORDER_PREFERENCES: RecorderPreferences = {
  shortcut: DEFAULT_SHORTCUT,
  mp4Enabled: true,
  mp4WithoutAudio: false,
  gifEnabled: false,
  mp4Resolution: "1080p",
  gifResolution: "720p",
  gifFps: "12",
  outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
  ffmpegPath: "",
};

export type PreferenceValidationResult =
  | { readonly ok: true; readonly value: RecorderPreferences }
  | { readonly ok: false; readonly errors: readonly string[] };

function stringValue(
  value: unknown,
  fallback: string,
  label: string,
  errors: string[],
): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    errors.push(`${label} must be a string.`);
    return fallback;
  }
  return value.trim();
}

function booleanValue(
  value: unknown,
  fallback: boolean,
  label: string,
  errors: string[],
): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    errors.push(`${label} must be a boolean.`);
    return fallback;
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
  errors: string[],
): T {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`${label} has an unsupported value.`);
    return fallback;
  }
  return value as T;
}

function isLocalPathInput(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("/");
}

export function validateRecorderPreferences(
  raw: Readonly<RawRecorderPreferences>,
): PreferenceValidationResult {
  const errors: string[] = [];
  const shortcutInput = stringValue(
    raw.shortcut,
    DEFAULT_SHORTCUT,
    "Shortcut",
    errors,
  );
  const shortcutResult = canonicalizeShortcutInput(shortcutInput);
  if (!shortcutResult.ok) {
    errors.push(shortcutResult.message);
  }
  const shortcut = shortcutResult.ok
    ? shortcutResult.value
    : DEFAULT_SHORTCUT;
  const mp4Enabled = booleanValue(
    raw.mp4Enabled,
    true,
    "MP4 enabled",
    errors,
  );
  const mp4WithoutAudio = booleanValue(
    raw.mp4WithoutAudio,
    false,
    "MP4 without audio",
    errors,
  );
  const gifEnabled = booleanValue(
    raw.gifEnabled,
    false,
    "GIF enabled",
    errors,
  );
  const mp4Resolution = enumValue(
    raw.mp4Resolution,
    ["1080p", "full"] as const,
    "1080p",
    "MP4 resolution",
    errors,
  );
  const gifResolution = enumValue(
    raw.gifResolution,
    ["720p", "full"] as const,
    "720p",
    "GIF resolution",
    errors,
  );
  const gifFps = enumValue(
    raw.gifFps,
    ["12", "source"] as const,
    "12",
    "GIF frame rate",
    errors,
  );
  const outputDirectory = stringValue(
    raw.outputDirectory,
    DEFAULT_OUTPUT_DIRECTORY,
    "Output directory",
    errors,
  );
  const ffmpegPath = stringValue(
    raw.ffmpegPath,
    "",
    "FFmpeg path",
    errors,
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
      shortcut,
      mp4Enabled,
      mp4WithoutAudio,
      gifEnabled,
      mp4Resolution,
      gifResolution,
      gifFps,
      outputDirectory,
      ffmpegPath,
    },
  };
}

function readRawPreferences(): RawRecorderPreferences {
  return {
    shortcut: iina.preferences.get("shortcut") as unknown,
    mp4Enabled: iina.preferences.get("mp4Enabled") as unknown,
    mp4WithoutAudio: iina.preferences.get("mp4WithoutAudio") as unknown,
    gifEnabled: iina.preferences.get("gifEnabled") as unknown,
    mp4Resolution: iina.preferences.get("mp4Resolution") as unknown,
    gifResolution: iina.preferences.get("gifResolution") as unknown,
    gifFps: iina.preferences.get("gifFps") as unknown,
    outputDirectory: iina.preferences.get("outputDirectory") as unknown,
    ffmpegPath: iina.preferences.get("ffmpegPath") as unknown,
  };
}

export function readRecorderPreferences(): RecorderPreferences {
  const result = validateRecorderPreferences(readRawPreferences());
  if (!result.ok) {
    throw new UserFacingError(
      `Invalid Clip Recorder preferences: ${result.errors.join(" ")}`,
      "invalid_preferences",
    );
  }
  const resolvedDirectory = iina.utils.resolvePath(
    result.value.outputDirectory,
  ) as unknown;
  if (
    typeof resolvedDirectory !== "string" ||
    !resolvedDirectory.startsWith("/")
  ) {
    throw new UserFacingError(
      "The output directory must resolve to an absolute local path.",
      "invalid_output_directory",
    );
  }

  return {
    ...result.value,
    outputDirectory: resolvedDirectory,
  };
}
