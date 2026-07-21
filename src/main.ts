import { validateClipRange, type ClipRangeError } from "./clip-range";
import {
  assessDiskSpace,
  queryDiskSpace,
  resolvePluginTemporaryDirectory,
} from "./disk-space";
import { exportGif, type GifExportRuntime } from "./export-gif";
import { exportMp4, type Mp4ExportRuntime } from "./export-mp4";
import {
  buildExportRiskAssessment,
  estimateExportStorage,
  formatBytes,
} from "./export-preflight";
import { buildExportConfirmationNotice } from "./export-confirmation";
import {
  createExportLifecycle,
  exportLifecycleIsCurrent,
  sourceStartBelongsToNaturalEof,
  type ExportLifecycle,
} from "./export-lifecycle";
import {
  createGifExportRuntime,
  createMp4ExportRuntime,
  createTemporaryGifFile,
  createTemporaryGifPaletteFile,
  createTemporaryMp4File,
  cleanupStaleTemporaryFiles,
  discoverFfmpeg,
  ensureOutputDirectory,
} from "./ffmpeg";
import { buildClipBasename, chooseAvailableOutputPath } from "./filenames";
import {
  captureCurrentMedia,
  currentSourcePath,
  eofReachedFromEvent,
} from "./media-info";
import {
  buildSavedClipNotice,
  formatExportOutcomeMessage,
  logDetailedError,
  notifyEncodingBusy,
  notifyError,
  notifyRecordingStarted,
  showOsd,
  type ExportOutcome,
} from "./notifications";
import { RecorderOverlay } from "./overlay";
import {
  readRecorderPreferences,
  type RecorderPreferences,
} from "./preferences";
import {
  initialRecorderState,
  reduceRecorderState,
  type RecorderEvent,
  type RecorderState,
} from "./recorder-state";
import { registerShortcut } from "./shortcut";
import {
  assertSourceFingerprint,
  readSourceFingerprint,
  type SourceFingerprint,
} from "./source-fingerprint";
import {
  UserFacingError,
  errorMessage,
  type ClipRange,
  type MediaSnapshot,
} from "./types";

interface ActiveSession {
  readonly ffmpeg: string;
  readonly preferences: RecorderPreferences;
  readonly sourceFingerprint: SourceFingerprint;
}

const TOGGLE_DEBOUNCE_MILLISECONDS = 100;
const overlay = new RecorderOverlay();

let state: RecorderState = initialRecorderState();
let activeSession: ActiveSession | null = null;
let lastOutputPath: string | null = null;
let overlayTimer: string | null = null;
let actionInFlight = false;
let lastToggleAt = 0;
let windowClosing = false;
let lifecycleGeneration = 0;
let preparingSnapshot: MediaSnapshot | null = null;
let pendingEndPosition: number | null = null;
let pendingEof = false;
let pendingEofGeneration: number | null = null;
let naturalEofObserved = false;
let activeExportLifecycle: ExportLifecycle | null = null;
let cachedFfmpeg: { readonly configuredPath: string; readonly path: string } | null =
  null;

overlay.setRevealHandler(() => {
  const outputPath = lastOutputPath;
  overlay.hide();
  if (outputPath === null || !iina.file.exists(outputPath)) {
    showOsd("The exported clip is no longer available");
    return;
  }
  iina.console.log(
    `[Clip Recorder] Revealing exported clip in Finder: ${outputPath}`,
  );
  iina.file.showInFinder(outputPath);
});

const shortcut = registerShortcut(requestToggle, () => lastOutputPath);

function dispatch(event: RecorderEvent): void {
  state = reduceRecorderState(state, event);
  shortcut.update(state, lastOutputPath);
}

function clearOverlayTimer(): void {
  if (overlayTimer !== null) {
    clearInterval(overlayTimer);
    overlayTimer = null;
  }
}

function sameSource(snapshot: MediaSnapshot): boolean {
  return currentSourcePath() === snapshot.sourcePath;
}

function updateRecordingOverlay(snapshot: MediaSnapshot): void {
  if (state.kind !== "recording" || windowClosing) {
    return;
  }
  if (!sameSource(snapshot)) {
    cancelRecording("Clip selection canceled because the source changed.", true);
    return;
  }

  const position = iina.core.status.position;
  if (position === null || !Number.isFinite(position)) {
    return;
  }
  const elapsed = position - snapshot.startPosition;
  overlay.showRecording(Math.max(0, elapsed), elapsed < 0);
}

function startRecordingOverlay(snapshot: MediaSnapshot): void {
  clearOverlayTimer();
  updateRecordingOverlay(snapshot);
  overlayTimer = setInterval(() => updateRecordingOverlay(snapshot), 100);
}

function cancelRecording(message: string, showMessage: boolean): void {
  if (state.kind !== "recording") {
    return;
  }
  clearOverlayTimer();
  overlay.hide();
  activeSession = null;
  activeExportLifecycle = null;
  dispatch({ type: "cancel" });
  iina.console.warn(`[Clip Recorder] ${message}`);
  if (showMessage && !windowClosing) {
    showOsd(message);
  }
}

function rangeErrorMessage(error: ClipRangeError): string {
  switch (error) {
    case "end_before_start":
      return "The end is before the start. The selection was reset.";
    case "too_short":
      return "The selected clip must be at least 0.1 seconds long.";
    case "invalid_duration":
      return "IINA did not report a valid media duration.";
    case "invalid_timestamp":
      return "IINA did not report valid clip timestamps.";
  }
}

function encodingLabel(preferences: RecorderPreferences): string {
  if (preferences.mp4Enabled && preferences.gifEnabled) {
    return "Encoding MP4 + GIF…";
  }
  return preferences.gifEnabled ? "Encoding GIF…" : "Encoding MP4…";
}

function preflightIsCurrent(
  lifecycle: ExportLifecycle,
  snapshot: MediaSnapshot,
): boolean {
  return (
    state.kind === "preflighting" &&
    activeSession !== null &&
    activeExportLifecycle === lifecycle &&
    !windowClosing &&
    exportLifecycleIsCurrent(
      lifecycle,
      lifecycleGeneration,
      sameSource(snapshot),
    )
  );
}

function cancelPreflight(message: string, showMessage: boolean): void {
  if (state.kind !== "preflighting") {
    return;
  }
  overlay.cancelExportConfirmation();
  overlay.hide();
  activeSession = null;
  activeExportLifecycle = null;
  dispatch({ type: "cancel" });
  iina.console.warn(`[Clip Recorder] ${message}`);
  if (showMessage && !windowClosing) {
    showOsd(message);
  }
}

function keepPreflightOrCancel(
  lifecycle: ExportLifecycle,
  snapshot: MediaSnapshot,
): boolean {
  if (preflightIsCurrent(lifecycle, snapshot)) {
    return true;
  }
  if (state.kind === "preflighting") {
    cancelPreflight(
      "Clip export canceled because the player or source changed.",
      !windowClosing,
    );
  }
  return false;
}

async function runExportPreflight(options: {
  readonly lifecycle: ExportLifecycle;
  readonly snapshot: MediaSnapshot;
  readonly range: ClipRange;
  readonly session: ActiveSession;
}): Promise<boolean> {
  const estimate = estimateExportStorage(
    options.snapshot,
    options.range,
    options.session.preferences,
  );
  const risk = buildExportRiskAssessment(
    estimate,
    options.range,
  );
  const temporaryDirectory = resolvePluginTemporaryDirectory();
  const outputDisk = await queryDiskSpace(
    options.session.preferences.outputDirectory,
  );
  if (!keepPreflightOrCancel(options.lifecycle, options.snapshot)) {
    return false;
  }
  const temporaryDisk = await queryDiskSpace(temporaryDirectory);
  if (!keepPreflightOrCancel(options.lifecycle, options.snapshot)) {
    return false;
  }
  const diskAssessment = assessDiskSpace(
    estimate,
    outputDisk,
    temporaryDisk,
  );

  iina.console.log(
    [
      "[Clip Recorder] Export preflight:",
      `range=${options.range.duration.toFixed(3)}s`,
      `estimated=${formatBytes(estimate.estimatedFinalBytes)}`,
      `planning=${formatBytes(estimate.planningFinalBytes)}`,
      `outputFree=${formatBytes(outputDisk.availableBytes)}`,
      `temporaryFree=${formatBytes(temporaryDisk.availableBytes)}`,
      `sameFilesystem=${String(diskAssessment.sameFilesystem)}`,
    ].join(" "),
  );

  if (diskAssessment.blocked) {
    const requirements = diskAssessment.requirements
      .map(
        (item) =>
          `${item.label}: ${formatBytes(item.availableBytes)} free, about ${formatBytes(item.estimatedRequiredBytes)} estimated`,
      )
      .join("; ");
    iina.console.error(
      `[Clip Recorder] Export blocked by free-space preflight: ${requirements}`,
    );
    throw new UserFacingError(
      `${diskAssessment.blockMessage ?? "There is not enough free disk space"} Shorten the range or free some space.`,
      "insufficient_disk_space",
    );
  }

  if (
    !risk.requiresConfirmation &&
    diskAssessment.warnings.length === 0
  ) {
    return true;
  }

  const confirmed = await overlay.requestExportConfirmation(
    buildExportConfirmationNotice({
      estimate,
      assessment: diskAssessment,
      outputDisk,
      temporaryDisk,
      range: options.range,
      risk,
    }),
  );
  if (!keepPreflightOrCancel(options.lifecycle, options.snapshot)) {
    return false;
  }
  if (!confirmed) {
    cancelPreflight("Clip export canceled.", true);
    return false;
  }
  return true;
}

async function runMp4ExportJob(options: {
  readonly session: ActiveSession;
  readonly snapshot: MediaSnapshot;
  readonly range: ClipRange;
  readonly outputPath: string;
  readonly isVisible: () => boolean;
}): Promise<ExportOutcome> {
  let runtime: Mp4ExportRuntime | null = null;
  try {
    const temporaryFile = createTemporaryMp4File();
    runtime = createMp4ExportRuntime({
      executable: options.session.ffmpeg,
      sourcePath: options.snapshot.sourcePath,
      temporaryFile,
      outputPath: options.outputPath,
      verifySource: () =>
        assertSourceFingerprint(
          options.snapshot.sourcePath,
          options.session.sourceFingerprint,
        ),
      onSoftwareFallback: () => {
        if (options.isVisible()) {
          overlay.showEncoding("Encoding… MP4 is using libx264");
        }
      },
    });
    const exportResult = await exportMp4(
      {
        sourcePath: options.snapshot.sourcePath,
        temporaryOutputPath: temporaryFile.resolvedPath,
        range: options.range,
        resolution: options.session.preferences.mp4Resolution,
        selectedVideoStreamIndex:
          options.snapshot.selectedVideoStreamIndex,
        includeAudio: !options.session.preferences.mp4WithoutAudio,
        hasEmbeddedAudio: options.snapshot.hasEmbeddedAudio,
        selectedEmbeddedAudioStreamIndex:
          options.snapshot.selectedEmbeddedAudioStreamIndex,
      },
      runtime,
    );
    iina.console.log(
      `[Clip Recorder] MP4 export complete with ${exportResult.encoder}: ${options.outputPath}`,
    );
    return {
      format: "MP4",
      ok: true,
      outputPath: options.outputPath,
      detail: options.session.preferences.mp4WithoutAudio
        ? `${exportResult.encoder}, no audio`
        : exportResult.encoder,
    };
  } catch (error) {
    logDetailedError("MP4 export failed", error);
    return {
      format: "MP4",
      ok: false,
      outputPath: options.outputPath,
      message: errorMessage(error),
    };
  } finally {
    runtime?.cleanupTemporaryFile();
  }
}

async function runGifExportJob(options: {
  readonly session: ActiveSession;
  readonly snapshot: MediaSnapshot;
  readonly range: ClipRange;
  readonly outputPath: string;
}): Promise<ExportOutcome> {
  let runtime: GifExportRuntime | null = null;
  try {
    const temporaryFile = createTemporaryGifFile();
    const paletteFile = createTemporaryGifPaletteFile();
    runtime = createGifExportRuntime({
      executable: options.session.ffmpeg,
      sourcePath: options.snapshot.sourcePath,
      temporaryFile,
      paletteFile,
      outputPath: options.outputPath,
      verifySource: () =>
        assertSourceFingerprint(
          options.snapshot.sourcePath,
          options.session.sourceFingerprint,
        ),
    });
    await exportGif(
      {
        sourcePath: options.snapshot.sourcePath,
        temporaryOutputPath: temporaryFile.resolvedPath,
        temporaryPalettePath: paletteFile.resolvedPath,
        range: options.range,
        resolution: options.session.preferences.gifResolution,
        frameRate: options.session.preferences.gifFps,
        selectedVideoStreamIndex:
          options.snapshot.selectedVideoStreamIndex,
      },
      runtime,
    );
    iina.console.log(`[Clip Recorder] GIF export complete: ${options.outputPath}`);
    return {
      format: "GIF",
      ok: true,
      outputPath: options.outputPath,
      detail: "two-pass palette",
    };
  } catch (error) {
    logDetailedError("GIF export failed", error);
    return {
      format: "GIF",
      ok: false,
      outputPath: options.outputPath,
      message: errorMessage(error),
    };
  } finally {
    runtime?.cleanupTemporaryFiles();
  }
}

async function resolvedFfmpeg(configuredPath: string): Promise<string> {
  if (
    cachedFfmpeg !== null &&
    cachedFfmpeg.configuredPath === configuredPath &&
    iina.file.exists(cachedFfmpeg.path)
  ) {
    return cachedFfmpeg.path;
  }

  const path = await discoverFfmpeg(configuredPath);
  if (path === null) {
    throw new UserFacingError(
      "FFmpeg was not found. Install it with ‘brew install ffmpeg’ or configure an absolute path.",
      "ffmpeg_not_found",
    );
  }
  cachedFfmpeg = { configuredPath, path };
  return path;
}

async function startRecording(): Promise<void> {
  const generation = lifecycleGeneration;
  const snapshot = captureCurrentMedia();
  preparingSnapshot = snapshot;
  pendingEndPosition = null;
  pendingEof = false;
  pendingEofGeneration = null;
  if (snapshot.isHdr) {
    throw new UserFacingError(
      "HDR export is not enabled in this version; SDR conversion must be explicit.",
      "hdr_not_supported",
    );
  }
  const preferences = readRecorderPreferences();
  if (
    preferences.mp4Enabled &&
    !preferences.mp4WithoutAudio &&
    snapshot.selectedAudioIsExternal
  ) {
    throw new UserFacingError(
      "External audio tracks are not supported for MP4 export. Select an embedded audio track or enable MP4 without audio.",
      "external_audio_not_supported",
    );
  }
  const sourceFingerprint = await readSourceFingerprint(snapshot.sourcePath);
  const ffmpeg = await resolvedFfmpeg(preferences.ffmpegPath);
  const completedAtEofWhilePreparing =
    pendingEof &&
    pendingEofGeneration === generation &&
    lifecycleGeneration === generation + 1;
  if (
    (generation !== lifecycleGeneration && !completedAtEofWhilePreparing) ||
    windowClosing
  ) {
    iina.console.log(
      "[Clip Recorder] Start preparation canceled by a window or source lifecycle change.",
    );
    preparingSnapshot = null;
    pendingEndPosition = null;
    pendingEof = false;
    pendingEofGeneration = null;
    return;
  }
  if (!sameSource(snapshot) && !completedAtEofWhilePreparing) {
    throw new UserFacingError(
      "The source changed while Clip Recorder was preparing.",
      "source_changed",
    );
  }

  activeSession = { ffmpeg, preferences, sourceFingerprint };
  dispatch({ type: "start", snapshot });
  iina.console.log(
    `[Clip Recorder] Start marked at ${snapshot.startPosition.toFixed(6)} seconds`,
  );

  let reachedEof = pendingEof;
  try {
    reachedEof = reachedEof || iina.mpv.getFlag("eof-reached");
  } catch (error) {
    logDetailedError("Unable to verify EOF after FFmpeg preparation", error);
  }
  const queuedEnd = reachedEof ? snapshot.duration : pendingEndPosition;
  preparingSnapshot = null;
  pendingEndPosition = null;
  pendingEof = false;
  pendingEofGeneration = null;
  if (queuedEnd !== null) {
    await finishRecording(queuedEnd, {
      sourceMayDetach: reachedEof,
    });
    return;
  }
  startRecordingOverlay(snapshot);
  notifyRecordingStarted();
}

async function finishRecording(
  endPosition: number,
  options: { readonly sourceMayDetach?: boolean } = {},
): Promise<void> {
  if (state.kind !== "recording" || activeSession === null) {
    return;
  }

  const snapshot = state.snapshot;
  const session = activeSession;
  const sourceIsStillCurrent = sameSource(snapshot);
  if (!sourceIsStillCurrent && !options.sourceMayDetach) {
    throw new UserFacingError(
      "The source changed before the end was marked.",
      "source_changed",
    );
  }
  if (!iina.file.exists(snapshot.sourcePath)) {
    throw new UserFacingError(
      "The source file is no longer available.",
      "missing_source",
    );
  }

  const result = validateClipRange(
    snapshot.startPosition,
    endPosition,
    snapshot.duration,
  );
  if (!result.ok) {
    throw new UserFacingError(
      rangeErrorMessage(result.error),
      `invalid_range_${result.error}`,
    );
  }

  clearOverlayTimer();
  dispatch({ type: "stop", range: result.range });
  overlay.showEncoding("Checking export…");
  iina.console.log(
    `[Clip Recorder] End marked at ${result.range.end.toFixed(6)} seconds; checking ${result.range.duration.toFixed(6)} seconds for export`,
  );

  // Capture the visible player lifecycle before the first asynchronous
  // preflight. If the source changes while mkdir/touch are running, the
  // immutable export may continue, but it must not reopen an overlay or post
  // its result into the new source's window lifecycle.
  const exportLifecycle = createExportLifecycle(
    lifecycleGeneration,
    options.sourceMayDetach === true,
    sourceIsStillCurrent,
  );
  activeExportLifecycle = exportLifecycle;
  const isVisible = (): boolean =>
    !windowClosing &&
    exportLifecycleIsCurrent(
      exportLifecycle,
      lifecycleGeneration,
      sameSource(snapshot),
    );

  await ensureOutputDirectory(session.preferences.outputDirectory);
  if (!keepPreflightOrCancel(exportLifecycle, snapshot)) {
    iina.console.log(
      "[Clip Recorder] Export preflight stopped after the player lifecycle changed.",
    );
    return;
  }
  await assertSourceFingerprint(
    snapshot.sourcePath,
    session.sourceFingerprint,
  );
  if (!keepPreflightOrCancel(exportLifecycle, snapshot)) {
    return;
  }
  const preflightAccepted = await runExportPreflight({
    lifecycle: exportLifecycle,
    snapshot,
    range: result.range,
    session,
  });
  if (!preflightAccepted) {
    return;
  }
  if (
    !keepPreflightOrCancel(exportLifecycle, snapshot) ||
    !iina.file.exists(snapshot.sourcePath)
  ) {
    cancelPreflight(
      "Clip export canceled because the source changed or is no longer available.",
      true,
    );
    return;
  }
  await assertSourceFingerprint(
    snapshot.sourcePath,
    session.sourceFingerprint,
  );
  if (!keepPreflightOrCancel(exportLifecycle, snapshot)) {
    return;
  }
  dispatch({ type: "beginEncoding" });
  overlay.showEncoding(encodingLabel(session.preferences));
  iina.console.log(
    `[Clip Recorder] Encoding ${result.range.duration.toFixed(6)} seconds`,
  );

  const basename = buildClipBasename(
    snapshot.sourcePath,
    new Date(),
    result.range.start,
    result.range.end,
  );
  if (!session.preferences.mp4Enabled && !session.preferences.gifEnabled) {
    throw new UserFacingError(
      "At least one output format must be enabled.",
      "no_output_formats",
    );
  }

  const outcomes: ExportOutcome[] = [];

  if (session.preferences.mp4Enabled) {
    if (session.preferences.gifEnabled && isVisible()) {
      overlay.showEncoding("Encoding MP4 (1/2)…");
    }
    const outputPath = chooseAvailableOutputPath(
      session.preferences.outputDirectory,
      basename,
      "mp4",
      (path) => iina.file.exists(path),
    );
    outcomes.push(
      await runMp4ExportJob({
        session,
        snapshot,
        range: result.range,
        outputPath,
        isVisible,
      }),
    );
  }
  if (session.preferences.gifEnabled) {
    if (session.preferences.mp4Enabled && isVisible()) {
      overlay.showEncoding("Encoding GIF (2/2)…");
    }
    const outputPath = chooseAvailableOutputPath(
      session.preferences.outputDirectory,
      basename,
      "gif",
      (path) => iina.file.exists(path),
    );
    outcomes.push(
      await runGifExportJob({
        session,
        snapshot,
        range: result.range,
        outputPath,
      }),
    );
  }
  // IINA 1.4.4 launches processes immediately but waits for every utils.exec
  // call on one serial plugin queue. Parallel encode→mv chains can therefore
  // delay or mis-order promotion. Sequential jobs are deterministic while
  // their typed outcomes still preserve partial success in either direction.
  const successful = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const savedNotice =
    successful.length > 0
      ? buildSavedClipNotice(outcomes, result.range.duration)
      : null;
  const preferredLastOutput =
    successful.find((outcome) => outcome.format === "MP4") ?? successful[0];
  lastOutputPath = preferredLastOutput?.outputPath ?? lastOutputPath;
  activeSession = null;
  activeExportLifecycle = null;
  overlay.hide();

  if (successful.length > 0) {
    dispatch({ type: "complete" });
  } else {
    dispatch({
      type: "fail",
      message: "All requested export formats failed.",
    });
    dispatch({ type: "reset" });
  }
  shortcut.update(state, lastOutputPath);
  if (isVisible()) {
    if (successful.length > 0) {
      overlay.showSaved(savedNotice!);
    } else {
      const failedFormats = failed.map((outcome) => outcome.format).join(" + ");
      showOsd(formatExportOutcomeMessage(outcomes));
      overlay.showResult(
        `${failedFormats} export failed. See the IINA log for details.`,
        true,
      );
    }
  }
}

async function toggle(): Promise<void> {
  if (state.kind === "encoding") {
    notifyEncodingBusy();
    return;
  }
  if (state.kind === "preflighting") {
    showOsd("Choose Export or Cancel in the export confirmation");
    return;
  }
  if (state.kind === "recording") {
    const position = iina.core.status.position;
    if (position === null || !Number.isFinite(position)) {
      throw new UserFacingError(
        "IINA did not report a valid end position.",
        "missing_end_position",
      );
    }
    await finishRecording(position);
    return;
  }
  if (state.kind === "error") {
    dispatch({ type: "reset" });
  }
  await startRecording();
}

function reportFailure(context: string, error: unknown): void {
  clearOverlayTimer();
  overlay.hide();
  activeSession = null;
  activeExportLifecycle = null;
  preparingSnapshot = null;
  pendingEndPosition = null;
  pendingEof = false;
  pendingEofGeneration = null;
  naturalEofObserved = false;
  logDetailedError(context, error);
  const message = errorMessage(error);
  try {
    dispatch({ type: "fail", message });
    if (!windowClosing) {
      notifyError(message);
      overlay.showResult(
        "Clip Recorder error. See the IINA log for details.",
        true,
      );
    }
    dispatch({ type: "reset" });
  } catch (stateError) {
    state = initialRecorderState();
    shortcut.update(state, lastOutputPath);
    logDetailedError("State recovery failed", stateError);
  }
}

function runExclusive(context: string, action: () => Promise<void>): void {
  if (actionInFlight) {
    if (state.kind === "encoding") {
      notifyEncodingBusy();
    } else if (state.kind === "preflighting") {
      showOsd("Choose Export or Cancel in the export confirmation");
    }
    return;
  }
  actionInFlight = true;
  void action()
    .catch((error: unknown) => reportFailure(context, error))
    .finally(() => {
      actionInFlight = false;
    });
}

function requestToggle(): void {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MILLISECONDS) {
    iina.console.warn("[Clip Recorder] Ignoring a repeated shortcut event");
    return;
  }
  lastToggleAt = now;

  if (preparingSnapshot !== null && actionInFlight) {
    const position = iina.core.status.position;
    if (position !== null && Number.isFinite(position)) {
      pendingEndPosition = position;
      iina.console.log(
        `[Clip Recorder] End queued during FFmpeg preparation at ${position.toFixed(6)} seconds`,
      );
    }
    return;
  }
  runExclusive("Shortcut action failed", toggle);
}

function onSourceStarted(): void {
  lifecycleGeneration += 1;
  const continuesNaturalEofExport = sourceStartBelongsToNaturalEof(
    activeExportLifecycle,
    lifecycleGeneration,
  );
  const continuesNaturalEofPreparation =
    preparingSnapshot !== null &&
    pendingEof &&
    pendingEofGeneration !== null &&
    lifecycleGeneration === pendingEofGeneration + 1;
  // IINA reuses idle PlayerCore instances and their plugin instances after a
  // player window closes. A new source therefore begins a fresh visible
  // lifecycle even though no second window-loaded event is guaranteed.
  windowClosing = false;
  if (!continuesNaturalEofPreparation) {
    preparingSnapshot = null;
    pendingEndPosition = null;
    pendingEof = false;
    pendingEofGeneration = null;
  }
  naturalEofObserved = false;
  overlay.initialize();
  if (state.kind === "recording") {
    cancelRecording("Clip selection canceled because the source changed.", true);
    return;
  }
  if (state.kind === "preflighting") {
    if (continuesNaturalEofExport) {
      iina.console.log(
        "[Clip Recorder] The playlist advanced after natural EOF; export preflight continues from the immutable source.",
      );
      return;
    }
    cancelPreflight(
      "Clip export canceled because the source changed.",
      true,
    );
    return;
  }
  if (state.kind === "encoding") {
    if (continuesNaturalEofExport) {
      iina.console.log(
        "[Clip Recorder] The playlist advanced after natural EOF; encoding continues from the immutable source.",
      );
      return;
    }
    overlay.hide();
    iina.console.log(
      "[Clip Recorder] Source changed while encoding; the immutable export job continues.",
    );
  }
}

function queueOrFinishAtEof(): void {
  if (preparingSnapshot !== null) {
    pendingEof = true;
    pendingEofGeneration = lifecycleGeneration;
    pendingEndPosition = preparingSnapshot.duration;
    return;
  }
  if (state.kind === "recording") {
    const end = state.snapshot.duration;
    runExclusive("Automatic EOF export failed", () =>
      finishRecording(end, { sourceMayDetach: true }),
    );
  }
}

function readEofFlag(): boolean {
  try {
    return iina.mpv.getFlag("eof-reached");
  } catch (error) {
    logDetailedError("Unable to read EOF state", error);
    return false;
  }
}

function onEofChanged(value?: unknown): void {
  // The 0.99.3 definitions type property callbacks as zero-argument, but the
  // 1.4.4 runtime actually passes the observed value. Prefer that immutable
  // event payload so playlist advancement cannot reset the property first.
  const reachedEof = eofReachedFromEvent(value) ?? readEofFlag();
  if (reachedEof) {
    naturalEofObserved = true;
    queueOrFinishAtEof();
  }
}

function onEndFile(): void {
  // IINA intentionally omits mpv's native end-file reason from the public
  // plugin event. The synchronous on_unload hook latches natural EOF while
  // the old file is still alive; rereading the live property here could
  // already inspect the next playlist item.
  if (!windowClosing && naturalEofObserved) {
    queueOrFinishAtEof();
  }
}

function onWindowWillClose(): void {
  lifecycleGeneration += 1;
  windowClosing = true;
  preparingSnapshot = null;
  pendingEndPosition = null;
  pendingEof = false;
  pendingEofGeneration = null;
  naturalEofObserved = false;
  clearOverlayTimer();
  overlay.hide();
  if (state.kind === "recording") {
    cancelRecording("Clip selection canceled because the player closed.", false);
  } else if (state.kind === "preflighting") {
    cancelPreflight("Clip export canceled because the player closed.", false);
  } else if (state.kind === "encoding") {
    activeExportLifecycle = null;
    iina.console.warn(
      "[Clip Recorder] The player closed during encoding. IINA 1.4.4 exposes no process cancellation API.",
    );
  }
}

function logRuntimeVersion(): void {
  const version = iina.core.getVersion();
  iina.console.log(
    `[Clip Recorder] Loaded in IINA ${version.iina} (${version.build}), mpv ${version.mpv}; shortcut ${shortcut.activeShortcut} (${shortcut.displayShortcut})`,
  );
  if (version.iina !== "1.4.4" || version.build !== "168") {
    iina.console.warn(
      `[Clip Recorder] This vertical slice was audited for IINA 1.4.4 (168), not ${version.iina} (${version.build}).`,
    );
  }
  if (shortcut.conflictDescription !== null) {
    iina.console.warn(
      `[Clip Recorder] The configured shortcut may be unavailable because it conflicts with ${shortcut.conflictDescription}`,
    );
  }
}

if (iina.core.window.loaded) {
  overlay.initialize();
}
iina.event.on("iina.window-loaded", () => overlay.initialize());
iina.event.on("iina.file-started", onSourceStarted);
iina.event.on("iina.window-will-close", onWindowWillClose);
iina.mpv.addHook("on_unload", 50, async (next) => {
  try {
    // IINA invokes MPV hooks on MPVController's private queue. Its timer
    // polyfill runs on the main queue, where plugin state, overlays and
    // EventController are safe to touch. Keep the hook pending so the old
    // source and eof-reached flag remain stable until the latch is recorded.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const reachedEof = !windowClosing && readEofFlag();
    naturalEofObserved = reachedEof;
    iina.console.log(
      `[Clip Recorder] on_unload observed eof-reached=${String(reachedEof)}`,
    );
    if (reachedEof) {
      queueOrFinishAtEof();
    }
  } catch (error) {
    naturalEofObserved = false;
    logDetailedError("Unable to classify source unload", error);
  } finally {
    next?.();
  }
});
iina.event.on("mpv.eof-reached.changed", onEofChanged);
iina.event.on("mpv.end-file", onEndFile);
shortcut.update(state, lastOutputPath);
logRuntimeVersion();
void cleanupStaleTemporaryFiles().catch((error: unknown) => {
  logDetailedError("Stale temporary cleanup failed", error);
});
