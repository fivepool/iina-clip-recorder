import type {
  DiskSpaceAssessment,
  DiskSpaceInfo,
} from "./disk-space";
import {
  formatBytes,
  formatDuration,
  type ExportRiskAssessment,
  type ExportStorageEstimate,
} from "./export-preflight";
import type { ExportConfirmationNotice } from "./overlay";
import type { ClipRange } from "./types";

function hasRisk(
  risk: ExportRiskAssessment,
  code: ExportRiskAssessment["risks"][number]["code"],
): boolean {
  return risk.risks.some((item) => item.code === code);
}

export function buildExportWarning(
  risk: ExportRiskAssessment,
  assessment: DiskSpaceAssessment,
): string {
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

export function buildExportConfirmationNotice(options: {
  readonly estimate: ExportStorageEstimate;
  readonly assessment: DiskSpaceAssessment;
  readonly outputDisk: DiskSpaceInfo;
  readonly temporaryDisk: DiskSpaceInfo;
  readonly range: ClipRange;
  readonly risk: ExportRiskAssessment;
}): ExportConfirmationNotice {
  const estimates = options.estimate.formats
    .map(
      (item) =>
        `${item.format}: about ${formatBytes(item.estimatedBytes)}`,
    )
    .join("\n");
  const disk = options.assessment.sameFilesystem
    ? `Free space: ${formatBytes(options.outputDisk.availableBytes)}`
    : [
        `Output free: ${formatBytes(options.outputDisk.availableBytes)}`,
        `Temporary free: ${formatBytes(options.temporaryDisk.availableBytes)}`,
      ].join("\n");

  return {
    title: "Review export",
    duration: `Selected range: ${formatDuration(options.range.duration)}`,
    estimates,
    disk,
    warning: buildExportWarning(options.risk, options.assessment),
    confirmLabel: "Export",
    cancelLabel: "Cancel",
  };
}
