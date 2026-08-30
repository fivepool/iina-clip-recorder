const UNSUPPORTED_INPUT_MARKER = "unsupported input";

/**
 * FFmpeg 8+ can reject otherwise valid scaling when a decoder exposes the
 * reserved transfer-characteristic value used by some ProRes/MOV files.
 * FFmpeg 8 logs that value as `(null)` in some builds and newer builds log it
 * as `reserved`.
 */
export function shouldSanitizeReservedColorTransfer(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  let searchFrom = 0;

  while (searchFrom < normalized.length) {
    const marker = normalized.indexOf(UNSUPPORTED_INPUT_MARKER, searchFrom);
    if (marker < 0) {
      return false;
    }

    const arrow = normalized.indexOf("->", marker);
    if (arrow < 0) {
      return false;
    }

    const inputDescription = normalized.slice(marker, arrow);
    if (
      (inputDescription.includes("trc:reserved") ||
        inputDescription.includes("trc:(null)")) &&
      inputDescription.includes("csp:bt709") &&
      inputDescription.includes("prim:bt709")
    ) {
      return true;
    }

    searchFrom = arrow + 2;
  }

  return false;
}

/**
 * Replace an invalid reserved transfer tag with the standards-defined
 * unspecified value. `setparams` changes frame metadata only; it does not
 * perform a color conversion or modify pixel values.
 */
export function sanitizeReservedColorTransfer(filter: string): string {
  return `setparams=color_trc=unknown,${filter}`;
}
