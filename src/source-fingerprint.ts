import { runProcess } from "./ffmpeg";
import { UserFacingError } from "./types";

export interface SourceFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modified: string;
  readonly value: string;
}

export function parseSourceFingerprint(value: string): SourceFingerprint {
  const normalized = value.trim();
  const match = /^(\d+):(\d+):(\d+):(-?\d+)$/.exec(normalized);
  if (match === null) {
    throw new Error("stat returned an invalid source fingerprint");
  }
  const [, device, inode, size, modified] = match;
  if (
    device === undefined ||
    inode === undefined ||
    size === undefined ||
    modified === undefined
  ) {
    throw new Error("stat returned an incomplete source fingerprint");
  }
  return { device, inode, size, modified, value: normalized };
}

export async function readSourceFingerprint(
  sourcePath: string,
): Promise<SourceFingerprint> {
  const result = await runProcess("/usr/bin/stat", [
    "-L",
    "-f",
    "%d:%i:%z:%m",
    sourcePath,
  ]);
  if (result.status !== 0) {
    throw new UserFacingError(
      "The source file is no longer available.",
      "missing_source",
    );
  }
  try {
    return parseSourceFingerprint(result.stdout);
  } catch {
    throw new UserFacingError(
      "The source file could not be identified reliably.",
      "source_fingerprint_unavailable",
    );
  }
}

export async function assertSourceFingerprint(
  sourcePath: string,
  expected: SourceFingerprint,
): Promise<void> {
  const current = await readSourceFingerprint(sourcePath);
  if (current.value !== expected.value) {
    throw new UserFacingError(
      "The source file changed after the start marker. The export was canceled.",
      "source_file_changed",
    );
  }
}
