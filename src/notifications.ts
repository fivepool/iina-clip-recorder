import { errorMessage } from "./types";

export type ExportFormat = "MP4" | "GIF";

export interface SavedClipNotice {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: "Reveal in Finder";
}

export type ExportOutcome =
  | {
      readonly format: ExportFormat;
      readonly ok: true;
      readonly outputPath: string;
      readonly detail?: string;
    }
  | {
      readonly format: ExportFormat;
      readonly ok: false;
      readonly outputPath: string;
      readonly message: string;
    };

function canShowOsd(): boolean {
  return iina.core.window.loaded;
}

export function showOsd(message: string): void {
  if (canShowOsd()) {
    iina.core.osd(message);
  }
}

export function notifyRecordingStarted(): void {
  showOsd("Clip start marked");
}

export function notifyEncodingBusy(): void {
  showOsd("A clip is already being encoded");
}

function filename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function directory(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

export function formatClipDurationSeconds(duration: number): string {
  const rounded = Math.max(0, Math.round(duration * 10) / 10);
  return `${rounded.toFixed(Number.isInteger(rounded) ? 0 : 1)} seconds`;
}

export function buildSavedClipNotice(
  outcomes: readonly ExportOutcome[],
  duration: number,
): SavedClipNotice {
  const successful = outcomes.filter(
    (outcome): outcome is Extract<ExportOutcome, { readonly ok: true }> =>
      outcome.ok,
  );
  const failed = outcomes.filter(
    (outcome): outcome is Extract<ExportOutcome, { readonly ok: false }> =>
      !outcome.ok,
  );
  const formats = successful.map((outcome) => outcome.format).join(" + ");
  const suffix = failed.length > 0
    ? ` · ${failed.map((outcome) => `${outcome.format} failed`).join(", ")}`
    : "";
  return {
    title:
      failed.length > 0
        ? "Clip partly saved"
        : successful.length === 1
          ? "Clip saved"
          : "Clips saved",
    detail: `${formats} · ${formatClipDurationSeconds(duration)}${suffix}`,
    actionLabel: "Reveal in Finder",
  };
}

export function formatExportOutcomeMessage(
  outcomes: readonly ExportOutcome[],
): string {
  const successful = outcomes.filter(
    (outcome): outcome is Extract<ExportOutcome, { readonly ok: true }> =>
      outcome.ok,
  );
  const failed = outcomes.filter(
    (outcome): outcome is Extract<ExportOutcome, { readonly ok: false }> =>
      !outcome.ok,
  );

  if (failed.length === 0) {
    const heading = successful.length === 1 ? "Clip saved" : "Clips saved";
    const lines = successful.map((outcome) => {
      const suffix = outcome.detail ? ` (${outcome.detail})` : "";
      return `${outcome.format}: ${filename(outcome.outputPath)}${suffix}`;
    });
    const destination = successful[0];
    return destination === undefined
      ? "Clip Recorder finished without an export result"
      : [heading, ...lines, directory(destination.outputPath)].join("\n");
  }

  if (successful.length > 0) {
    const firstSuccessful = successful[0];
    if (firstSuccessful === undefined) {
      return "Clip export failed";
    }
    const savedLines = successful.map(
      (outcome) => `Saved ${outcome.format}: ${filename(outcome.outputPath)}`,
    );
    const failedLines = failed.map(
      (outcome) => `${outcome.format} failed: ${outcome.message}`,
    );
    return [
      "Clip export partly completed",
      ...savedLines,
      ...failedLines,
      directory(firstSuccessful.outputPath),
    ].join("\n");
  }

  return [
    "Clip export failed",
    ...failed.map((outcome) => `${outcome.format}: ${outcome.message}`),
  ].join("\n");
}

export function notifyExportOutcomes(outcomes: readonly ExportOutcome[]): void {
  showOsd(formatExportOutcomeMessage(outcomes));
}

export function notifyError(message: string): void {
  showOsd(`Clip Recorder: ${message}`);
}

export function logDetailedError(context: string, error: unknown): void {
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
  iina.console.error(`[Clip Recorder] ${context}: ${errorMessage(error)}${stack}`);
}
