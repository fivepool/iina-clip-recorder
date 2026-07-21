import type { RecorderState } from "./recorder-state";

export const DEFAULT_SHORTCUT_INPUT = "Meta+r";
const EMERGENCY_FALLBACK_SHORTCUT = "Ctrl+Alt+Meta+c";

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  alt: "Alt",
  cmd: "Meta",
  command: "Meta",
  control: "Ctrl",
  ctrl: "Ctrl",
  meta: "Meta",
  opt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const NAMED_KEYS = new Set([
  "BS",
  "DEL",
  "DOWN",
  "END",
  "ENTER",
  "ESC",
  "HOME",
  "LEFT",
  "PGDWN",
  "PGUP",
  "RIGHT",
  "SPACE",
  "TAB",
  "UP",
  ...Array.from({ length: 20 }, (_, index) => `F${index + 1}`),
]);

export type ShortcutParseResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

function expandModifierGlyphs(value: string): string {
  return value
    .split("⌃")
    .join("Ctrl+")
    .split("⌥")
    .join("Alt+")
    .split("⇧")
    .join("Shift+")
    .split("⌘")
    .join("Meta+");
}

export function canonicalizeShortcutInput(value: string): ShortcutParseResult {
  const expanded = expandModifierGlyphs(value.trim()).replace(/\s*\+\s*/g, "+");
  if (expanded.length === 0 || expanded.length > 80) {
    return {
      ok: false,
      message: "Shortcut must contain one modified key, for example Meta+r.",
    };
  }
  if (
    expanded.includes("-") ||
    expanded.includes(",") ||
    expanded.startsWith("+") ||
    expanded.endsWith("+") ||
    expanded.includes("++")
  ) {
    return {
      ok: false,
      message: "Key sequences are not supported; enter one key combination.",
    };
  }

  const tokens = expanded.split("+");
  if (tokens.length < 2 || tokens.length > 5) {
    return {
      ok: false,
      message: "Shortcut must have a modifier and one key, for example Meta+r.",
    };
  }

  const rawKey = tokens[tokens.length - 1];
  if (rawKey === undefined) {
    return { ok: false, message: "Shortcut is missing its regular key." };
  }
  const modifiers = new Set<string>();
  for (const token of tokens.slice(0, -1)) {
    const canonical = MODIFIER_ALIASES[token.toLowerCase()];
    if (canonical === undefined) {
      return {
        ok: false,
        message: `Unknown shortcut modifier: ${token}.`,
      };
    }
    if (modifiers.has(canonical)) {
      return {
        ok: false,
        message: `Shortcut modifier ${canonical} is repeated.`,
      };
    }
    modifiers.add(canonical);
  }
  if (
    !modifiers.has("Meta") &&
    !modifiers.has("Ctrl") &&
    !modifiers.has("Alt")
  ) {
    return {
      ok: false,
      message: "Shortcut must include Command, Control, or Option.",
    };
  }

  let key: string;
  if (/^[a-z0-9]$/i.test(rawKey)) {
    key = rawKey.toLowerCase();
  } else {
    const namedKey = rawKey.toUpperCase();
    if (!NAMED_KEYS.has(namedKey)) {
      return {
        ok: false,
        message: `Unsupported shortcut key: ${rawKey}.`,
      };
    }
    key = namedKey;
  }

  return {
    ok: true,
    value: [
      ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
      key,
    ].join("+"),
  };
}

export function formatShortcutForDisplay(normalized: string): string {
  const parts = normalized.split("+");
  const key = parts.pop() ?? "";
  const symbols = parts
    .map((part) => {
      switch (part) {
        case "Ctrl":
          return "⌃";
        case "Alt":
          return "⌥";
        case "Shift":
          return "⇧";
        case "Meta":
          return "⌘";
        default:
          return "";
      }
    })
    .join("");
  return `${symbols}${key.length === 1 ? key.toUpperCase() : key}`;
}

export interface ShortcutController {
  readonly activeShortcut: string;
  readonly displayShortcut: string;
  readonly conflictDescription: string | null;
  refreshPreference(): void;
  update(state: RecorderState, lastOutputPath: string | null): void;
}

function preferenceString(key: string, fallback: string): string {
  const value = iina.preferences.get(key) as unknown;
  return typeof value === "string" ? value : fallback;
}

export function registerShortcut(
  toggle: () => void,
  getLastOutputPath: () => string | null,
): ShortcutController {
  let activeShortcut = "";
  let conflictDescription: string | null = null;
  let lastPreferenceValue = "";
  const registeredShortcuts = new Set<string>();

  const writeRuntimeStatus = (message: string, normalized: string): void => {
    let changed = false;
    if (preferenceString("shortcutStatus", "") !== message) {
      iina.preferences.set("shortcutStatus", message);
      changed = true;
    }
    if (preferenceString("shortcutNormalized", "") !== normalized) {
      iina.preferences.set("shortcutNormalized", normalized);
      changed = true;
    }
    if (changed) {
      iina.preferences.sync();
    }
  };

  const registerHandler = (normalized: string): void => {
    if (registeredShortcuts.has(normalized)) {
      return;
    }
    iina.input.onKeyDown(
      normalized,
      ({ isRepeat }) => {
        if (activeShortcut !== normalized) {
          return false;
        }
        if (isRepeat) {
          return true;
        }
        toggle();
        return true;
      },
      iina.input.PRIORITY_HIGH,
    );
    registeredShortcuts.add(normalized);
  };

  const tryActivate = (
    raw: string,
  ): { readonly ok: true } | { readonly ok: false; readonly message: string } => {
    const parsed = canonicalizeShortcutInput(raw);
    if (!parsed.ok) {
      return { ok: false, message: parsed.message };
    }
    let normalized: string;
    try {
      normalized = iina.input.normalizeKeyCode(parsed.value);
    } catch (error) {
      return {
        ok: false,
        message: `IINA could not normalize ${parsed.value}: ${String(error)}`,
      };
    }
    const existingBinding = iina.input.getAllKeyBindings()[normalized];
    if (existingBinding !== undefined) {
      conflictDescription = `${existingBinding.key}: ${existingBinding.action}`;
      return {
        ok: false,
        message: `${formatShortcutForDisplay(normalized)} conflicts with ${existingBinding.action}.`,
      };
    }

    conflictDescription = null;
    registerHandler(normalized);
    activeShortcut = normalized;
    return { ok: true };
  };

  const applyPreference = (raw: string): void => {
    const requested = tryActivate(raw);
    if (!requested.ok) {
      const requestedFailure = requested.message;
      if (activeShortcut.length === 0) {
        for (const fallback of [
          DEFAULT_SHORTCUT_INPUT,
          EMERGENCY_FALLBACK_SHORTCUT,
        ]) {
          if (tryActivate(fallback).ok) {
            break;
          }
        }
      }
      const suffix =
        activeShortcut.length > 0
          ? ` Keeping ${formatShortcutForDisplay(activeShortcut)} active.`
          : " Use the plugin menu until the shortcut is corrected.";
      const message = `Not applied: ${requestedFailure}${suffix}`;
      iina.console.warn(`[Clip Recorder] ${message}`);
      writeRuntimeStatus(message, activeShortcut);
      return;
    }

    const display = formatShortcutForDisplay(activeShortcut);
    const message = `Active in player windows: ${display}`;
    iina.console.log(`[Clip Recorder] Shortcut ${message}`);
    writeRuntimeStatus(message, activeShortcut);
  };

  const refreshPreference = (): void => {
    const raw = preferenceString("shortcut", DEFAULT_SHORTCUT_INPUT).trim();
    if (raw === lastPreferenceValue) {
      return;
    }
    lastPreferenceValue = raw;
    applyPreference(raw);
  };

  const toggleItem = iina.menu.item("Start / Stop Clip Selection", () => {
    toggle();
  });
  const showLastItem = iina.menu.item(
    "Show Last Clip in Finder",
    () => {
      const path = getLastOutputPath();
      if (path !== null && iina.file.exists(path)) {
        iina.file.showInFinder(path);
      } else {
        iina.core.osd("No exported clip is available yet");
      }
    },
    { enabled: true },
  );
  iina.menu.addItem(toggleItem);
  iina.menu.addItem(showLastItem);
  refreshPreference();

  return {
    get activeShortcut(): string {
      return activeShortcut;
    },
    get displayShortcut(): string {
      return formatShortcutForDisplay(activeShortcut);
    },
    get conflictDescription(): string | null {
      return conflictDescription;
    },
    refreshPreference,
    update(_state: RecorderState, _lastOutputPath: string | null): void {
      // Menu items stay static on IINA 1.4.4. Dynamic shortcuts are handled by
      // Input listeners; old handlers remain inert after a preference change.
    },
  };
}
