import type { SavedClipNotice } from "./notifications";

export interface ExportConfirmationNotice {
  readonly title: string;
  readonly duration: string;
  readonly estimates: string;
  readonly disk: string;
  readonly warning: string;
  readonly confirmLabel: "Export";
  readonly cancelLabel: "Cancel";
}

function formatElapsed(seconds: number): string {
  const milliseconds = Math.max(0, Math.floor(seconds * 1000));
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const wholeSeconds = totalSeconds % 60;
  const tenths = Math.floor((milliseconds % 1000) / 100);
  const base = `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${tenths}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${base}` : base;
}

function escapeHtml(value: string): string {
  return value
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;");
}

const OVERLAY_STYLE = [
  "html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }",
  "body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; }",
  ".clip-recorder-badge { position: absolute; top: calc(18px + env(safe-area-inset-top)); right: calc(18px + env(safe-area-inset-right)); display: flex; align-items: center; gap: 8px; padding: 7px 11px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; color: white; background: linear-gradient(145deg, rgba(28,29,32,.78), rgba(10,10,12,.72)); box-shadow: 0 5px 18px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.07); backdrop-filter: blur(18px) saturate(130%); -webkit-backdrop-filter: blur(18px) saturate(130%); font-size: 13px; font-weight: 650; letter-spacing: .04em; font-variant-numeric: tabular-nums; white-space: nowrap; }",
  ".clip-recorder-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #ff3b30; box-shadow: 0 0 0 2px rgba(255,59,48,.22); }",
  ".clip-recorder-badge.encoding .clip-recorder-dot { background: #ffcc00; animation: clip-recorder-pulse 1.1s ease-in-out infinite; }",
  ".clip-recorder-badge.result { max-width: min(520px, calc(100% - 36px)); white-space: normal; letter-spacing: 0; line-height: 1.35; }",
  ".clip-recorder-badge.result.error .clip-recorder-dot { background: #ff453a; animation: none; }",
  ".clip-recorder-note { color: rgba(255,255,255,.72); font-weight: 500; letter-spacing: 0; }",
  "@keyframes clip-recorder-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }",
].join("\n");

type OverlayMode = "simple" | "saved" | "confirmation";

export class RecorderOverlay {
  private initialized = false;
  private eventSubscribed = false;
  private mode: OverlayMode = "simple";
  private dismissTimer: string | null = null;
  private pendingSavedNotice: SavedClipNotice | null = null;
  private pendingConfirmationNotice: ExportConfirmationNotice | null = null;
  private confirmationResolver: ((confirmed: boolean) => void) | null = null;
  private confirmationToken = 0;
  private revealHandler: (() => void) | null = null;

  private clearDismissTimer(): void {
    if (this.dismissTimer !== null) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  private activateSimpleMode(): boolean {
    if (!iina.core.window.loaded) {
      return false;
    }
    if (!this.initialized || this.mode !== "simple") {
      this.cancelExportConfirmation();
      iina.overlay.simpleMode();
      iina.overlay.setClickable(false);
      iina.overlay.setStyle(OVERLAY_STYLE);
      iina.overlay.setContent("");
      this.initialized = true;
      this.mode = "simple";
    }
    return true;
  }

  private postPendingSavedNotice(): void {
    if (this.pendingSavedNotice !== null && this.mode === "saved") {
      iina.overlay.postMessage("clip-recorder-show-saved", this.pendingSavedNotice);
    }
  }

  private handleOverlayLoaded(): void {
    if (this.mode === "confirmation") {
      const token = this.confirmationToken;
      iina.console.log(
        "[Clip Recorder] Export confirmation overlay loaded; actions armed",
      );
      iina.overlay.onMessage("clip-recorder-confirm-export", () => {
        if (this.mode === "confirmation" && token === this.confirmationToken) {
          this.settleExportConfirmation(true);
        }
      });
      iina.overlay.onMessage("clip-recorder-cancel-export", () => {
        if (this.mode === "confirmation" && token === this.confirmationToken) {
          this.settleExportConfirmation(false);
        }
      });
      if (this.pendingConfirmationNotice !== null) {
        iina.overlay.postMessage(
          "clip-recorder-show-export-warning",
          this.pendingConfirmationNotice,
        );
      }
      return;
    }
    if (this.mode !== "saved") {
      return;
    }
    // IINA 1.4.4 clears every overlay message listener inside loadFile() and
    // simpleMode(). Register only after WKWebView didFinish emits this event.
    iina.console.log(
      "[Clip Recorder] Saved overlay loaded; Reveal in Finder handler armed",
    );
    iina.overlay.onMessage("clip-recorder-reveal", () => {
      iina.console.log(
        "[Clip Recorder] Reveal in Finder received from saved overlay",
      );
      this.revealHandler?.();
    });
    this.postPendingSavedNotice();
  }

  initialize(): void {
    if (!this.eventSubscribed) {
      iina.event.on("iina.plugin-overlay-loaded", () => {
        this.handleOverlayLoaded();
      });
      this.eventSubscribed = true;
    }
    if (this.initialized || !iina.core.window.loaded) {
      return;
    }
    this.activateSimpleMode();
  }

  setRevealHandler(handler: () => void): void {
    this.revealHandler = handler;
  }

  private settleExportConfirmation(confirmed: boolean): void {
    const resolver = this.confirmationResolver;
    if (resolver === null) {
      return;
    }
    this.confirmationResolver = null;
    this.pendingConfirmationNotice = null;
    this.confirmationToken += 1;
    iina.overlay.setClickable(false);
    iina.overlay.hide();
    resolver(confirmed);
  }

  cancelExportConfirmation(): void {
    this.settleExportConfirmation(false);
  }

  requestExportConfirmation(
    notice: ExportConfirmationNotice,
  ): Promise<boolean> {
    this.clearDismissTimer();
    this.initialize();
    this.cancelExportConfirmation();
    if (!iina.core.window.loaded) {
      return Promise.resolve(false);
    }

    this.pendingSavedNotice = null;
    this.pendingConfirmationNotice = notice;
    this.mode = "confirmation";
    this.confirmationToken += 1;
    return new Promise<boolean>((resolve) => {
      this.confirmationResolver = resolve;
      try {
        iina.overlay.loadFile("overlay/export-warning.html");
        iina.overlay.setClickable(true);
        iina.overlay.show();
      } catch (error) {
        iina.console.error(
          `[Clip Recorder] Could not show export confirmation: ${String(error)}`,
        );
        this.settleExportConfirmation(false);
      }
    });
  }

  showRecording(elapsed: number, beforeStart: boolean): void {
    this.clearDismissTimer();
    this.initialize();
    if (!this.activateSimpleMode()) {
      return;
    }
    const note = beforeStart ? '<span class="clip-recorder-note">seeked before start</span>' : "";
    iina.overlay.setContent(`<div class="clip-recorder-badge"><span class="clip-recorder-dot"></span><span>REC</span><span>${formatElapsed(elapsed)}</span>${note}</div>`);
    iina.overlay.show();
  }

  showEncoding(label = "Encoding MP4…"): void {
    this.clearDismissTimer();
    this.initialize();
    if (!this.activateSimpleMode()) {
      return;
    }
    iina.overlay.setContent(`<div class="clip-recorder-badge encoding"><span class="clip-recorder-dot"></span><span>${escapeHtml(label)}</span></div>`);
    iina.overlay.show();
  }

  showSaved(notice: SavedClipNotice, duration = 4_000): void {
    this.clearDismissTimer();
    this.initialize();
    this.cancelExportConfirmation();
    if (!iina.core.window.loaded) {
      return;
    }
    this.pendingSavedNotice = notice;
    this.mode = "saved";
    iina.overlay.loadFile("overlay/clip-saved.html");
    iina.overlay.setClickable(true);
    iina.overlay.show();
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      this.hide();
    }, duration);
  }

  showResult(message: string, isError: boolean, duration = 10_000): void {
    this.clearDismissTimer();
    this.initialize();
    if (!this.activateSimpleMode()) {
      return;
    }
    const errorClass = isError ? " error" : "";
    iina.overlay.setContent(`<div class="clip-recorder-badge result${errorClass}"><span class="clip-recorder-dot"></span><span>${escapeHtml(message)}</span></div>`);
    iina.overlay.show();
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      this.hide();
    }, duration);
  }

  hide(): void {
    this.clearDismissTimer();
    this.pendingSavedNotice = null;
    if (this.confirmationResolver !== null) {
      this.settleExportConfirmation(false);
      return;
    }
    this.pendingConfirmationNotice = null;
    if (
      this.initialized ||
      this.mode === "saved" ||
      this.mode === "confirmation"
    ) {
      iina.overlay.setClickable(false);
      iina.overlay.hide();
    }
  }
}
