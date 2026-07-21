import type { ClipRange } from "./types";

export type ClipRangeError =
  | "invalid_timestamp"
  | "invalid_duration"
  | "end_before_start"
  | "too_short";

export type ClipRangeResult =
  | { readonly ok: true; readonly range: ClipRange }
  | { readonly ok: false; readonly error: ClipRangeError };

export const MINIMUM_CLIP_DURATION_SECONDS = 0.1;

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

export function validateClipRange(
  rawStart: number,
  rawEnd: number,
  mediaDuration: number,
  minimumDuration = MINIMUM_CLIP_DURATION_SECONDS,
): ClipRangeResult {
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
    range: { start, end, duration },
  };
}
