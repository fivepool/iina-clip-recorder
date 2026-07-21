import type { ExportStorageEstimate } from "./export-preflight";
import { MEBIBYTE } from "./export-preflight";
import { runProcess } from "./ffmpeg";
import { UserFacingError } from "./types";
import type { ProcessResult } from "./export-mp4";

export interface DiskSpaceInfo {
  readonly filesystem: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly mountPoint: string;
}

export interface DiskRequirement {
  readonly label: "output" | "temporary";
  readonly availableBytes: number;
  readonly estimatedRequiredBytes: number;
  readonly planningRequiredBytes: number;
  readonly headroomBytes: number;
}

export interface DiskSpaceAssessment {
  readonly sameFilesystem: boolean;
  readonly blocked: boolean;
  readonly blockMessage: string | null;
  readonly warnings: readonly string[];
  readonly requirements: readonly DiskRequirement[];
}

function parseSafeBlocks(value: string, label: string): number {
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

export function parsePosixDf(stdout: string): DiskSpaceInfo {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error("df output does not contain a data row");
  }
  const columns = (lines[lines.length - 1] ?? "").split(/\s+/);
  if (columns.length < 6) {
    throw new Error("df output row is incomplete");
  }
  const filesystem = columns[0];
  if (filesystem === undefined || filesystem.length === 0) {
    throw new Error("df output does not identify a filesystem");
  }
  return {
    filesystem,
    totalBytes: parseSafeBlocks(columns[1] ?? "", "total blocks"),
    usedBytes: parseSafeBlocks(columns[2] ?? "", "used blocks"),
    availableBytes: parseSafeBlocks(columns[3] ?? "", "available blocks"),
    mountPoint: columns.slice(5).join(" "),
  };
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
) => Promise<ProcessResult>;

export async function queryDiskSpace(
  path: string,
  run: ProcessRunner = runProcess,
): Promise<DiskSpaceInfo> {
  const result = await run("/bin/df", ["-Pk", path]);
  if (result.status !== 0) {
    throw new UserFacingError(
      `Could not check free space for ${path}.`,
      "disk_space_check_failed",
    );
  }
  try {
    return parsePosixDf(result.stdout);
  } catch (error) {
    throw new UserFacingError(
      `IINA received an unreadable free-space result for ${path}: ${String(error)}`,
      "disk_space_result_invalid",
    );
  }
}

export function resolvePluginTemporaryDirectory(): string {
  const resolved = iina.utils.resolvePath("@tmp/.") as unknown;
  if (typeof resolved !== "string" || !resolved.startsWith("/")) {
    throw new UserFacingError(
      "IINA did not provide a usable temporary directory.",
      "temporary_directory_unavailable",
    );
  }
  return resolved;
}

function headroom(planningBytes: number): number {
  return Math.max(256 * MEBIBYTE, Math.ceil(planningBytes * 0.1));
}

function requirement(
  label: DiskRequirement["label"],
  availableBytes: number,
  estimatedRequiredBytes: number,
  planningRequiredBytes: number,
): DiskRequirement {
  return {
    label,
    availableBytes,
    estimatedRequiredBytes,
    planningRequiredBytes,
    headroomBytes: headroom(planningRequiredBytes),
  };
}

export function assessDiskSpace(
  estimate: ExportStorageEstimate,
  output: DiskSpaceInfo,
  temporary: DiskSpaceInfo,
): DiskSpaceAssessment {
  const sameFilesystem = output.filesystem === temporary.filesystem;
  const requirements: DiskRequirement[] = sameFilesystem
    ? [
        requirement(
          "output",
          Math.min(output.availableBytes, temporary.availableBytes),
          estimate.estimatedFinalBytes,
          estimate.planningFinalBytes,
        ),
      ]
    : [
        requirement(
          "output",
          output.availableBytes,
          estimate.estimatedFinalBytes,
          estimate.planningFinalBytes,
        ),
        requirement(
          "temporary",
          temporary.availableBytes,
          estimate.estimatedTemporaryBytes,
          estimate.planningTemporaryBytes,
        ),
      ];

  const insufficient = requirements.find(
    (item) => item.availableBytes < item.estimatedRequiredBytes,
  );
  const warnings = requirements
    .filter(
      (item) =>
        item.availableBytes <
        item.planningRequiredBytes + item.headroomBytes,
    )
    .map((item) =>
      item.label === "output"
        ? "The output disk has less than the conservative planning reserve."
        : "IINA’s temporary disk has less than the conservative planning reserve.",
    );

  return {
    sameFilesystem,
    blocked: insufficient !== undefined,
    blockMessage:
      insufficient === undefined
        ? null
        : insufficient.label === "output"
          ? "The output disk has less free space than the approximate export size."
          : "IINA’s temporary disk has less free space than the approximate working-file size.",
    warnings,
    requirements,
  };
}
