import type {
  Mp4Encoder,
  Mp4ExportRuntime,
  ProcessResult,
} from "./export-mp4";
import type { GifExportPhase, GifExportRuntime } from "./export-gif";
import { UserFacingError, errorMessage } from "./types";

const COMMON_FFMPEG_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
] as const;

export interface TemporaryExportFile {
  readonly magicPath: string;
  readonly resolvedPath: string;
}

export type TemporaryMp4File = TemporaryExportFile;
export type TemporaryGifFile = TemporaryExportFile;
export type TemporaryGifPaletteFile = TemporaryExportFile;

interface Redaction {
  readonly value: string;
  readonly replacement: string;
}

function asProcessResult(value: unknown): ProcessResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("IINA returned an invalid process result");
  }
  const candidate = value as Partial<ProcessResult>;
  if (
    typeof candidate.status !== "number" ||
    typeof candidate.stdout !== "string" ||
    typeof candidate.stderr !== "string"
  ) {
    throw new Error("IINA returned an incomplete process result");
  }
  return {
    status: candidate.status,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
  };
}

export async function runProcess(
  executable: string,
  args: readonly string[],
): Promise<ProcessResult> {
  try {
    return asProcessResult(
      await iina.utils.exec(executable, [...args], null, null, null),
    );
  } catch (error) {
    throw new UserFacingError(
      `Could not launch ${executable}: ${errorMessage(error)}`,
      "process_launch_failed",
    );
  }
}

function resolveConfiguredExecutable(path: string): string | null {
  if (path.length === 0) {
    return null;
  }
  const resolved = iina.utils.resolvePath(path) as unknown;
  return typeof resolved === "string" && resolved.startsWith("/")
    ? resolved
    : null;
}

async function probeFfmpeg(candidate: string): Promise<boolean> {
  try {
    if (!iina.utils.fileInPath(candidate)) {
      return false;
    }
    const result = await runProcess(candidate, ["-hide_banner", "-version"]);
    if (result.status === 0 && result.stdout.toLowerCase().includes("ffmpeg")) {
      return true;
    }
    iina.console.warn(
      `[Clip Recorder] FFmpeg probe failed for ${candidate}: status ${result.status}`,
    );
  } catch (error) {
    iina.console.warn(
      `[Clip Recorder] FFmpeg probe failed for ${candidate}: ${errorMessage(error)}`,
    );
  }
  return false;
}

export async function discoverFfmpeg(
  configuredPath: string,
): Promise<string | null> {
  const configured = resolveConfiguredExecutable(configuredPath);
  if (configuredPath.length > 0 && configured === null) {
    iina.console.warn(
      "[Clip Recorder] Ignoring a non-absolute custom FFmpeg path",
    );
  }

  // Bare-name probing is retained to match the documented order. On IINA
  // 1.4.4 it only succeeds for binaries in IINA-managed binary directories;
  // ordinary PATH lookup is not trusted.
  const candidates = [configured, "ffmpeg", ...COMMON_FFMPEG_PATHS].filter(
    (candidate): candidate is string => candidate !== null,
  );
  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    if (await probeFfmpeg(candidate)) {
      iina.console.log(`[Clip Recorder] Using FFmpeg: ${candidate}`);
      return candidate;
    }
  }
  return null;
}

export async function ensureOutputDirectory(directory: string): Promise<void> {
  const result = await runProcess("/bin/mkdir", ["-p", directory]);
  if (result.status !== 0 || !iina.file.exists(directory)) {
    throw new UserFacingError(
      `Cannot create or access the output directory: ${directory}`,
      "output_directory_unavailable",
    );
  }

  const probePath = `${directory.replace(/\/+$/, "")}/.iina-clip-recorder-write-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  const touchResult = await runProcess("/usr/bin/touch", [probePath]);
  if (touchResult.status !== 0 || !iina.file.exists(probePath)) {
    throw new UserFacingError(
      `The output directory is not writable: ${directory}`,
      "output_directory_not_writable",
    );
  }
  const removeResult = await runProcess("/bin/rm", ["-f", probePath]);
  if (removeResult.status !== 0 || iina.file.exists(probePath)) {
    throw new UserFacingError(
      `A write-test file could not be removed from: ${directory}`,
      "output_directory_cleanup_failed",
    );
  }
}

export async function cleanupStaleTemporaryFiles(): Promise<void> {
  const resolved = iina.utils.resolvePath("@tmp/.") as unknown;
  if (typeof resolved !== "string" || !resolved.startsWith("/")) {
    return;
  }
  const result = await runProcess("/usr/bin/find", [
    resolved,
    "-type",
    "f",
    "-name",
    "clip-recorder-*",
    "-mmin",
    "+1440",
    "-delete",
  ]);
  if (result.status !== 0) {
    iina.console.warn(
      `[Clip Recorder] Stale temporary cleanup failed with status ${result.status}`,
    );
  }
}

function createTemporaryExportFile(
  extension: "mp4" | "gif" | "png",
): TemporaryExportFile {
  const token = `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  const magicPath = `@tmp/clip-recorder-${token}.${extension}`;
  const resolved = iina.utils.resolvePath(magicPath) as unknown;
  if (typeof resolved !== "string" || !resolved.startsWith("/")) {
    throw new UserFacingError(
      "IINA did not provide a usable temporary directory.",
      "temporary_directory_unavailable",
    );
  }
  return { magicPath, resolvedPath: resolved };
}

export function createTemporaryMp4File(): TemporaryMp4File {
  return createTemporaryExportFile("mp4");
}

export function createTemporaryGifFile(): TemporaryGifFile {
  return createTemporaryExportFile("gif");
}

export function createTemporaryGifPaletteFile(): TemporaryGifPaletteFile {
  return createTemporaryExportFile("png");
}

function redact(value: string, redactions: readonly Redaction[]): string {
  return [...redactions]
    .sort((left, right) => right.value.length - left.value.length)
    .reduce(
      (text, item) =>
        item.value.length > 0
          ? text.split(item.value).join(item.replacement)
          : text,
      value,
    );
}

function commandForLog(
  executable: string,
  args: readonly string[],
  redactions: readonly Redaction[],
): string {
  return [executable, ...args]
    .map((argument) => JSON.stringify(redact(argument, redactions)))
    .join(" ");
}

interface ExportRuntimeOptions {
  readonly executable: string;
  readonly sourcePath: string;
  readonly temporaryFile: TemporaryExportFile;
  readonly outputPath: string;
  readonly auxiliaryTemporaryFiles?: readonly TemporaryExportFile[];
  readonly verifySource?: () => Promise<void>;
}

function createExportRuntimeCore(options: ExportRuntimeOptions): {
  readonly cleanupTemporaryFiles: () => void;
  readonly promoteTemporaryFile: () => Promise<void>;
  readonly run: (
    args: readonly string[],
    label: string,
  ) => Promise<ProcessResult>;
} {
  const outputDirectory =
    options.outputPath.slice(0, options.outputPath.lastIndexOf("/")) || "/";
  const temporaryFiles = [
    options.temporaryFile,
    ...(options.auxiliaryTemporaryFiles ?? []),
  ];
  const redactions: Redaction[] = [
    { value: options.sourcePath, replacement: "<source>" },
    ...temporaryFiles.map((file, index) => ({
      value: file.resolvedPath,
      replacement: index === 0 ? "<temporary-output>" : "<temporary-palette>",
    })),
    { value: outputDirectory, replacement: "<output-directory>" },
  ];

  const cleanupTemporaryFiles = (): void => {
    for (const file of temporaryFiles) {
      try {
        if (iina.file.exists(file.magicPath)) {
          iina.file.delete(file.magicPath);
        }
      } catch (error) {
        iina.console.warn(
          `[Clip Recorder] Temporary cleanup failed: ${errorMessage(error)}`,
        );
      }
    }
  };

  return {
    cleanupTemporaryFiles,
    async run(
      args: readonly string[],
      label: string,
    ): Promise<ProcessResult> {
      iina.console.log(
        `[Clip Recorder] FFmpeg (${label}): ${commandForLog(options.executable, args, redactions)}`,
      );
      const result = await runProcess(options.executable, args);
      if (result.status !== 0) {
        iina.console.error(
          `[Clip Recorder] FFmpeg (${label}) exited ${result.status}\n${redact(result.stderr, redactions)}`,
        );
      }
      return result;
    },
    async promoteTemporaryFile(): Promise<void> {
      const moveResult = await runProcess("/bin/mv", [
        "-n",
        options.temporaryFile.resolvedPath,
        options.outputPath,
      ]);
      if (
        moveResult.status !== 0 ||
        iina.file.exists(options.temporaryFile.magicPath) ||
        !iina.file.exists(options.outputPath)
      ) {
        throw new UserFacingError(
          "The clip was encoded, but could not be moved into the output folder.",
          "output_promotion_failed",
        );
      }
    },
  };
}

export function createMp4ExportRuntime(options: ExportRuntimeOptions & {
  readonly onSoftwareFallback: () => void;
}): Mp4ExportRuntime {
  const core = createExportRuntimeCore(options);

  return {
    async run(
      args: readonly string[],
      encoder: Mp4Encoder,
    ): Promise<ProcessResult> {
      return core.run(args, encoder);
    },
    cleanupTemporaryFile: core.cleanupTemporaryFiles,
    promoteTemporaryFile: core.promoteTemporaryFile,
    onSoftwareFallback: options.onSoftwareFallback,
    ...(options.verifySource === undefined
      ? {}
      : { verifySource: options.verifySource }),
  };
}

export function createGifExportRuntime(
  options: ExportRuntimeOptions & {
    readonly paletteFile: TemporaryGifPaletteFile;
  },
): GifExportRuntime {
  const core = createExportRuntimeCore({
    ...options,
    auxiliaryTemporaryFiles: [options.paletteFile],
  });
  return {
    run(
      args: readonly string[],
      phase: GifExportPhase,
    ): Promise<ProcessResult> {
      return core.run(
        args,
        phase === "palette" ? "GIF palette" : "GIF encode",
      );
    },
    cleanupTemporaryFiles: core.cleanupTemporaryFiles,
    promoteTemporaryFile: core.promoteTemporaryFile,
    ...(options.verifySource === undefined
      ? {}
      : { verifySource: options.verifySource }),
  };
}
